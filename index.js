/**
 * @local/dsh-truenas — manage one or more TrueNAS systems from DSH.
 *
 * TrueNAS retired its REST API in favour of a versioned JSON-RPC 2.0 WebSocket
 * API, so the plugin keeps one authenticated socket per instance and exposes a
 * curated tool surface plus a generic `truenas_call` escape hatch. Instance
 * records (URL, user, TLS, credential name) live in the plugin configuration;
 * the API key itself lives in the DSH credential store.
 */

import z from '@deepseek-ai/schemastery'

import { TruenasClient } from './lib/truenas.js'
import { createAdmin } from './lib/admin.js'
import { registerRoutes } from './lib/routes.js'
import { createPanel } from './lib/panel.js'
import { createTools } from './lib/tools.js'
import { normalizeInstance } from './lib/instances.js'

const ENTRY_ID = 'dsh-truenas'

/**
 * Credential references are ordinary strings in the harness API (`credentialRef`
 * from `@deepseek-ai/dsh-credentials` is compile-time branding only), and the
 * store requires shell-identifier names. Validating here keeps the plugin free
 * of harness package imports while still failing early on a bad name.
 */
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function credentialRef(name) {
  if (!CREDENTIAL_NAME.test(name)) {
    throw new TypeError(`credential name "${name}" must match ${String(CREDENTIAL_NAME)}`)
  }
  return name
}
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_JOB_TIMEOUT_MS = 600000

export const inject = ['tools', 'credentials', 'settings']

export const Config = z
  .object({
    instances: z
      .array(
        z.object({
          name: z.string().description('Display name used by the "instance" parameter.'),
          url: z.string().description('TrueNAS web UI address, for example https://nas.lab.local.'),
          username: z.string().default('root').description('TrueNAS user that owns the API key.'),
          apiPath: z.string().default('/api/current').description('WebSocket API path.'),
          insecureTls: z.boolean().default(false).description('Skip TLS certificate verification for a self-signed NAS certificate.'),
          description: z.string().default('').description('Free-form note shown in the instance list.'),
          credential: z.string().default('').description('DSH credential name holding the API key.'),
        }),
      )
      .default([])
      .description('TrueNAS systems this plugin manages. The first instance is the default when a tool call omits "instance".')
      .volatile(),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS).description('Per-request timeout in milliseconds.'),
    jobTimeoutMs: z.number().default(DEFAULT_JOB_TIMEOUT_MS).description('How long to wait for a long-running TrueNAS job, in milliseconds.'),
  })
  .description('Manage TrueNAS systems over the JSON-RPC 2.0 WebSocket API.')

/**
 * Schemastery `.volatile()` fields arrive as `Volatile<T>` refs so the loader can
 * swap them in place. Unwrap on every read to pick up live settings edits.
 */
function unwrapDeep(value) {
  if (value && typeof value.get === 'function') return unwrapDeep(value.get())
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(unwrapDeep)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = unwrapDeep(item)
  return out
}

/**
 * One authenticated client per instance, rebuilt when its URL, user, or key
 * changes. Clients connect lazily, so an idle NAS costs nothing.
 */
class ClientPool {
  constructor(readConfig) {
    this.readConfig = readConfig
    this.clients = new Map()
  }

  create(entry, apiKey) {
    return new TruenasClient({
      url: entry.url,
      username: entry.username,
      apiKey,
      insecureTls: entry.insecureTls,
      apiPath: entry.apiPath,
      timeoutMs: this.readConfig().timeoutMs,
    })
  }

  get(entry, apiKey) {
    const signature = [entry.url, entry.username, entry.apiPath, entry.insecureTls ? '1' : '0', apiKey].join('|')
    const existing = this.clients.get(entry.name)
    if (existing && existing.signature === signature) return existing.client
    if (existing) existing.client.close()
    const client = this.create(entry, apiKey)
    this.clients.set(entry.name, { signature, client })
    return client
  }

  invalidate(name) {
    const existing = this.clients.get(name)
    if (!existing) return
    existing.client.close()
    this.clients.delete(name)
  }

  dispose() {
    for (const { client } of this.clients.values()) client.close()
    this.clients.clear()
  }
}

function createStore(ctx, readConfig, state) {
  const entryId = ctx.fiber?.entry?.id || ENTRY_ID
  const settingsService = () => {
    try {
      return ctx.get('settings')
    } catch {
      return undefined
    }
  }

  const readSettingsRecord = () => {
    const svc = settingsService()
    if (typeof svc?.describe !== 'function') return undefined
    try {
      return svc.describe().find((item) => item.ns === entryId)
    } catch {
      return undefined
    }
  }

  return {
    config() {
      const live = readConfig()
      return { ...live, instances: state.instances.length ? state.instances : live.instances }
    },
    instances() {
      return this.config().instances
    },
    /** Persist the instance list as a live (volatile) settings change. */
    async saveInstances(next) {
      const normalized = next.map((item, index) => normalizeInstance(item, index))
      const entry = ctx.fiber?.entry
      const editor = (() => {
        try {
          return ctx.get('configEditor')
        } catch {
          return undefined
        }
      })()
      if (entry && typeof editor?.edit === 'function') {
        // Volatile fields are applied in place, so the plugin keeps running.
        await editor.edit(entry, (current) => ({ ...current, instances: normalized }))
        state.instances = normalized
        return
      }
      const svc = settingsService()
      if (typeof svc?.update !== 'function') {
        throw new Error('No DSH configuration service is available, so the instance list cannot be saved')
      }
      const record = readSettingsRecord()
      await svc.update(entryId, { instances: normalized }, record?.revision)
      state.instances = normalized
    },
    /** Re-read the instance list from the profile after an external settings edit. */
    async restore() {
      const record = readSettingsRecord()
      const configured = record?.value?.instances
      if (Array.isArray(configured)) state.instances = configured.map((item, index) => normalizeInstance(item, index))
    },
    async getApiKey(name) {
      if (!name) return undefined
      const resolved = await ctx.credentials.resolve(credentialRef(name))
      return resolved?.value
    },
    async hasApiKey(name) {
      if (!name) return false
      const described = await ctx.credentials.describe(credentialRef(name))
      return Boolean(described?.configured)
    },
    async setApiKey(name, value) {
      await ctx.credentials.set(credentialRef(name), value)
    },
    async deleteApiKey(name) {
      if (!name) return
      await ctx.credentials.unset(credentialRef(name))
    },
    entryId,
  }
}

export function apply(ctx, config) {
  const readConfig = () => {
    const live = unwrapDeep(config)
    const timeoutMs = Number(live?.timeoutMs)
    const jobTimeoutMs = Number(live?.jobTimeoutMs)
    return {
      instances: Array.isArray(live?.instances) ? live.instances.map((item, index) => normalizeInstance(item, index)) : [],
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      jobTimeoutMs: Number.isFinite(jobTimeoutMs) && jobTimeoutMs > 0 ? jobTimeoutMs : DEFAULT_JOB_TIMEOUT_MS,
    }
  }

  const state = { instances: readConfig().instances }
  const store = createStore(ctx, readConfig, state)
  const pool = new ClientPool(readConfig)

  // Volatile settings edits arrive as events; refresh the mirror so tools see
  // the new instance list without a plugin restart.
  ctx.effect(() => {
    const refresh = () => {
      store.restore().catch(() => {})
    }
    const disposers = ['loader/volatile-update', 'config', 'settings/document-updated'].map((event) => ctx.on(event, refresh))
    return () => disposers.forEach((dispose) => dispose?.())
  })

  // Close sockets when the plugin is unloaded or restarted.
  ctx.effect(() => () => pool.dispose())

  // One administration surface for both the agent tools and the settings page.
  const admin = createAdmin({ store, pool })
  // The sidebar panel reads through the same pool; it caches for a few seconds.
  const panel = createPanel({ store, pool, getConfig: readConfig })

  // The settings page lives on the DSH web origin and needs same-origin routes.
  // A headless host has no web server, in which case the page simply stays absent.
  ctx.effect(() => {
    const routes = registerRoutes(ctx, admin, panel)
    return () => {
      for (const dispose of routes.disposers || []) {
        try {
          dispose()
        } catch (error) {
          console.warn('[dsh-truenas] route cleanup failed:', (error && error.message) || error)
        }
      }
    }
  })

  // Timeouts are read on every call so a settings edit applies without a restart.
  const toolContext = {
    store,
    pool,
    admin,
    get config() {
      return readConfig()
    },
  }

  for (const definition of createTools(toolContext)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
