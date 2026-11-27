#!/usr/bin/env node
// Minimal stand-in for `dsh web`, used to test the supervisor without the upstream build.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const portIndex = process.argv.indexOf('--port')
const port = Number(portIndex === -1 ? 0 : process.argv[portIndex + 1])
const TOKEN = 'test-token'
const COOKIE = 'dsh_session=ok'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const hasAuth = (req) => String(req.headers.cookie ?? '').includes(COOKIE)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (url.pathname === '/' && url.searchParams.get('token') !== null) {
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('bad token')
      return
    }
    res.writeHead(302, {
      location: '/',
      'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
    })
    res.end()
    return
  }

  if (!hasAuth(req)) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>mock</title><p>MOCK_HARNESS</p>')
    return
  }

  if (url.pathname === '/api/echo') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      url: req.url,
      host: req.headers.host,
      cookie: req.headers.cookie ?? null,
      origin: req.headers.origin ?? null,
      shared: process.env.MOCK_SHARED ?? null,
      shell: process.env.SHELL ?? null,
      dshHome: process.env.DSH_HOME ?? null,
      leakedTrimToken: process.env.TRIM_API_TOKEN ?? null,
    }))
    return
  }

  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: '/api/echo' })
    res.end()
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.on('upgrade', (req, socket) => {
  if (!hasAuth(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const key = String(req.headers['sec-websocket-key'] ?? '')
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'))
  socket.on('data', (chunk) => socket.write(chunk))
  socket.on('error', () => socket.destroy())
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const actual = typeof address === 'object' && address !== null ? address.port : port
  setTimeout(() => console.log(`dsh web: http://127.0.0.1:${actual}/?token=${TOKEN}`), Number(process.env.MOCK_START_DELAY_MS ?? 0))
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
