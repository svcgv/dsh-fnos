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
    connection: { requestRejection: () => undefined },
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

test('enabled activation registers the fixed routes and injects one panel script', async () => {
  const { ctx, load, registered, upgrades, taps } = fakeContext()
  const browser = await activate(ctx, { env: LIVE_ENV, load, workerFactory: fakeWorkerFactory({ ops: [] }) })
  assert.ok(browser !== undefined)
  assert.deepEqual(registered.map((route) => [route.kind, route.path]), [['prefix', '/browser-live']])
  assert.deepEqual(upgrades.map((route) => route.path), ['/browser-live/ws'])
  assert.equal(taps.length, 1)
  const transformed = taps[0]('<html><body><div id="app"></div></body></html>')
  assert.match(transformed, /<script type="module" src="browser-live\/panel\.js"><\/script>/u)
  assert.equal(taps[0](transformed), transformed)
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
  const agent = { id: 'a1' }
  const calls = { ops: [] }
  const { ctx, load, tools, scopeDisposed } = fakeContext({ agents: [agent] })
  await activate(ctx, { env: LIVE_ENV, load, workerFactory: fakeWorkerFactory(calls) })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].agent, agent)
  const definition = tools[0].definition
  assert.equal(definition.name, 'browser_live_control')

  await assert.rejects(definition.call({ action: 'open_test_site' }, { agent: { id: 'other' }, signal: new AbortController().signal }), /有效且匹配/u)
  await assert.rejects(definition.call({ action: 'open_test_site' }, { agent, signal: undefined }), /有效且匹配/u)

  const result = await definition.call({ action: 'open_test_site' }, { agent, signal: new AbortController().signal })
  assert.equal(result.content[0].type, 'text')
  assert.deepEqual(calls.options, { acceptanceFixture: true, livePanel: true, onEvent: calls.options.onEvent })
  assert.deepEqual(calls.ops.slice(0, 2).map((entry) => entry.op), ['open_test_site', 'live_start'])
  assert.ok(scopeDisposed.length === 0)
})

test('network mode exposes approved local, LAN and public navigation', () => {
  assert.deepEqual(toolSchema('network').properties.action.enum, ['navigate', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics'])
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
