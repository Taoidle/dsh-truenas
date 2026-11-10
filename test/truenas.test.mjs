import test from 'node:test'
import assert from 'node:assert/strict'

import { MockTruenas } from './mock-truenas.mjs'
import { TruenasClient, RpcError } from '../lib/truenas.js'
import { explainConnectError, parseEndpoint } from '../lib/ws.js'
import {
  addOrUpdateInstance,
  defaultCredentialName,
  findInstance,
  instanceReadiness,
  listInstances,
  maskKey,
  normalizeInstance,
  removeInstance,
} from '../lib/instances.js'

async function withServer(options, fn) {
  const server = await new MockTruenas(options).start()
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

function clientFor(server, overrides = {}) {
  return new TruenasClient({
    url: server.url,
    username: 'root',
    apiKey: '1-testkey',
    apiPath: '/api/current',
    insecureTls: false,
    timeoutMs: 5000,
    ...overrides,
  })
}

test('parseEndpoint accepts bare hosts, URLs, custom paths and insecure TLS', () => {
  const bare = parseEndpoint('nas.lab.local', undefined, false)
  assert.equal(bare.secure, true)
  assert.equal(bare.port, 443)
  assert.equal(bare.path, '/api/current')
  assert.equal(bare.displayUrl, 'https://nas.lab.local')

  const insecure = parseEndpoint('https://10.0.0.5:8443/', '/api/current', true)
  assert.equal(insecure.rejectUnauthorized, false)
  assert.equal(insecure.port, 8443)
  assert.equal(insecure.host, '10.0.0.5')

  const ws = parseEndpoint('ws://127.0.0.1:1234/api/v25.10', undefined, false)
  assert.equal(ws.secure, false)
  assert.equal(ws.path, '/api/v25.10')
  assert.equal(ws.displayUrl, 'http://127.0.0.1:1234')

  const ipv6 = parseEndpoint('https://[fd00::1]:443', undefined, false)
  assert.equal(ipv6.host, 'fd00::1')
  assert.equal(ipv6.port, 443)
})

test('client authenticates with an API key and calls a method', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      const info = await client.request('system.info')
      assert.equal(info.version, '25.10.0')
      assert.equal(info.hostname, 'mock.test')
      assert.equal(server.calls[0].method, 'auth.login_ex')
      assert.deepEqual(server.calls[0].params[0].mechanism, 'API_KEY_PLAIN')
    } finally {
      client.close()
    }
  })
})

test('a rejected API key fails the connection with a useful message', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server, { apiKey: '1-wrong' })
    await assert.rejects(() => client.request('system.info'), /Authentication failed for user "root": invalid API key/)
    client.close()
  })
})

test('legacy servers fall back to auth.login_with_api_key', async () => {
  await withServer({ legacyOnly: true }, async (server) => {
    const client = clientFor(server)
    try {
      const info = await client.request('system.info')
      assert.equal(info.version, '25.10.0')
      assert.ok(server.calls.some((call) => call.method === 'auth.login_with_api_key'))
    } finally {
      client.close()
    }
  })
})

test('JSON-RPC errors surface as RpcError with the reason', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      const error = await client.request('test.error').then(
        () => null,
        (err) => err,
      )
      assert.ok(error instanceof RpcError)
      assert.equal(error.method, 'test.error')
      assert.equal(error.reason, 'boom')
      assert.match(error.message, /test\.error: boom/)
    } finally {
      client.close()
    }
  })
})

test('concurrent calls are serialized and correlate their responses', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      const results = await Promise.all([
        client.request('test.raw', [1]),
        client.request('test.raw', [2]),
        client.request('test.raw', [3]),
      ])
      assert.deepEqual(
        results.map((entry) => entry.params[0]),
        [1, 2, 3],
      )
    } finally {
      client.close()
    }
  })
})

test('waitJob polls core.get_jobs until the job succeeds', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      const jobId = await client.request('test.startJob', [{}, {}])
      assert.equal(typeof jobId, 'number')
      const job = await client.waitJob(jobId, { intervalMs: 10, timeoutMs: 2000 })
      assert.equal(job.state, 'SUCCESS')
      assert.deepEqual(job.result, { ok: true, jobId })
    } finally {
      client.close()
    }
  })
})

test('waitJob reports a failed job with its error', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      const jobId = await client.request('test.startJob', [{}, { fail: true }])
      await assert.rejects(
        () => client.waitJob(jobId, { intervalMs: 10, timeoutMs: 2000 }),
        /Job \d+ failed: mock failure/,
      )
    } finally {
      client.close()
    }
  })
})

test('a dropped session is re-opened before the next call', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      await client.request('test.drop')
      await new Promise((resolve) => setTimeout(resolve, 80))
      const who = await client.request('test.whoami')
      assert.equal(who.serverId, 'mock')
      assert.equal(server.calls.filter((call) => call.method === 'auth.login_ex').length, 2)
    } finally {
      client.close()
    }
  })
})

test('a session rejected as unauthenticated is re-opened and retried once', async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server)
    try {
      await client.request('test.expire')
      const who = await client.request('test.whoami')
      assert.equal(who.serverId, 'mock')
      assert.equal(server.calls.filter((call) => call.method === 'auth.login_ex').length, 2)
    } finally {
      client.close()
    }
  })
})

test('two clients stay bound to their own server', async () => {
  await withServer({ serverId: 'alpha', apiKey: '1-alpha' }, async (alpha) => {
    await withServer({ serverId: 'beta', apiKey: '1-beta' }, async (beta) => {
      const first = clientFor(alpha, { apiKey: '1-alpha' })
      const second = clientFor(beta, { apiKey: '1-beta' })
      try {
        const [a, b] = await Promise.all([first.request('test.whoami'), second.request('test.whoami')])
        assert.equal(a.serverId, 'alpha')
        assert.equal(b.serverId, 'beta')
      } finally {
        first.close()
        second.close()
      }
    })
  })
})

test('instance records normalize with a per-instance credential name', () => {
  const entry = normalizeInstance({ url: 'https://nas.lab.local' }, 0)
  assert.equal(entry.name, 'default')
  assert.equal(entry.username, 'root')
  assert.equal(entry.apiPath, '/api/current')
  assert.equal(entry.credential, 'TRUENAS_APIKEY_DEFAULT')
  assert.equal(defaultCredentialName('lab nas'), 'TRUENAS_APIKEY_LAB_NAS')

  const named = normalizeInstance({ name: 'backup-nas', url: 'https://backup', credential: 'MY_KEY' }, 1)
  assert.equal(named.credential, 'MY_KEY')
  assert.equal(defaultCredentialName('backup-nas'), 'TRUENAS_APIKEY_BACKUP_NAS')
})

test('instance lookup: first instance is the default and unknown names explain the list', () => {
  const config = {
    instances: [
      { name: 'alpha', url: 'https://a' },
      { name: 'beta', url: 'https://b' },
    ],
  }
  assert.equal(listInstances(config).length, 2)
  assert.equal(findInstance(config, '').instance.name, 'alpha')
  assert.equal(findInstance(config, 'BETA').instance.name, 'beta')
  const missing = findInstance(config, 'gamma')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /alpha, beta/)
  assert.equal(findInstance({}, '').ok, false)
})

test('add/update/remove maintain the instance list', () => {
  let instances = addOrUpdateInstance([], { name: 'alpha', url: 'https://a' })
  instances = addOrUpdateInstance(instances, { name: 'beta', url: 'https://b' })
  assert.deepEqual(
    instances.map((entry) => entry.name),
    ['alpha', 'beta'],
  )
  instances = addOrUpdateInstance(instances, { name: 'BETA', url: 'https://b2', username: 'admin' })
  assert.equal(instances[1].url, 'https://b2')
  assert.equal(instances[1].username, 'admin')
  assert.equal(instances.length, 2)
  assert.throws(() => removeInstance(instances, 'gamma'), /Unknown instance/)
  instances = removeInstance(instances, 'alpha')
  assert.deepEqual(
    instances.map((entry) => entry.name),
    ['beta'],
  )
})

test('readiness and key masking', () => {
  assert.equal(instanceReadiness({ url: '', credential: 'K' }, true), 'missing url')
  assert.match(instanceReadiness({ url: 'https://a', credential: 'K' }, false), /API key not set/)
  assert.equal(instanceReadiness({ url: 'https://a', credential: 'K' }, true), null)
  assert.equal(maskKey('1-abcdefghijklmnop'), '1-ab…op')
  assert.equal(maskKey('short'), '********')
  assert.equal(maskKey(''), '')
})

test('a bare host:port is HTTPS first, but ws:// stays plaintext', () => {
  const bare = parseEndpoint('192.168.2.88:86', undefined, true)
  assert.equal(bare.secure, true)
  assert.equal(bare.schemeExplicit, false)
  assert.equal(bare.port, 86)
  assert.equal(bare.rejectUnauthorized, false)

  const explicit = parseEndpoint('ws://192.168.2.88:86', undefined, true)
  assert.equal(explicit.secure, false)
  assert.equal(explicit.schemeExplicit, true)
  assert.equal(explicit.port, 86)
})

test('a plain-HTTP listener is explained instead of surfacing an OpenSSL code', () => {
  const endpoint = parseEndpoint('192.168.2.88:86', undefined, true)
  const error = Object.assign(new Error('ssl3_get_record:wrong version number'), { code: 'EPROTO' })
  const text = explainConnectError(error, endpoint)
  assert.match(text, /plain HTTP/)
  assert.match(text, /ws:\/\/192\.168\.2\.88:86/)
})

test('with TLS verification skipped, a bare host:port falls back to plaintext once', async () => {
  const server = await new MockTruenas({ apiKey: '1-fallback', username: 'root' }).start()
  // `server.url` is http://127.0.0.1:<port>; strip the scheme to make the plugin
  // try TLS first, exactly like a user typing "192.168.2.88:86".
  const bare = server.url.replace(/^http:\/\//, '')
  const client = new TruenasClient({ url: bare, username: 'root', apiKey: '1-fallback', insecureTls: true })
  try {
    const info = await client.request('system.info')
    assert.equal(info.hostname, 'mock.test')
    assert.match(client.transportNote || '', /plain HTTP/)
    assert.match(client.displayUrl, /^http:\/\//)
  } finally {
    client.close()
    await server.stop()
  }
})

test('without skip-verify the fallback is refused and the error explains ws://', async () => {
  const server = await new MockTruenas({ apiKey: '1-fallback', username: 'root' }).start()
  const bare = server.url.replace(/^http:\/\//, '')
  const client = new TruenasClient({ url: bare, username: 'root', apiKey: '1-fallback', insecureTls: false })
  try {
    await assert.rejects(
      () => client.request('system.info'),
      (error) => /plain HTTP/.test(error.message) && /ws:\/\//.test(error.message),
    )
  } finally {
    client.close()
    await server.stop()
  }
})
