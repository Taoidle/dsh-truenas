/**
 * Tool definitions.
 *
 * The surface is deliberately curated: eight tools cover the everyday TrueNAS
 * administration tasks, and `truenas_call` is the escape hatch for everything
 * else in the JSON-RPC namespace.
 */

import { findInstance, instanceReadiness, listInstances, maskKey } from './instances.js'
import { createAlertsTool } from './tools-alerts.js'
import { createCloudTool } from './tools-cloud.js'
import { createNetworkTool } from './tools-network.js'
import { createReplicationTool } from './tools-replication.js'
import { createUsersTool } from './tools-users.js'
import {
  errorText,
  formatBytes,
  formatDate,
  formatDuration,
  formatLoadAverage,
  jobLine,
  jsonBlock,
  keyValues,
  table,
  truncate,
} from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'
import { classifyCall } from './danger.js'

function instanceTable(instances, keyState) {
  return table(
    instances.map((entry, index) => ({
      index: index + 1,
      name: entry.name,
      url: entry.url || '(not set)',
      username: entry.username,
      key: keyState(entry),
      tls: entry.insecureTls ? 'verify off' : 'verified',
    })),
    [
      { key: 'index', header: '#' },
      { key: 'name', header: 'Name' },
      { key: 'url', header: 'URL' },
      { key: 'username', header: 'User' },
      { key: 'key', header: 'API key' },
      { key: 'tls', header: 'TLS' },
    ],
  )
}

const APP_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/

function checkAppName(value) {
  const name = String(value || '').trim()
  if (!name) return { ok: false, error: 'Pass "app" with the application name.' }
  if (name.length > 40 || !APP_NAME.test(name)) {
    return {
      ok: false,
      error: `"${name}" is not a valid app name: use lowercase letters, digits and dashes, start with a letter, end with a letter or digit, at most 40 characters.`,
    }
  }
  return { ok: true, name }
}

/**
 * TrueNAS accepts a custom app either as a Compose document (YAML text) or as
 * the parsed object. Both are forwarded untouched; the only local check is the
 * shape that TrueNAS itself rejects late and with an opaque job error.
 */
function readCompose(args) {
  if (args.composeObject && typeof args.composeObject === 'object') {
    return { ok: true, kind: 'object', value: args.composeObject }
  }
  const text = typeof args.compose === 'string' ? args.compose.trim() : ''
  if (!text) {
    return { ok: false, error: 'Pass "compose" with a Docker Compose document (YAML), or "composeObject" with the parsed object.' }
  }
  if (!/^\s*services\s*:/m.test(text)) {
    return { ok: false, error: 'The Compose document has no top-level "services:" section, so TrueNAS would reject it.' }
  }
  return { ok: true, kind: 'string', value: text }
}

async function resolveRegistry(client, spec) {
  const raw = String(spec || '').trim()
  if (!raw) return { ok: false, error: 'Pass "registry" with the registry id or name. Run action "registry_list" to see them.' }
  const registries = await client.request('app.registry.query', [[], {}])
  const list = Array.isArray(registries) ? registries : []
  const found =
    list.find((registry) => String(registry.id) === raw) ||
    list.find((registry) => String(registry.name).toLowerCase() === raw.toLowerCase())
  if (!found) return { ok: false, error: `No Docker registry matches "${raw}". Run action "registry_list" to see them.` }
  return { ok: true, id: found.id, name: found.name }
}

export function createTools(ctx) {
  const instanceTool = define(
    'truenas_instances',
    [
      'Manage the configured TrueNAS systems for this plugin: list them, add one with its URL and API key, update it, remove it, or test connectivity.',
      'The API key is stored in the DSH credential store under a per-instance name and never echoed back.',
      'Start here: an instance needs a URL and an API key before the other truenas_* tools can use it.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'test'], description: 'Operation to perform.' },
        instance: { type: 'string', description: 'Instance name to update, remove or test. For "add" it is the new instance name; omit to derive it from the URL host.' },
        url: { type: 'string', description: 'TrueNAS web UI address, for example "https://nas.lab.local" or "192.168.1.10". HTTPS uses port 443 unless a port is given.' },
        username: { type: 'string', description: 'TrueNAS user that owns the API key. Defaults to "root".' },
        name: { type: 'string', description: 'Instance name for "add". Defaults to the URL host.' },
        apiKey: { type: 'string', description: 'TrueNAS API key (System → API Keys). Stored in the DSH credential store, not in plugin config. Required for "add".' },
        insecureTls: { type: 'boolean', description: 'Skip TLS certificate verification (self-signed NAS certificates). Defaults to false.' },
        apiPath: { type: 'string', description: 'WebSocket API path. Defaults to /api/current.' },
        description: { type: 'string', description: 'Free-form note about the instance.' },
        forgetApiKey: { type: 'boolean', description: 'Also delete the stored API key when removing an instance.' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      const admin = ctx.admin
      const action = String(args.action || '').trim()

      if (action === 'list') {
        const state = await admin.list()
        if (!state.instances.length) {
          return ok({
            action: 'list',
            text:
              'No TrueNAS instance is configured yet.\n' +
              'Add one with: truenas_instances action "add", url "https://nas.lan", apiKey "1-xxxxxxxx".',
            data: { instances: [] },
          })
        }
        const names = state.instances.map((entry) => entry.name).join(', ')
        return ok({
          action: 'list',
          text:
            `${state.instances.length} instance(s) configured (${names}). The first instance is the default:\n\n` +
            instanceTable(state.instances, (entry) => (entry.hasApiKey ? 'set' : 'missing')),
          data: { defaultName: state.defaultName, instances: state.instances },
        })
      }

      if (action === 'add' || action === 'update') {
        const apiKey = typeof args.apiKey === 'string' && args.apiKey.trim() ? args.apiKey.trim() : ''
        const result = await admin.perform({
          action,
          name: action === 'add' ? String(args.name || args.instance || '').trim() : String(args.instance || '').trim(),
          url: args.url,
          username: args.username,
          apiPath: args.apiPath,
          insecureTls: args.insecureTls,
          description: args.description,
          apiKey,
        })
        if (!result.ok) return fail(result.error, result.hint)
        return ok({
          action,
          instance: result.instance,
          text: keyValues([
            ['Instance', `${result.instance} (${action === 'add' ? 'added' : 'updated'})`],
            ['URL', result.entry?.url],
            ['User', result.entry?.username],
            [
              'API key',
              apiKey
                ? `stored as ${result.entry?.credential} (${maskKey(apiKey)})`
                : `already stored as ${result.entry?.credential}`,
            ],
            ['Connected', `TrueNAS ${result.version}`],
            ['Hostname', result.hostname],
            ['Default instance', result.defaultName === result.instance ? 'yes' : 'no'],
          ]),
          data: { instance: result.instance, version: result.version, hostname: result.hostname, defaultName: result.defaultName },
        })
      }

      if (action === 'test') {
        const result = await admin.perform({ action: 'test', name: String(args.instance || '').trim() })
        if (!result.ok) return fail(result.error, result.hint)
        const info = result.info || {}
        return ok({
          action: 'test',
          instance: result.instance,
          text: keyValues([
            ['Instance', result.instance],
            ['URL', result.entry?.url],
            ['TrueNAS', result.version],
            ['Hostname', result.hostname],
            ['Platform', result.product],
            ['Cores', info.cores],
            ['Memory', info.physmem ? formatBytes(info.physmem) : undefined],
            ['Uptime', info.uptime],
          ]),
          data: { version: result.version, hostname: result.hostname },
        })
      }

      if (action === 'remove') {
        const refusal = requireConfirm(args, 'remove an instance')
        if (refusal) return refusal
        const result = await admin.perform({
          action: 'remove',
          name: String(args.instance || '').trim(),
          confirm: true,
          forgetApiKey: args.forgetApiKey === true,
        })
        if (!result.ok) return fail(result.error, result.hint)
        return ok({
          action: 'remove',
          instance: result.instance,
          text: keyValues([
            ['Removed', result.instance],
            ['Remaining instances', (result.remaining || []).join(', ') || '(none)'],
            ['Stored API key', result.forgotApiKey ? 'deleted from the credential store' : 'kept in the credential store'],
          ]),
          data: { instance: result.instance, remaining: result.remaining },
        })
      }

      return fail(`Unknown action "${action}".`)
    },
  )

  const callTool = define(
    'truenas_call',
    [
      'Call any TrueNAS API method directly over JSON-RPC 2.0 (WebSocket). Use this for configuration that the curated tools do not cover.',
      'Method names are documented at https://api.truenas.com/. Long-running methods return a job id: set waitJob to true to wait for the result.',
      'Examples: method "system.info" with no params; method "user.query" with params [[]].',
      'Methods that reboot, wipe, export or otherwise destroy data are refused unless confirm is true.',
    ].join(' '),
    {
      required: ['method'],
      properties: {
        instance: INSTANCE_PARAM,
        method: { type: 'string', description: 'API method name, for example "system.info" or "pool.dataset.query".' },
        params: { type: 'array', description: 'Method parameters as a JSON array. Defaults to [].', items: {} },
        waitJob: { type: 'boolean', description: 'When the method returns a job id, wait for the job to finish and return its result.' },
        timeoutMs: { type: 'number', description: 'Per-call timeout in milliseconds.' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      const method = String(args.method || '').trim()
      if (!method) return fail('A method name is required.')
      const params = Array.isArray(args.params) ? args.params : []
      const verdict = classifyCall(method, params)
      if (verdict.dangerous && args.confirm !== true) {
        return {
          ok: false,
          error: `${verdict.method} would ${verdict.reason}. Refusing without confirmation. Call again with confirm: true once you are sure.`,
          requiresConfirm: true,
          hint: 'Tell the user what the call does before asking them to confirm.',
        }
      }
      return withInstance(ctx, args, async (client, entry) => {
        let result
        try {
          result = await client.request(method, params, { timeoutMs: args.timeoutMs })
        } catch (error) {
          // RpcError already carries the method; avoid repeating it in the prefix.
          const reason = error?.reason ? String(error.reason) : errorText(error)
          return fail(`${method} failed: ${reason}`)
        }
        let job = null
        if (args.waitJob === true && Number.isInteger(result)) {
          job = await client.waitJob(result, { timeoutMs: ctx.config.jobTimeoutMs })
          result = job.result
        }
        return ok({
          action: method,
          text: `${method}${params.length ? ` ${jsonBlock(params, 400)}` : '()'} →\n${jsonBlock(result)}`,
          data: { method, result, job },
        })
      })
    },
  )

  const systemTool = define(
    'truenas_system',
    [
      'Read TrueNAS system state: version and hardware information, active alerts, and system services.',
      'Use action "alerts" first when something looks wrong.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: { type: 'string', enum: ['info', 'alerts', 'services', 'service'], description: 'What to read.' },
        service: { type: 'string', description: 'Service name for action "service", for example "smb" or "ssh".' },
        includeDismissed: { type: 'boolean', description: 'Include dismissed alerts (action "alerts").' },
      },
    },
    async (args) => {
      if (args.action === 'info') {
        return withInstance(ctx, args, async (client, entry) => {
          const info = await client.request('system.info')
          const load = formatLoadAverage(info?.loadavg)
          return ok({
            action: 'info',
            text: keyValues([
              ['Instance', entry.name],
              ['URL', entry.url || client.displayUrl],
              ['TrueNAS', info?.version],
              ['Hostname', info?.hostname],
              ['Product', info?.system_product],
              ['CPU', info?.model],
              ['Cores', info?.cores ? `${info.cores}${info.physical_cores ? ` (${info.physical_cores} physical)` : ''}` : undefined],
              ['Memory', info?.physmem ? formatBytes(info.physmem) : undefined],
              ['Load average', load ? `${load} (1 / 5 / 15 min)` : undefined],
              ['Uptime', info?.uptime || (info?.uptime_seconds ? formatDuration(info.uptime_seconds) : undefined)],
              ['Boot time', info?.boottime ? formatDate(info.boottime) : undefined],
            ]),
            data: { version: info?.version, hostname: info?.hostname, uptime_seconds: info?.uptime_seconds },
          })
        })
      }

      if (args.action === 'alerts') {
        return withInstance(ctx, args, async (client) => {
          const alerts = await client.request('alert.list', [])
          const list = (Array.isArray(alerts) ? alerts : []).filter(
            (alert) => args.includeDismissed === true || alert.dismissed !== true,
          )
          if (!list.length) return ok({ action: 'alerts', text: 'No active alerts.', data: { alerts: [] } })
          const text = table(
            list.map((alert) => ({
              level: alert.level,
              text: truncate(alert.text, 100),
              when: formatDate(alert.datetime),
            })),
            [
              { key: 'level', header: 'Level' },
              { key: 'text', header: 'Alert' },
              { key: 'when', header: 'Since' },
            ],
          )
          return ok({ action: 'alerts', text: `${list.length} alert(s):\n\n${text}`, data: { alerts: list } })
        })
      }

      if (args.action === 'services') {
        return withInstance(ctx, args, async (client) => {
          const services = await client.request('service.query', [[]])
          const rows = (Array.isArray(services) ? services : [])
            .map((service) => ({
              name: service.service || service.name,
              state: service.state,
              enabled: service.enable ? 'yes' : 'no',
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          return ok({
            action: 'services',
            text: table(rows, [
              { key: 'name', header: 'Service' },
              { key: 'state', header: 'State' },
              { key: 'enabled', header: 'Enabled' },
            ]),
            data: { services: rows },
          })
        })
      }

      if (args.action === 'service') {
        const name = String(args.service || '').trim()
        if (!name) return fail('Pass "service" with the service name, for example "smb".')
        return withInstance(ctx, args, async (client) => {
          const services = await client.request('service.query', [[['service', '=', name]]])
          const service = Array.isArray(services) ? services[0] : null
          if (!service) return fail(`Unknown service "${name}".`)
          return ok({
            action: 'service',
            text: keyValues([
              ['Service', service.service || service.name],
              ['State', service.state],
              ['Enabled', service.enable ? 'yes' : 'no'],
              ['Start on boot', service.enable ? 'yes' : 'no'],
            ]),
            data: { service },
          })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const storageTool = define(
    'truenas_storage',
    [
      'Inspect and manage ZFS storage: pools, datasets, and scrub runs.',
      'Creating and deleting datasets changes storage layout; deletion requires confirm: true.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['pools', 'datasets', 'dataset', 'create_dataset', 'delete_dataset', 'scrub'],
          description: 'What to do.',
        },
        pool: { type: 'string', description: 'Pool name filter for "datasets", or the pool to scrub for "scrub".' },
        dataset: { type: 'string', description: 'Full dataset name for "dataset" and "delete_dataset", for example "tank/media".' },
        name: { type: 'string', description: 'Dataset to create for "create_dataset", for example "tank/media/photos".' },
        type: { type: 'string', enum: ['FILESYSTEM', 'VOLUME'], description: 'Dataset type for "create_dataset" (default FILESYSTEM).' },
        comments: { type: 'string', description: 'Comment for a created dataset.' },
        compression: { type: 'string', description: 'Compression for a created dataset, for example "LZ4", "ZSTD", or "INHERIT".' },
        recursive: { type: 'boolean', description: 'Recursive delete ("delete_dataset").' },
        force: { type: 'boolean', description: 'Force delete ("delete_dataset").' },
        threshold: { type: 'number', description: 'Scrub threshold in days ("scrub", default 35). 0 forces a scrub run.' },
        limit: { type: 'number', description: 'Maximum rows to list (default 100 for datasets).' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      if (args.action === 'pools') {
        return withInstance(ctx, args, async (client) => {
          const pools = await client.request('pool.query', [])
          const rows = (Array.isArray(pools) ? pools : []).map((pool) => ({
            name: pool.name,
            status: pool.status,
            healthy: pool.healthy === false ? 'no' : 'yes',
            size: formatBytes(pool.size),
            allocated: formatBytes(pool.allocated),
            free: formatBytes(pool.free),
            frag: Number.isFinite(pool.fragmentation) ? `${pool.fragmentation}%` : '—',
          }))
          if (!rows.length) return ok({ action: 'pools', text: 'No pools found.', data: { pools: [] } })
          return ok({
            action: 'pools',
            text: table(rows, [
              { key: 'name', header: 'Pool' },
              { key: 'status', header: 'Status' },
              { key: 'healthy', header: 'Healthy' },
              { key: 'size', header: 'Size' },
              { key: 'allocated', header: 'Used' },
              { key: 'free', header: 'Free' },
              { key: 'frag', header: 'Frag' },
            ]),
            data: { pools: rows },
          })
        })
      }

      if (args.action === 'datasets') {
        return withInstance(ctx, args, async (client) => {
          const all = await client.request('pool.dataset.query', [[]])
          const pool = String(args.pool || '').trim().replace(/\/+$/, '')
          const limit = Number(args.limit) > 0 ? Number(args.limit) : 100
          const filtered = (Array.isArray(all) ? all : []).filter(
            (dataset) => !pool || dataset.id === pool || dataset.id.startsWith(`${pool}/`),
          )
          const rows = filtered.slice(0, limit).map((dataset) => ({
            id: dataset.id,
            type: dataset.type,
            used: formatBytes(dataset.used?.parsed ?? dataset.used),
            available: formatBytes(dataset.available?.parsed ?? dataset.available),
            compression: dataset.compression?.value ?? dataset.compression,
            mountpoint: dataset.mountpoint,
          }))
          if (!rows.length) return ok({ action: 'datasets', text: pool ? `No datasets under "${pool}".` : 'No datasets found.', data: { datasets: [] } })
          const more = filtered.length > rows.length ? `\n… ${filtered.length - rows.length} more (raise "limit")` : ''
          return ok({
            action: 'datasets',
            text: `${filtered.length} dataset(s):\n\n${table(rows, [
              { key: 'id', header: 'Dataset' },
              { key: 'type', header: 'Type' },
              { key: 'used', header: 'Used' },
              { key: 'available', header: 'Available' },
              { key: 'compression', header: 'Compression' },
              { key: 'mountpoint', header: 'Mount point' },
            ])}${more}`,
            data: { datasets: rows },
          })
        })
      }

      if (args.action === 'dataset') {
        const id = String(args.dataset || '').trim()
        if (!id) return fail('Pass "dataset" with the full dataset name, for example "tank/media".')
        return withInstance(ctx, args, async (client) => {
          const dataset = await client.request('pool.dataset.get_instance', [id])
          return ok({
            action: 'dataset',
            text: keyValues([
              ['Dataset', dataset?.id],
              ['Type', dataset?.type],
              ['Used', formatBytes(dataset?.used?.parsed ?? dataset?.used)],
              ['Available', formatBytes(dataset?.available?.parsed ?? dataset?.available)],
              ['Quota', dataset?.quota?.parsed ? formatBytes(dataset.quota.parsed) : undefined],
              ['Compression', dataset?.compression?.value ?? dataset?.compression],
              ['Recordsize', dataset?.recordsize?.value ?? dataset?.recordsize],
              ['Mount point', dataset?.mountpoint],
              ['Encrypted', dataset?.encrypted ? 'yes' : 'no'],
              ['Comment', dataset?.comments],
            ]),
            data: { dataset },
          })
        })
      }

      if (args.action === 'create_dataset') {
        const name = String(args.name || args.dataset || '').trim()
        if (!name) return fail('Pass "name" with the dataset to create, for example "tank/media/photos".')
        return withInstance(ctx, args, async (client) => {
          const data = { name, type: args.type || 'FILESYSTEM' }
          if (args.comments) data.comments = args.comments
          if (args.compression) data.compression = args.compression
          const dataset = await client.request('pool.dataset.create', [data])
          return ok({
            action: 'create_dataset',
            text: keyValues([
              ['Created', dataset?.id || name],
              ['Type', dataset?.type],
              ['Mount point', dataset?.mountpoint],
              ['Compression', dataset?.compression?.value ?? dataset?.compression],
            ]),
            data: { dataset },
          })
        })
      }

      if (args.action === 'delete_dataset') {
        const refusal = requireConfirm(args, 'delete a dataset')
        if (refusal) return refusal
        const id = String(args.dataset || '').trim()
        if (!id) return fail('Pass "dataset" with the dataset to delete.')
        return withInstance(ctx, args, async (client) => {
          await client.request('pool.dataset.delete', [id, { recursive: args.recursive === true, force: args.force === true }])
          return ok({
            action: 'delete_dataset',
            text: `Deleted dataset ${id}${args.recursive ? ' recursively' : ''}.`,
          })
        })
      }

      if (args.action === 'scrub') {
        const pool = String(args.pool || '').trim()
        if (!pool) return fail('Pass "pool" with the pool to scrub.')
        return withInstance(ctx, args, async (client) => {
          const threshold = Number.isFinite(args.threshold) ? Number(args.threshold) : 35
          await client.request('pool.scrub.run', [pool, threshold])
          return ok({
            action: 'scrub',
            text:
              threshold === 0
                ? `Started a scrub of pool ${pool}.`
                : `Scrub requested for pool ${pool} (starts only when the last scrub is older than ${threshold} days; pass threshold 0 to force it).`,
          })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const snapshotTool = define(
    'truenas_snapshots',
    [
      'Manage ZFS snapshots: list them for a dataset, create one, delete one, clone one into a new dataset, or roll a dataset back to one.',
      'Rollback is destructive: newer data is lost. It and delete require confirm: true.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: { type: 'string', enum: ['list', 'create', 'delete', 'rollback', 'clone'], description: 'What to do.' },
        dataset: { type: 'string', description: 'Dataset for "list" or "create", for example "tank/media".' },
        name: { type: 'string', description: 'Snapshot name for "create" (without the dataset prefix).' },
        snapshot: { type: 'string', description: 'Full snapshot id for "delete", "rollback" and "clone", for example "tank/media@daily".' },
        target: { type: 'string', description: 'New dataset name for "clone".' },
        recursive: { type: 'boolean', description: 'Recursive create, delete, or rollback.' },
        recursiveClones: { type: 'boolean', description: 'Also destroy clones on rollback ("rollback").' },
        limit: { type: 'number', description: 'Maximum snapshots to list (default 50).' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      if (args.action === 'list') {
        const dataset = String(args.dataset || '').trim()
        return withInstance(ctx, args, async (client) => {
          const filters = dataset ? [[['dataset', '=', dataset]]] : [[]]
          const snapshots = await client.request('pool.snapshot.query', filters)
          const limit = Number(args.limit) > 0 ? Number(args.limit) : 50
          const list = (Array.isArray(snapshots) ? snapshots : []).slice(0, limit)
          if (!list.length) return ok({ action: 'list', text: dataset ? `No snapshots for ${dataset}.` : 'No snapshots found.', data: { snapshots: [] } })
          return ok({
            action: 'list',
            text: table(
              list.map((snapshot) => ({
                id: snapshot.id || `${snapshot.dataset}@${snapshot.name}`,
                created: formatDate(snapshot.properties?.creation?.parsed ?? snapshot.properties?.creation?.value),
                used: formatBytes(snapshot.properties?.used?.parsed ?? snapshot.properties?.used?.value),
              })),
              [
                { key: 'id', header: 'Snapshot' },
                { key: 'created', header: 'Created' },
                { key: 'used', header: 'Used' },
              ],
            ),
            data: { snapshots: list.map((snapshot) => snapshot.id) },
          })
        })
      }

      if (args.action === 'create') {
        const dataset = String(args.dataset || '').trim()
        if (!dataset) return fail('Pass "dataset" with the dataset to snapshot.')
        return withInstance(ctx, args, async (client) => {
          const data = { dataset }
          if (args.name) data.name = String(args.name).trim()
          if (args.recursive === true) data.recursive = true
          const snapshot = await client.request('pool.snapshot.create', [data])
          const id = snapshot?.id || `${dataset}@${data.name || '(generated)'}`
          return ok({
            action: 'create',
            text: `Created snapshot ${id}${data.recursive ? ' (recursive)' : ''}.`,
            data: { id },
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a snapshot')
        if (refusal) return refusal
        const id = String(args.snapshot || '').trim()
        if (!id) return fail('Pass "snapshot" with the full snapshot id.')
        return withInstance(ctx, args, async (client) => {
          await client.request('pool.snapshot.delete', [id, { recursive: args.recursive === true }])
          return ok({ action: 'delete', text: `Deleted snapshot ${id}${args.recursive ? ' recursively' : ''}.` })
        })
      }

      if (args.action === 'rollback') {
        const refusal = requireConfirm(args, 'roll back a dataset')
        if (refusal) return refusal
        const id = String(args.snapshot || '').trim()
        if (!id) return fail('Pass "snapshot" with the full snapshot id to roll back to.')
        return withInstance(ctx, args, async (client) => {
          await client.request('pool.snapshot.rollback', [
            id,
            {
              recursive: args.recursive === true,
              recursive_clones: args.recursiveClones === true,
            },
          ])
          return ok({
            action: 'rollback',
            text: `Rolled back to ${id}. Data written after this snapshot has been discarded.`,
          })
        })
      }

      if (args.action === 'clone') {
        const snapshot = String(args.snapshot || '').trim()
        const target = String(args.target || '').trim()
        if (!snapshot) return fail('Pass "snapshot" with the full snapshot id to clone.')
        if (!target) return fail('Pass "target" with the new dataset name.')
        return withInstance(ctx, args, async (client) => {
          await client.request('pool.snapshot.clone', [{ snapshot, dataset_dst: target }])
          return ok({ action: 'clone', text: `Cloned ${snapshot} into dataset ${target}.` })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const shareTool = define(
    'truenas_shares',
    [
      'Inspect and manage SMB and NFS shares.',
      'Creating a share points it at an existing dataset path, for example "/mnt/tank/media". Deleting a share requires confirm: true.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: { type: 'string', enum: ['list', 'smb', 'nfs', 'create_smb', 'create_nfs', 'delete', 'set_enabled'], description: 'What to do.' },
        kind: { type: 'string', enum: ['smb', 'nfs'], description: 'Share protocol for "delete" and "set_enabled".' },
        id: { type: 'number', description: 'Share id for "delete" and "set_enabled".' },
        name: { type: 'string', description: 'Share name for "create_smb" (defaults to the last path segment).' },
        path: { type: 'string', description: 'Local path to share, starting with /mnt/, for example "/mnt/tank/media".' },
        comment: { type: 'string', description: 'Comment for the share.' },
        enabled: { type: 'boolean', description: 'Enabled flag for "set_enabled".' },
        networks: { type: 'array', items: { type: 'string' }, description: 'Authorized CIDR networks for an NFS share.' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'Authorized hosts for an NFS share.' },
        readOnly: { type: 'boolean', description: 'Export an NFS share read-only.' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      if (args.action === 'list' || args.action === 'smb' || args.action === 'nfs') {
        return withInstance(ctx, args, async (client) => {
          const wantSmb = args.action !== 'nfs'
          const wantNfs = args.action !== 'smb'
          const [smb, nfs] = await Promise.all([
            wantSmb ? client.request('sharing.smb.query', []) : Promise.resolve([]),
            wantNfs ? client.request('sharing.nfs.query', []) : Promise.resolve([]),
          ])
          const rows = [
            ...(Array.isArray(smb) ? smb : []).map((share) => ({
              kind: 'SMB',
              id: share.id,
              name: share.name,
              path: share.path,
              enabled: share.enabled ? 'yes' : 'no',
              comment: truncate(share.comment, 60),
            })),
            ...(Array.isArray(nfs) ? nfs : []).map((share) => ({
              kind: 'NFS',
              id: share.id,
              name: share.path?.split('/').pop() || share.path,
              path: share.path,
              enabled: share.enabled ? 'yes' : 'no',
              comment: truncate(share.comment, 60),
            })),
          ]
          if (!rows.length) return ok({ action: args.action, text: 'No shares found.', data: { shares: [] } })
          return ok({
            action: args.action,
            text: table(rows, [
              { key: 'kind', header: 'Kind' },
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'path', header: 'Path' },
              { key: 'enabled', header: 'Enabled' },
              { key: 'comment', header: 'Comment' },
            ]),
            data: { shares: rows },
          })
        })
      }

      if (args.action === 'create_smb') {
        const path = String(args.path || '').trim()
        if (!path) return fail('Pass "path" with the dataset path to share, for example "/mnt/tank/media".')
        const name = String(args.name || path.split('/').filter(Boolean).pop() || '').trim()
        return withInstance(ctx, args, async (client) => {
          const data = { path, name }
          if (args.comment) data.comment = args.comment
          if (args.enabled === false) data.enabled = false
          const share = await client.request('sharing.smb.create', [data])
          return ok({
            action: 'create_smb',
            text: keyValues([
              ['Created SMB share', share?.name],
              ['ID', share?.id],
              ['Path', share?.path],
              ['Enabled', share?.enabled ? 'yes' : 'no'],
            ]),
            data: { share },
          })
        })
      }

      if (args.action === 'create_nfs') {
        const path = String(args.path || '').trim()
        if (!path) return fail('Pass "path" with the dataset path to export, for example "/mnt/tank/media".')
        return withInstance(ctx, args, async (client) => {
          const data = { path }
          if (args.comment) data.comment = args.comment
          if (Array.isArray(args.networks) && args.networks.length) data.networks = args.networks
          if (Array.isArray(args.hosts) && args.hosts.length) data.hosts = args.hosts
          if (args.readOnly === true) data.ro = true
          const share = await client.request('sharing.nfs.create', [data])
          return ok({
            action: 'create_nfs',
            text: keyValues([
              ['Created NFS share', share?.path],
              ['ID', share?.id],
              ['Networks', Array.isArray(share?.networks) ? share.networks.join(', ') || 'all' : undefined],
              ['Read only', share?.ro ? 'yes' : 'no'],
            ]),
            data: { share },
          })
        })
      }

      if (args.action === 'set_enabled') {
        const kind = String(args.kind || '').trim()
        if (!['smb', 'nfs'].includes(kind)) return fail('Pass "kind" as "smb" or "nfs".')
        if (!Number.isInteger(args.id)) return fail('Pass "id" with the share id.')
        return withInstance(ctx, args, async (client) => {
          const enabled = args.enabled !== false
          const share = await client.request(`sharing.${kind}.update`, [args.id, { enabled }])
          return ok({
            action: 'set_enabled',
            text: `${kind.toUpperCase()} share ${args.id} is now ${share?.enabled === false ? 'disabled' : 'enabled'}.`,
            data: { share },
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a share')
        if (refusal) return refusal
        const kind = String(args.kind || '').trim()
        if (!['smb', 'nfs'].includes(kind)) return fail('Pass "kind" as "smb" or "nfs".')
        if (!Number.isInteger(args.id)) return fail('Pass "id" with the share id, as shown by action "list".')
        return withInstance(ctx, args, async (client) => {
          await client.request(`sharing.${kind}.delete`, [args.id])
          return ok({ action: 'delete', text: `Deleted ${kind.toUpperCase()} share ${args.id}.` })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const appsTool = define(
    'truenas_apps',
    [
      'Work with TrueNAS applications (the Apps catalog): list them with state and versions, read one or its configuration, start, stop, or redeploy it,',
      'install a custom app from a Docker Compose document, delete one, and manage the Docker registries the NAS pulls images from.',
      'Starting, stopping, redeploying, creating and deleting run as jobs and are waited on before returning.',
      'Registry passwords and custom-app definitions are collected from the user in the conversation first; never guess them, and never repeat a password back.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'config',
            'start',
            'stop',
            'restart',
            'create_custom',
            'delete',
            'registry_list',
            'registry_add',
            'registry_update',
            'registry_remove',
          ],
          description: 'What to do.',
        },
        app: {
          type: 'string',
          description:
            'Application name for "get", "config", "start", "stop", "restart", "create_custom" and "delete". Custom app names must match ^[a-z]([-a-z0-9]*[a-z0-9])?$ (lowercase letters, digits, dashes, at most 40 characters).',
        },
        state: { type: 'string', description: 'Only list apps in this state, for example "RUNNING" ("list").' },
        compose: {
          type: 'string',
          description:
            'Docker Compose document for "create_custom", as YAML text with a top-level "services:" section. Use this or "composeObject", not both.',
        },
        composeObject: {
          type: 'object',
          additionalProperties: true,
          description: 'The same Compose document already parsed into an object ("create_custom").',
        },
        removeImages: { type: 'boolean', description: 'Also remove the Docker images when deleting an app ("delete", default true).' },
        registry: {
          type: 'string',
          description: 'Registry id or name, for "registry_update" and "registry_remove".',
        },
        registryName: { type: 'string', description: 'Short name of the registry ("registry_add"), for example "ghcr".' },
        registryUri: {
          type: 'string',
          description: 'Registry endpoint ("registry_add" and "registry_update"); defaults on the NAS to https://index.docker.io/v1/.',
        },
        registryUsername: { type: 'string', description: 'Account that owns the registry credentials ("registry_add" and "registry_update").' },
        registryPassword: {
          type: 'string',
          description:
            'Password or access token for the registry ("registry_add" and "registry_update"). Ask the user for it; it is written to the NAS and never returned by this tool.',
        },
        registryDescription: { type: 'string', description: 'Optional note for the registry ("registry_add" and "registry_update").' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const apps = await client.request('app.query', [[], { order_by: ['name'] }])
          const filter = String(args.state || '').toUpperCase()
          const rows = (Array.isArray(apps) ? apps : [])
            .filter((app) => !filter || String(app.state).toUpperCase() === filter)
            .map((app) => ({
              name: app.name,
              state: app.state,
              version: app.human_version || app.version,
              upgrade: app.upgrade_available ? 'yes' : 'no',
              custom: app.custom_app ? 'yes' : 'no',
            }))
          if (!rows.length) return ok({ action: 'list', text: filter ? `No apps in state ${filter}.` : 'No apps installed.', data: { apps: [] } })
          return ok({
            action: 'list',
            text: table(rows, [
              { key: 'name', header: 'App' },
              { key: 'state', header: 'State' },
              { key: 'version', header: 'Version' },
              { key: 'upgrade', header: 'Update' },
              { key: 'custom', header: 'Custom' },
            ]),
            data: { apps: rows },
          })
        })
      }

      if (args.action === 'registry_list') {
        return withInstance(ctx, args, async (client) => {
          const registries = await client.request('app.registry.query', [[], { order_by: ['name'] }])
          const rows = (Array.isArray(registries) ? registries : []).map((registry) => ({
            id: registry.id,
            name: registry.name,
            uri: registry.uri,
            user: registry.username,
            description: registry.description || '',
          }))
          if (!rows.length) return ok({ action: 'registry_list', text: 'No Docker registry is configured on this system.', data: { registries: [] } })
          return ok({
            action: 'registry_list',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'uri', header: 'Endpoint' },
              { key: 'user', header: 'User' },
            ]),
            data: { registries: rows },
          })
        })
      }

      if (args.action === 'registry_add' || args.action === 'registry_update') {
        return withInstance(ctx, args, async (client) => {
          const payload = {}
          const name = String(args.registryName || '').trim()
          if (name) payload.name = name
          if (args.registryUri !== undefined) payload.uri = String(args.registryUri).trim()
          if (args.registryUsername !== undefined) payload.username = String(args.registryUsername).trim()
          if (args.registryPassword !== undefined) {
            const password = String(args.registryPassword)
            if (!password.trim()) return fail('The registry password is empty. Ask the user for it instead of sending a blank value.')
            payload.password = password
          }
          if (args.registryDescription !== undefined) payload.description = String(args.registryDescription)

          const action = args.action
          let entry
          let existingName
          if (action === 'registry_add') {
            const missing = ['name', 'username', 'password'].filter((field) => !payload[field])
            if (missing.length) {
              return fail(
                `A registry needs ${missing.map((field) => `"${field}"`).join(', ')}. Ask the user for the missing values, then call again.`,
              )
            }
            entry = await client.request('app.registry.create', [payload])
          } else {
            const target = await resolveRegistry(client, args.registry)
            if (!target.ok) return fail(target.error)
            if (!Object.keys(payload).length) return fail('Pass at least one registry field to change: registryName, registryUri, registryUsername, registryPassword or registryDescription.')
            existingName = target.name
            entry = await client.request('app.registry.update', [target.id, payload])
          }

          const saved = entry && typeof entry === 'object' ? entry : {}
          const registryName = payload.name || saved.name || existingName || ''
          const summary = keyValues([
            ['Registry', registryName],
            ['Endpoint', payload.uri || saved.uri],
            ['User', payload.username || saved.username],
            ['Id', saved.id],
          ])
          return ok({
            action,
            text:
              `${action === 'registry_add' ? 'Added' : 'Updated'} registry "${registryName}". The password is stored on the NAS and is never shown again.\n${summary}`,
            data: { registry: { id: saved.id, name: registryName, uri: payload.uri || saved.uri, username: payload.username || saved.username, description: payload.description || saved.description || '' } },
          })
        })
      }

      if (args.action === 'registry_remove') {
        const refusal = requireConfirm(args, 'remove a registry')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const target = await resolveRegistry(client, args.registry)
          if (!target.ok) return fail(target.error)
          await client.request('app.registry.delete', [target.id])
          return ok({ action: 'registry_remove', text: `Removed registry "${target.name}" (id ${target.id}).`, data: { id: target.id, name: target.name } })
        })
      }

      const appName = String(args.app || '').trim()
      if (!appName) return fail('Pass "app" with the application name.')

      if (args.action === 'create_custom') {
        const checkedName = checkAppName(appName)
        if (!checkedName.ok) return fail(checkedName.error)
        const compose = readCompose(args)
        if (!compose.ok) return fail(compose.error)
        return withInstance(ctx, args, async (client) => {
          const payload = { custom_app: true, app_name: appName }
          if (compose.kind === 'object') payload.custom_compose_config = compose.value
          else payload.custom_compose_config_string = compose.value
          const jobId = await client.request('app.create', [payload])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          const installed = await client.request('app.query', [[['name', '=', appName]], { get: true }])
          const entry = Array.isArray(installed) ? installed[0] : installed
          return ok({
            action: 'create_custom',
            text: [
              `Created custom app ${appName}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
              keyValues([
                ['State', entry?.state],
                ['Version', entry?.human_version || entry?.version],
                ['Custom app', 'yes'],
              ]),
              'Run "list" in a moment to watch it reach RUNNING, or "get" for the portal URL.',
            ].join('\n'),
            data: { app: { name: appName, state: entry?.state || 'DEPLOYING' }, job: finished },
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, `delete app "${appName}"`)
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const removeImages = args.removeImages === undefined ? true : Boolean(args.removeImages)
          const jobId = await client.request('app.delete', [appName, { remove_images: removeImages, remove_ix_volumes: false }])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          return ok({
            action: 'delete',
            text: `Deleted app ${appName}${removeImages ? ' and its images' : ''}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
            data: { job: finished },
          })
        })
      }

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const app = await client.request('app.get_instance', [appName])
          return ok({
            action: 'get',
            text: keyValues([
              ['App', app?.name],
              ['State', app?.state],
              ['Version', app?.human_version || app?.version],
              ['Update available', app?.upgrade_available ? 'yes' : 'no'],
              ['Latest version', app?.latest_version],
              ['Custom app', app?.custom_app ? 'yes' : 'no'],
              ['Portal', app?.active_workloads?.portals?.[0]?.value],
            ]),
            data: { app },
          })
        })
      }

      if (args.action === 'config') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('app.config', [appName])
          return ok({ action: 'config', text: jsonBlock(config, 8000), data: { config } })
        })
      }

      if (args.action === 'start' || args.action === 'stop') {
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request(`app.${args.action}`, [appName])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          return ok({
            action: args.action,
            text: `${args.action === 'start' ? 'Started' : 'Stopped'} app ${appName}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
            data: { job: finished },
          })
        })
      }

      if (args.action === 'restart') {
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('app.redeploy', [appName])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          return ok({
            action: 'restart',
            text: `Redeployed app ${appName}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
            data: { job: finished },
          })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const jobsTool = define(
    'truenas_jobs',
    [
      'Track long-running TrueNAS jobs: list recent jobs, inspect one, wait for one to finish, or abort one.',
      'Most mutating API methods return a job id; the curated tools already wait for the jobs they start.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: { type: 'string', enum: ['list', 'get', 'wait', 'abort'], description: 'What to do.' },
        id: { type: 'number', description: 'Job id for "get", "wait" and "abort".' },
        limit: { type: 'number', description: 'Maximum jobs to list (default 20).' },
        state: { type: 'string', description: 'Only jobs in this state, for example "FAILED" ("list").' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const limit = Number(args.limit) > 0 ? Number(args.limit) : 20
          const state = String(args.state || '').trim().toUpperCase()
          const filters = state ? [[['state', '=', state]]] : []
          const jobs = await client.request('core.get_jobs', [filters, { order_by: ['-id'], limit }])
          const rows = (Array.isArray(jobs) ? jobs : []).map((job) => ({
            id: job.id,
            state: job.state,
            method: job.method,
            progress: jobLine(job),
            started: formatDate(job.time_started?.$date ?? job.time_started),
          }))
          if (!rows.length) return ok({ action: 'list', text: 'No jobs found.', data: { jobs: [] } })
          return ok({
            action: 'list',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'state', header: 'State' },
              { key: 'method', header: 'Method' },
              { key: 'progress', header: 'Progress' },
              { key: 'started', header: 'Started' },
            ]),
            data: { jobs: rows },
          })
        })
      }

      const id = Number(args.id)
      if (!Number.isInteger(id)) return fail('Pass "id" with the job id.')

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const jobs = await client.request('core.get_jobs', [[['id', '=', id]]])
          const job = Array.isArray(jobs) ? jobs[0] : null
          if (!job) return fail(`Job ${id} not found.`)
          return ok({
            action: 'get',
            text: keyValues([
              ['Job', job.id],
              ['State', job.state],
              ['Method', job.method],
              ['Progress', jobLine(job)],
              ['Started', formatDate(job.time_started?.$date ?? job.time_started)],
              ['Finished', formatDate(job.time_finished?.$date ?? job.time_finished)],
              ['Error', job.error],
              ['Exception', truncate(job.exception, 300)],
              ['Result', job.result !== undefined ? jsonBlock(job.result, 2000) : undefined],
            ]),
            data: { job },
          })
        })
      }

      if (args.action === 'wait') {
        return withInstance(ctx, args, async (client) => {
          const finished = await client.waitJob(id, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({
            action: 'wait',
            text: `Job ${id} finished: ${finished.state}.\n\n${jsonBlock(finished.result, 4000)}`,
            data: { job: finished },
          })
        })
      }

      if (args.action === 'abort') {
        const refusal = requireConfirm(args, 'abort a running job')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          await client.request('core.job_abort', [id])
          return ok({ action: 'abort', text: `Aborted job ${id}.` })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )

  const networkTool = createNetworkTool(ctx)
  const usersTool = createUsersTool(ctx)
  const replicationTool = createReplicationTool(ctx)
  const cloudTool = createCloudTool(ctx)
  const alertsTool = createAlertsTool(ctx)

  return [
    instanceTool,
    systemTool,
    storageTool,
    snapshotTool,
    shareTool,
    appsTool,
    jobsTool,
    callTool,
    networkTool,
    usersTool,
    replicationTool,
    cloudTool,
    alertsTool,
  ]
}

