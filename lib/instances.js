/**
 * Multi-instance registry helpers.
 *
 * Instances live in the plugin configuration so they can be edited through the
 * DSH settings UI and updated at runtime, while the API key itself lives in the
 * DSH credential store under a per-instance credential name.
 */

const DEFAULT_API_PATH = '/api/current'

/** Turn a display name into a credential-safe suffix: "lab-nas" → "LAB_NAS". */
export function credentialSlug(name) {
  const slug = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'DEFAULT'
}

export function defaultCredentialName(name) {
  return `TRUENAS_APIKEY_${credentialSlug(name)}`
}

/** Normalize one configured instance, dropping empty optional fields. */
export function normalizeInstance(raw, index = 0) {
  const name = String(raw?.name || (index === 0 ? 'default' : '')).trim()
  const entry = {
    name,
    url: String(raw?.url || '').trim(),
    username: String(raw?.username || 'root').trim() || 'root',
    apiPath: String(raw?.apiPath || DEFAULT_API_PATH).trim() || DEFAULT_API_PATH,
    insecureTls: Boolean(raw?.insecureTls),
    description: String(raw?.description || '').trim(),
  }
  entry.credential = String(raw?.credential || '').trim() || defaultCredentialName(name)
  return entry
}

/** Every configured instance, in configuration order (the first one is the default). */
export function listInstances(config) {
  const entries = Array.isArray(config?.instances) ? config.instances : []
  return entries
    .filter((entry) => entry && (entry.name || entry.url))
    .map((entry, index) => normalizeInstance(entry, index))
}

export function findInstance(config, name) {
  const instances = listInstances(config)
  if (!instances.length) {
    return {
      ok: false,
      error: 'No TrueNAS instance is configured. Add one with truenas_instances action "add" (url + API key), or fill in the plugin settings.',
    }
  }
  const wanted = String(name || '').trim()
  if (!wanted) return { ok: true, instance: instances[0], instances }
  const match =
    instances.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase()) ||
    instances.find((entry) => entry.url.toLowerCase() === wanted.toLowerCase())
  if (!match) {
    const names = instances.map((entry) => entry.name).join(', ')
    return { ok: false, error: `Unknown TrueNAS instance "${wanted}". Configured instances: ${names}.`, instances }
  }
  return { ok: true, instance: match, instances }
}

/** Instances without a URL or credential name are only partially configured. */
export function instanceReadiness(entry, hasKey) {
  if (!entry.url) return 'missing url'
  if (!entry.credential) return 'missing credential name'
  if (!hasKey) return `API key not set (run truenas_instances action "add" with apiKey, or set credential ${entry.credential})`
  return null
}

export function addOrUpdateInstance(instances, patch) {
  const next = Array.isArray(instances) ? instances.map((entry) => ({ ...entry })) : []
  const name = String(patch.name || '').trim()
  if (!name) throw new Error('Instance name is required')
  const index = next.findIndex((entry) => String(entry?.name || '').trim().toLowerCase() === name.toLowerCase())
  const merged = {
    name: index === -1 ? name : next[index].name,
    url: String(patch.url || '').trim(),
    username: String(patch.username || 'root').trim() || 'root',
    apiPath: String(patch.apiPath || DEFAULT_API_PATH).trim() || DEFAULT_API_PATH,
    insecureTls: Boolean(patch.insecureTls),
    description: String(patch.description || '').trim(),
    credential: String(patch.credential || '').trim() || defaultCredentialName(name),
  }
  if (index === -1) next.push(merged)
  else next[index] = merged
  return next
}

export function removeInstance(instances, name) {
  const wanted = String(name || '').trim().toLowerCase()
  const list = Array.isArray(instances) ? instances : []
  const remaining = list.filter((entry) => String(entry?.name || '').trim().toLowerCase() !== wanted)
  if (remaining.length === list.length) throw new Error(`Unknown instance "${name}"`)
  return remaining
}

/** Redact an API key for any output that might be echoed back to a transcript. */
export function maskKey(key) {
  const value = String(key || '')
  if (value.length <= 8) return value ? '********' : ''
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}
