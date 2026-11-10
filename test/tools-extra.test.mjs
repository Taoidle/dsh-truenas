import assert from 'node:assert/strict'
import test from 'node:test'

import { createTools } from '../lib/tools.js'

const ENTRY = {
  name: 'mock',
  url: 'http://127.0.0.1:8734',
  username: 'root',
  apiPath: '/api/current',
  insecureTls: false,
  description: '',
  credential: 'TRUENAS_APIKEY_MOCK',
}

const INTERFACES = [
  {
    id: 'enp6s18',
    name: 'enp6s18',
    type: 'PHYSICAL',
    state: { link_state: 'LINK_STATE_UP', flags: ['UP', 'BROADCAST'] },
    aliases: [{ type: 'INET', address: '192.168.66.60', netmask: 20 }],
    ipv4_dhcp: false,
    mtu: 1500,
    description: '',
  },
]

const USERS = [
  { id: 1, uid: 0, username: 'root', full_name: 'root', builtin: true, smb: false, locked: false, shell: '/usr/sbin/nologin', home: '/root', group: { id: 1, bsdgrp_group: 'root' } },
  { id: 6, uid: 3000, username: 'truenas_admin', full_name: 'TrueNAS Admin', builtin: false, smb: true, locked: false, shell: '/usr/bin/bash', home: '/home/truenas_admin', group: { id: 4, bsdgrp_group: 'truenas_admin' } },
]

const GROUPS = [
  { id: 1, gid: 0, name: 'root', builtin: true, smb: false },
  { id: 4, gid: 3000, name: 'truenas_admin', builtin: false, smb: true },
  { id: 5, gid: 3001, name: 'media', builtin: false, smb: true },
]

const ALERTS = [
  { uuid: 'aa11', level: 'WARNING', source: 'ZFS', klass: 'ZpoolCapacityNotice', text: 'Pool tank is 82% full', datetime: '2026-11-10T10:00:00Z', dismissed: false },
]

function build() {
  const calls = []
  const client = {
    displayUrl: 'http://127.0.0.1:8734',
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'interface.query') return INTERFACES
      if (method === 'interface.get_instance') return INTERFACES.find((entry) => entry.id === params[0]) || null
      if (method === 'interface.update') return { ...INTERFACES[0], ...params[1] }
      if (method === 'staticroute.query') return [{ id: 2, destination: '10.0.0.0/8', gateway: '192.168.66.1', description: '' }]
      if (method === 'staticroute.create') return { id: 3, ...params[0] }
      if (method === 'staticroute.delete') return true
      if (method === 'network.configuration.config') {
        return { hostname: 'truenas', domain: '', ipv4gateway: '192.168.66.11', nameserver1: '192.168.66.11', nameserver2: '', nameserver3: '', httpproxy: '' }
      }
      if (method === 'network.configuration.update') return { ...params[0] }
      if (method === 'user.query') {
        if (params?.[1]?.get) {
          const filter = params[0][0]
          return USERS.find((user) => user[filter[0]] === filter[2]) || null
        }
        return USERS
      }
      if (method === 'user.create') return { id: 9, uid: 3002, ...params[0], password: undefined }
      if (method === 'user.update') return { ...USERS[1], ...params[1] }
      if (method === 'user.delete') return true
      if (method === 'group.query') {
        if (params?.[1]?.get) {
          const filter = params[0][0]
          return GROUPS.find((group) => group[filter[0]] === filter[2]) || null
        }
        return GROUPS
      }
      if (method === 'group.create') return { id: 11, gid: 3002, ...params[0] }
      if (method === 'group.delete') return true
      if (method === 'filesystem.getacl') {
        return {
          path: params[0],
          acltype: 'POSIX1E',
          uid: 3000,
          gid: 3000,
          acl: [
            { tag: 'owner@', id: -1, perms: { basic: 'full_control' }, flags: { basic: 'inherit' } },
            { tag: 'group@', id: -1, perms: { basic: 'modify' }, flags: { basic: 'inherit' } },
          ],
        }
      }
      if (method === 'filesystem.setacl') return null
      if (method === 'replication.query') {
        if (params?.[1]?.get) return { id: 1, name: 'nightly', direction: 'PUSH', source_datasets: ['tank/media'], target_dataset: 'backup/media', enabled: true, state: { state: 'FINISHED' }, last_run: { end_time: '2026-11-10T02:00:00Z', duration: 120 } }
        return [{ id: 1, name: 'nightly', direction: 'PUSH', transport: 'SSH', source_datasets: ['tank/media'], target_dataset: 'backup/media', enabled: true, state: { state: 'FINISHED' }, last_run: { end_time: '2026-11-10T02:00:00Z', duration: 120 } }]
      }
      if (method === 'replication.run') return 77
      if (method === 'replication.delete') return true
      if (method === 'cloudsync.query') {
        if (params?.[1]?.get) return null
        return [{ id: 3, description: 'photos to b2', path: '/mnt/tank/photos', direction: 'PUSH', transfer_mode: 'SYNC', enabled: true, credentials: { provider: { type: 'B2' } }, last_run: { state: 'SUCCESS', end_time: '2026-11-09T21:00:00Z' } }]
      }
      if (method === 'cloudsync.sync') return 78
      if (method === 'cloud_backup.query') return []
      if (method === 'alert.list') return ALERTS
      if (method === 'alert.dismiss') return true
      if (method === 'alertservice.query') {
        if (params?.[1]?.get) return null
        return [{ id: 1, name: 'ops mail', attributes: { type: 'Mail' }, level: 'WARNING', enabled: true }]
      }
      if (method === 'alertservice.create') return { id: 5, ...params[0] }
      if (method === 'alertservice.update') return { id: params[0], ...params[1] }
      if (method === 'alertservice.delete') return true
      if (method === 'alertservice.test') return null
      if (method === 'mail.config') return { fromemail: 'nas@example.com', fromname: 'truenas', outgoingserver: 'smtp.example.com', port: 587, security: 'TLS', user: 'nas', pass: '********' }
      if (method === 'mail.update') return { ...params[0] }
      return null
    },
    async waitJob(id) {
      calls.push({ method: 'waitJob', params: [id] })
      return { id, state: 'SUCCESS', result: null }
    },
  }
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
  return { calls, byName, tools }
}

test('all curated tools are registered, including the new network, users, replication, cloud and alert tools', () => {
  const { tools } = build()
  const names = tools.map((tool) => tool.name)
  for (const name of [
    'truenas_instances',
    'truenas_system',
    'truenas_storage',
    'truenas_snapshots',
    'truenas_shares',
    'truenas_apps',
    'truenas_jobs',
    'truenas_call',
    'truenas_network',
    'truenas_users',
    'truenas_replication',
    'truenas_cloud',
    'truenas_alerts',
  ]) {
    assert.ok(names.includes(name), `${name} is registered`)
  }
})

test('truenas_call refuses a destructive method without confirmation', async () => {
  const { byName, calls } = build()
  const call = byName('truenas_call')
  const refused = await call.execute({ method: 'system.reboot' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  assert.match(refused.error, /reboot the system/)
  assert.equal(calls.some((entry) => entry.method === 'system.reboot'), false)

  const allowed = await call.execute({ method: 'system.reboot', confirm: true })
  assert.equal(allowed.ok, true)
  assert.ok(calls.some((entry) => entry.method === 'system.reboot'))
})

test('truenas_call refuses a batched destructive core.bulk call too', async () => {
  const { byName } = build()
  const call = byName('truenas_call')
  const refused = await call.execute({ method: 'core.bulk', params: ['pool.dataset.delete', [['tank/data', {}]]] })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
})

test('network interfaces show link state and addresses', async () => {
  const { byName } = build()
  const result = await byName('truenas_network').execute({ action: 'interfaces' })
  assert.equal(result.ok, true)
  assert.match(result.text, /enp6s18/)
  assert.match(result.text, /192\.168\.66\.60\/20/)
  assert.match(result.text, /up/)
})

test('interface_update converts CIDR addresses and rejects malformed ones', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_network')
  const result = await tool.execute({ action: 'interface_update', interface: 'enp6s18', addresses: ['192.168.66.61/20'] })
  assert.equal(result.ok, true)
  const sent = calls.find((entry) => entry.method === 'interface.update')
  assert.deepEqual(sent.params[1].aliases, [{ type: 'INET', address: '192.168.66.61', netmask: 20 }])

  const bad = await tool.execute({ action: 'interface_update', interface: 'enp6s18', addresses: ['192.168.66.61'] })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /CIDR/)
})

test('dns_update maps nameservers onto nameserver1..3 and caps the list at three', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_network')
  const result = await tool.execute({ action: 'dns_update', nameservers: ['1.1.1.1', '8.8.8.8'] })
  assert.equal(result.ok, true)
  const sent = calls.find((entry) => entry.method === 'network.configuration.update')
  assert.deepEqual(sent.params[0], { nameserver1: '1.1.1.1', nameserver2: '8.8.8.8', nameserver3: '' })

  const tooMany = await tool.execute({ action: 'dns_update', nameservers: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1'] })
  assert.equal(tooMany.ok, false)
})

test('route_remove needs confirmation, route_add does not', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_network')
  const refused = await tool.execute({ action: 'route_remove', route: 2 })
  assert.equal(refused.ok, false)
  assert.equal(calls.some((entry) => entry.method === 'staticroute.delete'), false)

  const added = await tool.execute({ action: 'route_add', destination: '10.0.0.0/8', gateway: '192.168.66.1' })
  assert.equal(added.ok, true)
})

test('user listing resolves the nested primary group name', async () => {
  const { byName } = build()
  const result = await byName('truenas_users').execute({ action: 'list' })
  assert.equal(result.ok, true)
  assert.match(result.text, /truenas_admin/)
  assert.match(result.text, /TrueNAS Admin/)
})

test('user creation resolves a group name to its id and never echoes the password', async () => {
  const { byName, calls } = build()
  const result = await byName('truenas_users').execute({
    action: 'create',
    username: 'alice',
    fullName: 'Alice Example',
    password: 'secret123',
    group: 'media',
  })
  assert.equal(result.ok, true)
  const sent = calls.find((entry) => entry.method === 'user.create')
  assert.equal(sent.params[0].group, 5)
  assert.equal(sent.params[0].password, 'secret123')
  assert.equal(result.text.includes('secret123'), false)
})

test('deleting a system account or group is refused even with confirmation', async () => {
  const { byName } = build()
  const users = byName('truenas_users')
  const user = await users.execute({ action: 'delete', user: 'root', confirm: true })
  assert.equal(user.ok, false)
  assert.match(user.error, /system account/)

  const group = await users.execute({ action: 'group_remove', name: 'root', confirm: true })
  assert.equal(group.ok, false)
  assert.match(group.error, /system group/)
})

test('acl_set requires confirmation and a complete payload', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_users')
  const refused = await tool.execute({ action: 'acl_set', path: '/mnt/tank/media' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)

  const missingAcl = await tool.execute({ action: 'acl_set', path: '/mnt/tank/media', confirm: true })
  assert.equal(missingAcl.ok, false)
  assert.match(missingAcl.error, /acl entries/)

  const applied = await tool.execute({
    action: 'acl_set',
    confirm: true,
    acl: { path: '/mnt/tank/media', acl: [{ tag: 'owner@', id: -1, perms: { basic: 'full_control' } }] },
  })
  assert.equal(applied.ok, true)
  const sent = calls.find((entry) => entry.method === 'filesystem.setacl')
  assert.equal(sent.params[0].acltype, 'POSIX1E')
})

test('replication list renders the last run and run waits for the job', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_replication')
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /nightly/)
  assert.match(listed.text, /ago|2026/)

  const refused = await tool.execute({ action: 'run', name: 'nightly' })
  assert.equal(refused.ok, false)

  const started = await tool.execute({ action: 'run', name: 'nightly', confirm: true })
  assert.equal(started.ok, true)
  assert.ok(calls.some((entry) => entry.method === 'replication.run' && entry.params[0] === 1))
  assert.ok(calls.some((entry) => entry.method === 'waitJob' && entry.params[0] === 77))
})

test('cloud sync listing shows direction and provider, delete needs confirmation', async () => {
  const { byName } = build()
  const tool = byName('truenas_cloud')
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /photos to b2/)
  assert.match(listed.text, /B2/)
  assert.match(listed.text, /PUSH/)

  const refused = await tool.execute({ action: 'delete', name: 'photos to b2' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /without confirmation/)
})

test('alerts list open alerts and service_add requires a provider type', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_alerts')
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /82% full/)
  assert.match(listed.text, /aa11/)

  const missingType = await tool.execute({ action: 'service_add', name: 'ops' })
  assert.equal(missingType.ok, false)
  assert.match(missingType.error, /"type"/)

  const added = await tool.execute({ action: 'service_add', name: 'ops', attributes: { type: 'Slack', url: 'https://hooks.example' } })
  assert.equal(added.ok, true)
  assert.ok(calls.some((entry) => entry.method === 'alertservice.create'))
})

test('mail_update sends the password to the NAS but does not echo it', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_alerts')
  const result = await tool.execute({ action: 'mail_update', smtpPassword: 'hunter2', smtpServer: 'smtp.example.com' })
  assert.equal(result.ok, true)
  const sent = calls.find((entry) => entry.method === 'mail.update')
  assert.equal(sent.params[0].pass, 'hunter2')
  assert.equal(JSON.stringify(result).includes('hunter2'), false)
})
