/**
 * Small HTTP helpers for the plugin's own settings routes.
 *
 * The plugin registers raw Node routes on the DSH web server, so it owns the
 * request lifecycle. These helpers keep the responses JSON-only and refuse
 * drive-by cross-site writes: the browser page that talks to them runs on the
 * DSH origin itself, and anything else is rejected before a body is read.
 */

const MAX_BODY_BYTES = 64 * 1024

export function isLoopbackHost(hostname) {
  const name = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!name) return false
  if (name === 'localhost' || name === '::1') return true
  if (name.startsWith('127.')) return true
  return false
}

export function isLanHost(hostname) {
  const name = String(hostname || '').toLowerCase()
  if (isLoopbackHost(name)) return true
  if (!name || name.includes(':')) return false
  if (name.startsWith('10.') || name.startsWith('192.168.')) return true
  const match = /^172\.(\d+)\./.exec(name)
  if (match) {
    const octet = Number(match[1])
    return octet >= 16 && octet <= 31
  }
  return false
}

/** A DNS name the plugin is willing to serve: loopback, a LAN address, or mDNS. */
export function isTrustedHostHeader(host) {
  const raw = String(host || '').trim()
  if (!raw) return false
  let hostname = raw
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end > 0) hostname = raw.slice(1, end)
  } else {
    hostname = raw.split(':')[0]
  }
  hostname = hostname.toLowerCase()
  return isLoopbackHost(hostname) || isLanHost(hostname) || hostname.endsWith('.local')
}

/**
 * Returns an HTTP status when the request must be refused, or undefined when it
 * may proceed: Host must be a local name, the browser must not flag the request
 * as cross-site, and an Origin, when sent, must be the very host being called.
 */
export function requestRejection(req) {
  const headers = req?.headers || {}
  const host = headers.host || ''
  if (!isTrustedHostHeader(host)) return 403

  const site = headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return 403

  const origin = headers.origin
  if (origin !== undefined) {
    if (!origin || origin === 'null') return 403
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return 403
    }
    if (originHost !== host) return 403
  }
  return undefined
}

export function writeJson(res, status, body) {
  if (!res || res.headersSent || res.writableEnded) return
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read and parse a JSON request body, refusing oversized or malformed input. */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`Request body exceeds ${limit} bytes`)
        error.statusCode = 413
        finish(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => finish(Object.assign(error, { statusCode: 400 })))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return finish(null, {})
      try {
        const value = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const error = new Error('Request body must be a JSON object')
          error.statusCode = 400
          return finish(error)
        }
        finish(null, value)
      } catch {
        const error = new Error('Request body is not valid JSON')
        error.statusCode = 400
        finish(error)
      }
    })
  })
}
