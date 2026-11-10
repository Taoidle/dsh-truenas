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

function build() {
  const calls = []
  const client = {
    displayUrl: 'http://127.0.0.1:8734',
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'cronjob.query') {
        if (params?.[1]?.get) return { id: 4, description: 'zfs snapshot cleanup', command: '/usr/bin/find /mnt/tank/.zfs/snapshot -mtime +30 -delete', user: 'root', enabled: true, stdout: true, stderr: false, schedule: { minute: '30', hour: '3', dom: '*', month: '*', dow: '*' } }
        return [
          { id: 4, description: 'zfs snapshot cleanup', command: '/usr/bin/find /mnt/tank/.zfs/snapshot -mtime +30 -delete', user: 'root', enabled: true, stdout: true, stderr: false, schedule: { minute: '30', hour: '3', dom: '*', month: '*', dow: '*' } },
        ]
      }
      if (method === 'cronjob.create') return { id: 7, ...params[0] }
      if (method === 'cronjob.update') return { id: params[0], ...params[1] }
      if (method === 'cronjob.delete') return true
      if (method === 'cronjob.run') return 91
      if (method === 'rsynctask.query') {
        if (params?.[1]?.get) return { id: 2, path: '/mnt/tank/photos', user: 'root', mode: 'MODULE', remotehost: 'backup.lan', remotemodule: 'photos', remotepath: '', direction: 'PUSH', desc: 'photos', enabled: true }
        return [{ id: 2, path: '/mnt/tank/photos', user: 'root', mode: 'MODULE', remotehost: 'backup.lan', remotemodule: 'photos', direction: 'PUSH', desc: 'photos', enabled: true }]
      }
      if (method === 'rsynctask.create') return { id: 3, ...params[0] }
      if (method === 'rsynctask.delete') return true
      if (method === 'rsynctask.run') return 92
      if (method === 'reporting.netdata_graphs') return [{ name: 'cpu', title: 'CPU usage' }, { name: 'interface', identifier: 'enp6s18', title: 'Interface' }]
      if (method === 'reporting.get_data') {
        return [
          {
            name: params[0][0].name,
            identifier: params[0][0].identifier || null,
            data: [
              [1762740000, 10.0],
              [1762743600, 14.69],
            ],
          },
        ]
      }
      if (method === 'reporting.config') return { id: 1, tier: 1, graph_age: 12, graph_points: 1200 }
      if (method === 'reporting.exporters.query') return [{ id: 1, name: 'prom', enabled: true, type: 'PROMETHEUS' }]
      if (method === 'docker.status') return { status: 'RUNNING', description: 'Apps service is running.' }
      if (method === 'docker.config') return { pool: 'app', address_pools: [{ base: '172.20.0.0/12', size: 16 }] }
      if (method === 'docker.network.query') return [{ id: 'net1', name: 'truenas_default', driver: 'bridge', scope: 'local' }]
      if (method === 'docker.nvidia_present') return false
      if (method === 'docker.list_backups') return [{ name: 'app-backup-2026-11-10', created_at: '2026-11-10T01:00:00Z', path: '/mnt/app/.backup' }]
      if (method === 'docker.backup_to_pool') return 93
      if (method === 'docker.restore_backup') return 94
      if (method === 'boot.environment.query') {
        return [
          { id: '26.04', name: '26.04-STABLE', active: true, activated: true, created: '2026-10-01T00:00:00Z', keep: false },
          { id: '25.10', name: '25.10-STABLE', active: false, activated: false, created: '2026-08-01T00:00:00Z', keep: true },
        ]
      }
      if (method === 'boot.environment.activate') return null
      if (method === 'update.status') return { status: 'AVAILABLE', current_version: '25.10.0', available_version: '26.04-BETA.1' }
      if (method === 'update.available_versions') return ['26.04-BETA.1', '25.10.4']
      if (method === 'systemdataset.config') return { pool: 'app', pool_set: true, name: 'sysdata' }
      if (method === 'ssh.config') return { tcpport: 22, passwordauth: false, rootlogin: false, pubkeyauth: true, tcpfwd: false, enabled: true, adminlogin_group: ['truenas_admin'] }
      if (method === 'support.config') return { enabled: false, name: '', email: '', secondary_email: '', phone: '', type: { pro_active: false } }
      if (method === 'support.is_available') return true
      if (method === 'tunable.query') return [{ id: 3, type: 'SYSCTL', var: 'net.ipv4.ip_forward', value: '1', enabled: true, comment: 'routing' }]
      if (method === 'app.query') return { name: 'plex', state: 'RUNNING', human_version: '1.40.2_1.0.0' }
      if (method === 'app.upgrade') return 95
      if (method === 'app.rollback') return 96
      if (method === 'app.pull_images') return 97
      if (method === 'app.update') return 98
      if (method === 'app.image.query') return [{ id: 'sha256:a', repository: 'plexinc/pms-docker', tag: '1.40', size: 734003200 }]
      if (method === 'app.outdated_docker_images') return { plexinc_pms_docker: ['1.40', '1.41'] }
      if (method === 'privilege.query') {
        if (params?.[1]?.get) return { id: 1, name: 'Full Admin', roles: ['FULL_ADMIN'], web_shell: true, local_groups: [4] }
        return [{ id: 1, name: 'Full Admin', roles: ['FULL_ADMIN'], web_shell: true, local_groups: [4] }]
      }
      if (method === 'privilege.roles') return { FULL_ADMIN: 'Full administrator', READONLY_ADMIN: 'Read-only administrator' }
      if (method === 'privilege.create') return { id: 9, ...params[0] }
      if (method === 'privilege.update') return { id: params[0], ...params[1] }
      if (method === 'privilege.delete') return true
      if (method === 'api_key.query') return [{ id: 2, name: 'ci', username: 'truenas_admin', created_at: '2026-11-01T00:00:00Z', expires_at: null }]
      if (method === 'api_key.create') return { id: 5, name: params[0].name, username: params[0].username, key: '1-secretkeymaterial' }
      if (method === 'api_key.delete') return true
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

test('tasks: cron list shows the schedule and creation validates the schedule', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_tasks')
  const listed = await tool.execute({ action: 'cron_list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /30 3 \* \* \*/)

  const missingSchedule = await tool.execute({ action: 'cron_add', command: 'echo hi' })
  assert.equal(missingSchedule.ok, false)
  assert.match(missingSchedule.error, /schedule/)

  const added = await tool.execute({
    action: 'cron_add',
    command: 'echo hi',
    schedule: { minute: '0', hour: '4' },
    user: 'root',
  })
  assert.equal(added.ok, true)
  const sent = calls.find((entry) => entry.method === 'cronjob.create')
  assert.deepEqual(sent.params[0].schedule, { minute: '0', hour: '4' })
  assert.equal(sent.params[0].user, 'root')
})

test('tasks: cron_run refuses without confirmation and waits for the job when confirmed', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_tasks')
  const refused = await tool.execute({ action: 'cron_run', id: 4 })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)

  const started = await tool.execute({ action: 'cron_run', id: 4, confirm: true })
  assert.equal(started.ok, true)
  assert.ok(calls.some((entry) => entry.method === 'cronjob.run' && entry.params[0] === 4))
  assert.ok(calls.some((entry) => entry.method === 'waitJob' && entry.params[0] === 91))
})

test('tasks: rsync creation needs the transport-specific field', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_tasks')
  const bad = await tool.execute({ action: 'rsync_add', path: '/mnt/tank/photos', mode: 'SSH', remoteModule: 'photos' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /remoteHost/)

  const added = await tool.execute({
    action: 'rsync_add',
    path: '/mnt/tank/photos',
    mode: 'MODULE',
    remoteHost: 'backup.lan',
    remoteModule: 'photos',
    direction: 'PUSH',
  })
  assert.equal(added.ok, true)
  const sent = calls.find((entry) => entry.method === 'rsynctask.create')
  assert.equal(sent.params[0].remotehost, 'backup.lan')
  assert.equal(sent.params[0].remotemodule, 'photos')
})

test('reporting: data summarises the latest aggregated bucket', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_reporting')
  const result = await tool.execute({ action: 'data', graph: 'cpu', unit: 'HOUR' })
  assert.equal(result.ok, true)
  assert.match(result.text, /12\.35/)
  const sent = calls.find((entry) => entry.method === 'reporting.get_data')
  assert.equal(sent.params[1].unit, 'HOUR')
})

test('reporting: graphs and exporters render tables', async () => {
  const { byName } = build()
  const tool = byName('truenas_reporting')
  const graphs = await tool.execute({ action: 'graphs' })
  assert.equal(graphs.ok, true)
  assert.match(graphs.text, /enp6s18/)
  const exporters = await tool.execute({ action: 'exporters' })
  assert.equal(exporters.ok, true)
  assert.match(exporters.text, /PROMETHEUS/)
})

test('docker: status and networks', async () => {
  const { byName } = build()
  const tool = byName('truenas_docker')
  const status = await tool.execute({ action: 'status' })
  assert.equal(status.ok, true)
  assert.match(status.text, /RUNNING/)
  const networks = await tool.execute({ action: 'networks' })
  assert.equal(networks.ok, true)
  assert.match(networks.text, /truenas_default/)
})

test('docker: restore needs a confirmation and a backup name', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_docker')
  const refused = await tool.execute({ action: 'restore', name: 'app-backup-2026-11-10' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)

  const noName = await tool.execute({ action: 'restore', confirm: true })
  assert.equal(noName.ok, false)

  const restored = await tool.execute({ action: 'restore', name: 'app-backup-2026-11-10', confirm: true })
  assert.equal(restored.ok, true)
  assert.ok(calls.some((entry) => entry.method === 'docker.restore_backup'))
})

test('system: boot environments and guarded activation', async () => {
  const { byName } = build()
  const tool = byName('truenas_system')
  const envs = await tool.execute({ action: 'boot_envs' })
  assert.equal(envs.ok, true)
  assert.match(envs.text, /26\.04-STABLE/)

  const refused = await tool.execute({ action: 'boot_activate', bootEnv: '25.10-STABLE' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
})

test('system: ssh config, update status and tunables', async () => {
  const { byName } = build()
  const tool = byName('truenas_system')
  const ssh = await tool.execute({ action: 'ssh_config' })
  assert.equal(ssh.ok, true)
  assert.match(ssh.text, /Port: 22/)
  assert.match(ssh.text, /Password login: disabled/)

  const update = await tool.execute({ action: 'update_status' })
  assert.equal(update.ok, true)
  assert.match(update.text, /AVAILABLE/)

  const tunables = await tool.execute({ action: 'tunables' })
  assert.equal(tunables.ok, true)
  assert.match(tunables.text, /ip_forward/)
})

test('apps: upgrade waits for the job and reports the new version', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_apps')
  const result = await tool.execute({ action: 'upgrade', app: 'plex', appVersion: '1.41' })
  assert.equal(result.ok, true)
  const sent = calls.find((entry) => entry.method === 'app.upgrade')
  assert.deepEqual(sent.params, ['plex', { app_version: '1.41', snapshot_hostpaths: false }])
  assert.ok(calls.some((entry) => entry.method === 'waitJob' && entry.params[0] === 95))
})

test('apps: rollback requires a version and confirmation', async () => {
  const { byName } = build()
  const tool = byName('truenas_apps')
  const noVersion = await tool.execute({ action: 'rollback', app: 'plex' })
  assert.equal(noVersion.ok, false)
  assert.match(noVersion.error, /appVersion/)

  const refused = await tool.execute({ action: 'rollback', app: 'plex', appVersion: '1.40' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
})

test('apps: image inventory renders repository, tag and size', async () => {
  const { byName } = build()
  const result = await byName('truenas_apps').execute({ action: 'images' })
  assert.equal(result.ok, true)
  assert.match(result.text, /plexinc\/pms-docker/)
  assert.match(result.text, /700 MiB|734/)
})

test('users: privileges and API keys', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_users')
  const privileges = await tool.execute({ action: 'privileges' })
  assert.equal(privileges.ok, true)
  assert.match(privileges.text, /Full Admin/)

  const roles = await tool.execute({ action: 'privilege_roles' })
  assert.equal(roles.ok, true)
  assert.match(roles.text, /READONLY_ADMIN/)

  const keys = await tool.execute({ action: 'api_keys' })
  assert.equal(keys.ok, true)
  assert.match(keys.text, /truenas_admin/)

  const added = await tool.execute({ action: 'api_key_add', apiKeyName: 'backup', apiKeyUser: 'truenas_admin' })
  assert.equal(added.ok, true)
  assert.match(added.text, /1-secretkeymaterial/)
  assert.ok(calls.some((entry) => entry.method === 'api_key.create'))

  const refused = await tool.execute({ action: 'api_key_remove', keyId: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
})
