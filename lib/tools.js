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
import { createTasksTool } from './tools-tasks.js'
import { createReportingTool } from './tools-reporting.js'
import { createDockerTool } from './tools-docker.js'
import { createServicesTool } from './tools-services.js'
import { createCertsTool } from './tools-certs.js'
import { createDisksTool } from './tools-disks.js'
import { createVmsTool } from './tools-vms.js'
import { createIscsiTool } from './tools-iscsi.js'
import { createNvmetTool } from './tools-nvmet.js'
import { createFilesTool } from './tools-files.js'
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

async function resolvePool(client, args) {
  const byId = Number(args.poolId)
  const pools = await client.request('pool.query', [[], { select: ['id', 'name', 'status'], order_by: ['name'] }])
  const list = Array.isArray(pools) ? pools : []
  if (Number.isInteger(byId) && byId > 0) {
    const hit = list.find((pool) => pool.id === byId)
    return hit ? { ok: true, pool: hit } : { ok: false, error: `No pool with id ${byId}.` }
  }
  const name = String(args.pool || '').trim()
  if (!name) return { ok: false, error: 'Pass "pool" with the pool name (or "poolId").' }
  const hit = list.find((pool) => pool.name === name)
  return hit ? { ok: true, pool: hit } : { ok: false, error: `No pool named "${name}". Known pools: ${list.map((pool) => pool.name).join(', ') || '(none)'}.` }
}

// Config objects can embed secrets: system.general.config carries the UI
// certificate with its private key, and other namespaces keep passwords and
// keys. Nothing here should ever reach the model or the transcript.
const SECRET_KEY = /private|secret|password|passwd|key$|token|credential|chain_list|csr|certificate$/i

function redactSetting(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(value)) return '<redacted PEM>'
    return value
  }
  if (Array.isArray(value)) return depth > 2 ? '<redacted list>' : value.map((item) => redactSetting(item, depth + 1))
  if (typeof value === 'object') {
    if (depth > 2) return '<redacted object>'
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '<redacted>' : redactSetting(item, depth + 1)
    }
    return out
  }
  return value
}

function formatSetting(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length ? value.map((item) => (typeof item === 'object' ? JSON.stringify(redactSetting(item)) : String(item))).join(', ') : '—'
  if (typeof value === 'object') {
    const safe = redactSetting(value)
    const text = JSON.stringify(safe)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
  const text = String(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

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

function splitImageTag(image) {
  const tags = Array.isArray(image?.repo_tags) ? image.repo_tags : []
  const raw = tags[0] || image?.repository || image?.image || ''
  const [namePart] = String(raw).split('@')
  const lastColon = namePart.lastIndexOf(':')
  const lastSlash = namePart.lastIndexOf('/')
  if (lastColon > lastSlash) return [namePart.slice(0, lastColon), namePart.slice(lastColon + 1)]
  return [namePart, tags.length > 1 ? `+${tags.length - 1}` : '']
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
        action: {
          type: 'string',
          enum: [
            'info',
            'alerts',
            'services',
            'service',
            'boot_envs',
            'boot_activate',
            'update_status',
            'update_versions',
            'systemdataset',
            'ssh_config',
            'support',
            'tunables',
            'general',
            'general_update',
            'advanced',
            'advanced_update',
            'ntp',
            'ntp_add',
            'ntp_update',
            'ntp_remove',
            'boot_clone',
            'boot_keep',
            'boot_destroy',
            'boot_scrub',
            'update_run',
          ],
          description: 'What to read or do.',
        },
        service: { type: 'string', description: 'Service name for action "service", for example "smb" or "ssh".' },
        bootEnv: { type: 'string', description: 'Boot environment name for "boot_activate", for example "default-1".' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "boot_activate".' },
        includeDismissed: { type: 'boolean', description: 'Include dismissed alerts (action "alerts").' },
        general: { type: 'object', additionalProperties: true, description: 'Fields for "general_update", for example {"hostname":"nas"}. Read "general" first.' },
        advanced: { type: 'object', additionalProperties: true, description: 'Fields for "advanced_update", for example {"autotune":true}. Read "advanced" first.' },
        ntp: { type: 'object', additionalProperties: true, description: 'NTP server object for "ntp_add" ({"address":"pool.ntp.org"}) or the patch for "ntp_update".' },
        ntpId: { type: 'number', description: 'NTP server id for "ntp_update" and "ntp_remove".' },
        newBootEnv: { type: 'string', description: 'Name for the clone ("boot_clone").' },
        keep: { type: 'boolean', description: '"boot_keep": whether to protect the environment from automatic deletion.' },
        reboot: { type: 'boolean', description: '"update_run": reboot after installing (default false).' },
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

      if (args.action === 'boot_envs') {
        return withInstance(ctx, args, async (client) => {
          const envs = await client.request('boot.environment.query', [[], { select: ['id', 'name', 'active', 'activated', 'created', 'keep', 'can_activate'] }])
          const rows = (Array.isArray(envs) ? envs : []).map((env) => ({
            id: env.id || '',
            name: env.name || '',
            active: env.active ? 'yes' : '',
            activated: env.activated === true ? 'requested' : env.activated ? formatDate(env.activated) : '',
            keep: env.keep ? 'yes' : '',
            created: env.created ? formatDate(env.created) : '',
          }))
          if (!rows.length) return ok({ action: 'boot_envs', text: 'No boot environments reported.', data: { environments: [] } })
          return ok({
            action: 'boot_envs',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Boot environment' },
              { key: 'active', header: 'Active' },
              { key: 'activated', header: 'Activated by' },
              { key: 'keep', header: 'Keep' },
              { key: 'created', header: 'Created' },
            ]),
            data: { environments: rows },
          })
        })
      }

      if (args.action === 'boot_activate') {
        const refusal = requireConfirm(args, 'activate a different boot environment (this reboots the system)')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const name = String(args.bootEnv || '').trim()
          if (!name) return fail('Pass "bootEnv" with the boot environment name (action "boot_envs" lists them).')
          await client.request('boot.environment.activate', [name])
          return ok({
            action: 'boot_activate',
            text: `Activated boot environment "${name}". The system reboots into it; check truenas_jobs for the reboot.`,
            data: { name },
          })
        })
      }

      if (args.action === 'update_status') {
        return withInstance(ctx, args, async (client) => {
          const status = await client.request('update.status', [])
          const current = status?.current_version || {}
          const next = status?.new_version || null
          const progress = status?.update_download_progress || null
          let version = current.version || ''
          if (!version) {
            try {
              version = await client.request('system.version', [])
            } catch {
              version = ''
            }
          }
          const state = typeof status?.status === 'string' ? status.status.split('|')[0] : status?.status?.code || status?.code || '—'
          return ok({
            action: 'update_status',
            text: keyValues([
              ['State', state],
              ['Installed version', version || '—'],
              ['Train', current.train || '—'],
              ['Profile', [current.profile, current.matches_profile === false ? '(does not match)' : ''].filter(Boolean).join(' ') || '—'],
              ['Available update', next ? [next.version, next.train].filter(Boolean).join(' on ') : 'none'],
              ['Download progress', progress ? `${progress.percent ?? '?'}% ${progress.description || ''}`.trim() : '—'],
              ['Error', status?.error || '—'],
            ]),
            data: { status },
          })
        })
      }

      if (args.action === 'update_versions') {
        return withInstance(ctx, args, async (client) => {
          const versions = await client.request('update.available_versions', [])
          const list = Array.isArray(versions) ? versions : []
          return ok({
            action: 'update_versions',
            text: list.length ? list.map((version) => `- ${version}`).join('\n') : 'No update versions reported.',
            data: { versions: list },
          })
        })
      }

      if (args.action === 'systemdataset') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('systemdataset.config', [])
          const entries = Object.entries(config && typeof config === 'object' ? config : {})
          return ok({
            action: 'systemdataset',
            text: keyValues(entries.map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])),
            data: { config },
          })
        })
      }

      if (args.action === 'ssh_config') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('ssh.config', [])
          return ok({
            action: 'ssh_config',
            text: keyValues([
              ['Port', config?.tcpport],
              ['Password login', config?.passwordauth ? 'allowed' : 'disabled'],
              ['Kerberos auth', config?.kerberosauth ? 'enabled' : 'disabled'],
              ['TCP forwarding', config?.tcpfwd ? 'allowed' : 'disabled'],
              ['Compression', config?.compression ? 'enabled' : 'disabled'],
              ['Bind interfaces', Array.isArray(config?.bindiface) && config.bindiface.length ? config.bindiface.join(', ') : 'all'],
              ['Password login groups', Array.isArray(config?.password_login_groups) && config.password_login_groups.length ? config.password_login_groups.join(', ') : 'any'],
              ['Weak ciphers', Array.isArray(config?.weak_ciphers) && config.weak_ciphers.length ? config.weak_ciphers.join(', ') : 'none'],
              ['Extra options', config?.options || '—'],
            ]),
            data: { config },
          })
        })
      }

      if (args.action === 'support') {
        return withInstance(ctx, args, async (client) => {
          const [config, available] = await Promise.all([
            client.request('support.config', []),
            client.request('support.is_available', []),
          ])
          return ok({
            action: 'support',
            text: keyValues([
              ['Proactive support available', available ? 'yes' : 'no'],
              ['Enabled', config?.enabled ? 'yes' : 'no'],
              ['Name', config?.name || ''],
              ['Email', config?.email || ''],
              ['Secondary email', config?.secondary_email || ''],
              ['Phone', config?.phone || ''],
              ['Type', config?.type ? JSON.stringify(config.type) : ''],
            ]),
            data: { config, available },
          })
        })
      }

      if (args.action === 'tunables') {
        return withInstance(ctx, args, async (client) => {
          const tunables = await client.request('tunable.query', [[], { select: ['id', 'type', 'var', 'value', 'enabled', 'comment'] }])
          const rows = (Array.isArray(tunables) ? tunables : []).map((entry) => ({
            id: entry.id,
            type: entry.type,
            var: entry.var,
            value: truncate(entry.value, 50),
            enabled: entry.enabled ? 'yes' : 'no',
            comment: entry.comment || '',
          }))
          if (!rows.length) return ok({ action: 'tunables', text: 'No tunables configured.', data: { tunables: [] } })
          return ok({
            action: 'tunables',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'type', header: 'Type' },
              { key: 'var', header: 'Variable' },
              { key: 'value', header: 'Value' },
              { key: 'enabled', header: 'Enabled' },
              { key: 'comment', header: 'Comment' },
            ]),
            data: { tunables: rows },
          })
        })
      }

      if (args.action === 'general' || args.action === 'advanced') {
        const method = args.action === 'general' ? 'system.general.config' : 'system.advanced.config'
        return withInstance(ctx, args, async (client) => {
          const config = await client.request(method, [])
          const source = config && typeof config === 'object' ? config : {}
          const rows = Object.keys(source)
            .filter((key) => !['id'].includes(key))
            .sort()
            .map((key) => [key, formatSetting(source[key])])
          return ok({
            action: args.action,
            text: keyValues(rows.slice(0, 60)),
            data: { [args.action]: redactSetting(source) },
          })
        })
      }

      if (args.action === 'general_update' || args.action === 'advanced_update') {
        const patch = args.action === 'general_update' ? args.general : args.advanced
        if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
          return fail(`Pass "${args.action === 'general_update' ? 'general' : 'advanced'}" with the fields to change.`)
        }
        const method = args.action === 'general_update' ? 'system.general.update' : 'system.advanced.update'
        return withInstance(ctx, args, async (client) => {
          const updated = await client.request(method, [patch])
          return ok({
            action: args.action,
            text: `Updated ${Object.keys(patch).join(', ')}.${args.action === 'general_update' ? ' Changes to the UI address or certificate restart the web interface.' : ''}`,
            data: { applied: Object.keys(patch), config: updated },
          })
        })
      }

      if (args.action === 'ntp') {
        return withInstance(ctx, args, async (client) => {
          const servers = await client.request('system.ntpserver.query', [[], { order_by: ['address'] }])
          const rows = (Array.isArray(servers) ? servers : []).map((server) => ({
            id: server.id,
            address: server.address || '',
            prefer: server.prefer ? 'yes' : 'no',
            minpoll: server.minpoll ?? '',
            maxpoll: server.maxpoll ?? '',
          }))
          return ok({
            action: 'ntp',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'address', header: 'Server' },
                  { key: 'prefer', header: 'Prefer' },
                  { key: 'minpoll', header: 'Minpoll' },
                  { key: 'maxpoll', header: 'Maxpoll' },
                ])
              : 'No NTP servers configured.',
            data: { servers: rows },
          })
        })
      }

      if (args.action === 'ntp_add') {
        const server = args.ntp
        if (!server || typeof server !== 'object' || !server.address) return fail('Pass "ntp" with at least {"address":"pool.ntp.org"}.')
        return withInstance(ctx, args, async (client) => {
          const created = await client.request('system.ntpserver.create', [server])
          return ok({
            action: 'ntp_add',
            text: `Added NTP server ${created?.address || server.address}.`,
            data: { server: created },
          })
        })
      }

      if (args.action === 'ntp_update' || args.action === 'ntp_remove') {
        const id = Number(args.ntpId)
        if (!Number.isInteger(id) || id <= 0) return fail('Pass "ntpId" with the numeric id from action "ntp".')
        return withInstance(ctx, args, async (client) => {
          if (args.action === 'ntp_remove') {
            await client.request('system.ntpserver.delete', [id])
            return ok({ action: 'ntp_remove', text: `Removed NTP server ${id}.`, data: { id } })
          }
          const patch = args.ntp && typeof args.ntp === 'object' ? args.ntp : {}
          if (!Object.keys(patch).length) return fail('Pass "ntp" with the fields to change.')
          const updated = await client.request('system.ntpserver.update', [id, patch])
          return ok({ action: 'ntp_update', text: `Updated NTP server ${id}.`, data: { server: updated } })
        })
      }

      if (args.action === 'boot_clone') {
        const source = String(args.bootEnv || '').trim()
        const target = String(args.newBootEnv || '').trim()
        if (!source) return fail('Pass "bootEnv" with the environment to clone.')
        if (!target) return fail('Pass "newBootEnv" with the name for the clone.')
        return withInstance(ctx, args, async (client) => {
          await client.request('boot.environment.clone', [{ id: source, target }])
          return ok({ action: 'boot_clone', text: `Cloned boot environment ${source} to ${target}.`, data: { source, target } })
        })
      }

      if (args.action === 'boot_keep') {
        const id = String(args.bootEnv || '').trim()
        if (!id) return fail('Pass "bootEnv" with the environment name.')
        const keep = args.keep !== false
        return withInstance(ctx, args, async (client) => {
          await client.request('boot.environment.keep', [{ id, value: keep }])
          return ok({
            action: 'boot_keep',
            text: `${keep ? 'Protecting' : 'Unprotected'} boot environment ${id}${keep ? ' from automatic deletion' : ''}.`,
            data: { id, keep },
          })
        })
      }

      if (args.action === 'boot_destroy') {
        const refusal = requireConfirm(args, 'destroy a boot environment')
        if (refusal) return refusal
        const id = String(args.bootEnv || '').trim()
        if (!id) return fail('Pass "bootEnv" with the environment name.')
        return withInstance(ctx, args, async (client) => {
          await client.request('boot.environment.destroy', [{ id }])
          return ok({ action: 'boot_destroy', text: `Destroyed boot environment ${id}.`, data: { id } })
        })
      }

      if (args.action === 'boot_scrub') {
        return withInstance(ctx, args, async (client) => {
          await client.request('boot.scrub', [])
          return ok({ action: 'boot_scrub', text: 'Started a scrub of the boot pool.' })
        })
      }

      if (args.action === 'update_run') {
        const refusal = requireConfirm(args, 'install a system update')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const outcome = await client.request('update.run', [{ reboot: args.reboot === true }])
          if (typeof outcome === 'number') {
            const job = await client.waitJob(outcome, { timeoutMs: 3600000 })
            return ok({
              action: 'update_run',
              text: `Update ${job?.state || 'finished'}.${args.reboot ? ' The system reboots now.' : ' Reboot to boot into the new version.'}`,
              data: { job: job?.state },
            })
          }
          return ok({ action: 'update_run', text: 'Update requested.' })
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
          enum: [
            'pools',
            'datasets',
            'dataset',
            'create_dataset',
            'delete_dataset',
            'scrub',
            'pool_create',
            'pool_export',
            'pool_import_find',
            'pool_import',
            'pool_upgrade',
            'snapshot_hold',
            'snapshot_release',
          ],
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
        disks: { type: 'array', items: { type: 'string' }, description: 'Disks for "pool_create", for example ["sda","sdb"]. Every byte on them is destroyed.' },
        raidType: {
          type: 'string',
          description: 'Vdev type for "pool_create" (default STRIPE); for example MIRROR, RAIDZ1, RAIDZ2, RAIDZ3.',
        },
        guid: { type: 'string', description: 'Pool GUID for "pool_import", from "pool_import_find".' },
        poolId: { type: 'number', description: 'Pool id for "pool_export" and "pool_upgrade" (name works too via "pool").' },
        cascade: { type: 'boolean', description: 'For "pool_export": also delete attachments (shares, tasks) of the pool.' },
        restartServices: { type: 'boolean', description: 'For "pool_export": restart services holding files on the pool.' },
        snapshotId: { type: 'string', description: 'Snapshot id for "snapshot_hold" and "snapshot_release".' },
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

      if (args.action === 'pool_create') {
        const refusal = requireConfirm(args, 'create a pool, destroying everything on the chosen disks')
        if (refusal) return refusal
        const name = String(args.pool || '').trim()
        const disks = Array.isArray(args.disks) ? args.disks.map((disk) => String(disk)) : []
        if (!name) return fail('Pass "pool" with the name for the new pool.')
        if (!disks.length) return fail('Pass "disks" with the member disks, for example ["sda","sdb"].')
        return withInstance(ctx, args, async (client) => {
          const data = {
            name,
            topology: { data: [{ type: String(args.raidType || 'STRIPE').toUpperCase(), disks }] },
          }
          if (args.encrypt === true) data.encryption = true
          const outcome = await client.request('pool.create', [data])
          if (typeof outcome === 'number') {
            const job = await client.waitJob(outcome, { timeoutMs: Math.min(ctx.config?.jobTimeoutMs || 600000, 600000) })
            return ok({
              action: 'pool_create',
              text: `Created pool ${name} (${data.topology.data[0].type}) on ${disks.join(', ')}: ${job?.state || 'unknown'}.`,
              data: { name, disks, job: job?.state },
            })
          }
          return ok({ action: 'pool_create', text: `Pool ${name} created.`, data: { name } })
        })
      }

      if (args.action === 'pool_export') {
        const refusal = requireConfirm(args, 'export a pool, detaching it from this system')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const target = await resolvePool(client, args)
          if (!target.ok) return fail(target.error)
          const outcome = await client.request('pool.export', [
            target.pool.id,
            { cascade: args.cascade === true, restart_services: args.restartServices === true, destroy: false },
          ])
          if (typeof outcome === 'number') await client.waitJob(outcome, { timeoutMs: 300000 })
          return ok({
            action: 'pool_export',
            text: `Exported pool ${target.pool.name}. Its data is untouched on disk; import it again to use it.`,
            data: { pool: target.pool.name },
          })
        })
      }

      if (args.action === 'pool_import_find') {
        return withInstance(ctx, args, async (client) => {
          const found = await client.request('pool.import_find', [])
          const rows = (Array.isArray(found) ? found : []).map((pool) => ({
            name: pool.name || '',
            guid: pool.guid || '',
            status: pool.status || '',
            disks: Array.isArray(pool.disks) ? pool.disks.join(', ') : '',
          }))
          return ok({
            action: 'pool_import_find',
            text: rows.length
              ? table(rows, [
                  { key: 'name', header: 'Pool' },
                  { key: 'guid', header: 'GUID' },
                  { key: 'status', header: 'Status' },
                  { key: 'disks', header: 'Disks' },
                ])
              : 'No importable pools were found on the attached disks.',
            data: { pools: rows },
          })
        })
      }

      if (args.action === 'pool_import') {
        const guid = String(args.guid || '').trim()
        if (!guid) return fail('Pass "guid" from action "pool_import_find".')
        return withInstance(ctx, args, async (client) => {
          const data = { guid }
          if (args.pool) data.name = String(args.pool).trim()
          await client.request('pool.import_pool', [data])
          return ok({
            action: 'pool_import',
            text: `Imported pool ${data.name || guid}.`,
            data: { guid, name: data.name },
          })
        })
      }

      if (args.action === 'pool_upgrade') {
        const refusal = requireConfirm(args, 'upgrade a pool, after which older TrueNAS releases cannot import it')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const target = await resolvePool(client, args)
          if (!target.ok) return fail(target.error)
          await client.request('pool.upgrade', [target.pool.id])
          return ok({
            action: 'pool_upgrade',
            text: `Upgraded pool ${target.pool.name} to the latest feature flags. Older releases can no longer import it.`,
            data: { pool: target.pool.name },
          })
        })
      }

      if (args.action === 'snapshot_hold' || args.action === 'snapshot_release') {
        const id = String(args.snapshotId || '').trim()
        if (!id) return fail('Pass "snapshotId" with the full snapshot id, for example "tank/media@daily".')
        return withInstance(ctx, args, async (client) => {
          const method = args.action === 'snapshot_hold' ? 'pool.snapshot.hold' : 'pool.snapshot.release'
          await client.request(method, [id, { recursive: args.recursive === true }])
          return ok({
            action: args.action,
            text: `${args.action === 'snapshot_hold' ? 'Held' : 'Released'} ${id}${args.recursive ? ' recursively' : ''}.`,
            data: { snapshot: id },
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
            'upgrade',
            'rollback',
            'pull_images',
            'update_config',
            'images',
            'outdated_images',
            'rollback_versions',
            'convert_to_custom',
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
        appVersion: {
          type: 'string',
          description: 'Target version for "upgrade" (default "latest") or the version to return to for "rollback".',
        },
        redeploy: { type: 'boolean', description: 'Redeploy after pulling images ("pull_images", default true).' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for destructive actions (delete, convert_to_custom, registry_remove).' },
        snapshotHostpaths: { type: 'boolean', description: 'Snapshot host-path volumes before "upgrade" (default false).' },
        values: {
          type: 'object',
          additionalProperties: true,
          description: 'Configuration values for "update_config" (catalog apps) or the upgrade.',
        },
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
      const fleetWide = args.action === 'images' || args.action === 'outdated_images'
      if (!appName && !fleetWide) return fail('Pass "app" with the application name.')

      if (args.action === 'upgrade') {
        const version = String(args.appVersion || 'latest').trim() || 'latest'
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('app.upgrade', [
            appName,
            { app_version: version, snapshot_hostpaths: args.snapshotHostpaths === true },
          ])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          const current = await client.request('app.query', [[['name', '=', appName]], { get: true }])
          const entry = Array.isArray(current) ? current[0] : current
          return ok({
            action: 'upgrade',
            text: `Upgraded ${appName} to ${version}${finished ? ` (job ${finished.id} succeeded)` : ''}.\nState: ${entry?.state}\nVersion: ${entry?.human_version || entry?.version}`,
            data: { app: { name: appName, state: entry?.state, version: entry?.human_version || entry?.version }, job: finished },
          })
        })
      }

      if (args.action === 'rollback') {
        const version = String(args.appVersion || '').trim()
        if (!version) return fail('Pass "appVersion" with the version to roll back to (action "list" shows the current version).')
        const refusal = requireConfirm(args, `roll back app "${appName}" to ${version}`)
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('app.rollback', [appName, { app_version: version }])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          const current = await client.request('app.query', [[['name', '=', appName]], { get: true }])
          const entry = Array.isArray(current) ? current[0] : current
          return ok({
            action: 'rollback',
            text: `Rolled ${appName} back to ${version}${finished ? ` (job ${finished.id} succeeded)` : ''}.\nState: ${entry?.state}`,
            data: { app: { name: appName, state: entry?.state }, job: finished },
          })
        })
      }

      if (args.action === 'pull_images') {
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('app.pull_images', [appName, { redeploy: args.redeploy !== false }])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          return ok({
            action: 'pull_images',
            text: `Pulled images for ${appName}${args.redeploy === false ? '' : ' and redeployed'}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
            data: { job: finished },
          })
        })
      }

      if (args.action === 'update_config') {
        const payload = {}
        if (args.values && typeof args.values === 'object') payload.values = args.values
        if (args.compose !== undefined || args.composeObject !== undefined) {
          const compose = readCompose(args)
          if (!compose.ok) return fail(compose.error)
          if (compose.kind === 'object') payload.custom_compose_config = compose.value
          else payload.custom_compose_config_string = compose.value
        }
        if (!Object.keys(payload).length) {
          return fail('Pass "values", "compose" or "composeObject" with the configuration to apply (action "config" shows the current values).')
        }
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('app.update', [appName, payload])
          const finished = Number.isInteger(jobId) ? await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs }) : null
          return ok({
            action: 'update_config',
            text: `Updated the configuration of ${appName}${finished ? ` (job ${finished.id} succeeded)` : ''}.`,
            data: { job: finished },
          })
        })
      }

      if (args.action === 'images') {
        return withInstance(ctx, args, async (client) => {
          const images = await client.request('app.image.query', [[], {}])
          const rows = (Array.isArray(images) ? images : []).map((image) => {
            const [repository, tag] = splitImageTag(image)
            return {
              id: String(image.id || '').replace(/^sha256:/, '').slice(0, 19),
              repository,
              tag,
              size: image.size ? formatBytes(image.size) : '',
              dangling: image.dangling ? 'yes' : '',
              update: image.update_available ? 'yes' : '',
            }
          })
          if (!rows.length) return ok({ action: 'images', text: 'No application images.', data: { images: [] } })
          return ok({
            action: 'images',
            text: table(rows, [
              { key: 'id', header: 'Image' },
              { key: 'repository', header: 'Repository' },
              { key: 'tag', header: 'Tag' },
              { key: 'size', header: 'Size' },
              { key: 'update', header: 'Update' },
              { key: 'dangling', header: 'Dangling' },
            ]),
            data: { images: rows },
          })
        })
      }

      if (args.action === 'outdated_images') {
        return withInstance(ctx, args, async (client) => {
          const outdated = await client.request('app.outdated_docker_images', [])
          const summary = Array.isArray(outdated)
            ? outdated
            : Object.values(outdated && typeof outdated === 'object' ? outdated : {})
          const lines = []
          if (Array.isArray(outdated)) {
            for (const item of outdated) {
              if (item && typeof item === 'object') {
                const name = item.image || item.repository || item.name || 'image'
                const tag = item.tag ? `:${item.tag}` : ''
                lines.push(`- ${name}${tag}`)
              } else lines.push(`- ${item}`)
            }
          } else if (outdated && typeof outdated === 'object') {
            for (const [key, value] of Object.entries(outdated)) {
              const count = Array.isArray(value) ? value.length : value
              lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : count}`)
            }
          }
          return ok({
            action: 'outdated_images',
            text: lines.length ? `Outdated image checks:\n${lines.join('\n')}` : 'No outdated image information reported.',
            data: { outdated },
          })
        })
      }

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

      if (args.action === 'rollback_versions') {
        const name = String(args.app || '').trim()
        if (!name) return fail('Pass "app" with the application name.')
        return withInstance(ctx, args, async (client) => {
          const versions = await client.request('app.rollback_versions', [name])
          const rows = (Array.isArray(versions) ? versions : []).map((version) => ({
            version: typeof version === 'string' ? version : version?.version || String(version),
          }))
          return ok({
            action: 'rollback_versions',
            text: rows.length
              ? `${name} — versions available to roll back to:\n${table(rows, [{ key: 'version', header: 'Version' }])}`
              : `No rollback versions recorded for ${name}.`,
            data: { app: name, versions: rows.map((row) => row.version) },
          })
        })
      }

      if (args.action === 'convert_to_custom') {
        const refusal = requireConfirm(args, 'convert a catalog application into a custom application')
        if (refusal) return refusal
        const name = String(args.app || '').trim()
        if (!name) return fail('Pass "app" with the catalog application to convert.')
        return withInstance(ctx, args, async (client) => {
          await client.request('app.convert_to_custom', [name])
          return ok({
            action: 'convert_to_custom',
            text: `Converted ${name} to a custom application. It no longer receives catalog updates.`,
            data: { app: name },
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
  const tasksTool = createTasksTool(ctx)
  const reportingTool = createReportingTool(ctx)
  const dockerTool = createDockerTool(ctx)
  const servicesTool = createServicesTool(ctx)
  const certsTool = createCertsTool(ctx)
  const disksTool = createDisksTool(ctx)
  const vmsTool = createVmsTool(ctx)
  const iscsiTool = createIscsiTool(ctx)
  const nvmetTool = createNvmetTool(ctx)
  const filesTool = createFilesTool(ctx)

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
    tasksTool,
    reportingTool,
    dockerTool,
    servicesTool,
    certsTool,
    disksTool,
    vmsTool,
    iscsiTool,
    nvmetTool,
    filesTool,
  ]
}

