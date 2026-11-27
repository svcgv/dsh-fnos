import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { activate } from './live.mjs'

class Socket extends EventEmitter {
  writes = []
  write(value) { this.writes.push(value); return true }
  end(value) { if (value) this.write(value) }
  destroy() { this.emit('close') }
  message(value) {
    const data = Buffer.from(JSON.stringify(value)); const mask = Buffer.from([1, 2, 3, 4]);
    assert.ok(data.length < 126)
    const body = Buffer.from(data.map((b, i) => b ^ mask[i % 4]))
    this.emit('data', Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, body]))
  }
  messages() {
    return this.writes.filter(Buffer.isBuffer).flatMap(frame => {
      const len = frame[1] & 127
      const offset = len === 126 ? 4 : len === 127 ? 10 : 2
      try { return [JSON.parse(frame.subarray(offset).toString())] } catch { return [] }
    })
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('tabs isolate workers, sessions, approvals and close', async () => {
  const agents = ['a', 'b'].map(id => ({ id, session: { id } }))
  const tools = new Map(); const upgrades = new Map(); const workers = []
  const ctx = {
    logger: { warn() {} }, connection: { admit: req => req.deny ? { peer: { principal: { kind: 'viewer' } } } : { peer: { principal: { kind: 'owner' } } } },
    agents: { get: id => agents.find(a => a.id === id), list: () => agents },
    webServer: { register: () => () => {}, registerUpgrade: x => { upgrades.set(x.path, x.handler); return () => {} } },
    effect() {}, on() {},
  }
  const load = async () => ({ createScope: (_, agent) => ({ ctx: { effect() {}, tools: { register: tool => tools.set(agent.id, tool) } }, dispose: async () => {} }), createMcpToolDefinition: (_, def) => def })
  const workerFactory = () => { const worker = { ops: [], stopped: false, async request(op, fields) { this.ops.push([op, fields]); return op === 'navigate' ? { url: fields.url } : {} }, async stop() { this.stopped = true } }; workers.push(worker); return worker }
  const runtime = await activate(ctx, { env: { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_BROWSER_NETWORK: '1' }, load, workerFactory })
  function connect(sessionId, tabId, deny = false) {
    const socket = new Socket()
    upgrades.get('/browser-live/ws')({ url: `/browser-live/ws?sessionId=${sessionId}&tabId=${tabId}`, headers: { 'sec-websocket-key': Buffer.alloc(16).toString('base64'), 'sec-websocket-version': '13' }, deny }, socket, Buffer.alloc(0))
    return socket
  }
  const rejected = connect('a', 'bad', true)
  assert.match(String(rejected.writes[0]), /403/)
  const one = connect('a', 'one'); const two = connect('a', 'two'); const other = connect('b', 'one')
  one.message({ type: 'subscribe' }); two.message({ type: 'subscribe' }); other.message({ type: 'subscribe' }); await tick(); await tick()
  assert.equal(workers.length, 3)
  const exec = { agent: agents[0], signal: AbortSignal.timeout(5000) }
  const list = await tools.get('a').call({ action: 'list_tabs' }, exec)
  assert.deepEqual(JSON.parse(list.content[0].text).tabs.map(x => x.tabId), ['one', 'two'])
  await assert.rejects(tools.get('a').call({ action: 'snapshot', tabId: 'missing' }, exec), /标签不存在/)
  const navigation = tools.get('a').call({ action: 'navigate', tabId: 'one', url: 'https://example.com/' }, exec)
  await tick(); await tick()
  const permission = one.messages().find(m => m.type === 'permission')
  assert.ok(permission); assert.equal(two.messages().some(m => m.type === 'permission'), false); assert.equal(other.messages().some(m => m.type === 'permission'), false)
  two.message({ type: 'permission-response', requestId: permission.requestId, allow: true }); await tick()
  assert.equal(workers[0].ops.some(([op]) => op === 'navigate'), false)
  one.message({ type: 'permission-response', requestId: permission.requestId, allow: true }); await navigation
  one.message({ type: 'permission-response', requestId: permission.requestId, allow: true }); await tick()
  assert.ok(one.messages().some(m => m.type === 'error' && /过期/.test(m.message)))
  one.message({ type: 'close' }); await tick(); assert.equal(workers[0].stopped, true)
  assert.equal(runtime.tabs.size, 2)
  await assert.rejects(tools.get('a').call({ action: 'snapshot', tabId: 'one' }, exec), /标签不存在/)
  two.message({ type: 'close' }); other.message({ type: 'close' }); await tick()
})

test('model-created tab becomes usable only after its sidebar connection arrives', async () => {
  const agent = { id: 'a', session: { id: 'a' } }; let tool
  const upgrades = new Map()
  const ctx = {
    logger: { warn() {} }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    agents: { get: id => id === 'a' ? agent : undefined, list: () => [agent] },
    webServer: { register: () => () => {}, registerUpgrade: x => { upgrades.set(x.path, x.handler); return () => {} } }, effect() {}, on() {},
  }
  const load = async () => ({ createScope: () => ({ ctx: { effect() {}, tools: { register: value => { tool = value } } }, dispose: async () => {} }), createMcpToolDefinition: (_, def) => def })
  const workerFactory = () => ({ async request(op, fields) { return op === 'navigate' ? { url: fields.url } : {} }, async stop() {} })
  await activate(ctx, { env: { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_BROWSER_NETWORK: '1' }, load, workerFactory })
  const connect = (path, query) => { const socket = new Socket(); upgrades.get(path)({ url: `${path}?${query}`, headers: { 'sec-websocket-key': Buffer.alloc(16).toString('base64'), 'sec-websocket-version': '13' } }, socket, Buffer.alloc(0)); return socket }
  const control = connect('/browser-live/control', 'sessionId=a')
  const exec = { agent, signal: AbortSignal.timeout(5000) }
  let settled = false
  const creation = tool.call({ action: 'create_tab' }, exec).then(value => { settled = true; return value })
  const request = control.messages().find(m => m.type === 'create_tab')
  control.message({ type: 'create_tab_result', requestId: request.requestId, sessionId: 'a', tabId: 'new' })
  await tick()
  assert.equal(settled, false, 'creation must wait for the panel connection')
  const panel = connect('/browser-live/ws', 'sessionId=a&tabId=new')
  assert.equal(JSON.parse((await creation).content[0].text).tabId, 'new')
  const navigation = tool.call({ action: 'navigate', tabId: 'new', url: 'https://example.com/' }, exec)
  await tick(); await tick()
  const permission = panel.messages().find(m => m.type === 'permission')
  assert.ok(permission)
  panel.message({ type: 'permission-response', requestId: permission.requestId, allow: true })
  assert.equal(JSON.parse((await navigation).content[0].text).url, 'https://example.com/')
  panel.message({ type: 'close' }); control.destroy()
})
