/**
 * Minimal RFC 6455 WebSocket client.
 *
 * The plugin talks to TrueNAS over the versioned JSON-RPC 2.0 WebSocket API
 * (`wss://host/api/current`), which is the transport TrueNAS keeps after the
 * REST API removal. A dependency-free client is used on purpose: a Host plugin
 * must install without a build step, and it needs TLS knobs (self-signed
 * certificates are the norm on a NAS) that the global WebSocket does not expose.
 */

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * Normalize a user supplied TrueNAS address.
 *
 * Accepts `192.168.1.10`, `192.168.1.10:8443`, `https://nas.lan/`,
 * `wss://nas.lan/api/current` and returns the pieces the transport needs.
 */
export function parseEndpoint(rawUrl, rawPath, insecureTls = false) {
  let value = String(rawUrl || '').trim()
  if (!value) throw new Error('TrueNAS URL is required')
  const schemeExplicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  if (!schemeExplicit) value = `https://${value}`

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid TrueNAS URL: ${rawUrl}`)
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL scheme ${url.protocol}; use https:// or http://`)
  }

  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || (secure ? 443 : 80))
  const explicitPath = url.pathname && url.pathname !== '/' ? url.pathname : ''
  let path = String(rawPath || '').trim() || explicitPath || '/api/current'
  if (!path.startsWith('/')) path = `/${path}`

  return {
    secure,
    schemeExplicit,
    explicitPort: Boolean(url.port),
    host,
    port,
    path,
    origin: `${secure ? 'https' : 'http'}://${url.host}`,
    rejectUnauthorized: !insecureTls,
    displayUrl: `${secure ? 'https' : 'http'}://${url.host}`,
  }
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(6)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(8)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(14)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const mask = crypto.randomBytes(4)
  mask.copy(header, header.length - 4)
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ mask[i & 3]
  return Buffer.concat([header, masked])
}

const PLAINTEXT_TLS_PATTERN = /WRONG_VERSION_NUMBER|wrong version number|unsupported protocol|EPROTO|SSL routines/i

/** True when a failed TLS handshake looks like a plain-HTTP listener. */
export function looksLikePlaintextListener(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`
  return PLAINTEXT_TLS_PATTERN.test(text)
}

/** Same host and path, but spoken as plain ws:// instead of wss://. */
export function toPlaintextEndpoint(endpoint) {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  const raw = endpoint.explicitPort ? `http://${host}:${endpoint.port}` : `http://${host}`
  const next = parseEndpoint(raw, endpoint.path, true)
  return next
}

/**
 * Turn a transport failure into something the user can act on: the common
 * case is an HTTPS attempt against a port that only speaks HTTP (a reverse
 * proxy on :80/:86), which OpenSSL reports as WRONG_VERSION_NUMBER.
 */
export function explainConnectError(error, endpoint) {
  const detail = error?.message || String(error)
  const where = `${endpoint.host}:${endpoint.port}`
  if (endpoint.secure && looksLikePlaintextListener(error)) {
    return `Could not talk TLS to ${where}: that port answered as plain HTTP. TrueNAS revokes an API key the moment it is presented over an unencrypted connection, so this plugin will not authenticate over ws://. Enable HTTPS on the NAS (System Settings → General → GUI → HTTPS, a certificate is enough) or put a TLS reverse proxy in front of it, then connect to the TLS port. TLS said: ${detail}`
  }
  if (error?.code === 'ECONNREFUSED') {
    return `Connection refused by ${where}. Check the port, that the TrueNAS web UI is running, and any firewall in between.`
  }
  if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') {
    return `Host "${endpoint.host}" could not be resolved.`
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'CONNECT_TIMEOUT') {
    return `Timed out connecting to ${where}.`
  }
  return `Could not connect to ${where}: ${detail}`
}

export class WsConnection {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15000
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = null
    this.closed = false
    this.closeInfo = null
    this.messageListeners = new Set()
    this.closeListeners = new Set()
  }

  static async open(endpoint, options = {}) {
    const connection = new WsConnection(endpoint, options)
    await connection.connect()
    return connection
  }

  async connect() {
    const { host, port, secure, rejectUnauthorized, path } = this.endpoint
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized,
          ALPNProtocols: ['http/1.1'],
        })
      : net.connect({ host, port })
    this.socket = socket

    await new Promise((resolve, reject) => {
      const event = secure ? 'secureConnect' : 'connect'
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${host}:${port}`)), this.connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off(event, onOpen)
        socket.off('error', onError)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      socket.once(event, onOpen)
      socket.once('error', onError)
    })

    socket.setNoDelay(true)
    socket.setTimeout(0)
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => this.destroy(new Error('connection closed')))
    socket.on('end', () => this.destroy(new Error('connection ended')))

    const key = crypto.randomBytes(16).toString('base64')
    const hostHeader = port === (secure ? 443 : 80) ? host : `${host}:${port}`
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'User-Agent: dsh-truenas/1.0',
      '',
      '',
    ].join('\r\n')
    socket.write(request)

    const head = await new Promise((resolve, reject) => {
      let pending = Buffer.alloc(0)
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for the WebSocket handshake from ${host}:${port}`))
      }, this.connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`Connection to ${host}:${port} closed during the WebSocket handshake`))
      }
      const onData = (chunk) => {
        pending = Buffer.concat([pending, chunk])
        if (pending.length > MAX_HEADER_BYTES) {
          cleanup()
          reject(new Error('WebSocket handshake response headers are too large'))
          return
        }
        const end = pending.indexOf('\r\n\r\n')
        if (end === -1) return
        cleanup()
        resolve({ head: pending.subarray(0, end).toString('latin1'), rest: pending.subarray(end + 4) })
      }
      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('close', onClose)
    })

    const lines = head.head.split('\r\n')
    const status = lines.shift() || ''
    const match = /^HTTP\/1\.1 (\d{3})/.exec(status)
    if (!match || Number(match[1]) !== 101) {
      throw new Error(`WebSocket handshake rejected: ${status || 'no status line'}`)
    }
    const headers = new Map()
    for (const line of lines) {
      const index = line.indexOf(':')
      if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
    }
    const accept = headers.get('sec-websocket-accept')
    const expected = crypto.createHash('sha1').update(key + GUID).digest('base64')
    if (accept !== expected) throw new Error('WebSocket handshake failed: invalid Sec-WebSocket-Accept')
    if ((headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      throw new Error('WebSocket handshake failed: server did not upgrade the connection')
    }

    socket.on('data', (chunk) => this.onData(chunk))
    if (head.rest.length) this.onData(head.rest)
    return this
  }

  onMessage(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  sendText(text) {
    if (this.closed) throw new Error('WebSocket is not open')
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')))
  }

  ping() {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)))
    } catch {
      /* a failed keepalive surfaces through the close path */
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    if (!this.socket || this.socket.destroyed) {
      this.destroy(new Error('connection closed'))
      return
    }
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      /* ignore: the socket is going away anyway */
    }
    const socket = this.socket
    setTimeout(() => socket.destroy(), 250).unref?.()
    this.destroy(new Error('connection closed'))
  }

  destroy(error) {
    if (this.closed) return
    this.closed = true
    this.closeInfo = error || null
    if (this.socket && !this.socket.destroyed) this.socket.destroy()
    for (const listener of this.closeListeners) {
      try {
        listener(error)
      } catch {
        /* listener failures must not break teardown */
      }
    }
    this.closeListeners.clear()
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const large = this.buffer.readBigUInt64BE(2)
        if (large > BigInt(MAX_MESSAGE_BYTES)) {
          this.destroy(new Error(`WebSocket frame of ${large} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`))
          return
        }
        length = Number(large)
        offset = 10
      }
      let maskKey = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return

      let payload = this.buffer.subarray(offset, offset + length)
      if (masked && maskKey) {
        const unmasked = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3]
        payload = unmasked
      }
      this.buffer = this.buffer.subarray(offset + length)
      this.onFrame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.closeInfo = new Error(`server closed the connection (code ${code})`)
      this.destroy(this.closeInfo)
      return
    }
    if (opcode === OP_PING) {
      if (!this.closed) this.socket.write(encodeFrame(OP_PONG, payload))
      return
    }
    if (opcode === OP_PONG) return

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      this.fragments = [payload]
      this.fragmentOpcode = opcode
      if (!fin) return
    } else if (opcode === OP_CONTINUATION) {
      if (!this.fragments.length) return
      this.fragments.push(payload)
    } else {
      return
    }

    if (!fin) return
    const complete = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
    const isText = this.fragmentOpcode === OP_TEXT
    this.fragments = []
    this.fragmentOpcode = null
    const message = isText ? complete.toString('utf8') : complete
    for (const listener of this.messageListeners) {
      try {
        listener(message)
      } catch {
        /* ignore malformed listener behaviour */
      }
    }
  }
}
