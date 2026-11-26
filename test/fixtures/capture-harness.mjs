#!/usr/bin/env node
// Records argv and selected environment for the Harness supervisor test, then
// behaves like the minimal mock Harness so the supervisor sees a ready instance.
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const portIndex = process.argv.indexOf('--port')
const port = Number(portIndex === -1 ? 0 : process.argv[portIndex + 1])
const TOKEN = 'capture-token'
const COOKIE = 'dsh_session=ok'

if (process.env.CAPTURE_ARGV !== undefined) {
  await writeFile(process.env.CAPTURE_ARGV, JSON.stringify(process.argv.slice(2)))
}
if (process.env.CAPTURE_ENV !== undefined) {
  await writeFile(process.env.CAPTURE_ENV, JSON.stringify({
    DSH_FNOS_BROWSER_LIVE: process.env.DSH_FNOS_BROWSER_LIVE ?? null,
    DSH_FNOS_ACCEPTANCE_FIXTURE: process.env.DSH_FNOS_ACCEPTANCE_FIXTURE ?? null,
    DSH_FNOS_BROWSER_NETWORK: process.env.DSH_FNOS_BROWSER_NETWORK ?? null,
    DSH_FNOS_WORKSPACE_DOCUMENTS: process.env.DSH_FNOS_WORKSPACE_DOCUMENTS ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
  }))
}

const hasAuth = (req) => String(req.headers.cookie ?? '').includes(COOKIE)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/' && url.searchParams.get('token') !== null) {
    if (url.searchParams.get('token') !== TOKEN) { res.writeHead(401); res.end(); return }
    res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}; Path=/; HttpOnly` })
    res.end()
    return
  }
  if (!hasAuth(req)) { res.writeHead(401); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>capture</title>')
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const actual = typeof address === 'object' && address !== null ? address.port : port
  console.log(`dsh web: http://127.0.0.1:${actual}/?token=${TOKEN}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
