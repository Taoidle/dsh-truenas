import test from 'node:test'
import assert from 'node:assert/strict'

import { MockTruenas } from './mock-truenas.mjs'
import { createAdmin } from '../lib/admin.js'
import { TruenasClient } from '../lib/truenas.js'

/**
 * The settings page and the agent tools share this layer, so these tests pin the
 * behaviour both surfaces promise: nothing is saved before it authenticates, the
 * API key lands in the credential store, and removal needs explicit confirmation.
 */

function harness() {
  const instances = []
  const keys = new Map()
  const live = []
  const store = {
    config: () => ({ instances }),
    instances: () => instances,
    saveInstances: async (next) => {
      instances.length = 0
      instances.push(...next)
    },
    hasApiKey: async (name) => keys.has(name),
    getApiKey: async (name) => keys.get(name),
    setApiKey: async (name, value) => {
      keys.set(name, value)
    },
    deleteApiKey: async (name) => {
      keys.delete(name)
    },
  }
  const create = (entry, apiKey) => {
    // The mock speaks plain HTTP; real TrueNAS would revoke a key presented that
    // way, and the client refuses unless this test-only switch is set.
    const client = new TruenasClient({ ...entry, apiKey, timeoutMs: 5000, allowInsecureApiKey: true })
    live.push(client)
    return client
  }
  const pool = { create, get: create, invalidate: () => {}, dispose: () => live.forEach((c) => c.close()) }
  return { admin: createAdmin({ store, pool }), instances, keys, pool }
}

async function withServer(options, fn) {
  const server = await new MockTruenas(options).start()
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

test('add authenticates first, then persists the entry and the key', async () => {
  await withServer({ apiKey: '1-addkey', username: 'root' }, async (server) => {
    const { admin, instances, keys } = harness()
    const result = await admin.perform({
      action: 'add',
      url: server.url,
      username: 'root',
      apiKey: '1-addkey',
      name: 'lab-nas',
    })

    assert.equal(result.ok, true)
    assert.equal(result.version, '25.10.0')
    assert.equal(result.instance, 'lab-nas')
    assert.equal(result.defaultName, 'lab-nas')
    assert.equal(instances.length, 1)
    assert.equal(instances[0].credential, 'TRUENAS_APIKEY_LAB_NAS')
    assert.equal(keys.get('TRUENAS_APIKEY_LAB_NAS'), '1-addkey')
  })
})

test('a bad key or unreachable host saves nothing', async () => {
  await withServer({ apiKey: '1-goodkey' }, async (server) => {
    const { admin, instances, keys } = harness()

    const badKey = await admin.perform({ action: 'add', url: server.url, apiKey: '1-wrongkey', name: 'wrong' })
    assert.equal(badKey.ok, false)
    assert.match(badKey.error, /Nothing was saved/)
    assert.equal(badKey.hint.includes('Skip TLS verification'), true)

    const badHost = await admin.perform({ action: 'add', url: 'http://127.0.0.1:1', apiKey: '1-goodkey', name: 'down' })
    assert.equal(badHost.ok, false)
    assert.equal(instances.length, 0)
    assert.equal(keys.size, 0)
  })
})

test('the name is required unless it can be derived from the URL, and duplicates are rejected', async () => {
  await withServer({ apiKey: '1-dupkey' }, async (server) => {
    const { admin, instances } = harness()

    const derived = await admin.perform({ action: 'add', url: server.url, apiKey: '1-dupkey' })
    assert.equal(derived.ok, true)
    assert.equal(derived.instance, '127.0.0.1')

    const duplicate = await admin.perform({ action: 'add', url: server.url, apiKey: '1-dupkey', name: '127.0.0.1' })
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.error, /already exists/)

    const missingKey = await admin.perform({ action: 'add', url: server.url, name: 'nokey' })
    assert.equal(missingKey.ok, false)
    assert.match(missingKey.error, /API key is required/)
    assert.equal(instances.length, 1)
  })
})

test('list reports every instance with whether a key is stored, without leaking it', async () => {
  await withServer({ apiKey: '1-listkey', username: 'root' }, async (first) => {
    await withServer({ apiKey: '2-listkey', username: 'admin' }, async (second) => {
      const { admin } = harness()
      const alpha = await admin.perform({ action: 'add', url: first.url, apiKey: '1-listkey', name: 'alpha' })
      const beta = await admin.perform({ action: 'add', url: second.url, username: 'admin', apiKey: '2-listkey', name: 'beta' })
      assert.equal(alpha.ok, true)
      assert.equal(beta.ok, true)
      assert.equal(beta.defaultName, 'alpha', 'adding does not change the default')

      const listed = await admin.perform({ action: 'list' })
      assert.equal(listed.ok, true)
      assert.equal(listed.defaultName, 'alpha')
      assert.deepEqual(
        listed.instances.map((entry) => [entry.name, entry.hasApiKey]),
        [
          ['alpha', true],
          ['beta', true],
        ],
      )
      assert.equal(JSON.stringify(listed).includes('1-listkey'), false)
      assert.equal(JSON.stringify(listed).includes('2-listkey'), false)
    })
  })
})

test('test reconnects with the stored key; default moves an instance to the front', async () => {
  await withServer({ apiKey: '1-first' }, async (first) => {
    await withServer({ apiKey: '2-second' }, async (second) => {
      const { admin } = harness()
      await admin.perform({ action: 'add', url: first.url, apiKey: '1-first', name: 'first' })
      await admin.perform({ action: 'add', url: second.url, apiKey: '2-second', name: 'second' })

      const probe = await admin.perform({ action: 'test', name: 'second' })
      assert.equal(probe.ok, true)
      assert.equal(probe.hostname, 'mock.test')

      const promoted = await admin.perform({ action: 'default', name: 'second' })
      assert.equal(promoted.ok, true)
      assert.equal(promoted.moved, true)
      const listed = await admin.perform({ action: 'list' })
      assert.equal(listed.defaultName, 'second')

      const unknown = await admin.perform({ action: 'test', name: 'nope' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /Unknown instance/)
    })
  })
})

test('removal needs confirm: true and can forget the stored key', async () => {
  await withServer({ apiKey: '1-rmkey' }, async (server) => {
    const { admin, instances, keys } = harness()
    await admin.perform({ action: 'add', url: server.url, apiKey: '1-rmkey', name: 'doomed' })
    assert.equal(instances.length, 1)

    const refused = await admin.perform({ action: 'remove', name: 'doomed' })
    assert.equal(refused.ok, false)
    assert.equal(refused.requiresConfirm, true)
    assert.equal(instances.length, 1, 'refused removal must keep the entry')

    const kept = await admin.perform({ action: 'remove', name: 'doomed', confirm: true, forgetApiKey: false })
    assert.equal(kept.ok, true)
    assert.equal(kept.forgotApiKey, false)
    assert.equal(instances.length, 0)
    assert.equal(keys.size, 1, 'forgetApiKey: false keeps the credential')

    await admin.perform({ action: 'add', url: server.url, apiKey: '1-rmkey', name: 'doomed' })
    const forgotten = await admin.perform({ action: 'remove', name: 'doomed', confirm: true })
    assert.equal(forgotten.forgotApiKey, true)
    assert.equal(keys.size, 0)
  })
})
