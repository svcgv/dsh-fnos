import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { createRestrictedProxy, clientHelloSni } from './proxy.mjs'

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
function hello(name = 'allowed.test') {
  const nameBytes = Buffer.from(name)
  const nameEntry = Buffer.concat([Buffer.from([0]), u16(nameBytes.length), nameBytes])
  const names = Buffer.concat([u16(nameEntry.length), nameEntry])
  const ext = Buffer.concat([u16(0), u16(names.length), names])
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 1]), Buffer.from([1, 0]), u16(ext.length), ext])
  const h = Buffer.alloc(4); h[0] = 1; h.writeUIntBE(body.length, 1, 3)
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(h.length + body.length), h, body])
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
async function fixture(t, records = [{ address: '127.0.0.1', family: 4 }]) {
  const received = []
  const dest = net.createServer(s => s.on('data', data => { received.push(data); s.write('ok') }))
  const port = await listen(dest)
  const proxy = createRestrictedProxy({ rules: [{ host: 'allowed.test', port, addresses: ['127.0.0.1'] }], lookup: async () => records, timeoutMs: 1000 })
  const bridge = net.createServer(s => proxy.accept(s)); const proxyPort = await listen(bridge)
  t.after(() => { proxy.close(); bridge.close(); dest.close() })
  return { port, proxyPort, received }
}
async function tunnel(f, options = {}) {
  const socket = net.connect(f.proxyPort, '127.0.0.1'); socket.on('error', () => {})
  await once(socket, 'connect')
  const authority = options.authority || `allowed.test:${f.port}`
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${options.host || authority}\r\n${options.extra || ''}\r\n`)
  return socket
}
async function collect(socket) {
  const chunks = []; for await (const c of socket) chunks.push(c); return Buffer.concat(chunks).toString()
}
test('validates TLS ClientHello, SNI, and length', () => {
  const h = hello(); assert.equal(clientHelloSni(h), 'allowed.test'); assert.equal(clientHelloSni(h.subarray(0, 10)), undefined); assert.equal(clientHelloSni(Buffer.from('GET /')), null)
  const ech = Buffer.concat([h, Buffer.from([0xfe, 0x0d, 0, 0])]); ech.writeUInt16BE(ech.length - 5, 3); ech.writeUIntBE(ech.length - 9, 6, 3); ech.writeUInt16BE(h.readUInt16BE(50) + 4, 50); assert.equal(clientHelloSni(ech), null)
})
test('only approved destination and SNI are forwarded', async t => {
  const f = await fixture(t), s = await tunnel(f)
  const [headers] = await once(s, 'data'); assert.match(headers.toString(), /^HTTP\/1.1 200/)
  s.write(hello()); const [data] = await once(s, 'data'); assert.equal(data.toString(), 'ok'); assert.deepEqual(Buffer.concat(f.received), hello()); s.destroy()
})
test('refuses mismatched SNI', async t => {
  const f = await fixture(t), s = await tunnel(f); await once(s, 'data'); s.write(hello('other.test')); await once(s, 'close'); assert.equal(f.received.length, 0)
})
test('rejects proxy credentials, unexpected host and non-allowlisted host', async t => {
  const f = await fixture(t)
  for (const options of [{extra:'Proxy-Authorization: Basic abc\r\n'}, {host:'other.test'}, {authority:`other.test:${f.port}`}]) {
    const s = await tunnel(f, options); await collect(s); assert.equal(f.received.length, 0)
  }
})
test('rejects DNS rebinding when any returned address is not allowed', async t => {
  const f = await fixture(t, [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }]); const s = await tunnel(f); await once(s, 'data'); s.write(hello()); await once(s, 'close'); assert.equal(f.received.length, 0)
})
test('rejects IPv6 mapped-address bypass', async t => {
  const f = await fixture(t, [{ address: '::ffff:127.0.0.1', family: 6 }]); const s = await tunnel(f); await once(s, 'data'); s.write(hello()); await once(s, 'close'); assert.equal(f.received.length, 0)
})
test('rejects non-CONNECT requests', async t => {
  const f = await fixture(t), s = net.connect(f.proxyPort, '127.0.0.1'); await once(s, 'connect'); s.end(`GET http://allowed.test:${f.port}/ HTTP/1.1\r\nHost: allowed.test:${f.port}\r\n\r\n`); assert.match(await collect(s), /405/); assert.equal(f.received.length, 0)
})
