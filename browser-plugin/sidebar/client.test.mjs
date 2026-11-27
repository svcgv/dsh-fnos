import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function fixture(react = {}) {
  const code = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let factory, body, inject, close, definition
  const sockets = [], tabs = [], actions = []
  let mounted, expanded = false, active, serial = 0
  const mountedListeners = new Set(), cleanups = []
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    send(value) { this.sent.push(JSON.parse(value)) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const context = { window: { location: { href: 'https://example.test/gateway/workspace/' }, __ModuleLoader__: { load: value => { factory = value.factory; assert.equal(value.id, '@dsh-fnos/controlled-browser-sidebar') } } }, document: { baseURI: 'https://example.test/gateway/workspace/' }, URL, WebSocket: Socket, setTimeout, clearTimeout, Math, JSON, TextEncoder }
  vm.runInNewContext(code, context)
  const plugin = factory(() => react)
  const ctx = {
    locale: { bind: () => x => x, register: () => () => {} },
    sidebarRightTabs: { register: x => { definition = x; return () => {} } },
    sidebarRight: {
      registerCloseHandler: (_, fn) => { close = fn; return () => {} },
      mounted: { getSnapshot: () => mounted, subscribe: fn => { mountedListeners.add(fn); return () => mountedListeners.delete(fn) } },
      openTabs: { getSnapshot: () => tabs },
      openTab: kind => { const tabId = `tab-${++serial}`; active = { id: tabId, kind }; tabs.push({ sessionId: mounted, tabId, kind }); expanded = true; actions.push(['open', mounted, tabId]) },
      active: () => active,
      isExpanded: () => expanded,
      toggleExpanded: () => { expanded = !expanded; actions.push(['expand', mounted]) },
      focus: tab => actions.push(['focus', mounted, tab])
    },
    slots: { inject: (_, fn) => fn(), register: (opts, component) => { body = component; inject = opts.inject; return () => {} } },
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
  }
  plugin.apply(ctx)
  return { sockets, definition, body, inject, close, tabs, actions, sidebar: ctx.sidebarRight, dispose: () => cleanups.reverse().forEach(fn => fn()), setMounted: value => { mounted = value; mountedListeners.forEach(fn => fn()) }, setExpanded: value => { expanded = value } }
}

test('multi-instance type and session-scoped websocket identity', async () => {
  const f = await fixture()
  assert.equal(f.definition.multiple, true)
  assert.equal(f.definition.guide.length, 1)
  assert.equal(typeof f.body, 'function')
  const a = f.inject('session A').controller('tab-1')
  const b = f.inject('session B').controller('tab-1')
  assert.notEqual(a, b)
  assert.equal(f.sockets.length, 0, 'render preparation must not connect')
  a.start(); b.start()
  const u = new URL(f.sockets[0].url)
  assert.equal(u.href, 'wss://example.test/gateway/workspace/browser-live/ws?sessionId=session+A&tabId=tab-1')
  assert.equal(new URL(f.sockets[1].url).searchParams.get('sessionId'), 'session B')
  a.setVisible(true); f.sockets[0].open()
  assert.equal(f.sockets[0].sent[0].type, 'subscribe')
  a.setVisible(false)
  assert.equal(f.sockets[0].sent[1].type, 'unsubscribe')
  f.close('session A', { id: 'tab-1' })
  assert.equal(f.sockets[0].sent.at(-1).type, 'close')
  assert.equal(f.sockets[1].readyState, 0)
  b.dispose()
})

test('address bar adds https and reports invalid addresses', async () => {
  let cursor = 0
  const hooks = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useMemo: fn => fn(), useSyncExternalStore: (_, get) => get(),
    useState: initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value }] },
    useCallback: fn => fn, useEffect: () => {},
  }
  const f = await fixture(react)
  const controller = f.inject('session').controller('tab')
  controller.start(); f.sockets[0].open()
  const render = () => { cursor = 0; return f.body({ useTabInfo: () => ({ tab: { id: 'tab', visible: true, actions: {} } }), controller: () => controller, t: x => x }) }
  const form = tree => tree.children[1]
  let tree = render()
  form(tree).children[3].props.onChange({ target: { value: 'example.com' } })
  tree = render(); form(tree).props.onSubmit({ preventDefault() {} })
  assert.equal(f.sockets[0].sent.at(-1).url, 'https://example.com/')
  tree = render(); form(tree).children[3].props.onChange({ target: { value: 'http://127.0.0.1:8080/' } })
  tree = render(); form(tree).props.onSubmit({ preventDefault() {} })
  assert.equal(f.sockets[0].sent.at(-1).url, 'http://127.0.0.1:8080/')
  tree = render(); form(tree).children[3].props.onChange({ target: { value: 'javascript:alert(1)' } })
  tree = render(); const count = f.sockets[0].sent.length; form(tree).props.onSubmit({ preventDefault() {} })
  tree = render(); assert.equal(f.sockets[0].sent.length, count)
  assert.equal(tree.children[3].children[1], ' — invalidAddress')
  controller.dispose()
})

test('show and permission reveal only the owning on-screen session and existing tab', async () => {
  const f = await fixture()
  f.tabs.push({ sessionId: 'A', tabId: 'same', kind: 'controlled-browser' }, { sessionId: 'B', tabId: 'same', kind: 'controlled-browser' })
  const a = f.inject('A').controller('same')
  const b = f.inject('B').controller('same')
  a.start(); b.start(); f.sockets[0].open(); f.sockets[1].open()
  const message = (socket, value) => socket.onmessage({ data: JSON.stringify(value) })
  f.setMounted('B')
  message(f.sockets[0], { type: 'show' })
  message(f.sockets[0], { type: 'permission', requestId: 'r1', url: 'https://example.com/' })
  assert.equal(f.actions.length, 0, 'background session cannot reveal or focus the same tab id')
  assert.equal(a.getSnapshot().permission.requestId, 'r1', 'permission remains available')
  message(f.sockets[1], { type: 'show' })
  assert.deepEqual(f.actions, [['expand', 'B'], ['focus', 'B', 'same']])
  f.setMounted('A'); f.setExpanded(true); f.actions.length = 0
  message(f.sockets[0], { type: 'permission', requestId: 'r2', url: 'https://example.com/' })
  assert.deepEqual(f.actions, [['focus', 'A', 'same']])
  f.actions.length = 0; f.tabs.splice(0, 1); f.setExpanded(false)
  message(f.sockets[0], { type: 'show' })
  assert.equal(f.actions.length, 0, 'removed tab cannot expand the sidebar')
  a.dispose(); b.dispose()
})

test('session control creates real tabs without any existing tab, expands, deduplicates and switches safely', async () => {
  const f = await fixture()
  f.setMounted('A')
  const a = f.sockets[0]; a.open()
  assert.equal(new URL(a.url).pathname, '/gateway/workspace/browser-live/control')
  assert.equal(new URL(a.url).searchParams.get('sessionId'), 'A')
  const request = { type: 'create_tab', sessionId: 'A', requestId: 'r1', expiresAt: Date.now() + 30000 }
  const deliver = (socket, value) => socket.onmessage({ data: JSON.stringify(value) })
  deliver(a, request)
  assert.equal(a.sent[0].tabId, 'tab-1')
  assert.equal(f.sidebar.isExpanded(), true)
  deliver(a, request)
  assert.equal(a.sent[1].tabId, 'tab-1')
  assert.equal(f.tabs.length, 1)
  deliver(a, { ...request, requestId: 'expired', expiresAt: Date.now() - 1 })
  assert.match(a.sent[2].error, /expired/)
  deliver(a, { ...request, requestId: 'wrong', sessionId: 'B' })
  assert.equal(a.sent.length, 3)
  f.setMounted('B')
  const b = f.sockets[1]; b.open()
  deliver(a, { ...request, requestId: 'late' })
  assert.equal(f.tabs.length, 1)
  deliver(b, { ...request, requestId: 'b', sessionId: 'B' })
  assert.equal(b.sent[0].tabId, 'tab-2')
  assert.equal(f.tabs[1].sessionId, 'B')
  f.dispose()
  assert.equal(b.readyState, 3)
})

test('creation fails closed if sidebar identity is ambiguous or not mounted', async () => {
  const f = await fixture(); f.setMounted('A')
  const socket = f.sockets[0]; socket.open()
  const open = f.sidebar.openTab
  f.sidebar.openTab = kind => { open(kind); open(kind) }
  socket.onmessage({ data: JSON.stringify({ type: 'create_tab', sessionId: 'A', requestId: 'r', expiresAt: Date.now() + 30000 }) })
  assert.match(socket.sent[0].error, /identify/)
  assert.equal(socket.sent[0].tabId, undefined)
  f.setMounted(undefined)
  assert.equal(socket.readyState, 3)
  f.dispose()
})

test('closing an unmounted tab sends explicit close after connection', async () => {
  const f = await fixture()
  f.close('session', { id: 'tab' })
  assert.equal(f.sockets.length, 1)
  f.sockets[0].open()
  assert.equal(f.sockets[0].sent[0].type, 'close')
  assert.equal(f.sockets[0].readyState, 3)
})
