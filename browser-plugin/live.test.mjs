import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveBrowser, activate, liveMode, toolFields, toolSchema, validateInput } from './live.mjs'

function fakeContext({ agents = [] } = {}) {
  const registered = []
  const upgrades = []
  const taps = []
  const tools = []
  const disposers = []
  const scopeDisposed = []
  const ctx = {
    logger: { warn() {}, info() {} },
    webServer: {
      register(route) { registered.push(route); return () => {} },
      registerUpgrade(route) { upgrades.push(route); return () => {} },
      tapIndex(transform) { taps.push(transform); return () => {} },
    },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    agents: { list: () => agents, get: (id) => agents.find((agent) => agent.id === id) },
    effect(fn) { disposers.push(fn); return () => {} },
    on() { return () => {} },
  }
  const load = async () => ({
    createScope: (_parent, agent) => {
      const scope = {
        ctx: {
          effect() { return () => {} },
          tools: { register: (definition) => { tools.push({ agent, definition }) } },
        },
        dispose: async () => { scopeDisposed.push(agent.id) },
      }
      return scope
    },
    createMcpToolDefinition: (_ctx, options) => options,
  })
  return { ctx, load, registered, upgrades, taps, tools, disposers, scopeDisposed }
}

function fakeWorkerFactory(calls) {
  return (options) => {
    calls.options = options
    return {
      async request(op, fields) {
        calls.ops.push({ op, fields })
        if (op === 'open_test_site') return { fixture: true, url: 'http://127.0.0.1:38179/', title: '内置固定测试页' }
        if (op === 'live_start') return { started: true }
        if (op === 'snapshot') return { generation: 1, elements: [] }
        if (op === 'live_stop') return { stopped: true }
        return { ok: true }
      },
      async stop() { calls.stopped = true },
    }
  }
}


const OWNER = { peer: { principal: { kind: 'owner' } } }

/** Minimal stand-in for the upgraded TCP socket used by live-ws.mjs. */
function fakeSocket() {
  const listeners = new Map()
  const socket = {
    writableLength: 0,
    writes: [],
    destroyed: false,
    write(chunk) { socket.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true },
    end(chunk) { if (chunk) socket.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) },
    destroy() { if (socket.destroyed) return; socket.destroyed = true; for (const handler of listeners.get('close') ?? []) handler() },
    on(event, handler) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); return socket },
    emit(event, value) { for (const handler of listeners.get(event) ?? []) handler(value) },
  }
  return socket
}

/** One masked, unfragmented text frame, as a browser sends it. */
function clientFrame(text) {
  const payload = Buffer.from(text)
  assert.ok(payload.length < 126)
  const mask = Buffer.from([7, 11, 13, 17])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index & 3]
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
}

/** Decode every text frame the server wrote back to one socket. */
function serverMessages(socket) {
  const messages = []
  for (const chunk of socket.writes) {
    if (chunk.length < 2 || chunk[0] !== 0x81) continue
    let length = chunk[1] & 0x7f
    let offset = 2
    if (length === 126) { length = chunk.readUInt16BE(2); offset = 4 }
    messages.push(JSON.parse(chunk.subarray(offset, offset + length).toString('utf8')))
  }
  return messages
}

function upgradeRequest(sessionId, tabId) {
  return { headers: { 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'), 'sec-websocket-version': '13' }, url: `/browser-live/ws?sessionId=${sessionId}&tabId=${tabId}` }
}

function fixturePlug() {
  const browsers = []
  const workerFactory = () => {
    const record = { ops: [], stopped: false }
    browsers.push(record)
    return {
      async request(op, fields) { record.ops.push({ op, fields }); return { ok: true, url: 'http://127.0.0.1:38179/', title: '内置固定测试页' } },
      async stop() { record.stopped = true },
    }
  }
  return { browsers, workerFactory }
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/** Open one panel websocket through the registered upgrade handler. */
async function openSocket(ctx, upgrades, sessionId, tabId) {
  const socket = fakeSocket()
  upgrades[0].handler({ ...upgradeRequest(sessionId, tabId), headers: { ...upgradeRequest(sessionId, tabId).headers } }, socket, Buffer.alloc(0))
  return socket
}

const LIVE_ENV = { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' }
const NETWORK_ENV = { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_BROWSER_NETWORK: '1' }

test('both trusted switches are required', () => {
  assert.equal(liveMode({}), false)
  assert.equal(liveMode({ DSH_FNOS_BROWSER_LIVE: '1' }), false)
  assert.equal(liveMode({ DSH_FNOS_ACCEPTANCE_FIXTURE: '1' }), false)
  assert.equal(liveMode({ DSH_FNOS_BROWSER_LIVE: 'TRUE', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' }), false)
  assert.equal(liveMode(LIVE_ENV), true)
  assert.equal(liveMode(NETWORK_ENV), true)
  assert.equal(liveMode({ DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1', DSH_FNOS_BROWSER_NETWORK: '1' }), false)
})

test('disabled activation registers nothing', async () => {
  const { ctx, load, registered, upgrades, taps } = fakeContext()
  const result = await activate(ctx, { env: {}, load, workerFactory: fakeWorkerFactory({ ops: [] }) })
  assert.equal(result, undefined)
  assert.equal(registered.length, 0)
  assert.equal(upgrades.length, 0)
  assert.equal(taps.length, 0)
})

test('enabled activation registers routes without legacy panel injection', async () => {
  const { ctx, load, registered, upgrades, taps } = fakeContext()
  const browser = await activate(ctx, { env: LIVE_ENV, load, workerFactory: fakeWorkerFactory({ ops: [] }) })
  assert.ok(browser !== undefined)
  assert.deepEqual(registered.map((route) => [route.kind, route.path]), [['prefix', '/browser-live']])
  assert.deepEqual(upgrades.map((route) => route.path), ['/browser-live/ws', '/browser-live/control'])
  assert.equal(taps.length, 0)
})

test('panel asset route answers 404 for unknown paths and 503 while panel files are absent', async () => {
  const { ctx, load, registered } = fakeContext()
  await activate(ctx, { env: LIVE_ENV, load, workerFactory: fakeWorkerFactory({ ops: [] }) })
  const handler = registered[0].handler
  const responses = []
  const res = { writeHead(status) { responses.push(status); this.status = status }, end() { this.ended = true } }
  await handler({ url: '/browser-live/other' }, res)
  assert.deepEqual(responses, [404])
})

test('agent tools are registered per live agent and reject foreign executions', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const calls = { ops: [] }
  const { ctx, load, tools, scopeDisposed } = fakeContext({ agents: [agent] })
  await activate(ctx, { env: LIVE_ENV, load, workerFactory: fakeWorkerFactory(calls) })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].agent, agent)
  const definition = tools[0].definition
  assert.equal(definition.name, 'browser_live_control')

  await assert.rejects(definition.call({ action: 'open_test_site' }, { agent: { id: 'other' }, signal: new AbortController().signal }), /有效且匹配/u)
  await assert.rejects(definition.call({ action: 'open_test_site' }, { agent, signal: undefined }), /有效且匹配/u)

  const result = await definition.call({ action: 'list_tabs' }, { agent, signal: new AbortController().signal })
  assert.deepEqual(JSON.parse(result.content[0].text), { tabs: [] })
  await assert.rejects(definition.call({ action: 'open_test_site', tabId: 'missing' }, { agent, signal: new AbortController().signal }), /标签不存在/u)
  assert.ok(scopeDisposed.length === 0)
})

test('network mode exposes approved local, LAN and public navigation', () => {
  assert.deepEqual(toolSchema('network').properties.action.enum, ['list_tabs', 'create_tab', 'navigate', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics'])
  for (const url of [
    'https://example.com/design?id=1',
    'http://example.com/',
    'http://127.0.0.1:8080/',
    'http://localhost:3000/',
    'http://192.168.2.64:8080/',
    'http://service.internal/',
    'https://example.com:8443/',
  ]) {
    assert.equal(toolFields({ action: 'navigate', url }, 'network').url, new URL(url).href)
  }
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,no', 'http://user:pass@example.com/', 'http://0.0.0.0/']) {
    assert.throws(() => toolFields({ action: 'navigate', url }, 'network'), Error, url)
  }
  assert.throws(() => toolFields({ action: 'navigate', url: 'https://example.com' }, 'fixture'), /无效的浏览器面板操作/u)
})

test('model navigation waits for explicit panel approval and denial keeps the worker', async () => {
  const messages = []
  const calls = { ops: [], stopped: false }
  const connection = {
    closed: false,
    sendText(text) { messages.push(JSON.parse(text)); return true },
    close() { this.closed = true },
  }
  const workerFactory = options => {
    calls.options = options
    return {
      async request(op, fields) {
        calls.ops.push({ op, fields })
        if (op === 'live_start') return { started: true }
        if (op === 'navigate') return { url: fields.url, title: 'Example', loading: false }
        if (op === 'live_stop') return { stopped: true }
        return { ok: true }
      },
      async stop() { calls.stopped = true },
    }
  }
  const browser = new LiveBrowser({ warn() {} }, 'network', workerFactory)
  browser.connect(connection)
  await browser.addViewer(connection)
  const pending = browser.invokeTool({ action: 'navigate', url: 'https://example.com/' }, AbortSignal.timeout(5000))
  for (let index = 0; index < 20 && !messages.some(message => message.type === 'permission'); index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  const permission = messages.find(message => message.type === 'permission')
  assert.ok(permission)
  assert.equal(permission.url, 'https://example.com/')
  assert.equal(permission.scope, 'public')
  assert.equal(calls.ops.some(entry => entry.op === 'navigate'), false)
  browser.respondPermission(connection, { requestId: permission.requestId, allow: true })
  assert.deepEqual(await pending, { url: 'https://example.com/', title: 'Example', loading: false })
  assert.equal(calls.ops.filter(entry => entry.op === 'navigate').length, 1)

  const denied = browser.invokeTool({ action: 'navigate', url: 'https://example.com/private' }, AbortSignal.timeout(5000))
  for (let index = 0; index < 20; index += 1) {
    const request = messages.filter(message => message.type === 'permission').at(-1)
    if (request?.url === 'https://example.com/private') {
      browser.respondPermission(connection, { requestId: request.requestId, allow: false })
      break
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  await assert.rejects(denied, /用户拒绝访问此地址/u)
  assert.equal(calls.stopped, false)
  await browser.dispose()
})

test('mouse, key and text events accept only the worker vocabulary', () => {
  assert.deepEqual(validateInput({ kind: 'mouse', type: 'mouseMoved', x: 12.6, y: -3 }), { kind: 'mouse', type: 'mouseMoved', x: 13, y: 0 })
  assert.deepEqual(validateInput({ kind: 'mouse', type: 'mousePressed', x: 99999, y: 99999, button: 'left', clickCount: 1 }), { kind: 'mouse', type: 'mousePressed', x: 1279, y: 799, button: 'left', clickCount: 1 })
  assert.deepEqual(validateInput({ kind: 'mouse', type: 'mouseWheel', x: 1, y: 2, deltaX: -10, deltaY: 120 }), { kind: 'mouse', type: 'mouseWheel', x: 1, y: 2, deltaX: -10, deltaY: 120 })
  assert.deepEqual(validateInput({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 8 }), { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 8 })
  assert.deepEqual(validateInput({ kind: 'text', text: '粘贴文本' }), { kind: 'text', text: '粘贴文本' })

  const rejected = [
    {},
    { kind: 'mouse', type: 'mouseMoved', x: 0, y: 0, button: 'left' },
    { kind: 'mouse', type: 'mouseMoved', x: Number.NaN, y: 0 },
    { kind: 'mouse', type: 'mousePressed', x: 0, y: 0, button: 'none' },
    { kind: 'mouse', type: 'mousePressed', x: 0, y: 0, button: 'left', clickCount: 4 },
    { kind: 'mouse', type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 1201 },
    { kind: 'mouse', type: 'mouseMoved', x: 0, y: 0, deltaY: 1 },
    { kind: 'key', type: 'keyDown', key: '' },
    { kind: 'key', type: 'keyPress', key: 'a' },
    { kind: 'key', type: 'keyDown', key: 'a', modifiers: 16 },
    { kind: 'text', text: '' },
    { kind: 'text', text: 'a'.repeat(4097) },
    { kind: 'paste', text: 'a' },
    { kind: 'text', text: 'bad\u0000' },
  ]
  for (const value of rejected) assert.throws(() => validateInput(value), Error, JSON.stringify(value))
})

test('tool fields reject actions, extra fields and out-of-range element references', () => {
  assert.deepEqual(toolFields({ action: 'open_test_site' }), {})
  assert.deepEqual(toolFields({ action: 'click', generation: 1, index: 2 }), { generation: 1, index: 2 })
  assert.deepEqual(toolFields({ action: 'fill', generation: 1, index: 2, value: 'x' }), { generation: 1, index: 2, value: 'x' })
  const rejected = [
    {},
    { action: 'navigate' },
    { action: 'open_test_site', url: 'https://example.com' },
    { action: 'click', generation: 1 },
    { action: 'click', generation: -1, index: 0 },
    { action: 'click', generation: 1, index: 100 },
    { action: 'fill', generation: 1, index: 0 },
    { action: 'fill', generation: 1, index: 0, value: 'x'.repeat(4097) },
  ]
  for (const value of rejected) assert.throws(() => toolFields(value), Error, JSON.stringify(value))
})

test('each sidebar tab owns an isolated browser and close stops only that tab', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades } = fakeContext({ agents: [agent] })
  const { browsers, workerFactory } = fixturePlug()
  const plugin = await activate(ctx, { env: LIVE_ENV, load, workerFactory })

  const first = await openSocket(ctx, upgrades, 'a1', 'tab-1')
  const second = await openSocket(ctx, upgrades, 'a1', 'tab-2')
  first.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
  second.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
  await settle()

  assert.equal(plugin.tabs.size, 2)
  assert.equal(browsers.length, 2, '每个标签一个独立 worker')
  assert.equal(browsers.every(record => record.ops.some(entry => entry.op === 'live_start')), true)

  first.emit('data', clientFrame(JSON.stringify({ type: 'close' })))
  await settle()
  assert.equal(plugin.tabs.size, 1, '关闭标签只移除自身')
  assert.equal(browsers[0].stopped, true)
  assert.equal(browsers[1].stopped, false, '另一标签的浏览器保持运行')
  assert.ok(serverMessages(second).some(message => message.type === 'state'))
})

test('upgrade rejects non-owner peers and mismatched session identities', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades } = fakeContext({ agents: [agent] })
  const { workerFactory } = fixturePlug()
  await activate(ctx, { env: LIVE_ENV, load, workerFactory })

  const denied = fakeSocket()
  ctx.connection.admit = () => ({ rejection: 401 })
  upgrades[0].handler(upgradeRequest('a1', 'tab-1'), denied, Buffer.alloc(0))
  assert.equal(denied.writes[0].toString('utf8').startsWith('HTTP/1.1 401'), true)

  ctx.connection.admit = () => OWNER
  const foreign = fakeSocket()
  upgrades[0].handler(upgradeRequest('a2', 'tab-1'), foreign, Buffer.alloc(0))
  assert.equal(foreign.writes[0].toString('utf8').startsWith('HTTP/1.1 403'), true)
})

test('failed synchronous worker creation releases shared capacity for other tabs', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades } = fakeContext({ agents: [agent] })
  const fixture = fixturePlug()
  let attempts = 0
  const workerFactory = (...args) => {
    attempts += 1
    if (attempts <= 3) throw new Error('worker factory failed')
    return fixture.workerFactory(...args)
  }
  const plugin = await activate(ctx, { env: LIVE_ENV, load, workerFactory })
  const sockets = []
  for (let index = 0; index < 4; index += 1) {
    const socket = await openSocket(ctx, upgrades, 'a1', `factory-${index}`)
    sockets.push(socket)
    socket.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
    await settle()
  }
  for (const socket of sockets.slice(0, 3)) {
    assert.ok(serverMessages(socket).some(message => message.type === 'error' && /worker factory failed/.test(message.message)))
  }
  assert.equal(attempts, 4)
  assert.equal(fixture.browsers.length, 1)
  assert.ok(serverMessages(sockets[3]).some(message => message.type === 'state'))
  await Promise.all([...plugin.tabs.values()].map(tab => tab.browser.dispose()))
})

test('invalid websocket handshakes do not consume or delete tab capacity', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades } = fakeContext({ agents: [agent] })
  const plugin = await activate(ctx, { env: LIVE_ENV, load, workerFactory: fixturePlug().workerFactory })
  await openSocket(ctx, upgrades, 'a1', 'existing')
  for (const tabId of ['existing', ...Array.from({ length: 7 }, (_, i) => `bad-${i}`)]) {
    const socket = fakeSocket()
    const request = upgradeRequest('a1', tabId)
    delete request.headers['sec-websocket-key']
    upgrades[0].handler(request, socket, Buffer.alloc(0))
    assert.match(socket.writes[0].toString('utf8'), /^HTTP\/1\.1 400/)
    assert.equal(plugin.tabs.size, 1)
  }
  const valid = await openSocket(ctx, upgrades, 'a1', 'valid')
  assert.match(valid.writes[0].toString('utf8'), /^HTTP\/1\.1 101/)
  assert.equal(plugin.tabs.size, 2)
  await Promise.all([...plugin.tabs.values()].map(tab => tab.browser.dispose()))
})

test('tab count and live worker count are bounded', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades } = fakeContext({ agents: [agent] })
  const { workerFactory } = fixturePlug()
  const plugin = await activate(ctx, { env: LIVE_ENV, load, workerFactory })

  for (let index = 0; index < 6; index += 1) await openSocket(ctx, upgrades, 'a1', `tab-${index}`)
  assert.equal(plugin.tabs.size, 6)
  const overflow = await openSocket(ctx, upgrades, 'a1', 'tab-overflow')
  assert.equal(overflow.writes[0].toString('utf8').startsWith('HTTP/1.1 403'), true)

  const sockets = []
  for (let index = 0; index < 3; index += 1) {
    const socket = fakeSocket()
    upgrades[0].handler(upgradeRequest('a1', `tab-${index}`), socket, Buffer.alloc(0))
    socket.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
    sockets.push(socket)
  }
  await settle()
  const fourth = fakeSocket()
  upgrades[0].handler(upgradeRequest('a1', 'tab-3'), fourth, Buffer.alloc(0))
  fourth.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
  await settle()
  assert.ok(serverMessages(fourth).some(message => message.type === 'error' && /最多运行 3 个受控浏览器/u.test(message.message)))
})

test('list_tabs reports per-tab page state for targeted agent control', async () => {
  const agent = { id: 'a1', session: { id: 'a1' } }
  const { ctx, load, upgrades, tools } = fakeContext({ agents: [agent] })
  const { workerFactory } = fixturePlug()
  await activate(ctx, { env: LIVE_ENV, load, workerFactory })
  const socket = await openSocket(ctx, upgrades, 'a1', 'tab-1')
  socket.emit('data', clientFrame(JSON.stringify({ type: 'subscribe' })))
  await settle()
  const result = await tools[0].definition.call({ action: 'list_tabs' }, { agent, signal: new AbortController().signal })
  const tabs = JSON.parse(result.content[0].text).tabs
  assert.equal(tabs.length, 1)
  assert.equal(typeof tabs[0].tabId, 'string')
  assert.equal(typeof tabs[0].url, 'string')
  assert.match(tabs[0].title, /内置固定测试页/u)
})
