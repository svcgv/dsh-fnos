// Opt-in end-to-end check of the visible browser panel against a real DSH Web
// process and a real Chromium worker. It starts a throwaway instance from this
// checkout (never the installed profile), verifies the panel asset, the
// authenticated upgrade, a screencast frame and one forwarded input event.
//
// Run: DSH_FNOS_REAL_LIVE_TEST=1 node --test --test-concurrency=1 browser-plugin/live.real.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ENABLED = process.env.DSH_FNOS_REAL_LIVE_TEST === '1'
const HARNESS = '/vol1/@appcenter/dsh-fnos/harness/entry.js'
const NODE = '/var/apps/nodejs_v26/target/bin/node'
const RUNTIME_LIB = '/vol1/@appcenter/dsh-fnos/runtime/lib'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PATCH = fileURLToPath(new URL('./live.patch.yml', import.meta.url))

function frame(mask, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const header = [0x80 | opcode]
  if (data.length < 126) header.push((mask ? 0x80 : 0) | data.length)
  else if (data.length < 65536) header.push((mask ? 0x80 : 0) | 126, data.length >> 8, data.length & 0xff)
  else { header.push((mask ? 0x80 : 0) | 127); for (let i = 7; i >= 0; i -= 1) header.push(i === 0 ? data.length & 0xff : 0) }
  let body = data
  if (mask) {
    const key = randomBytes(4)
    header.push(...key)
    body = Buffer.from(data)
    for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4]
  }
  return Buffer.concat([Buffer.from(header), body])
}

/** Minimal masked client WebSocket for the loopback test. */
function openWebSocket(port, path, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Cookie: ${cookie}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '', '',
    ]
    socket.write(lines.join('\r\n'))
    let buffer = Buffer.alloc(0)
    let upgraded = false
    const messages = []
    const waiters = []
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buffer.subarray(0, end).toString('latin1')
        if (!/^HTTP\/1\.1 101 /u.test(head)) { reject(new Error(`upgrade rejected: ${head.split('\r\n')[0]}`)); socket.destroy(); return }
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
        if (!head.includes(`sec-websocket-accept: ${accept}`)) { reject(new Error('bad accept header')); socket.destroy(); return }
        buffer = buffer.subarray(end + 4)
        upgraded = true
        resolve({
          send: (text) => socket.write(frame(true, 0x1, text)),
          close: () => { try { socket.write(frame(true, 0x8, '')) } catch { /* already gone */ } socket.destroy() },
          drain: () => messages.splice(0),
          next: (timeoutMs = 15_000) => new Promise((res, rej) => {
            if (messages.length > 0) { res(messages.shift()); return }
            const timer = setTimeout(() => rej(new Error('timed out waiting for a frame event')), timeoutMs)
            waiters.push({ resolve: (value) => { clearTimeout(timer); res(value) }, reject: (error) => { clearTimeout(timer); rej(error) } })
          }),
        })
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const masked = (buffer[1] & 0x80) !== 0
        if (masked) offset += 4
        const total = offset + length
        if (buffer.length < total) return
        const payload = Buffer.from(buffer.subarray(offset, total))
        if (masked) {
          const key = buffer.subarray(offset - 4, offset)
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4]
        }
        buffer = buffer.subarray(total)
        if (opcode === 0x1) {
          let value
          try {
            value = JSON.parse(payload.toString('utf8'))
          } catch (error) {
            for (const waiter of waiters.splice(0)) waiter.reject(error)
            socket.destroy()
            return
          }
          if (waiters.length > 0) waiters.shift().resolve(value)
          else messages.push(value)
        } else if (opcode === 0x8) {
          for (const waiter of waiters.splice(0)) waiter.reject(new Error('socket closed'))
          socket.destroy()
        }
      }
    })
    socket.on('error', reject)
  })
}

async function freePort() {
  const { createServer } = await import('node:http')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

test('real DSH serves the panel, streams a frame and accepts an input event', { skip: !ENABLED, timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-real-'))
  const dshHome = join(home, 'dsh-home')
  const agentsHome = join(home, 'agents-home')
  const workspace = join(home, 'workspace')
  const tmp = join(home, 'tmp')
  await Promise.all([dshHome, agentsHome, workspace, tmp].map(async (path) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path, { recursive: true, mode: 0o700 })
  }))
  // Mirror the packaged layout: the extension lives next to the Harness
  // node_modules so bare host imports resolve, while the installed Harness stays
  // untouched.
  const extensionRoot = join(home, 'harness')
  await mkdir(extensionRoot, { recursive: true, mode: 0o700 })
  await Promise.all([
    cp(fileURLToPath(new URL('.', import.meta.url)), join(extensionRoot, 'browser-plugin'), { recursive: true }),
    cp(fileURLToPath(new URL('../browser-worker', import.meta.url)), join(extensionRoot, 'browser-worker'), { recursive: true }),
  ])
  await symlink('/vol1/@appcenter/dsh-fnos/harness/node_modules', join(extensionRoot, 'node_modules'), 'dir')
  const patchedExtension = join(extensionRoot, 'browser-plugin', 'live.patch.yml')
  const port = await freePort()
  const child = spawn(NODE, [HARNESS, '--profile', 'web', '--patch', patchedExtension, '--no-open', '--port', String(port)], {
    cwd: workspace,
    env: {
      HOME: home,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: agentsHome,
      TMPDIR: tmp,
      PWD: workspace,
      PATH: '/vol1/@appcenter/dsh-fnos/runtime/bin:/var/apps/nodejs_v26/target/bin:/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LD_LIBRARY_PATH: RUNTIME_LIB,
      DSH_FNOS_BROWSER_LIVE: '1',
      DSH_FNOS_ACCEPTANCE_FIXTURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  try {
    const token = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error(`no startup token\n${stderr}`)), 90_000)
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        const match = /https?:\/\/\S+[?&]token=[A-Za-z0-9._~%-]+/u.exec(buffer)
        if (match !== null) { clearTimeout(timer); resolve(match[0]) }
      })
      child.on('exit', (code) => reject(new Error(`harness exited ${code}\n${stderr}`)))
    })
    const exchange = await fetch(token, { redirect: 'manual' })
    const cookie = exchange.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
    assert.notEqual(cookie, '')

    const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
    assert.equal(index.status, 200)
    assert.match(await index.text(), /browser-live\/panel\.js/u)

    const panel = await fetch(`http://127.0.0.1:${port}/browser-live/panel.js`, { headers: { cookie } })
    assert.equal(panel.status, 200)
    assert.match(panel.headers.get('content-type') ?? '', /javascript/u)
    const css = await fetch(`http://127.0.0.1:${port}/browser-live/panel.css`, { headers: { cookie } })
    assert.equal(css.status, 200)

    // Without the session cookie the upgrade must be refused before any stream.
    await assert.rejects(openWebSocket(port, '/browser-live/ws', 'none=1'), /upgrade rejected: HTTP\/1\.1 401/u)

    const ws = await openWebSocket(port, '/browser-live/ws', cookie)
    try {
      ws.send(JSON.stringify({ type: 'subscribe' }))
      let state
      let frameEvent
      for (let attempt = 0; attempt < 60 && frameEvent === undefined; attempt += 1) {
        const event = await ws.next(30_000)
        if (event.type === 'state') state = event
        if (event.type === 'error') throw new Error(`panel error: ${event.message}`)
        if (event.type === 'frame') frameEvent = event
      }
      assert.ok(state !== undefined, 'panel must report its state')
      assert.equal(state.open, true)
      assert.ok(frameEvent !== undefined, 'panel must receive a screencast frame')
      assert.ok(typeof frameEvent.data === 'string' && frameEvent.data.length > 0)
      assert.ok(frameEvent.width > 0 && frameEvent.height > 0)

      ws.send(JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 100, y: 100 } }))
      // A mouse move at a spot where nothing repaints produces no new frame, and
      // a successful input is silent by protocol, so only an error event here
      // would prove the accepted input was rejected downstream.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      for (const event of ws.drain()) {
        if (event.type === 'error') throw new Error(`valid input rejected: ${event.message}`)
      }
      // Negative control: the panel must refuse malformed input on the same channel.
      ws.send(JSON.stringify({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 1, y: 1, button: 'left' } }))
      let rejection
      for (let attempt = 0; attempt < 20 && rejection === undefined; attempt += 1) {
        const event = await ws.next(15_000)
        if (event.type === 'error') rejection = event
      }
      assert.ok(rejection !== undefined, 'malformed input must be rejected')
      assert.match(rejection.message, /移动事件不能携带按键/u)
    } finally {
      ws.close()
    }
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('committed patch file still asks for the reviewed fixture marker', async () => {
  const text = await readFile(PATCH, 'utf8')
  assert.match(text, /network-browser-permission-reviewed-v1/u)
  assert.match(text, /DSH_FNOS_BROWSER_NETWORK !== '1'/u)
})
