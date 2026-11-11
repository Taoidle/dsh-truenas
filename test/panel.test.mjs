import test from 'node:test'
import assert from 'node:assert/strict'

import { createPanel } from '../lib/panel.js'

const GIB = 1024 ** 3

function fakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push([method, params])
      if (method in overrides) {
        const value = overrides[method]
        return typeof value === 'function' ? value(params) : value
      }
      // Write actions answer with a job id; the light ones answer null.
      if (method.startsWith('app.')) return 101
      if (method === 'core.job_abort' || method === 'alert.dismiss') return null
      throw new Error(`unexpected call: ${method}`)
    },
    async waitJob(id) {
      return { id, state: 'SUCCESS' }
    },
  }
}

function harness(overrides = {}, options = {}) {
  const client = fakeClient(overrides)
  const entries = options.entries || [
    { name: 'lab-nas', url: 'https://nas.lab.local', username: 'root', credential: 'TRUENAS_APIKEY_LAB_NAS', insecureTls: false },
  ]
  const keys = new Map(options.keys || [['TRUENAS_APIKEY_LAB_NAS', '1-secret']])
  const store = {
    getApiKey: async (name) => keys.get(name),
  }
  const pool = { get: () => client }
  const config = { instances: entries, timeoutMs: 5000, jobTimeoutMs: 60000 }
  const panel = createPanel({ store, pool, getConfig: () => config })
  return { panel, client, entries, config }
}

const healthy = {
  'system.info': {
    hostname: 'nas',
    version: '25.10.4',
    physmem: 16 * GIB,
    cores: 8,
    uptime_seconds: 3661,
    loadavg: [0.5, 0.4, 0.2],
  },
  'reporting.get_data': [
    { name: 'cpu', identifier: null, data: [[1, 10, 20], [2, 30, 40]] },
    { name: 'memory', identifier: null, data: [[1, 4 * GIB]] },
    { name: 'cputemp', identifier: null, data: [[1, 42]] },
  ],
  'pool.query': [{ name: 'tank', status: 'ONLINE', healthy: true, size: 1000, allocated: 250, free: 750 }],
  'app.query': [
    { name: 'plex', state: 'STOPPED', human_version: '1.0.0', upgrade_available: true },
    { name: 'forgejo', state: 'RUNNING', human_version: '9.0.1' },
  ],
  'core.get_jobs': [{ id: 7, method: 'pool.scrub.run', state: 'RUNNING', progress: { percent: 40 } }],
  'alert.list': [
    { uuid: 'a1', level: 'WARNING', text: 'SMART test failed', dismissed: false },
    { uuid: 'a2', level: 'INFO', text: 'old', dismissed: true },
  ],
}

test('overview summarises cards, apps, jobs and alerts', async () => {
  const { panel } = harness(healthy)
  const state = await panel.overview()

  assert.equal(state.ok, true)
  assert.equal(state.selected, 'lab-nas')
  assert.equal(state.system.hostname, 'nas')
  assert.equal(state.cards.cpu.percent, 35)
  assert.equal(state.cards.memory.percent, 25)
  assert.equal(state.cards.memory.used, 4 * GIB)
  assert.equal(state.cards.temperature.celsius, 42)
  assert.equal(state.cards.pool.percent, 25)
  assert.equal(state.cards.pool.name, 'tank')
  assert.deepEqual(state.apps.map((app) => app.name), ['forgejo', 'plex'])
  assert.equal(state.apps[1].upgradeAvailable, true)
  assert.equal(state.jobs[0].percent, 40)
  assert.deepEqual(state.alerts.map((alert) => alert.uuid), ['a1'])
  assert.deepEqual(state.issues, [])
})

test('overview lists instances and rejects an unknown selection', async () => {
  const { panel } = harness(healthy)
  const state = await panel.overview('missing')
  assert.equal(state.ok, false)
  assert.match(state.error, /Unknown TrueNAS instance/i)
  assert.equal(state.instances.length, 1)
})

test('overview reports a partially failing NAS without losing the rest', async () => {
  const overrides = {
    ...healthy,
    'app.query': () => {
      throw new Error('app.query: not available')
    },
  }
  const { panel } = harness(overrides)
  const state = await panel.overview()
  assert.equal(state.ok, true)
  assert.deepEqual(state.apps, [])
  assert.equal(state.issues.length, 1)
  assert.match(state.issues[0], /^apps: /)
})

test('overview refuses an instance without a stored key', async () => {
  const { panel } = harness(healthy, { keys: [] })
  const state = await panel.overview('lab-nas')
  assert.equal(state.ok, false)
  assert.match(state.error, /not ready/i)
  assert.match(state.error, /API key/i)
})

test('overview caches within the window', async () => {
  const { panel, client } = harness(healthy)
  await panel.overview()
  const calls = client.calls.length
  await panel.overview()
  assert.equal(client.calls.length, calls)
})

test('app.delete needs a second confirmation and never calls the NAS without it', async () => {
  const { panel, client } = harness(healthy)
  const refused = await panel.act({ action: 'app.delete', name: 'plex' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  assert.equal(client.calls.length, 0)

  const done = await panel.act({ action: 'app.delete', name: 'plex', confirm: true })
  assert.equal(done.ok, true)
  assert.deepEqual(client.calls[0], ['app.delete', ['plex']])
})

test('app actions wait for their job and refresh the cache', async () => {
  const { panel, client } = harness(healthy)
  await panel.overview()
  const before = client.calls.length
  const result = await panel.act({ action: 'app.restart', name: 'forgejo' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'SUCCESS')
  assert.deepEqual(client.calls[before], ['app.restart', ['forgejo']])
})

test('job.abort and alert.dismiss call the right methods', async () => {
  const { panel, client } = harness(healthy)
  assert.equal((await panel.act({ action: 'job.abort', id: 7 })).ok, true)
  assert.deepEqual(client.calls.at(-1), ['core.job_abort', [7]])
  assert.equal((await panel.act({ action: 'alert.dismiss', uuid: 'a1' })).ok, true)
  assert.deepEqual(client.calls.at(-1), ['alert.dismiss', ['a1']])
})

test('unknown actions are refused', async () => {
  const { panel, client } = harness(healthy)
  const result = await panel.act({ action: 'system.reboot' })
  assert.equal(result.ok, false)
  assert.match(result.error, /Unsupported panel action/)
  assert.equal(client.calls.length, 0)
})
