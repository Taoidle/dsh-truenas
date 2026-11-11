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

const VM = { id: 3, name: 'win11', state: 'RUNNING', vcpus: 4, cores: 2, memory: 8589934592, autostart: true }

function build() {
  const calls = []
  const client = {
    displayUrl: 'http://127.0.0.1:8734',
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'vm.query') {
        if (params?.[1]?.get) return VM
        return [VM, { ...VM, id: 4, name: 'ubuntu', state: 'STOPPED' }]
      }
      if (method === 'vm.clone') return 55
      if (method === 'vm.delete') return 56
      if (method.startsWith('vm.')) return 57
      if (method.endsWith('.query')) {
        if (method === 'disk.query') {
          if (params?.[1]?.get) return { id: 1, name: 'sda', model: 'QEMU', serial: 'x', size: 107374182400, type: 'SSD', bus: 'SCSI', rotationrate: null, description: '', hddstandby: 'ALWAYS ON', advpowermgmt: 'DISABLED' }
          return [{ name: 'sda', model: 'QEMU', size: 107374182400, type: 'SSD', bus: 'SCSI', rotationrate: null }, { name: 'sdb', model: 'QEMU', size: 107374182400, type: 'SSD', bus: 'SCSI', rotationrate: null }]
        }
        if (method === 'iscsi.target.query') return [{ id: 1, name: 'iqn.2005-10.org.freenas.ctl:tank', alias: 'tank', mode: 'ISCSI', groups: [{ portal: 1, initiator: 1 }] }]
        if (method === 'iscsi.extent.query') return [{ id: 2, name: 'extent-tank', type: 'DISK', disk: 'zvol/tank/iscsi', enabled: true }]
        if (method === 'iscsi.portal.query') return [{ id: 1, comment: 'portal', listen: [{ ip: '0.0.0.0', port: 3260 }] }]
        if (method === 'iscsi.initiator.query') return [{ id: 1, comment: 'igroup', initiators: [{ initiator: 'iqn.1991-05.com.microsoft:win' }] }]
        if (method === 'nvmet.subsys.query') return [{ id: 1, name: 'subsys', subnqn: 'nqn.2011-06.com.truenas:subsys', allow_any_host: true }]
        if (method === 'nvmet.host.query') return [{ id: 1, hostnqn: 'nqn.host', dhchap_key: 'secret' }]
        if (method === 'nvmet.namespace.query') return [{ id: 1, subsys: { id: 1, name: 'subsys' }, device_path: '/dev/zvol/tank/nvme', enabled: true, nsid: 1 }]
        if (method === 'nvmet.port.query') return [{ id: 1, addr_trtype: 'TCP', addr_traddr: '0.0.0.0', addr_trsvcid: '4420', addr_adrfam: 'ipv4' }]
        if (method === 'pool.query') return [{ id: 1, name: 'tank', status: 'ONLINE', healthy: true, size: 100, allocated: 10, free: 90 }]
        if (method === 'service.query') return [{ id: 1, service: 'ssh', state: 'RUNNING', enable: true }]
        if (method === 'system.ntpserver.query') return [{ id: 1, address: 'pool.ntp.org', prefer: true, minpoll: 6, maxpoll: 10 }]
        if (method === 'cloudsync.credentials.query') return [{ id: 9, name: 'b2', provider: { type: 'B2' } }]
        return []
      }
      if (method === 'iscsi.global.sessions') return [{ initiator: 'iqn.1991-05.com.microsoft:win', target: 'iqn.2005-10.org.freenas.ctl:tank', cid: 1, tsih: 1, user: 'root' }]
      if (method === 'nvmet.global.sessions') return [{ host_nqn: 'nqn.host', subsys_nqn: 'nqn.2011-06.com.truenas:subsys', trtype: 'tcp', traddr: '192.168.1.2' }]
      if (method === 'filesystem.listdir') {
        return [
          { name: '.hidden', type: 'FILE', size: 10 },
          { name: 'media', type: 'DIRECTORY', size: 3 },
        ]
      }
      if (method === 'filesystem.stat') return { type: 'DIRECTORY', size: 4096, mode: 16877, uid: 0, gid: 0, acl: false, mtime: 1700000000 }
      if (method === 'filesystem.statfs') return { fstype: 'zfs', blocks: 100, bfree: 40, frsize: 1024, type_name: 'ZFS' }
      if (method === 'filesystem.mkdir') return { path: params[0].path }
      if (method === 'disk.temperatures') return { sda: 38, sdb: null }
      if (method === 'disk.temperature_agg') return { sda: { min: 30, max: 44, avg: 37 } }
      if (method === 'pool.create') return 61
      if (method === 'pool.export') return null
      if (method === 'pool.import_find') return [{ name: 'tank', guid: '123', status: 'ONLINE', disks: ['sda'] }]
      if (method === 'pool.import_pool') return true
      if (method === 'pool.upgrade') return true
      if (method === 'pool.snapshot.hold' || method === 'pool.snapshot.release') return null
      if (method === 'system.general.config') {
        return {
          id: 1,
          hostname: 'nas',
          domain: 'lan',
          timezone: 'Asia/Shanghai',
          ui_certificate: {
            id: 1,
            name: 'truenas_default',
            certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
            privatekey: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
          },
        }
      }
      if (method === 'system.advanced.config') return { id: 1, autotune: false, consolemenu: false }
      if (method === 'system.general.update' || method === 'system.advanced.update') return { id: 1, ...params[0] }
      if (method === 'system.ntpserver.create') return { id: 2, ...params[0] }
      if (method === 'system.ntpserver.update') return { id: params[0], ...params[1] }
      if (method === 'system.ntpserver.delete') return true
      if (method === 'boot.environment.clone') return true
      if (method === 'boot.environment.keep') return true
      if (method === 'boot.environment.destroy') return true
      if (method === 'boot.scrub') return true
      if (method === 'update.run') return 62
      if (method === 'interface.create') return { id: 'br0', name: 'br0', type: 'BRIDGE', bridge_members: ['enp6s18'], state: { link_state: 'LINK_STATE_UP', aliases: [] }, aliases: [], ipv4_dhcp: false, mtu: 1500 }
      if (method === 'interface.has_pending_changes') return true
      if (method === 'interface.commit') return 63
      if (method === 'interface.rollback') return true
      if (method === 'interface.delete') return true
      if (method === 'cloudsync.credentials.create') return { id: 10, ...params[0] }
      if (method === 'cloudsync.credentials.update') return { id: params[0], ...params[1] }
      if (method === 'cloudsync.credentials.delete') return true
      if (method === 'reporting.exporters.create') return { id: 11, ...params[0] }
      if (method === 'reporting.exporters.update') return { id: params[0], ...params[1] }
      if (method === 'reporting.exporters.delete') return true
      if (method === 'replication.config.config') return { max_parallel_replication_tasks: 2 }
      if (method === 'replication.config.update') return { max_parallel_replication_tasks: 3 }
      if (method === 'user.set_password') return true
      if (method === 'user.shell_choices') return { '/usr/bin/sh': 'sh', '/usr/bin/zsh': 'zsh' }
      if (method === 'disk.update') return { id: params[0], ...params[1] }
      if (method === 'alertclasses.config') return { classes: { ZFS: 'WARNING' } }
      if (method === 'alertclasses.update') return { classes: params[0].classes }
      if (method === 'app.rollback_versions') return ['1.0.2', '1.0.1']
      if (method === 'app.convert_to_custom') return true
      if (method === 'iscsi.target.delete' || method === 'iscsi.extent.delete') return true
      if (method === 'nvmet.subsys.delete') return true
      return true
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

test('vms: list, start waits the job, delete needs confirmation', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_vms')
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.match(listed.text, /win11/)
  assert.match(listed.text, /RUNNING/)

  const started = await tool.execute({ action: 'start', id: 'ubuntu' })
  assert.equal(started.ok, true)
  assert.ok(calls.some((call) => call.method === 'waitJob'))

  const refused = await tool.execute({ action: 'delete', id: 'ubuntu' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  assert.ok(!calls.some((call) => call.method === 'vm.delete'))

  const deleted = await tool.execute({ action: 'delete', id: 'ubuntu', confirm: true })
  assert.equal(deleted.ok, true)
  const sent = calls.find((call) => call.method === 'vm.delete')
  assert.deepEqual(sent.params, [3, { zvols: true }])
})

test('iscsi: overview counts objects and deletes are guarded', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_iscsi')
  const overview = await tool.execute({ action: 'overview' })
  assert.equal(overview.ok, true)
  assert.match(overview.text, /Targets: 1/)
  assert.match(overview.text, /Sessions: 1/)

  const sessions = await tool.execute({ action: 'sessions' })
  assert.match(sessions.text, /iqn\.1991-05\.com\.microsoft:win/)

  const refused = await tool.execute({ action: 'target_delete', id: 1 })
  assert.equal(refused.ok, false)
  assert.ok(!calls.some((call) => call.method === 'iscsi.target.delete'))

  const removed = await tool.execute({ action: 'target_delete', id: 1, confirm: true })
  assert.equal(removed.ok, true)
  assert.ok(calls.some((call) => call.method === 'iscsi.target.delete'))
})

test('nvmet: overview summarises subsystems and deletion is guarded', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_nvmet')
  const overview = await tool.execute({ action: 'overview' })
  assert.equal(overview.ok, true)
  assert.match(overview.text, /Subsystems: 1/)
  assert.match(overview.text, /nqn\.2011-06\.com\.truenas:subsys/)

  const refused = await tool.execute({ action: 'subsystem_delete', id: 1 })
  assert.equal(refused.ok, false)
  assert.ok(!calls.some((call) => call.method === 'nvmet.subsys.delete'))
})

test('files: listdir hides dotfiles, stat and statfs format sizes', async () => {
  const { byName } = build()
  const tool = byName('truenas_files')
  const listed = await tool.execute({ action: 'listdir', path: '/mnt/tank' })
  assert.equal(listed.ok, true)
  assert.ok(!listed.text.includes('.hidden'))
  assert.match(listed.text, /media/)

  const withHidden = await tool.execute({ action: 'listdir', path: '/mnt/tank', all: true })
  assert.match(withHidden.text, /\.hidden/)

  const stat = await tool.execute({ action: 'stat', path: '/mnt/tank' })
  assert.match(stat.text, /DIRECTORY/)

  const statfs = await tool.execute({ action: 'statfs', path: '/mnt/tank' })
  assert.match(statfs.text, /zfs/)

  const relative = await tool.execute({ action: 'stat', path: 'mnt/tank' })
  assert.equal(relative.ok, false)
})

test('storage: pool lifecycle is guarded and import uses the guid', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_storage')

  const refused = await tool.execute({ action: 'pool_create', pool: 'tank', disks: ['sda'] })
  assert.equal(refused.ok, false)
  assert.ok(!calls.some((call) => call.method === 'pool.create'))

  const created = await tool.execute({ action: 'pool_create', pool: 'tank', disks: ['sda', 'sdb'], raidType: 'MIRROR', confirm: true })
  assert.equal(created.ok, true)
  const sent = calls.find((call) => call.method === 'pool.create')
  assert.deepEqual(sent.params[0].topology.data[0], { type: 'MIRROR', disks: ['sda', 'sdb'] })

  const found = await tool.execute({ action: 'pool_import_find' })
  assert.match(found.text, /GUID/)

  const imported = await tool.execute({ action: 'pool_import', guid: '123' })
  assert.equal(imported.ok, true)
  assert.ok(calls.some((call) => call.method === 'pool.import_pool'))

  const held = await tool.execute({ action: 'snapshot_hold', snapshotId: 'tank/media@daily' })
  assert.equal(held.ok, true)
})

test('system: general/advanced reads, ntp CRUD, boot clone and update guard', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_system')

  const general = await tool.execute({ action: 'general' })
  assert.match(general.text, /hostname/)
  assert.match(general.text, /nas/)

  const updated = await tool.execute({ action: 'general_update', general: { hostname: 'nas2' } })
  assert.equal(updated.ok, true)
  assert.deepEqual(calls.find((call) => call.method === 'system.general.update').params, [{ hostname: 'nas2' }])

  const ntp = await tool.execute({ action: 'ntp' })
  assert.match(ntp.text, /pool\.ntp\.org/)
  const added = await tool.execute({ action: 'ntp_add', ntp: { address: 'time.cloudflare.com' } })
  assert.equal(added.ok, true)
  const removed = await tool.execute({ action: 'ntp_remove', ntpId: 1 })
  assert.equal(removed.ok, true)

  const cloned = await tool.execute({ action: 'boot_clone', bootEnv: 'default', newBootEnv: 'before-update' })
  assert.equal(cloned.ok, true)
  assert.deepEqual(calls.find((call) => call.method === 'boot.environment.clone').params, [{ id: 'default', target: 'before-update' }])

  const refused = await tool.execute({ action: 'update_run' })
  assert.equal(refused.ok, false)
})

test('network: bridge creation builds members and commit explains the check-in', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_network')
  const added = await tool.execute({ action: 'interface_add', interface: 'br0', members: ['enp6s18'] })
  assert.equal(added.ok, true)
  const sent = calls.find((call) => call.method === 'interface.create').params[0]
  assert.deepEqual(sent.bridge_members, ['enp6s18'])
  assert.equal(sent.type, 'BRIDGE')

  const pending = await tool.execute({ action: 'pending_changes' })
  assert.match(pending.text, /pending/i)

  const refused = await tool.execute({ action: 'interface_commit' })
  assert.equal(refused.ok, false)
  const committed = await tool.execute({ action: 'interface_commit', confirm: true, checkinTimeout: 30 })
  assert.equal(committed.ok, true)
  const commit = calls.find((call) => call.method === 'interface.commit').params[0]
  assert.equal(commit.checkin_timeout, 30)
  assert.equal(commit.rollback, true)
})

test('cloud: credentials list, add and guarded delete', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_cloud')
  const listed = await tool.execute({ action: 'credentials' })
  assert.match(listed.text, /B2/)

  const added = await tool.execute({ action: 'credential_add', data: { name: 'b2', provider: { type: 'B2' } } })
  assert.equal(added.ok, true)

  const refused = await tool.execute({ action: 'credential_remove', credential: 9 })
  assert.equal(refused.ok, false)
  assert.ok(!calls.some((call) => call.method === 'cloudsync.credentials.delete'))
})

test('reporting: exporter add validates the payload', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_reporting')
  const bad = await tool.execute({ action: 'exporter_add' })
  assert.equal(bad.ok, false)

  const good = await tool.execute({
    action: 'exporter_add',
    data: { enabled: true, attributes: { exporter_type: 'GRAPHITE', destination_ip: '10.0.0.5', destination_port: 2003 } },
  })
  assert.equal(good.ok, true)
  assert.ok(calls.some((call) => call.method === 'reporting.exporters.create'))
})

test('users: password change never echoes the secret and shells are listed', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_users')
  const missing = await tool.execute({ action: 'set_password', user: 'bob' })
  assert.equal(missing.ok, false)

  const changed = await tool.execute({ action: 'set_password', user: 'bob', password: 'S3cret!' })
  assert.equal(changed.ok, true)
  assert.ok(!changed.text.includes('S3cret!'))
  const sent = calls.find((call) => call.method === 'user.set_password').params[0]
  assert.equal(sent.username, 'bob')
  assert.equal(sent.new_password, 'S3cret!')

  const shells = await tool.execute({ action: 'shell_choices' })
  assert.match(shells.text, /zsh/)
})

test('disks: details include temperature, agg table, guarded update', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_disks')
  const details = await tool.execute({ action: 'details', name: '/dev/sda' })
  assert.match(details.text, /38 °C/)

  const agg = await tool.execute({ action: 'temperature_agg' })
  assert.match(agg.text, /37/)

  const bad = await tool.execute({ action: 'update', name: 'sda' })
  assert.equal(bad.ok, false)

  const updated = await tool.execute({ action: 'update', name: 'sda', data: { hddstandby: '20' } })
  assert.equal(updated.ok, true)
  assert.deepEqual(calls.find((call) => call.method === 'disk.update').params, [1, { hddstandby: '20' }])
})

test('alerts: classes list and update', async () => {
  const { byName } = build()
  const tool = byName('truenas_alerts')
  const classes = await tool.execute({ action: 'classes' })
  assert.match(classes.text, /ZFS/)

  const updated = await tool.execute({ action: 'classes_update', classes: { ZFS: 'WARNING' } })
  assert.equal(updated.ok, true)

})

test('apps: rollback versions and guarded custom conversion', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_apps')
  const versions = await tool.execute({ action: 'rollback_versions', app: 'plex' })
  assert.match(versions.text, /1\.0\.2/)

  const refused = await tool.execute({ action: 'convert_to_custom', app: 'plex' })
  assert.equal(refused.ok, false)
  assert.ok(!calls.some((call) => call.method === 'app.convert_to_custom'))

  const converted = await tool.execute({ action: 'convert_to_custom', app: 'plex', confirm: true })
  assert.equal(converted.ok, true)
})

test('replication: global config read and update', async () => {
  const { byName, calls } = build()
  const tool = byName('truenas_replication')
  const config = await tool.execute({ action: 'config' })
  assert.match(config.text, /max_parallel/)

  const bad = await tool.execute({ action: 'config_update' })
  assert.equal(bad.ok, false)

  const updated = await tool.execute({ action: 'config_update', config: { max_parallel_replication_tasks: 3 } })
  assert.equal(updated.ok, true)
  assert.ok(calls.some((call) => call.method === 'replication.config.update'))
})

test('system config views redact certificate material and passwords', async () => {
  const { byName } = build()
  const tool = byName('truenas_system')
  const changed = await tool.execute({ action: 'general_update', general: { hostname: 'nas2' } })
  assert.equal(changed.ok, true)

  const general = await tool.execute({ action: 'general' })
  assert.equal(general.ok, true)
  assert.ok(!general.text.includes('BEGIN PRIVATE KEY'))
  assert.ok(!general.text.includes('BEGIN CERTIFICATE'))
  assert.match(general.text, /ui_certificate/)
})
