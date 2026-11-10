/**
 * TrueNAS JSON-RPC 2.0 client.
 *
 * TrueNAS replaced its REST API with a versioned JSON-RPC 2.0 WebSocket API
 * (`/api/current`). One authenticated WebSocket session carries every method
 * call, so a client is cheap to keep and cheap to re-open.
 */

import {
  WsConnection,
  explainConnectError,
  looksLikePlaintextListener,
  parseEndpoint,
  toPlaintextEndpoint,
} from './ws.js'

const TERMINAL_JOB_STATES = new Set(['SUCCESS', 'FAILED', 'ABORTED'])
const AUTH_ERROR_PATTERN = /not authenticated|NOT_AUTHENTICATED|Please log in/i

export class RpcError extends Error {
  constructor(method, error) {
    const reason = error?.data?.reason || error?.data?.errname || error?.message || 'unknown error'
    super(`${method}: ${reason}`)
    this.name = 'RpcError'
    this.method = method
    this.code = error?.code
    this.errname = error?.data?.errname
    this.reason = error?.data?.reason
    this.extra = error?.data?.extra
    this.payload = error
  }
}

function isMissingMethod(error) {
  if (error instanceof RpcError) {
    return error.code === -32601 || /method.*(does not exist|not found|unknown)/i.test(error.message)
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class TruenasClient {
  constructor(config) {
    this.config = config
    this.endpoint = parseEndpoint(config.url, config.apiPath, config.insecureTls)
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 60000

    this.ws = null
    this.connecting = null
    this.sequence = 0
    this.pending = new Map()
    this.queue = Promise.resolve()
    this.lastUsed = Date.now()
  }

  get displayUrl() {
    return this.endpoint.displayUrl
  }

  /**
   * A bare `host:port` is tried over TLS first. Some LAN deployments expose
   * the web UI (or a reverse proxy) on a plain-HTTP port; when the user has
   * already opted out of TLS verification, fall back to ws:// once instead of
   * failing the whole verification with an OpenSSL handshake error.
   */
  async openSocket() {
    const options = { connectTimeoutMs: Math.min(this.timeoutMs, 20000) }
    try {
      return await WsConnection.open(this.endpoint, options)
    } catch (error) {
      // "Skip TLS verification" is the user telling us this endpoint is not
      // certificate-trusted, so an explicit https:// on a plain-HTTP port gets
      // the same one-time downgrade as a bare host:port. The saved notice says
      // what happened, so nobody is left thinking they are on TLS.
      const canFallBack =
        this.endpoint.secure && this.config.insecureTls === true && looksLikePlaintextListener(error)
      if (!canFallBack) throw new Error(explainConnectError(error, this.endpoint))
      const plain = toPlaintextEndpoint(this.endpoint)
      this.endpoint = plain
      this.transportNote = `port ${plain.port} answered as plain HTTP; using ${plain.displayUrl} without TLS`
      return WsConnection.open(plain, options)
    }
  }

  async connect() {
    if (this.ws && !this.ws.closed) return this.ws
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const ws = await this.openSocket()
      ws.onMessage((message) => this.onMessage(message))
      ws.onClose((error) => this.onClose(error))
      this.ws = ws
      try {
        await this.login()
      } catch (error) {
        ws.destroy(error)
        this.ws = null
        throw error
      }
      return ws
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  /**
   * Authenticate the session.
   *
   * TrueNAS 25.04+ exposes `auth.login_ex`, and TrueNAS 26 made SCRAM the
   * default mechanism. An API key is still accepted through the explicit
   * `API_KEY_PLAIN` mechanism when the owning user name is supplied, which
   * keeps the plugin to a single round trip. Servers that predate
   * `auth.login_ex` fall back to the legacy key-only method.
   */
  async login() {
    const { username, apiKey } = this.config
    if (!apiKey) throw new Error('API key is not configured')

    if (username) {
      try {
        const response = await this.rawCall('auth.login_ex', [
          { mechanism: 'API_KEY_PLAIN', username, api_key: apiKey },
        ])
        const type = response?.response_type
        if (type === 'SUCCESS') return
        if (type === 'AUTH_ERR') throw new Error(`Authentication failed for user "${username}": invalid API key`)
        if (type === 'EXPIRED') throw new Error(`Authentication failed: the API key for "${username}" has expired`)
        if (type === 'DENIED') throw new Error(`Authentication failed: user "${username}" does not have API access`)
        if (type === 'OTP_REQUIRED') throw new Error('This account requires a one-time password; use an API key instead')
        if (type === 'REDIRECT') {
          const urls = Array.isArray(response?.urls) ? response.urls.join(', ') : 'the active controller'
          throw new Error(`Authentication must target the active storage controller: ${urls}`)
        }
        throw new Error(`Unexpected authentication response: ${JSON.stringify(response)}`)
      } catch (error) {
        if (!isMissingMethod(error)) throw error
      }
    }

    const accepted = await this.rawCall('auth.login_with_api_key', [apiKey])
    if (!accepted) throw new Error('Authentication failed: invalid API key')
  }

  onMessage(message) {
    let payload
    try {
      payload = JSON.parse(message)
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (payload.id !== undefined && payload.id !== null) {
      const entry = this.pending.get(payload.id)
      if (!entry) return
      this.pending.delete(payload.id)
      clearTimeout(entry.timer)
      if (payload.error) entry.reject(new RpcError(entry.method, payload.error))
      else entry.resolve(payload.result)
      return
    }
    // `collection_update` events are irrelevant here: this plugin queries on demand
    // and never keeps collection subscriptions open.
  }

  onClose(error) {
    this.ws = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error instanceof Error ? error : new Error('WebSocket connection closed'))
    }
    this.pending.clear()
  }

  rawCall(method, params = [], options = {}) {
    if (!this.ws || this.ws.closed) return Promise.reject(new Error('WebSocket is not connected'))
    const id = ++this.sequence
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const body = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.ws.sendText(JSON.stringify(body))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /**
   * One queued request. Calls are serialized because middleware rejects bursts
   * with "too many concurrent calls" and tools are naturally sequential.
   */
  async request(method, params = [], options = {}) {
    const run = async () => {
      this.lastUsed = Date.now()
      await this.connect()
      this.lastUsed = Date.now()
      try {
        return await this.rawCall(method, params, options)
      } catch (error) {
        if (!AUTH_ERROR_PATTERN.test(error?.message || '')) throw error
        // The session was dropped server-side (reboot, key rotation, timeout):
        // re-open once and retry the call.
        this.ws?.close()
        this.ws = null
        await this.connect()
        return this.rawCall(method, params, options)
      }
    }

    const previous = this.queue
    let release
    this.queue = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }

  async waitJob(jobId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
    const intervalMs = options.intervalMs ?? 1500
    const id = Number(jobId)
    if (!Number.isFinite(id)) throw new Error(`Invalid job id: ${jobId}`)
    const deadline = Date.now() + timeoutMs
    let last = null

    while (Date.now() < deadline) {
      const jobs = await this.request('core.get_jobs', [[['id', '=', id]]], { timeoutMs: 30000 })
      const job = Array.isArray(jobs) ? jobs[0] : null
      if (job) {
        last = job
        if (job.state === 'SUCCESS') return { id: job.id, state: job.state, progress: job.progress, result: job.result }
        if (job.state === 'FAILED' || job.state === 'ABORTED') {
          const reason = job.error || job.exception || job.exc_info?.repr || job.state
          throw new Error(`Job ${id} ${job.state.toLowerCase()}: ${reason}`)
        }
      }
      await sleep(intervalMs)
    }
    const state = last ? `${last.state} (${last.progress?.percent ?? 0}%)` : 'unknown'
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for job ${id}; last state: ${state}`)
  }

  close() {
    const ws = this.ws
    this.ws = null
    if (ws && !ws.closed) ws.close()
  }
}
