import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyMethod, destructiveMethods } from '../lib/danger.js'
import { createPanel } from '../lib/panel.js'
import { createTools } from '../lib/tools.js'

const GIB = 1024 ** 3

const ENTRY = {
  name: 'mock',
  url: 'http://127.0.0.1:8734',
  username: 'root',
  apiPath: '/api/current',
  insecureTls: false,
  description: '',
  credential: 'TRUENAS_APIKEY_MOCK',
}

const SERVICES = [
  { id: 1, service: 'smb', state: 'RUNNING', enable: true },
  { id: 2, service: 'ssh', state: 'STOPPED', enable: false },
  { id: 3, service: 'nfs', state: 'RUNNING', enable: true },
]

const CERTIFICATES = [
  {
    id: 1,
    name: 'truenas_default',
    type: 'CERTIFICATE',
    cert_type: 'SELF_SIGNED',
    from: 'Tue Nov 17 11:27:09 2025',
    until: 'Sun May 16 11:27:09 2027',
    expired: false,
    renew_days: 10,
    acme: null,
  },
  {
    id: 2,
    name: 'vpn-edge',
    type: 'CERTIFICATE',
    cert_type: 'IMPORTED',
    from: 'Mon Jan 06 10:00:00 2025',
    until: 'Thu Jan 13 10:00:00 2028',
    expired: false,
    renew_days: 10,
    acme: null,
  },
  {
    id: 3,
    name: 'old-acme',
    type: 'CERTIFICATE',
    cert_type: 'ACME',
    until: 'Wed Jan 01 00:00:00 2025',
    expired: true,
    renew_days: 10,
    acme: { id: 1 },
  },
]

const DISKS = [
  { name: 'sda', model: 'QEMU HARDDISK', serial: 'abc', size: 100 * GIB, type: 'SSD', bus: 'SCSI', rotationrate: null },
  { name: 'sdb', model: 'QEMU HARDDISK', serial: 'def', size: 980 * GIB, type: 'SSD', bus: 'SCSI', rotationrate: null },
]

const TEMPS = { sda: 56, sdb: 38 }

const SYSTEM = {
  hostname: 'nas',
  version: '25.10.4',
  physmem: 16 * GIB,
  cores: 8,
  uptime_seconds: 3600,
  loadavg: [0.2, 0.2, 0.2],
}

const REPORTING = [
  { name: 'cpu', identifier: 'cpu', legend: ['time', 'cpu0'], data: [[1, 12], [2, 14]] },
  { name: 'memory', identifier: 'memory', legend: ['time', 'available'], data: [[1, 8 * GIB], [2, 8 * GIB]] },
  { name: 'cputemp', identifier: 'cputemp', legend: ['time', 'cpu0'], data: [[1, 0], [2, 0]] },
]

function fakeClient() {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'service.query') {
        if (params?.[1]?.get) {
          const filter = params[0][0]
          return SERVICES.find((row) => row[filter[0]] === filter[2]) || null
        }
        return SERVICES
      }
      if (method === 'service.control') return 301
      if (method === 'service.update') return { ...SERVICES[0], ...params[1] }
      if (method === 'certificate.query') {
        if (params?.[1]?.get) {
          const filter = params[0][0]
          return CERTIFICATES.find((row) => row[filter[0]] === filter[2]) || null
        }
        return CERTIFICATES
      }
      if (method === 'certificate.delete') return true
      if (method === 'certificate.acme_server_choices') {
        return { "Let's Encrypt": 'https://acme-v02.api.letsencrypt.org/directory' }
      }
      if (method === 'acme.dns.authenticator.query') return [{ id: 4, name: 'cloudflare', attributes: { authenticator: 'cloudflare' } }]
      if (method === 'disk.query') {
        if (params?.[1]?.get) {
          const filter = params[0][0]
          return DISKS.find((disk) => disk[filter[0]] === filter[2]) || null
        }
        const filter = params?.[0]?.[0]
        if (Array.isArray(filter) && filter[1] === 'in') {
          return DISKS.filter((disk) => filter[2].includes(disk.name))
        }
        return DISKS
      }
      if (method === 'disk.temperatures') {
        return Object.fromEntries(params[0].map((name) => [name, TEMPS[name] ?? null]))
      }
      if (method === 'disk.smart_test') return null
      if (method === 'disk.wipe') return 302
      if (method === 'system.info') return SYSTEM
      if (method === 'reporting.get_data') return REPORTING
      if (method === 'pool.query') return [{ name: 'tank', size: 1000, allocated: 250 }]
      if (method === 'app.query') return [{ name: 'forgejo', state: 'RUNNING' }]
      if (method === 'core.get_jobs') return []
      if (method === 'alert.list') return []
      return null
    },
    async waitJob(id) {
      calls.push({ method: 'waitJob', params: [id] })
      return { id, state: 'SUCCESS', result: true }
    },
  }
}

function build() {
  const client = fakeClient()
  const store = {
    config: () => ({ instances: [ENTRY], timeoutMs: 60000, jobTimeoutMs: 600000 }),
    instances: () => [ENTRY],
    getApiKey: async () => '1-testkey',
  }
  const ctx = { config: { jobTimeoutMs: 600000 }, store, pool: { get: () => client } }
  const tools = createTools(ctx)
  const byName = (name) => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `${name} is registered`)
    return tool
  }
  return { client, byName, tools }
}

function buildPanel() {
  const client = fakeClient()
  const store = { getApiKey: async () => '1-testkey' }
  const pool = { get: () => client }
  const config = { instances: [ENTRY], timeoutMs: 5000, jobTimeoutMs: 60000 }
  const panel = createPanel({ store, pool, getConfig: () => config })
  return { panel, client }
}

test('the service, certificate and disk tools are registered', () => {
  const { tools } = build()
  const names = tools.map((tool) => tool.name)
  for (const name of ['truenas_services', 'truenas_certificates', 'truenas_disks']) {
    assert.ok(names.includes(name), `${name} is registered`)
  }
})

test('truenas_services lists, starts and toggles boot flags', async () => {
  const { byName, client } = build()
  const tool = byName('truenas_services')

  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /2 of 3 services running/)

  const started = await tool.execute({ action: 'start', name: 'ssh' })
  assert.equal(started.ok, true)
  const control = client.calls.find((call) => call.method === 'service.control')
  assert.deepEqual(control.params.slice(0, 2), ['START', 'ssh'])
  assert.equal(control.params[2].silent, false)

  await tool.execute({ action: 'enable', name: 'nfs' })
  const update = client.calls.find((call) => call.method === 'service.update')
  assert.deepEqual(update.params, [3, { enable: true }])

  const missing = await tool.execute({ action: 'restart', name: 'nope' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /No service matches "nope"/)
})

test('truenas_certificates flags expiry and never returns PEM material', async () => {
  const { byName, client } = build()
  const tool = byName('truenas_certificates')

  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  const states = listed.data.certificates.map((cert) => [cert.name, cert.state])
  assert.deepEqual(states, [
    ['truenas_default', 'valid'],
    ['vpn-edge', 'valid'],
    ['old-acme', 'EXPIRED'],
  ])

  const one = await tool.execute({ action: 'get', id: 'truenas_default' })
  assert.equal(one.ok, true)
  assert.match(one.text, /truenas_default/)
  assert.equal(/BEGIN CERTIFICATE|PRIVATE KEY/.test(one.text), false)

  const refused = await tool.execute({ action: 'delete', id: 'truenas_default' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  const deleted = await tool.execute({ action: 'delete', id: 'truenas_default', confirm: true })
  assert.equal(deleted.ok, true)
  assert.ok(client.calls.some((call) => call.method === 'certificate.delete' && call.params[0] === 1))

  const servers = await tool.execute({ action: 'acme_servers' })
  assert.match(servers.text, /letsencrypt/)
  const authenticators = await tool.execute({ action: 'authenticators' })
  assert.match(authenticators.text, /cloudflare/)
})

test('truenas_disks merges temperatures, runs SMART tests and gates wipes', async () => {
  const { byName, client } = build()
  const tool = byName('truenas_disks')

  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.equal(listed.data.disks.length, 2)
  const sda = listed.data.disks.find((disk) => disk.name === 'sda')
  assert.equal(sda.celsius, '56 °C')
  assert.equal(sda.state, 'hot')
  const sdb = listed.data.disks.find((disk) => disk.name === 'sdb')
  assert.equal(sdb.state, 'ok')
  assert.equal(listed.data.warm, 1)

  const tested = await tool.execute({ action: 'smart_test', name: '/dev/sda', testType: 'long' })
  assert.equal(tested.ok, true)
  const smart = client.calls.find((call) => call.method === 'disk.smart_test')
  assert.deepEqual(smart.params, [['sda'], 'LONG'])

  const refused = await tool.execute({ action: 'wipe', name: 'sdb' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)

  const wiped = await tool.execute({ action: 'wipe', name: 'sdb', mode: 'FULL', confirm: true })
  assert.equal(wiped.ok, true)
  const wipe = client.calls.find((call) => call.method === 'disk.wipe')
  assert.deepEqual(wipe.params, ['sdb', 'FULL', true])
})

test('the panel overview carries services, certificates and disks', async () => {
  const { panel } = buildPanel()
  const state = await panel.overview()

  assert.equal(state.ok, true)
  assert.equal(state.services.length, 3)
  assert.equal(state.services.find((svc) => svc.name === 'smb').enabled, true)
  assert.equal(state.services.find((svc) => svc.name === 'ssh').running, false)

  assert.equal(state.certificates.length, 3)
  assert.equal(state.certificates.find((cert) => cert.name === 'old-acme').state, 'EXPIRED')
  assert.equal(state.expiring, 1)

  assert.equal(state.disks.length, 2)
  assert.equal(state.disks.find((disk) => disk.name === 'sda').state, 'hot')
})

test('the panel can control services, toggle boot flags and start SMART tests', async () => {
  const { panel, client } = buildPanel()

  const restarted = await panel.act({ action: 'service.control', instance: 'mock', name: 'smb', verb: 'restart' })
  assert.equal(restarted.ok, true)
  const control = client.calls.find((call) => call.method === 'service.control')
  assert.deepEqual(control.params.slice(0, 2), ['RESTART', 'smb'])

  const toggled = await panel.act({ action: 'service.enable', instance: 'mock', name: 'ssh', enabled: true })
  assert.equal(toggled.ok, true)
  const update = client.calls.find((call) => call.method === 'service.update')
  assert.deepEqual(update.params, [2, { enable: true }])

  const badVerb = await panel.act({ action: 'service.control', instance: 'mock', name: 'smb', verb: 'explode' })
  assert.equal(badVerb.ok, false)

  const smart = await panel.act({ action: 'smart.test', instance: 'mock', disk: 'sda', testType: 'short' })
  assert.equal(smart.ok, true)
  const test = client.calls.find((call) => call.method === 'disk.smart_test')
  assert.deepEqual(test.params, [['sda'], 'SHORT'])
})

test('the destructive table covers the destructive namespaces added this round', () => {
  for (const method of [
    'certificate.delete',
    'acme.dns.authenticator.delete',
    'pool.create',
    'pool.offline',
    'pool.replace',
    'pool.upgrade',
    'update.run',
    'directoryservices.leave',
    'catalog.delete',
    'boot.attach',
    'config.reset',
  ]) {
    assert.equal(classifyMethod(method).dangerous, true, `${method} is classified`)
  }
  assert.equal(classifyMethod('pool.query').dangerous, false)
  assert.equal(classifyMethod('service.query').dangerous, false)
  assert.ok(destructiveMethods().length >= 30)
})
