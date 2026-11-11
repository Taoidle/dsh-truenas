/**
 * Minimal TrueNAS WebSocket API stub for tests.
 *
 * Speaks just enough of RFC 6455 (server side: unmasked frames, one HTTP
 * upgrade) and JSON-RPC 2.0 to exercise the client against the same shapes the
 * real API returns. No dependencies, no TLS.
 */

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

function encodeFrame(text) {
  const payload = Buffer.from(text)
  const length = payload.length
  if (length < 126) {
    const header = Buffer.alloc(2)
    header[0] = 0x81
    header[1] = length
    return Buffer.concat([header, payload])
  }
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function controlFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(2)
  header[0] = 0x80 | opcode
  header[1] = payload.length
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer, onFrame) {
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length - cursor < maskLength + length) break
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null
    cursor += maskLength
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    cursor += length
    offset = cursor
    onFrame(opcode, payload)
  }
  return buffer.subarray(offset)
}

export class MockTruenas {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? '1-testkey'
    this.username = options.username ?? 'root'
    this.serverId = options.serverId ?? 'mock'
    this.legacyOnly = options.legacyOnly === true
    this.tls = options.tls || undefined
    this.connections = new Set()
    this.calls = []
    this.jobs = new Map()
    this.jobSequence = 100
    this.registries = []
    this.registrySequence = 0
    this.apps = []
    this.sockets = new Map()
  }

  async start(port = 0) {
    this.server = net.createServer((socket) => this.handleSocket(socket))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    return this
  }

  get url() {
    return `${this.tls ? 'https' : 'http'}://127.0.0.1:${this.port}`
  }

  async stop() {
    for (const socket of this.sockets.keys()) socket.destroy()
    this.sockets.clear()
    await new Promise((resolve) => this.server.close(resolve))
  }

  handleSocket(rawSocket) {
    const socket = this.tls ? new tls.TLSSocket(rawSocket, { isServer: true, secureContext: tls.createSecureContext(this.tls) }) : rawSocket
    if (this.tls) {
      socket.on('error', () => rawSocket.destroy())
      rawSocket.on('error', () => socket.destroy())
    }
    let buffered = Buffer.alloc(0)
    let upgraded = false
    const state = { authed: false, username: this.username }
    this.connections.add(socket)
    this.sockets.set(socket, state)

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!upgraded) {
        // A TLS ClientHello (0x16) is not an HTTP request. Answer it the way a
        // real web server on a plain-HTTP port does, so the client's TLS layer
        // reports WRONG_VERSION_NUMBER instead of hanging until the timeout.
        if (buffered.length && buffered[0] !== 0x47) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          return
        }
        const end = buffered.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffered.subarray(0, end).toString('latin1')
        const match = /sec-websocket-key:\s*(\S+)/i.exec(head)
        buffered = buffered.subarray(end + 4)
        upgraded = true
        const response = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(match ? match[1] : '')}`,
          '',
          '',
        ].join('\r\n')
        socket.write(response)
      }
      buffered = decodeFrames(buffered, (opcode, payload) => {
        if (opcode === 0x8) {
          socket.end(controlFrame(0x8))
          return
        }
        if (opcode === 0x9) {
          socket.write(controlFrame(0xa, payload))
          return
        }
        if (opcode !== 0x1) return
        let request
        try {
          request = JSON.parse(payload.toString('utf8'))
        } catch {
          return
        }
        this.dispatch(socket, state, request)
      })
    })

    socket.on('error', () => {})
    socket.on('close', () => {
      this.connections.delete(socket)
      this.sockets.delete(socket)
    })
  }

  send(socket, payload) {
    if (socket.destroyed) return
    socket.write(encodeFrame(JSON.stringify(payload)))
  }

  respond(socket, id, result) {
    this.send(socket, { jsonrpc: '2.0', id, result })
  }

  fail(socket, id, reason, code = -32001) {
    this.send(socket, { jsonrpc: '2.0', id, error: { code, message: 'method call error', data: { reason, errname: 'CallError' } } })
  }

  dispatch(socket, state, request) {
    const { id, method, params } = request
    this.calls.push({ method, params })
    const args = Array.isArray(params) ? params : []

    if (method === 'auth.login_ex') {
      if (this.legacyOnly) return this.fail(socket, id, `Method ${method} does not exist`, -32601)
      const body = args[0] || {}
      if (body.mechanism !== 'API_KEY_PLAIN') return this.respond(socket, id, { response_type: 'AUTH_ERR' })
      if (body.username !== this.username || body.api_key !== this.apiKey) {
        return this.respond(socket, id, { response_type: 'AUTH_ERR' })
      }
      state.authed = true
      return this.respond(socket, id, { response_type: 'SUCCESS', user_info: { username: this.username } })
    }

    if (method === 'auth.login_with_api_key') {
      if (args[0] !== this.apiKey) return this.respond(socket, id, false)
      state.authed = true
      return this.respond(socket, id, true)
    }

    if (!state.authed) return this.fail(socket, id, 'Please log in')

    switch (method) {
      case 'system.info':
        return this.respond(socket, id, {
          version: '25.10.0',
          hostname: `${this.serverId}.test`,
          physmem: 34359738368,
          model: 'TRUENAS-MOCK',
          cores: 8,
          loadavg: [0.1, 0.2, 0.3],
          uptime_seconds: 86400,
        })
      case 'system.version':
        return this.respond(socket, id, '25.10.0')
      case 'test.whoami':
        return this.respond(socket, id, { serverId: this.serverId, user: state.username })
      case 'test.raw':
        return this.respond(socket, id, { method, params })
      case 'test.error':
        return this.fail(socket, id, 'boom')
      case 'test.expire':
        state.authed = false
        return this.respond(socket, id, null)
      case 'test.drop':
        this.respond(socket, id, { dropped: true })
        setTimeout(() => socket.destroy(), 10)
        return undefined
      default:
        break
    }

    if (method === 'test.startJob') {
      const jobId = ++this.jobSequence
      this.jobs.set(jobId, {
        id: jobId,
        state: 'RUNNING',
        polls: 0,
        result: { ok: true, jobId },
        fail: args[1]?.fail === true,
      })
      return this.respond(socket, id, jobId)
    }

    if (method === 'reporting.get_data') {
      const now = Math.floor(Date.now() / 1000)
      return this.respond(socket, id, [
        { name: 'cpu', identifier: null, data: [[now - 60, 18, 24, 12], [now, 22, 31, 16]] },
        { name: 'memory', identifier: null, data: [[now - 60, 6 * 1024 ** 3], [now, 7 * 1024 ** 3]] },
        { name: 'cputemp', identifier: null, data: [[now - 60, 40], [now, 43]] },
      ])
    }

    if (method === 'pool.query') {
      return this.respond(socket, id, [
        { name: 'tank', status: 'ONLINE', healthy: true, size: 4 * 1024 ** 4, allocated: 1024 ** 4, free: 3 * 1024 ** 4 },
      ])
    }

    if (method === 'alert.list') {
      return this.respond(socket, id, [
        { uuid: 'mock-alert-1', level: 'WARNING', text: 'Pool tank has a failed disk', formatted: 'Pool tank has a failed disk', dismissed: false },
      ])
    }

    if (method === 'alert.dismiss') return this.respond(socket, id, null)

    if (method === 'app.query') {
      if (this.apps.length) return this.respond(socket, id, this.apps)
      return this.respond(socket, id, [
        { name: 'forgejo', state: 'RUNNING', human_version: '9.0.1', upgrade_available: false },
        { name: 'plex', state: 'STOPPED', human_version: '1.41.0', upgrade_available: true, latest_version: '1.41.2' },
      ])
    }

    if (method === 'app.registry.query') return this.respond(socket, id, this.registries)

    if (method === 'app.registry.create') {
      const data = args[0] ?? {}
      const entry = {
        id: ++this.registrySequence,
        name: data.name,
        uri: data.uri || 'https://index.docker.io/v1/',
        username: data.username,
        password: '********',
        description: data.description ?? '',
      }
      this.registries.push(entry)
      return this.respond(socket, id, entry)
    }

    if (method === 'app.registry.update') {
      const entry = this.registries.find((registry) => registry.id === args[0])
      if (!entry) return this.fail(socket, id, `Registry ${args[0]} not found`)
      Object.assign(entry, args[1] || {})
      entry.password = '********'
      return this.respond(socket, id, entry)
    }

    if (method === 'app.registry.delete') {
      const before = this.registries.length
      this.registries = this.registries.filter((registry) => registry.id !== args[0])
      if (this.registries.length === before) return this.fail(socket, id, `Registry ${args[0]} not found`)
      return this.respond(socket, id, true)
    }

    if (method === 'app.create') {
      const data = args[0] ?? {}
      const appName = data.app_name
      const jobId = ++this.jobSequence
      this.jobs.set(jobId, {
        id: jobId,
        state: 'RUNNING',
        polls: 0,
        result: { name: appName, state: 'RUNNING', custom_app: true },
        fail: false,
      })
      this.apps.push({
        name: appName,
        state: 'RUNNING',
        version: '1.0.0',
        human_version: `${appName} 1.0.0`,
        custom_app: data.custom_app === true,
        upgrade_available: false,
      })
      return this.respond(socket, id, jobId)
    }

    if (method === 'app.delete') {
      const appName = args[0]
      this.apps = this.apps.filter((app) => app.name !== appName)
      const jobId = ++this.jobSequence
      this.jobs.set(jobId, { id: jobId, state: 'RUNNING', polls: 0, result: null, fail: false })
      return this.respond(socket, id, jobId)
    }

    if (method === 'app.query') {
      const filters = Array.isArray(args[0]) ? args[0] : []
      const triple = Array.isArray(filters[0]) ? filters[0] : undefined
      if (Array.isArray(triple) && triple[0] === 'name') {
        return this.respond(socket, id, this.apps.filter((app) => app.name === triple[2]))
      }
      return this.respond(socket, id, this.apps)
    }

    if (method === 'core.get_jobs') {
      const filters = Array.isArray(args[0]) ? args[0] : []
      const triple = Array.isArray(filters[0]) ? filters[0] : filters
      const wanted = Array.isArray(triple) && triple[0] === 'id' ? triple[2] : undefined
      if (triple[0] === 'state') {
        const running = [...this.jobs.values()].filter((job) => job.state === 'RUNNING')
        return this.respond(
          socket,
          id,
          running.map((job) => ({ id: job.id, method: 'mock.job', state: job.state, progress: { percent: 55, description: 'working' } })),
        )
      }
      const job = this.jobs.get(wanted)
      if (!job) return this.respond(socket, id, [])
      job.polls += 1
      if (job.polls >= 2) {
        if (job.fail) {
          job.state = 'FAILED'
          job.error = 'mock failure'
        } else {
          job.state = 'SUCCESS'
        }
      }
      return this.respond(socket, id, [
        {
          id: job.id,
          state: job.state,
          progress: { percent: job.state === 'SUCCESS' ? 100 : 50, description: 'working' },
          result: job.state === 'SUCCESS' ? job.result : null,
          error: job.error ?? null,
        },
      ])
    }

    if (method === 'core.job_abort') return this.respond(socket, id, null)

    return this.fail(socket, id, `Method ${method} does not exist`)
  }
}
