import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'

// This is a research prototype. It enforces destination IP, port, and TLS SNI,
// not the encrypted HTTP Host or paths inside the tunnel.
function ipKey(value) {
  if (net.isIP(value) === 4) return value
  if (net.isIP(value) !== 6 || value.includes('%')) return null
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase() } catch { return null }
}
function hostKey(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) || net.isIP(value)) return null
  return value
}
function parseAuthority(value) {
  const m = /^([a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value || '')
  if (!m || !hostKey(m[1])) return null
  const port = Number(m[2])
  return port <= 65535 ? { host: m[1], port } : null
}

// Return null for malformed/non-TLS input, undefined while incomplete, and
// the exact SNI when one complete unfragmented ClientHello has arrived.
export function clientHelloSni(b) {
  try {
    if (b.length < 5) return undefined
    if (b[0] !== 22 || b[1] !== 3) return null
    const n = b.readUInt16BE(3)
    if (n > 16384 || n < 4) return null
    if (b.length < 5 + n) return undefined
    const end = 5 + n
    if (b[5] !== 1 || b.readUIntBE(6, 3) !== n - 4) return null
    let p = 9 + 2 + 32
    const read8 = () => { if (p + 1 > end) throw 0; return b[p++] }
    const read16 = () => { if (p + 2 > end) throw 0; const v = b.readUInt16BE(p); p += 2; return v }
    const skip = x => { p += x; if (p > end) throw 0 }
    skip(read8()); const cipherLen = read16(); if (!cipherLen || cipherLen % 2) return null; skip(cipherLen); skip(read8())
    const extLen = read16(); if (p + extLen !== end) return null
    let found = null; const seen = new Set()
    while (p < end) {
      const type = read16(), len = read16(), stop = p + len
      if (stop > end || seen.has(type)) return null
      seen.add(type)
      // Encrypted ClientHello conceals the destination name; fail closed.
      if (type === 0xfe0d) return null
      if (type === 0) {
        const listLen = read16(); if (p + listLen !== stop || read8() !== 0) return null
        const nameLen = read16(); if (!nameLen || p + nameLen !== stop) return null
        found = b.toString('ascii', p, stop)
        if (!Buffer.from(found, 'ascii').equals(b.subarray(p, stop)) || !hostKey(found)) return null
      }
      p = stop
    }
    return found
  } catch { return null }
}

/** Creates a disconnected CONNECT-only proxy. Feed only trusted local sockets via accept(). */
export function createRestrictedProxy({ rules, lookup = (host) => dns.lookup(host, { all: true, verbatim: true }), connect = (opts) => net.connect(opts), timeoutMs = 10000 } = {}) {
  if (!Array.isArray(rules) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('invalid proxy configuration')
  const allowed = new Map()
  for (const rule of rules) {
    if (!hostKey(rule.host) || !Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535 || !Array.isArray(rule.addresses) || !rule.addresses.length) throw new Error('invalid rule')
    const addresses = rule.addresses.map(ipKey)
    if (addresses.some(x => !x) || allowed.has(`${rule.host}:${rule.port}`)) throw new Error('invalid rule addresses')
    allowed.set(`${rule.host}:${rule.port}`, new Set(addresses))
  }
  const active = new Set()
  const initial = new Map()
  const server = http.createServer({ maxHeaderSize: 8192 }, (_req, res) => { res.writeHead(405, { Connection: 'close' }); res.end() })
  server.headersTimeout = timeoutMs
  server.requestTimeout = timeoutMs
  server.on('clientError', (_err, socket) => socket.destroy())
  server.on('connect', (req, client, head) => {
    client.on('error', () => {})
    client.setTimeout(timeoutMs, () => client.destroy())
    const target = parseAuthority(req.url)
    const keys = req.rawHeaders.filter((_, i) => i % 2 === 0).map(x => x.toLowerCase())
    const whitelist = target && allowed.get(`${target.host}:${target.port}`)
    if (req.httpVersion !== '1.1' || !target || !whitelist || new Set(keys).size !== keys.length || keys.some(x => ['proxy-authorization', 'authorization', 'cookie', 'transfer-encoding', 'content-length', 'upgrade', 'expect'].includes(x)) || req.headers.host !== req.url) { client.destroy(); return }
    let buffered = head, done = false
    const fail = () => { done = true; client.destroy() }
    const processHello = async () => {
      if (done) return
      if (buffered.length > 65536) { fail(); return }
      const sni = clientHelloSni(buffered)
      if (sni === undefined) return
      if (sni !== target.host) { fail(); return }
      done = true; client.pause()
      try {
        const records = await lookup(target.host)
        if (client.destroyed) return
        if (!Array.isArray(records) || !records.length || records.length > 32 || records.some(r => !r || !ipKey(r.address) || !whitelist.has(ipKey(r.address)))) { client.destroy(); return }
        const address = records[0].address
        const upstream = connect({ host: address, port: target.port, family: net.isIP(address) })
        active.add(upstream); upstream.once('close', () => active.delete(upstream)); upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy())
        upstream.setTimeout(timeoutMs, () => upstream.destroy())
        upstream.once('connect', () => {
          if (!whitelist.has(ipKey(upstream.remoteAddress)) || ipKey(upstream.remoteAddress) !== ipKey(address) || upstream.remotePort !== target.port || client.destroyed) { upstream.destroy(); client.destroy(); return }
          clearTimeout(initial.get(client)); initial.delete(client)
          upstream.write(buffered); client.pipe(upstream); upstream.pipe(client); client.resume()
        })
      } catch { client.destroy() }
    }
    client.on('data', chunk => { if (done) return; buffered = Buffer.concat([buffered, chunk]); void processHello() })
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    void processHello()
  })
  return {
    accept(socket) {
      if (!(socket instanceof net.Socket)) throw new Error('expected socket')
      if (active.size >= 32) { socket.destroy(); return }
      active.add(socket)
      socket.on('error', () => {})
      initial.set(socket, setTimeout(() => socket.destroy(), timeoutMs))
      socket.once('close', () => { active.delete(socket); clearTimeout(initial.get(socket)); initial.delete(socket) })
      server.emit('connection', socket)
      socket.resume()
    },
    close() { for (const socket of active) socket.destroy(); server.close() },
  }
}
