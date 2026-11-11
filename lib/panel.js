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

const CACHE_MS = 4000
const ACTIONS = new Set([
  'app.start',
  'app.stop',
  'app.restart',
  'app.upgrade',
  'app.delete',
  'job.abort',
  'alert.dismiss',
])

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
const SERIES_QUERY = { unit: 'MINUTE', page: 1, aggregate: true }
const SERIES = [{ name: 'cpu' }, { name: 'memory' }, { name: 'cputemp' }]

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

  function cards(system, reporting) {
    const cpuSeries = seriesByName(reporting, 'cpu')
    const memorySeries = seriesByName(reporting, 'memory')
    const tempSeries = seriesByName(reporting, 'cputemp')

    let cpu = percentOf(mean(latestValues(cpuSeries)))
    if (cpu === undefined) {
      const load = numeric(system?.loadavg?.[0]) ?? numeric(system?.loadavg?.['1'])
      const cores = numeric(system?.cores)
      if (load !== undefined && cores) cpu = percentOf((load / cores) * 100)
    }

    const total = numeric(system?.physmem)
    const memoryValues = latestValues(memorySeries)
    let used = memoryValues?.find((value) => value > 0)
    let memoryPercent
    if (used !== undefined && total) {
      // A single small value is already a percentage; bytes are compared to RAM.
      if (used > total) used = total
      memoryPercent = percentOf((used / total) * 100)
    } else if (used !== undefined && used <= 100) {
      memoryPercent = percentOf(used)
      used = total ? (used / 100) * total : undefined
    }

    const temperature = numeric(latestValues(tempSeries)?.[0])

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
    const [info, reporting, pools, apps, jobs, alerts] = await Promise.all([
      call(client, 'system.info'),
      call(client, 'reporting.get_data', [SERIES, SERIES_QUERY]),
      call(client, 'pool.query', [[], { select: POOL_SELECT, order_by: ['name'] }]),
      call(client, 'app.query', [[], { select: APP_SELECT }]),
      call(client, 'core.get_jobs', [
        [['state', 'in', ['WAITING', 'RUNNING']]],
        { select: JOB_SELECT },
      ]),
      call(client, 'alert.list'),
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
        default:
          return { ok: false, error: `Unsupported panel action: ${action}` }
      }
    } catch (error) {
      return { ok: false, instance: entry.name, error: errorText(error) }
    }
  }

  return { overview, act }
}
