/**
 * Aggregation for the right-sidebar panel.
 *
 * The panel is a browser surface, so it never talks to a NAS directly: this
 * module runs inside the plugin, reuses the same pooled WebSocket client the
 * agent tools use, and hands the client one compact JSON document. Reads are
 * cached for a few seconds because several panes (and several browser tabs) can
 * poll the same instance at once.
 */

import { errorText, formatBytes, formatDuration } from './format.js'
import { findInstance, instanceReadiness } from './instances.js'

// The live stream re-reads every 2.5 s; a shorter cache also keeps the
// fallback poll responsive without hammering the NAS.
const CACHE_MS = 2500
const ACTIONS = new Set([
  'app.start',
  'app.stop',
  'app.restart',
  'app.upgrade',
  'app.delete',
  'job.abort',
  'alert.dismiss',
  'snapshot.create',
  'service.control',
  'service.enable',
  'smart.test',
  'vm.start',
  'vm.stop',
  'vm.restart',
  'snapshot.delete',
])

// Sections that cost more than a single query are read on their own cadence:
// certificates and disks barely change, services change on human timescales,
// while CPU/jobs/alerts need to feel live.
const SECTION_TTL = {
  services: 10000,
  certificates: 60000,
  disks: 20000,
  snapshots: 15000,
  replication: 10000,
  cloud: 10000,
  network: 10000,
  vms: 8000,
  iscsi: 15000,
  ups: 15000,
}

const APP_SELECT = [
  'name',
  'state',
  'version',
  'human_version',
  'upgrade_available',
  'latest_version',
  'custom_app',
]
const POOL_SELECT = ['name', 'status', 'healthy', 'size', 'allocated', 'free']
const JOB_SELECT = ['id', 'method', 'state', 'progress', 'time_started', 'description']
const SERVICE_SELECT = ['id', 'service', 'state', 'enable']
const CERT_SELECT = ['id', 'name', 'type', 'from', 'until', 'expired', 'cert_type', 'common', 'renew_days', 'acme']
const DISK_SELECT = ['name', 'model', 'size', 'type', 'bus', 'rotationrate']
const VM_SELECT = ['id', 'name', 'state', 'vcpus', 'cores', 'memory', 'autostart']
const SNAPSHOT_SELECT = ['id', 'dataset', 'name', 'createtxg', 'properties']
const SERIES = [{ name: 'cpu' }, { name: 'memory' }, { name: 'cputemp' }]
const DAY_MS = 24 * 60 * 60 * 1000

/** `until` is "Sun May 16 11:27:09 2027" or an ISO string depending on build. */
// TrueNAS sometimes wraps datetimes as {"$date": <ms>} (pydantic), sometimes as
// an ISO string; the panel normalises both to an ISO string the browser can
// parse, and returns null when the value is missing.
function isoOf(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = typeof value === 'object' && value.$date !== undefined ? Number(value.$date) : value
  const parsed = raw instanceof Date ? raw : new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function certDaysLeft(until) {
  if (until === undefined || until === null || until === '') return undefined
  const raw = typeof until === 'object' && until.$date !== undefined ? Number(until.$date) : until
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return undefined
  return Math.floor((parsed.getTime() - Date.now()) / DAY_MS)
}
const SERIES_WINDOW_SECONDS = 20

/**
 * Ask for the newest handful of samples instead of a whole unit page: the
 * hourly page returns 3600 one-second rows per series (over a megabyte), while
 * the panel only needs the latest value.
 */
function seriesQuery() {
  const end = Math.floor(Date.now() / 1000)
  return { start: end - SERIES_WINDOW_SECONDS, end, aggregate: false }
}

function stateRank(state) {
  switch (state) {
    case 'RUNNING':
      return 0
    case 'DEPLOYING':
    case 'STOPPING':
      return 1
    case 'CRASHED':
      return 2
    default:
      return 3
  }
}

function numeric(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function seriesByName(payload, name) {
  const list = Array.isArray(payload) ? payload : payload?.data
  if (!Array.isArray(list)) return undefined
  return list.find((item) => item && item.name === name)
}

/** TrueNAS returns one row per timestamp, `[ts, ...columns]`. */
function latestValues(series) {
  if (!series || !Array.isArray(series.data) || series.data.length === 0) return undefined
  const row = series.data[series.data.length - 1]
  if (!Array.isArray(row) || row.length < 2) return undefined
  return row.slice(1).map(numeric).filter((value) => value !== undefined)
}

function mean(values) {
  if (!values || values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentOf(value) {
  if (value === undefined) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function createPanel({ store, pool, getConfig }) {
  const cache = new Map()
  const sections = new Map()

  /**
   * Serve a slow section from its own cache and keep the last good value when a
   * refresh fails, so a transient NAS hiccup does not empty the pane.
   */
  async function section(instanceName, key, loader) {
    const cacheKey = `${instanceName}|${key}`
    const hit = sections.get(cacheKey)
    const ttl = SECTION_TTL[key] ?? CACHE_MS
    if (hit && Date.now() - hit.at < ttl) return { value: hit.value }
    try {
      const value = await loader()
      sections.set(cacheKey, { at: Date.now(), value })
      return { value }
    } catch (error) {
      if (hit) return { value: hit.value, error: errorText(error), stale: true }
      return { error: errorText(error) }
    }
  }

  async function call(client, method, params) {
    try {
      return { value: await client.request(method, params) }
    } catch (error) {
      return { error: errorText(error) }
    }
  }

  function instanceList(config) {
    return config.instances.map((entry, index) => ({
      name: entry.name,
      url: entry.url,
      username: entry.username,
      description: entry.description || '',
      default: index === 0,
      insecureTls: entry.insecureTls === true,
    }))
  }

  /** Last sample as `{ legendColumn: value }`, using the series legend. */
  function latestColumns(series) {
    const rows = Array.isArray(series?.data) ? series.data : undefined
    if (!rows || rows.length === 0) return undefined
    const row = rows[rows.length - 1]
    if (!Array.isArray(row) || row.length < 2) return undefined
    const legend = Array.isArray(series.legend) ? series.legend.slice(1) : []
    const values = {}
    for (let index = 1; index < row.length; index += 1) {
      const key = legend[index - 1] || `column${index}`
      const value = numeric(row[index])
      if (value !== undefined) values[key] = value
    }
    return values
  }

  function cards(system, reporting) {
    const cpuColumns = latestColumns(seriesByName(reporting, 'cpu'))
    const memoryColumns = latestColumns(seriesByName(reporting, 'memory'))
    const tempColumns = latestColumns(seriesByName(reporting, 'cputemp'))

    // Each cpu column is the share of one CPU (or core group) in percent, so the
    // instantaneous total is their sum.
    let cpu
    if (cpuColumns) {
      const total = Object.values(cpuColumns).reduce((sum, value) => sum + value, 0)
      if (total > 0) cpu = percentOf(total)
    }
    if (cpu === undefined) {
      const load = numeric(system?.loadavg?.[0]) ?? numeric(system?.loadavg?.['1'])
      const cores = numeric(system?.cores)
      if (load !== undefined && cores) cpu = percentOf((load / cores) * 100)
    }

    // memory reports `available` bytes (ZFS counts cache as used, which is why
    // the UI uses free+available for its own math).
    const total = numeric(system?.physmem)
    let used
    for (const [key, value] of Object.entries(memoryColumns || {})) {
      if (/avail|free/i.test(key) && total) {
        used = Math.max(0, total - value)
        break
      }
    }
    if (used === undefined && memoryColumns && total) {
      const first = Object.values(memoryColumns)[0]
      if (first !== undefined && first <= total) used = first
    }
    const memoryPercent = used !== undefined && total ? percentOf((used / total) * 100) : undefined

    // A chart with no sensor (common in VMs) is all zeros; report nothing then.
    let temperature
    for (const value of Object.values(tempColumns || {})) {
      if (value > 0) temperature = Math.max(temperature ?? 0, value)
    }

    return {
      cpu: { percent: cpu },
      memory: { percent: memoryPercent, used, total },
      temperature: { celsius: temperature },
    }
  }

  async function overview(requested) {
    const config = getConfig()
    const instances = instanceList(config)
    if (instances.length === 0) {
      return { ok: true, configured: 0, instances: [], selected: null }
    }

    const found = findInstance(config, requested)
    if (!found.ok) {
      return { ok: false, error: found.error, configured: instances.length, instances, selected: null }
    }
    const entry = found.instance

    const cached = cache.get(entry.name)
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return { ...cached.value, cached: true }
    }

    const apiKey = await store.getApiKey(entry.credential)
    const missing = instanceReadiness(entry, Boolean(apiKey))
    if (missing) {
      return {
        ok: false,
        configured: instances.length,
        instances,
        selected: entry.name,
        error: `Instance "${entry.name}" is not ready: ${missing}`,
      }
    }

    const client = pool.get(entry, apiKey)
    const [info, reporting, pools, apps, jobs, alerts, services, certificates, disks, snapshots, replication, cloud, network, vms, iscsi, ups] =
      await Promise.all([
      call(client, 'system.info'),
      call(client, 'reporting.get_data', [SERIES, seriesQuery()]),
      call(client, 'pool.query', [[], { select: POOL_SELECT, order_by: ['name'] }]),
      call(client, 'app.query', [[], { select: APP_SELECT }]),
      call(client, 'core.get_jobs', [
        [['state', 'in', ['WAITING', 'RUNNING']]],
        { select: JOB_SELECT },
      ]),
      call(client, 'alert.list'),
      section(entry.name, 'services', () =>
        client.request('service.query', [[], { select: SERVICE_SELECT, order_by: ['service'] }]),
      ),
      section(entry.name, 'certificates', () =>
        client.request('certificate.query', [[], { select: CERT_SELECT, order_by: ['name'] }]),
      ),
      section(entry.name, 'disks', async () => {
        const list = await client.request('disk.query', [[], { select: DISK_SELECT, order_by: ['name'] }])
        const names = (Array.isArray(list) ? list : []).map((disk) => disk.name).filter(Boolean)
        let temps = {}
        if (names.length) {
          // A machine without SMART support simply returns nothing here; the
          // inventory is still worth showing.
          temps = await client
            .request('disk.temperatures', [names, false])
            .catch(() => ({}))
        }
        return { disks: list, temps: temps || {} }
      }),
      section(entry.name, 'snapshots', () =>
        client.request('pool.snapshot.query', [
          [],
          { select: SNAPSHOT_SELECT, order_by: ['-id'], limit: 12 },
        ]),
      ),
      section(entry.name, 'replication', () =>
        client.request('replication.query', [
          [],
          { select: ['id', 'name', 'state', 'source_datasets', 'target_dataset', 'enabled', 'job', 'last_run'], limit: 20 },
        ]),
      ),
      section(entry.name, 'cloud', async () => {
        const [sync, backups] = await Promise.all([
          client.request('cloudsync.query', [[], { select: ['id', 'description', 'direction', 'enabled', 'job', 'last_run'], limit: 20 }]),
          client.request('cloud_backup.query', [[], { select: ['id', 'description', 'enabled', 'job', 'last_run'], limit: 20 }]).catch(() => []),
        ])
        return { sync, backups }
      }),
      section(entry.name, 'network', () =>
        client.request('interface.query', [
          [],
          { select: ['id', 'name', 'type', 'state', 'aliases', 'ipv4_dhcp', 'mtu'], order_by: ['name'] },
        ]),
      ),
      section(entry.name, 'vms', () =>
        client.request('vm.query', [[], { select: VM_SELECT, order_by: ['name'] }]).catch(() => []),
      ),
      section(entry.name, 'iscsi', async () => {
        const [targets, sessions] = await Promise.all([
          client.request('iscsi.target.query', [[], { select: ['id', 'name', 'alias'], order_by: ['name'] }]).catch(() => []),
          client.request('iscsi.global.sessions', []).catch(() => []),
        ])
        return { targets, sessions }
      }),
      section(entry.name, 'ups', () =>
        client
          .request('reporting.get_data', [
            [{ name: 'upscharge' }, { name: 'upsruntime' }, { name: 'upsload' }],
            seriesQuery(),
          ])
          .catch(() => null),
      ),
    ])

    const system = info.value
    if (!system) {
      return {
        ok: false,
        configured: instances.length,
        instances,
        selected: entry.name,
        error: info.error || 'The NAS did not answer system.info.',
      }
    }

    const issues = []
    for (const [label, result] of [
      ['reporting', reporting],
      ['pools', pools],
      ['apps', apps],
      ['jobs', jobs],
      ['alerts', alerts],
      ['services', services],
      ['certificates', certificates],
      ['disks', disks],
      ['snapshots', snapshots],
      ['replication', replication],
      ['cloud', cloud],
      ['network', network],
      ['vms', vms],
      ['iscsi', iscsi],
      ['ups', ups],
    ]) {
      if (result.error) issues.push(`${label}: ${result.error}`)
    }

    const poolRows = Array.isArray(pools.value) ? pools.value : []
    const poolCards = poolRows.map((row) => {
      const size = numeric(row.size)
      const allocated = numeric(row.allocated)
      return {
        name: row.name,
        status: row.status || (row.healthy === false ? 'DEGRADED' : 'ONLINE'),
        size,
        allocated,
        percent: size && allocated !== undefined ? percentOf((allocated / size) * 100) : undefined,
        text: size ? `${formatBytes(allocated || 0)} / ${formatBytes(size)}` : '',
      }
    })

    const appRows = (Array.isArray(apps.value) ? apps.value : [])
      .map((app) => ({
        name: app.name,
        state: app.state || 'UNKNOWN',
        version: app.human_version || app.version || '',
        upgradeAvailable: app.upgrade_available === true,
        latestVersion: app.latest_version || '',
        custom: app.custom_app === true,
      }))
      .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name))

    const jobRows = (Array.isArray(jobs.value) ? jobs.value : []).map((job) => ({
      id: job.id,
      method: job.method || job.description || 'job',
      state: job.state,
      percent: numeric(job.progress?.percent),
      description: job.progress?.description || '',
    }))

    const alertRows = (Array.isArray(alerts.value) ? alerts.value : [])
      .filter((alert) => alert && alert.dismissed !== true)
      .map((alert) => ({
        uuid: alert.uuid,
        level: alert.level || 'WARNING',
        text: alert.formatted || alert.text || '',
      }))

    const serviceRows = (Array.isArray(services.value) ? services.value : []).map((row) => ({
      id: row.id,
      name: serviceName(row),
      state: row.state || 'UNKNOWN',
      enabled: row.enable === true,
      running: String(row.state || '').toUpperCase() === 'RUNNING',
    }))

    const certificateRows = (Array.isArray(certificates.value) ? certificates.value : [])
      .map((cert) => {
        const days = certDaysLeft(cert.until)
        return {
          id: cert.id,
          name: cert.name || `certificate ${cert.id}`,
          type: cert.cert_type || String(cert.type ?? ''),
          common: cert.common || '',
          until: cert.until ?? '',
          days,
          state: cert.expired ? 'EXPIRED' : days !== undefined && days <= (cert.renew_days ?? 10) ? 'RENEW SOON' : 'valid',
          acme: cert.acme !== null && cert.acme !== undefined,
        }
      })
      .sort((a, b) => (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER))

    const diskRows = (Array.isArray(disks.value?.disks) ? disks.value.disks : []).map((disk) => {
      const temps = disks.value?.temps || {}
      const celsius = typeof temps[disk.name] === 'number' ? temps[disk.name] : undefined
      return {
        name: disk.name,
        model: disk.model || '',
        bus: disk.bus || '',
        size: numeric(disk.size),
        celsius,
        state:
          celsius === undefined ? 'unknown' : celsius >= 55 ? 'hot' : celsius >= 45 ? 'warm' : 'ok',
      }
    })

    const snapshotRows = (Array.isArray(snapshots.value) ? snapshots.value : [])
      .map((snapshot) => ({
        id: snapshot.id || `${snapshot.dataset}@${snapshot.name}`,
        dataset: snapshot.dataset || String(snapshot.id || '').split('@')[0],
        name: snapshot.name || String(snapshot.id || '').split('@')[1] || '',
        created: isoOf(snapshot.properties?.creation?.parsed ?? snapshot.properties?.creation?.value ?? snapshot.created),
      }))
      .slice(0, 8)

    const replicationRows = (Array.isArray(replication.value) ? replication.value : []).map((task) => ({
      id: task.id,
      name: task.name || '',
      state: task.state || (task.job?.state ?? 'PENDING'),
      enabled: task.enabled !== false,
      lastRun: task.job?.time_finished?.$date ?? task.last_run?.$date ?? null,
    }))

    const cloudRows = [
      ...(Array.isArray(cloud.value?.sync) ? cloud.value.sync : []).map((task) => ({
        id: `sync-${task.id}`,
        kind: 'sync',
        name: task.description || '',
        state: task.job?.state || '',
        enabled: task.enabled !== false,
        lastRun: task.job?.time_finished?.$date ?? task.last_run?.$date ?? null,
      })),
      ...(Array.isArray(cloud.value?.backups) ? cloud.value.backups : []).map((task) => ({
        id: `backup-${task.id}`,
        kind: 'backup',
        name: task.description || '',
        state: task.job?.state || '',
        enabled: task.enabled !== false,
        lastRun: task.job?.time_finished?.$date ?? task.last_run?.$date ?? null,
      })),
    ]

    const networkRows = (Array.isArray(network.value) ? network.value : []).map((iface) => {
      const flags = Array.isArray(iface.state?.flags) ? iface.state.flags : []
      const aliases = Array.isArray(iface.aliases) ? iface.aliases : Array.isArray(iface.state?.aliases) ? iface.state.aliases : []
      return {
        name: iface.name,
        type: iface.type || '',
        link: iface.state?.link_state === 'LINK_STATE_UP' || flags.includes('UP') ? 'up' : 'down',
        addresses: aliases.map((alias) => `${alias.address}/${alias.netmask ?? ''}`).join(', '),
        mtu: numeric(iface.mtu),
      }
    })

    const vmRows = (Array.isArray(vms.value) ? vms.value : []).map((vm) => ({
      id: vm.id,
      name: vm.name || `vm ${vm.id}`,
      state: typeof vm.state === 'string' ? vm.state : vm.state?.state || 'UNKNOWN',
      vcpus: numeric(vm.vcpus) ?? numeric(vm.cores),
      memory: numeric(vm.memory),
      autostart: vm.autostart === true,
    }))

    const iscsiInfo = {
      targets: Array.isArray(iscsi.value?.targets) ? iscsi.value.targets.length : 0,
      sessions: Array.isArray(iscsi.value?.sessions) ? iscsi.value.sessions.length : 0,
      names: Array.isArray(iscsi.value?.targets) ? iscsi.value.targets.map((target) => target.name || `target ${target.id}`) : [],
    }

    const upsRows = (() => {
      const series = Array.isArray(ups.value) ? ups.value : []
      const read = (name) => {
        const match = series.find((entry) => entry?.name === name || entry?.identifier === name)
        const row = match?.data?.[match.data.length - 1]
        return Array.isArray(row) ? numeric(row[row.length - 1]) : numeric(match?.aggregations?.mean)
      }
      const charge = read('upscharge')
      const runtime = read('upsruntime')
      if (charge === undefined && runtime === undefined) return null
      return { charge, runtime }
    })()

    const result = {
      ok: true,
      at: Date.now(),
      configured: instances.length,
      instances,
      selected: entry.name,
      system: {
        hostname: system.hostname,
        version: system.version,
        uptime: formatDuration(numeric(system.uptime_seconds)),
        load: numeric(system.loadavg?.[0]),
        cores: numeric(system.cores),
      },
      cards: {
        ...cards(system, reporting.value),
        pool: poolCards[0] || null,
      },
      pools: poolCards,
      apps: appRows,
      jobs: jobRows,
      alerts: alertRows,
      services: serviceRows,
      certificates: certificateRows,
      disks: diskRows,
      snapshots: snapshotRows,
      replication: replicationRows,
      cloud: cloudRows,
      network: networkRows,
      vms: vmRows,
      iscsi: iscsiInfo,
      ups: upsRows,
      expiring: certificateRows.filter((cert) => cert.state !== 'valid').length,
      issues,
    }

    cache.set(entry.name, { at: Date.now(), value: result })
    return result
  }

  async function act(payload) {
    const action = String(payload?.action || '')
    if (!ACTIONS.has(action)) {
      return { ok: false, error: `Unsupported panel action: ${action || '(none)'}` }
    }
    if (action === 'app.delete' && payload?.confirm !== true) {
      return {
        ok: false,
        requiresConfirm: true,
        error: `Deleting application "${payload?.name}" removes it and its volumes. Confirm first.`,
      }
    }

    const config = getConfig()
    const found = findInstance(config, payload?.instance)
    if (!found.ok) return { ok: false, error: found.error }
    const entry = found.instance
    const apiKey = await store.getApiKey(entry.credential)
    const missing = instanceReadiness(entry, Boolean(apiKey))
    if (missing) {
      return { ok: false, error: `Instance "${entry.name}" is not ready: ${missing}` }
    }

    const client = pool.get(entry, apiKey)
    cache.delete(entry.name)

    try {
      switch (action) {
        case 'app.start':
        case 'app.stop':
        case 'app.restart':
        case 'app.upgrade':
        case 'app.delete': {
          const name = String(payload?.name || '')
          if (!name) return { ok: false, error: 'This action needs an application name.' }
          const params =
            action === 'app.upgrade'
              ? [name, { app_version: payload?.version || 'latest' }]
              : [name]
          const jobId = await client.request(action, params)
          let job
          if (typeof jobId === 'number') {
            job = await client.waitJob(jobId, {
              timeoutMs: Math.min(getConfig().jobTimeoutMs || 600000, 180000),
            })
          }
          return {
            ok: true,
            instance: entry.name,
            state: job?.state || 'SUCCESS',
            message: `${action} ${name}: ${job?.state || 'submitted'}`,
          }
        }
        case 'job.abort': {
          const id = numeric(payload?.id)
          if (id === undefined) return { ok: false, error: 'This action needs a job id.' }
          await client.request('core.job_abort', [id])
          return { ok: true, instance: entry.name, message: `Job ${id} aborted.` }
        }
        case 'alert.dismiss': {
          const uuid = String(payload?.uuid || '')
          if (!uuid) return { ok: false, error: 'This action needs an alert id.' }
          await client.request('alert.dismiss', [uuid])
          return { ok: true, instance: entry.name, message: 'Alert dismissed.' }
        }
        case 'snapshot.create': {
          // Snapshots are cheap and non-destructive, so the panel offers one
          // click per pool; the name is generated here to keep it unique.
          const dataset = String(payload?.dataset || '').trim()
          if (!dataset) return { ok: false, error: 'This action needs a dataset name.' }
          const name = String(payload?.name || '').trim() || snapshotName()
          await client.request('pool.snapshot.create', [{ dataset, name }])
          return {
            ok: true,
            instance: entry.name,
            message: `Snapshot ${dataset}@${name} created.`,
            snapshot: { dataset, name },
          }
        }
        case 'service.control': {
          const name = String(payload?.name || '').trim()
          const verb = String(payload?.verb || '').toUpperCase()
          if (!name) return { ok: false, error: 'This action needs a service name.' }
          if (!['START', 'STOP', 'RESTART', 'RELOAD'].includes(verb)) {
            return { ok: false, error: '"verb" must be START, STOP, RESTART or RELOAD.' }
          }
          const jobId = await client.request('service.control', [
            verb,
            name,
            { silent: false, timeout: 120 },
          ])
          let job
          if (typeof jobId === 'number') {
            job = await client.waitJob(jobId, {
              timeoutMs: Math.min(getConfig().jobTimeoutMs || 600000, 180000),
            })
          }
          return {
            ok: true,
            instance: entry.name,
            state: job?.state || 'SUCCESS',
            message: `${name}: ${verb} ${job?.state || 'submitted'}`,
          }
        }
        case 'service.enable': {
          const name = String(payload?.name || '').trim()
          const enabled = payload?.enabled !== false
          if (!name) return { ok: false, error: 'This action needs a service name.' }
          const row = await client.request('service.query', [
            [['service', '=', name]],
            { select: ['id', 'service', 'enable'], get: true },
          ])
          if (!row) return { ok: false, error: `No service named "${name}".` }
          await client.request('service.update', [row.id, { enable: enabled }])
          return {
            ok: true,
            instance: entry.name,
            message: `${name}: start on boot ${enabled ? 'enabled' : 'disabled'}.`,
          }
        }
        case 'smart.test': {
          const disk = String(payload?.disk || '').replace(/^\/dev\//, '').trim()
          const type = String(payload?.testType || 'SHORT').toUpperCase()
          if (!disk) return { ok: false, error: 'This action needs a disk name.' }
          if (!['SHORT', 'LONG', 'CONVEYANCE', 'OFFLINE'].includes(type)) {
            return { ok: false, error: '"testType" must be SHORT, LONG, CONVEYANCE or OFFLINE.' }
          }
          await client.request('disk.smart_test', [[disk], type])
          return {
            ok: true,
            instance: entry.name,
            message: `SMART ${type} self-test started on ${disk}.`,
          }
        }
        case 'vm.start':
        case 'vm.stop':
        case 'vm.restart': {
          const id = numeric(payload?.id)
          if (id === undefined) return { ok: false, error: 'This action needs a virtual machine id.' }
          const verb = action.slice(3)
          const jobId = await client.request(`vm.${verb}`, [id])
          let job
          if (typeof jobId === 'number') {
            job = await client.waitJob(jobId, {
              timeoutMs: Math.min(getConfig().jobTimeoutMs || 600000, 180000),
            })
          }
          return {
            ok: true,
            instance: entry.name,
            state: job?.state || 'SUCCESS',
            message: `vm ${id}: ${verb} ${job?.state || 'submitted'}`,
          }
        }
        case 'snapshot.delete': {
          if (payload?.confirm !== true) {
            return {
              ok: false,
              requiresConfirm: true,
              error: `Deleting snapshot "${payload?.id}" cannot be undone. Confirm first.`,
            }
          }
          const id = String(payload?.id || '').trim()
          if (!id) return { ok: false, error: 'This action needs a snapshot id.' }
          await client.request('pool.snapshot.delete', [id, { recursive: false }])
          return { ok: true, instance: entry.name, message: `Snapshot ${id} deleted.` }
        }
        default:
          return { ok: false, error: `Unsupported panel action: ${action}` }
      }
    } catch (error) {
      return { ok: false, instance: entry.name, error: errorText(error) }
    }
  }

/** Service rows call the column `service`; older builds also had `name`. */
function serviceName(entry) {
  return entry?.service || entry?.name || ''
}

/** `panel-20261111-112530`: valid for ZFS and obvious in the UI later. */
function snapshotName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    'panel',
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('-')
}

  return { overview, act }
}
