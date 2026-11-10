/**
 * Instance administration shared by the agent tools and the settings UI.
 *
 * Both surfaces must behave identically: an instance is only saved after its
 * URL, user and API key have been proven to work, and the key itself is written
 * to the DSH credential store rather than the plugin configuration.
 */

import {
  addOrUpdateInstance,
  defaultCredentialName,
  instanceReadiness,
  listInstances,
  normalizeInstance,
  removeInstance,
} from './instances.js'
import { errorText } from './format.js'

/** Derive a display name from a URL or bare host: "https://nas.lan:443" → "nas.lan". */
export function deriveInstanceName(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    return parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return raw
  }
}

const VERIFY_HINT =
  'Check the address, that the API key belongs to the user you passed, and enable "Skip TLS verification" for a self-signed certificate.'

function verifyHint(error) {
  const text = errorText(error)
  if (/plain HTTP|WRONG_VERSION_NUMBER|encrypted|wss:\/\//i.test(text)) {
    return 'That port speaks plain HTTP, and TrueNAS revokes API keys presented over an unencrypted connection. Enable HTTPS on the NAS (System Settings → General → GUI → HTTPS) or front it with a TLS proxy, then use wss://host:port.'
  }
  if (/certificate|self.signed|CERT_|DEPTH_ZERO/i.test(text)) {
    return 'The certificate is not trusted. Tick "Skip TLS verification" for a self-signed or LAN certificate.'
  }
  return VERIFY_HINT
}

function fail(error, hint) {
  return hint ? { ok: false, error, hint } : { ok: false, error }
}

export function createAdmin({ store, pool }) {
  /** Every configured instance plus the state the UI needs to render it. */
  async function list() {
    const instances = listInstances(store.config())
    const rows = []
    for (const entry of instances) {
      rows.push({
        name: entry.name,
        url: entry.url,
        username: entry.username,
        apiPath: entry.apiPath,
        insecureTls: entry.insecureTls,
        description: entry.description,
        credential: entry.credential,
        hasApiKey: await store.hasApiKey(entry.credential),
      })
    }
    return { ok: true, defaultName: instances[0]?.name || null, instances: rows }
  }

  /** Connect with a candidate key and read the identity TrueNAS reports back. */
  async function verify(entry, apiKey) {
    const client = pool.create(entry, apiKey)
    try {
      const info = await client.request('system.info')
      const version = info?.version || (await client.request('system.version'))
      return {
        version,
        hostname: info?.hostname,
        product: info?.system_product || info?.model,
        info,
      }
    } finally {
      client.close()
    }
  }

  async function save(action, payload) {
    const current = listInstances(store.config())
    const wanted = String(payload.name || '').trim()
    const targetName = action === 'add' ? wanted || deriveInstanceName(payload.url) : wanted
    if (!targetName) return fail('A TrueNAS URL or instance name is required.')

    const existing = current.find((entry) => entry.name.toLowerCase() === targetName.toLowerCase())
    if (action === 'add' && existing) {
      return fail(`Instance "${targetName}" already exists. Edit it instead, or pick another name.`)
    }
    if (action === 'update' && !existing) return fail(`Unknown instance "${targetName}".`)

    const merged = {
      name: existing?.name || targetName,
      url: String(payload.url ?? existing?.url ?? '').trim(),
      username: String(payload.username ?? existing?.username ?? 'root').trim() || 'root',
      apiPath: String(payload.apiPath ?? existing?.apiPath ?? '/api/current').trim() || '/api/current',
      insecureTls: payload.insecureTls === undefined ? Boolean(existing?.insecureTls) : Boolean(payload.insecureTls),
      description: String(payload.description ?? existing?.description ?? '').trim(),
      credential: String(existing?.credential || '').trim() || defaultCredentialName(targetName),
    }
    if (!merged.url) return fail('A TrueNAS address is required.')

    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
    if (!apiKey && !existing) return fail('An API key is required to add an instance.')
    const candidateKey = apiKey || (await store.getApiKey(merged.credential))
    if (!candidateKey) {
      return fail(`Instance "${merged.name}" has no stored API key. Enter the key again.`)
    }

    // Verify before persisting so a typo never leaves a broken instance behind.
    let identity
    try {
      identity = await verify(normalizeInstance(merged), candidateKey)
    } catch (error) {
      return fail(
        `Could not verify "${merged.name}" at ${merged.url}: ${errorText(error)}. Nothing was saved.`,
        verifyHint(error),
      )
    }

    if (apiKey) await store.setApiKey(merged.credential, apiKey)
    await store.saveInstances(addOrUpdateInstance(current, merged))
    pool.invalidate(merged.name)
    const after = listInstances(store.config())
    return {
      ok: true,
      action,
      instance: merged.name,
      entry: merged,
      version: identity.version,
      hostname: identity.hostname,
      defaultName: after[0]?.name || merged.name,
    }
  }

  async function remove(payload) {
    const name = String(payload.name || '').trim()
    const instances = listInstances(store.config())
    const entry = instances.find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (!entry) return fail(`Unknown instance "${name}".`)
    // Removing an instance drops its stored API key too; require the caller to say so explicitly.
    if (payload.confirm !== true) {
      return { ok: false, requiresConfirm: true, error: `Refusing to remove "${entry.name}" without confirmation.`, hint: 'Send confirm: true once you are sure.' }
    }
    const remaining = removeInstance(instances, entry.name)
    await store.saveInstances(remaining)
    pool.invalidate(entry.name)
    if (payload.forgetApiKey !== false) await store.deleteApiKey(entry.credential)
    return {
      ok: true,
      action: 'remove',
      instance: entry.name,
      remaining: remaining.map((item) => item.name),
      forgotApiKey: payload.forgetApiKey !== false,
    }
  }

  async function test(payload) {
    const name = String(payload.name || '').trim()
    const instances = listInstances(store.config())
    if (!instances.length) return fail('No TrueNAS instance is configured yet.')
    const entry = name ? instances.find((item) => item.name.toLowerCase() === name.toLowerCase()) : instances[0]
    if (!entry) return fail(`Unknown instance "${name}".`)
    const apiKey = typeof payload.apiKey === 'string' && payload.apiKey.trim() ? payload.apiKey.trim() : await store.getApiKey(entry.credential)
    const missing = instanceReadiness(entry, Boolean(apiKey))
    if (missing) return fail(`Instance "${entry.name}" is not ready: ${missing}`)
    try {
      const identity = await verify(entry, apiKey)
      return { ok: true, action: 'test', instance: entry.name, entry, ...identity }
    } catch (error) {
      return fail(`${entry.name}: ${errorText(error)}`, 'Check the address and API key, and whether the certificate needs "Skip TLS verification".')
    }
  }

  /** Move an instance to the front so tool calls without "instance" use it. */
  async function promote(payload) {
    const name = String(payload.name || '').trim()
    const instances = listInstances(store.config())
    const index = instances.findIndex((item) => item.name.toLowerCase() === name.toLowerCase())
    if (index === -1) return fail(`Unknown instance "${name}".`)
    if (index === 0) return { ok: true, action: 'default', instance: instances[0].name, moved: false }
    const next = [instances[index], ...instances.slice(0, index), ...instances.slice(index + 1)]
    await store.saveInstances(next)
    return { ok: true, action: 'default', instance: next[0].name, moved: true }
  }

  /** Dispatch used by the HTTP surface; unknown actions fail loudly. */
  async function perform(payload) {
    const action = String(payload?.action || '').trim()
    switch (action) {
      case 'add':
      case 'update':
        return save(action, payload)
      case 'list':
        return list()
      case 'remove':
        return remove(payload)
      case 'test':
        return test(payload)
      case 'default':
        return promote(payload)
      default:
        return fail(`Unknown action "${action}".`)
    }
  }

  return { list, perform, verify }
}
