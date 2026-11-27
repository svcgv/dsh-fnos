// Opt-in controlled browser tabs in the Web GUI's right sidebar.
// Each tab has an independent private-CDP worker shared with its Agent tools.
// Model-requested HTTP(S) navigation requires explicit approval; same-origin
// page-initiated navigation remains allowed. The client uses an authenticated
// WebSocket protocol and never receives a CDP socket.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startWorker } from './worker-client.mjs'
import { acceptWebSocket, rejectUpgrade } from './live-ws.mjs'
import { browserTargetScope, normalizeBrowserUrl } from '../browser-worker/browser-url.mjs'

export const inject = ['tools', 'agents', 'webServer', 'connection']

/** Trusted host switch; absent or different means the plugin stays inert. */
export const LIVE_ENV = 'DSH_FNOS_BROWSER_LIVE'
/** Fixed-page acceptance mode. */
export const FIXTURE_ENV = 'DSH_FNOS_ACCEPTANCE_FIXTURE'
/** Network browser mode; each model navigation still needs user approval. */
export const NETWORK_ENV = 'DSH_FNOS_BROWSER_NETWORK'

const ROUTE = '/browser-live'
const WS_ROUTE = '/browser-live/ws'
const CONTROL_ROUTE = '/browser-live/control'
const MAX_CONTROL_CONNECTIONS = 32
const CREATE_TIMEOUT_MS = 30_000
const ASSETS = new Map([
  ['/browser-live/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/browser-live/panel.css', ['panel.css', 'text/css; charset=utf-8']],
])
const PANEL_DIR = new URL('./panel/', import.meta.url)
const FIXTURE_URL = 'http://127.0.0.1:38179/'
const FIXTURE_TITLE = '内置固定测试页'
const PANEL_VIEWPORT = Object.freeze({ maxWidth: 1280, maxHeight: 800, quality: 60 })
/** Sidebar tabs are cheap; each live worker is a full Chromium process, so bound both. */
export const MAX_TABS = 6
export const MAX_WORKERS = 3
const MAX_SESSIONS_PAGE_OPEN = 30_000
const MAX_TOOL_MS = 30_000
const MAX_NAVIGATE_MS = 90_000
const PERMISSION_TIMEOUT_MS = 60_000

/** Exactly one browser mode is selected by trusted host environment. */
export function liveBrowserMode(env = process.env) {
  if (env?.[LIVE_ENV] !== '1') return undefined
  const fixture = env?.[FIXTURE_ENV] === '1'
  const networkBrowser = env?.[NETWORK_ENV] === '1'
  if (fixture === networkBrowser) return undefined
  return networkBrowser ? 'network' : 'fixture'
}

export function liveMode(env = process.env) {
  return liveBrowserMode(env) !== undefined
}

function numberIn(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function bytes(value) { return Buffer.byteLength(value, 'utf8') }

function cleanString(value, maxBytes, label) {
  if (typeof value !== 'string' || value.length === 0 || bytes(value) > maxBytes || value.includes('\0')) throw new Error(`${label}无效`)
  return value
}

function optionalString(value, maxBytes, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || bytes(value) > maxBytes || value.includes('\0')) throw new Error(`${label}无效`)
  return value
}

function modifiersOf(value) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > 15) throw new Error('修饰键无效')
  return value
}

const MOUSE_TYPES = new Set(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'])
const BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward'])
const KEY_TYPES = new Set(['keyDown', 'keyUp'])

/**
 * Accept only the worker's compact input vocabulary; anything else is rejected
 * before it reaches the browser. Coordinates are CSS pixels in the fixed
 * 1280x800 viewport with the top-left corner as the origin.
 */
export function validateInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入事件格式无效')
  const kind = value.kind
  if (kind === 'mouse') {
    if (typeof value.type !== 'string' || !MOUSE_TYPES.has(value.type)) throw new Error('不支持的鼠标事件')
    if (!numberIn(value.x, -100_000, 100_000) || !numberIn(value.y, -100_000, 100_000)) throw new Error('鼠标坐标无效')
    const cleaned = { kind, type: value.type, x: Math.min(1279, Math.max(0, Math.round(value.x))), y: Math.min(799, Math.max(0, Math.round(value.y))) }
    if (value.type === 'mousePressed' || value.type === 'mouseReleased') {
      if (typeof value.button !== 'string' || !BUTTONS.has(value.button) || value.button === 'none') throw new Error('鼠标按键无效')
      cleaned.button = value.button
    } else if (value.type === 'mouseWheel') {
      if (value.button !== undefined) {
        if (typeof value.button !== 'string' || !BUTTONS.has(value.button)) throw new Error('鼠标按键无效')
        cleaned.button = value.button
      }
    } else if (value.button !== undefined) throw new Error('移动事件不能携带按键')
    if (value.clickCount !== undefined) {
      if (value.type === 'mouseMoved' || value.type === 'mouseWheel' || !Number.isSafeInteger(value.clickCount) || value.clickCount < 0 || value.clickCount > 3) throw new Error('连击次数无效')
      cleaned.clickCount = value.clickCount
    }
    const modifiers = modifiersOf(value.modifiers)
    if (modifiers !== undefined) cleaned.modifiers = modifiers
    if (value.type === 'mouseWheel') {
      if (!numberIn(value.deltaX, -1200, 1200) || !numberIn(value.deltaY, -1200, 1200)) throw new Error('滚动增量无效')
      cleaned.deltaX = value.deltaX
      cleaned.deltaY = value.deltaY
    } else if (value.deltaX !== undefined || value.deltaY !== undefined) throw new Error('非滚动事件不能携带滚动增量')
    return cleaned
  }
  if (kind === 'key') {
    if (typeof value.type !== 'string' || !KEY_TYPES.has(value.type)) throw new Error('不支持的按键事件')
    const cleaned = {
      kind,
      type: value.type,
      key: cleanString(value.key, 64, '按键标识'),
    }
    const code = optionalString(value.code, 64, '物理键标识')
    if (code !== undefined) cleaned.code = code
    for (const name of ['windowsVirtualKeyCode', 'nativeVirtualKeyCode']) {
      if (value[name] === undefined) continue
      if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 65_535) throw new Error('虚拟键码无效')
      cleaned[name] = value[name]
    }
    const text = optionalString(value.text, 256, '按键文本')
    if (text !== undefined) cleaned.text = text
    const unmodifiedText = optionalString(value.unmodifiedText, 256, '按键文本')
    if (unmodifiedText !== undefined) cleaned.unmodifiedText = unmodifiedText
    const modifiers = modifiersOf(value.modifiers)
    if (modifiers !== undefined) cleaned.modifiers = modifiers
    return cleaned
  }
  if (kind === 'text') {
    return { kind, text: cleanString(value.text, 4096, '文本内容') }
  }
  throw new Error('不支持的输入事件种类')
}

const FIXTURE_ACTIONS = ['list_tabs', 'create_tab', 'open_test_site', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics']
const NETWORK_ACTIONS = ['list_tabs', 'create_tab', 'navigate', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics']
const TOOL_TOOL_FIELDS = Object.freeze({
  open_test_site: Object.freeze([]),
  navigate: Object.freeze(['url']),
  snapshot: Object.freeze([]),
  click: Object.freeze(['generation', 'index']),
  fill: Object.freeze(['generation', 'index', 'value']),
  screenshot: Object.freeze([]),
  diagnostics: Object.freeze([]),
})
const FIXTURE_DESCRIPTION = '操作界面右侧可见的内置固定测试页（用户与 AI 共用同一页面）；只支持内置页，不访问网站或任意 URL。'
const NETWORK_DESCRIPTION = '操作界面右侧可见的受控浏览器。navigate 支持本机、局域网和公网 HTTP/HTTPS 地址；每次调用 navigate 均须用户查看完整 URL 后批准。同源页面跳转不会逐次审批。'

export function toolSchema(mode = 'fixture') {
  if (mode !== 'fixture' && mode !== 'network') throw new Error('无效的浏览器模式')
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: mode === 'network' ? NETWORK_ACTIONS : FIXTURE_ACTIONS, description: mode === 'network' ? '受控浏览器操作；list_tabs 列出当前会话的标签' : '对内置固定测试页的操作' },
      tabId: { type: 'string', description: '除 list_tabs 和 create_tab 外必填，使用返回的标签 ID' },
      url: { type: 'string', description: '仅 navigate：需要用户批准的 HTTP 或 HTTPS URL' },
      generation: { type: 'integer', description: 'snapshot 返回的页面代次' },
      index: { type: 'integer', description: 'snapshot 返回的元素索引' },
      value: { type: 'string', description: '仅 fill：测试输入' },
    },
    required: ['action'],
  }
}

/** Validate one tool request; returns the worker fields for the chosen action. */
export function toolFields(args, mode = 'fixture') {
  if (mode !== 'fixture' && mode !== 'network') throw new Error('无效的浏览器模式')
  const actions = mode === 'network' ? NETWORK_ACTIONS : FIXTURE_ACTIONS
  if (args === null || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string' || !actions.includes(args.action)) {
    throw new Error('无效的浏览器面板操作')
  }
  const allowed = TOOL_TOOL_FIELDS[args.action]
  if (Object.keys(args).some(key => key !== 'action' && !allowed.includes(key))) throw new Error('无效的操作参数')
  if ((args.action === 'click' || args.action === 'fill') && (!Number.isSafeInteger(args.generation) || args.generation < 0 || !Number.isSafeInteger(args.index) || args.index < 0 || args.index >= 100)) {
    throw new Error('元素引用无效')
  }
  if (args.action === 'fill' && (typeof args.value !== 'string' || args.value.length > 4096)) throw new Error('输入内容无效')
  if (args.action === 'navigate') return { url: normalizeBrowserUrl(args.url) }
  return Object.fromEntries(allowed.filter(key => key in args).map(key => [key, args[key]]))
}

async function loadHostDeps() {
  const [{ createScope }, { createMcpToolDefinition }] = await Promise.all([
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-mcp-client'),
  ])
  return { createScope, createMcpToolDefinition }
}

function sendJson(connection, value) {
  try { connection.sendText(JSON.stringify(value)) } catch { /* a dead viewer is dropped elsewhere */ }
}

/**
 * One browser per sidebar tab: its viewers and Agent tools drive the same page.
 */
export class LiveBrowser {
  #worker = null
  #starting = null
  #screencasting = false
  #tail = Promise.resolve()
  #disposed = false
  #connections = new Set()
  #connectionWaiters = new Set()
  #viewers = new Set()
  #permission = null
  #lastState
  #logger
  #mode
  #workerFactory
  #slots
  #slotHeld = false

  constructor(logger, mode = 'fixture', workerFactory = startWorker, slots = null) {
    if (mode !== 'fixture' && mode !== 'network') throw new Error('无效的浏览器模式')
    this.#logger = logger
    this.#mode = mode
    this.#workerFactory = workerFactory
    this.#slots = slots
    this.#lastState = {
      open: true,
      url: mode === 'fixture' ? FIXTURE_URL : 'about:blank',
      title: mode === 'fixture' ? FIXTURE_TITLE : '浏览器',
      width: PANEL_VIEWPORT.maxWidth,
      height: PANEL_VIEWPORT.maxHeight,
      loading: false,
    }
  }

  get worker() { return this.#worker }
  get viewerCount() { return this.#viewers.size }
  get connectionCount() { return this.#connections.size }
  get mode() { return this.#mode }
  get state() { return { ...this.#lastState } }

  connect(connection) {
    if (this.#disposed) throw new Error('浏览器面板已关闭')
    this.#connections.add(connection)
    for (const ready of this.#connectionWaiters) ready()
    if (this.#permission !== null) sendJson(connection, this.#permission.message)
  }

  waitForConnection(signal) {
    signal.throwIfAborted()
    if (this.#disposed) return Promise.reject(new Error('浏览器面板已关闭'))
    if (this.#connections.size > 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = error => {
        this.#connectionWaiters.delete(ready)
        signal.removeEventListener('abort', aborted)
        error ? reject(error) : resolve()
      }
      const ready = error => finish(error)
      const aborted = () => finish(new Error('等待浏览器面板连接失败，请检查侧栏'))
      this.#connectionWaiters.add(ready)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
  }

  disconnect(connection) {
    this.removeViewer(connection)
    this.#connections.delete(connection)
    if (this.#connections.size === 0 && this.#permission !== null) {
      this.#permission.deny(new Error('浏览器面板已断开，访问未获批准'))
    }
  }

  #broadcastTo(connections, value) {
    let sent = 0
    for (const connection of connections) {
      if (connection.closed) { this.#connections.delete(connection); this.#viewers.delete(connection); continue }
      if (connection.sendText(JSON.stringify(value))) sent += 1
    }
    return sent
  }

  #broadcast(value) { return this.#broadcastTo(this.#viewers, value) }
  #broadcastControl(value) { return this.#broadcastTo(this.#connections, value) }

  #stateMessage() {
    return { type: 'state', ...this.#lastState }
  }

  #broadcastState() {
    this.#broadcast(this.#stateMessage())
  }

  #onEvent(event) {
    if (event.event === 'frame') {
      const data = event.data
      if (typeof data !== 'string' || data.length === 0 || data.length > 3 * 1024 * 1024) return
      const width = Number.isSafeInteger(event.width) && event.width > 0 ? event.width : PANEL_VIEWPORT.maxWidth
      const height = Number.isSafeInteger(event.height) && event.height > 0 ? event.height : PANEL_VIEWPORT.maxHeight
      this.#broadcast({ type: 'frame', seq: Number.isSafeInteger(event.seq) ? event.seq : 0, data, width, height })
      return
    }
    if (event.event === 'live_error') {
      this.#broadcast({ type: 'error', message: '浏览器画面流已中断' })
      this.#retireWorker()
      return
    }
    if (event.event === 'state') {
      this.#lastState = {
        open: true,
        url: String(event.url ?? this.#lastState.url),
        title: String(event.title ?? this.#lastState.title),
        width: PANEL_VIEWPORT.maxWidth,
        height: PANEL_VIEWPORT.maxHeight,
        loading: Boolean(event.loading),
      }
      this.#broadcastState()
    }
  }

  #serialize(task) {
    const run = this.#tail.then(task, task)
    this.#tail = run.then(() => {}, () => {})
    return run
  }

  async ensureWorker() {
    if (this.#disposed) throw new Error('浏览器面板已关闭')
    if (this.#worker !== null) return this.#worker
    if (this.#starting !== null) return this.#starting
    const starting = (async () => {
      if (this.#slots !== null && !this.#slotHeld) { this.#slots.acquire(); this.#slotHeld = true }
      const options = this.#mode === 'network'
        ? { networkBrowser: true, livePanel: true, onEvent: event => this.#onEvent(event) }
        : { acceptanceFixture: true, livePanel: true, onEvent: event => this.#onEvent(event) }
      let worker
      try {
        worker = this.#workerFactory(options)
      } catch (error) {
        this.#releaseSlot()
        throw error
      }
      this.#worker = worker
      try {
        if (this.#mode === 'fixture') await worker.request('open_test_site', {}, AbortSignal.timeout(MAX_SESSIONS_PAGE_OPEN))
        if (this.#disposed || this.#worker !== worker) throw new Error('浏览器面板已关闭')
        await worker.request('live_start', { ...PANEL_VIEWPORT }, AbortSignal.timeout(MAX_SESSIONS_PAGE_OPEN))
        if (this.#disposed || this.#worker !== worker) throw new Error('浏览器面板已关闭')
      } catch (error) {
        this.#worker = null
        await worker.stop().catch(() => {})
        this.#releaseSlot()
        throw error
      }
      this.#screencasting = true
      this.#broadcastState()
      return worker
    })()
    this.#starting = starting
    try {
      return await starting
    } finally {
      if (this.#starting === starting) this.#starting = null
    }
  }

  async addViewer(connection) {
    this.#viewers.add(connection)
    try {
      await this.#serialize(async () => {
        const worker = await this.ensureWorker()
        if (!this.#screencasting && this.#viewers.size > 0) {
          await worker.request('live_start', { ...PANEL_VIEWPORT }, AbortSignal.timeout(MAX_SESSIONS_PAGE_OPEN))
          this.#screencasting = true
        }
      })
    } catch (error) {
      this.#viewers.delete(connection)
      sendJson(connection, { type: 'error', message: `无法启动浏览器面板：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    sendJson(connection, this.#stateMessage())
    if (this.#permission !== null) sendJson(connection, this.#permission.message)
  }

  removeViewer(connection) {
    this.#viewers.delete(connection)
    if (this.#viewers.size === 0) void this.#serialize(async () => {
      if (this.#viewers.size !== 0 || this.#worker === null || !this.#screencasting) return
      await this.#worker.request('live_stop', {}, AbortSignal.timeout(5_000))
      this.#screencasting = false
    }).catch(error => this.#logger.warn('browser-live-stop-stream-failed', { error: String(error) }))
  }

  async input(value) {
    let cleaned
    try { cleaned = validateInput(value) } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (this.#worker === null) return { ok: false, error: '浏览器尚未启动' }
    if (this.#permission !== null) return { ok: false, error: '请先处理浏览器访问申请' }
    try {
      await this.#serialize(() => {
        if (this.#disposed || this.#worker === null || this.#permission !== null) throw new Error('浏览器不可输入')
        return this.#worker.request('live_input', cleaned, AbortSignal.timeout(15_000))
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Only authenticated panel connections may call this directly; model calls
  // always go through invokeTool and its explicit permission flow.
  async userNavigate(action, url) {
    if (this.#mode !== 'network') throw new Error('当前模式不支持导航')
    if (this.#permission !== null) throw new Error('请先处理浏览器访问申请')
    const fields = action === 'navigate' ? { url: normalizeBrowserUrl(url) } : { direction: action }
    if (action !== 'navigate' && !['back', 'forward', 'reload'].includes(action)) throw new Error('无效的导航操作')
    return this.#serialize(async () => {
      await this.ensureWorker()
      if (this.#permission !== null) throw new Error('请先处理浏览器访问申请')
      const result = await this.#worker.request(action === 'navigate' ? 'navigate' : 'browser_navigation', fields, AbortSignal.timeout(MAX_TOOL_MS))
      if (result && typeof result === 'object') {
        this.#lastState = { ...this.#lastState, url: result.url ?? this.#lastState.url, title: result.title ?? this.#lastState.title, loading: result.loading === true }
        this.#broadcastState()
      }
      return result
    })
  }

  async #requestNavigationPermission(url, scope, signal) {
    if (this.#permission !== null) throw new Error('已有浏览器访问申请正在等待处理')
    if (this.#connections.size === 0) throw new Error('请先打开浏览器面板以批准访问')
    const requestId = randomUUID()
    const message = { type: 'permission', requestId, kind: 'navigate', url, scope }
    this.#broadcastControl({ type: 'show' })
    const sent = this.#broadcastControl(message)
    if (sent === 0) throw new Error('请先打开浏览器面板以批准访问')
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => deny(new Error('等待浏览器访问授权超时')), PERMISSION_TIMEOUT_MS)
      timer.unref()
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#permission = null
        this.#broadcastControl({ type: 'permission-clear', requestId })
        error ? reject(error) : resolve()
      }
      const onAbort = () => settle(signal.reason ?? new Error('访问授权已取消'))
      const deny = error => settle(error)
      this.#permission = { requestId, message, allow: () => settle(), deny }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  respondPermission(connection, message) {
    if (!this.#connections.has(connection)) throw new Error('浏览器连接无效')
    if (message === null || typeof message !== 'object' || typeof message.requestId !== 'string' || typeof message.allow !== 'boolean') {
      throw new Error('访问授权响应无效')
    }
    const pending = this.#permission
    if (pending === null || pending.requestId !== message.requestId) throw new Error('访问申请已过期')
    if (message.allow) pending.allow()
    else pending.deny(new Error('用户拒绝访问此地址'))
    return true
  }

  async invokeTool(args, signal) {
    if (this.#disposed) throw new Error('浏览器面板已关闭')
    const fields = toolFields(args, this.#mode)
    const timeout = args.action === 'navigate' ? MAX_NAVIGATE_MS : MAX_TOOL_MS
    const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    const result = await this.#serialize(async () => {
      await this.ensureWorker()
      if (args.action === 'navigate') await this.#requestNavigationPermission(fields.url, browserTargetScope(fields.url), toolSignal)
      try {
        return await this.#worker.request(args.action, fields, toolSignal)
      } catch (error) {
        this.#retireWorker()
        throw error
      }
    })
    if (args.action === 'open_test_site' || args.action === 'navigate') {
      if (args.action === 'navigate' && result !== null && typeof result === 'object') {
        this.#lastState = {
          ...this.#lastState,
          url: typeof result.url === 'string' ? result.url : fields.url,
          title: typeof result.title === 'string' ? result.title : '',
          loading: result.loading === true,
        }
      }
      this.#broadcastControl({ type: 'show' })
      this.#broadcastState()
    }
    return result
  }

  #releaseSlot() {
    if (!this.#slotHeld) return
    this.#slotHeld = false
    this.#slots?.release()
  }

  #retireWorker() {
    const worker = this.#worker
    this.#worker = null
    this.#screencasting = false
    this.#releaseSlot()
    if (worker !== null) {
      worker.stop().catch(error => this.#logger.warn('browser-live-worker-stop-failed', { error: String(error) }))
    }
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const ready of this.#connectionWaiters) ready(new Error('浏览器面板已关闭'))
    this.#permission?.deny(new Error('浏览器面板已关闭'))
    for (const connection of this.#connections) { try { connection.close() } catch { /* ignore */ } }
    this.#connections.clear()
    this.#viewers.clear()
    const worker = this.#worker
    this.#worker = null
    if (worker !== null) {
      if (this.#screencasting) await worker.request('live_stop', {}, AbortSignal.timeout(5_000)).catch(() => {})
      await worker.stop().catch(error => { throw new Error(`浏览器 worker 未确认停止：${error instanceof Error ? error.message : String(error)}`) })
    }
    this.#releaseSlot()
  }

  get screencasting() { return this.#screencasting }
}

/**
 * Register compatibility assets, the WebSocket upgrade and Agent tools.
 * Every registered surface is owned by the caller's effect scope.
 */
export async function activate(ctx, { env = process.env, load = loadHostDeps, workerFactory = startWorker } = {}) {
  const mode = liveBrowserMode(env)
  if (mode === undefined) return undefined
  const { createScope, createMcpToolDefinition } = await load()
  const logger = ctx.logger ?? { warn: () => {}, info: () => {} }
  const tabs = new Map()
  const controls = new Set()
  const pendingCreates = new Map()
  const disposers = []
  let runningWorkers = 0
  const workerSlots = {
    acquire() {
      if (runningWorkers >= MAX_WORKERS) throw new Error(`同时最多运行 ${MAX_WORKERS} 个受控浏览器，请先关闭其他标签`)
      runningWorkers += 1
    },
    release() { runningWorkers = Math.max(0, runningWorkers - 1) },
  }
  const keyOf = (sessionId, tabId) => JSON.stringify([sessionId, tabId])
  const validId = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !value.includes('\0')
  function sessionAgent(sessionId) {
    if (!validId(sessionId)) return undefined
    const agent = ctx.agents.get(sessionId)
    return agent?.id === sessionId && agent?.session?.id === sessionId ? agent : undefined
  }
  function getTab(sessionId, tabId, create = false) {
    if (!sessionAgent(sessionId) || !validId(tabId)) throw new Error('浏览器会话或标签无效')
    const key = keyOf(sessionId, tabId)
    let tab = tabs.get(key)
    if (!tab && create) {
      if (tabs.size >= MAX_TABS) throw new Error(`受控浏览器标签最多 ${MAX_TABS} 个，请先关闭其他标签`)
      tab = { sessionId, tabId, browser: new LiveBrowser(logger, mode, workerFactory, workerSlots) }
      tabs.set(key, tab)
      broadcastInventory(sessionId)
    }
    if (!tab) throw new Error('浏览器标签不存在')
    return tab
  }

  // Sidebar layout is browser-local. Keep every connected device's controlled
  // browser inventory aligned with the session-owned host registry instead.
  function broadcastInventory(sessionId) {
    const message = JSON.stringify({
      type: 'tabs_sync',
      sessionId,
      tabs: [...tabs.values()]
        .filter(tab => tab.sessionId === sessionId)
        .map(tab => ({ tabId: tab.tabId, ...tab.browser.state })),
    })
    for (const control of controls) {
      if (control.sessionId !== sessionId || control.connection.closed) continue
      try { control.connection.sendText(message) } catch { /* a dead viewer is dropped elsewhere */ }
    }
  }

  // A control connection is bound to the exact live Agent object at admission.
  // Requests are sent to one client only: broadcasting could create duplicates.
  function controlUpgrade(req, socket, head) {
    let admission, agent, sessionId
    try {
      admission = ctx.connection.admit(req)
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (admission?.peer?.principal?.kind !== 'owner' || admission.rejection !== undefined || url.searchParams.getAll('sessionId').length !== 1) throw new Error('invalid admission')
      sessionId = url.searchParams.get('sessionId')
      agent = sessionAgent(sessionId)
      if (!agent || controls.size >= MAX_CONTROL_CONNECTIONS) throw new Error('invalid session')
    } catch { rejectUpgrade(socket, admission?.rejection ?? 403); return }
    let connection
    try { connection = acceptWebSocket(req, socket, head) } catch { return }
    const control = { connection, sessionId, agent }
    controls.add(control)
    broadcastInventory(sessionId)
    connection.onMessage(text => {
      let message
      try { message = JSON.parse(text) } catch { return }
      if (!message || message.type !== 'create_tab_result' || typeof message.requestId !== 'string') return
      const pending = pendingCreates.get(message.requestId)
      if (!pending || pending.control !== control) return
      if (sessionAgent(sessionId) !== agent || message.sessionId !== sessionId) {
        pending.finish(new Error('浏览器会话已变化，新建结果不确定，请检查侧栏'))
        return
      }
      if (message.error !== undefined) {
        pending.finish(new Error('客户端未能新建浏览器标签，请检查侧栏'))
        return
      }
      if (!validId(message.tabId) || pending.existing.has(message.tabId) || pending.claimed.has(message.tabId)) {
        pending.finish(new Error('客户端返回的标签无效，新建结果不确定，请检查侧栏'))
        return
      }
      try {
        const tab = getTab(sessionId, message.tabId, true)
        // Mark the ID across concurrently pending requests before settling.
        for (const other of pendingCreates.values()) if (other.control.sessionId === sessionId) other.claimed.add(tab.tabId)
        pending.finish(null, tab.tabId)
      } catch (error) { pending.finish(error) }
    })
    connection.onClose(() => {
      controls.delete(control)
      for (const pending of [...pendingCreates.values()]) if (pending.control === control) pending.finish(new Error('客户端已断开，新建结果不确定，请检查侧栏'))
    })
  }

  function createTab(agent, signal) {
    signal.throwIfAborted()
    const sessionId = agent.session?.id
    if (sessionAgent(sessionId) !== agent) throw new Error('需要有效且匹配的会话')
    if (tabs.size + pendingCreates.size >= MAX_TABS) throw new Error(`受控浏览器标签最多 ${MAX_TABS} 个，请先关闭其他标签`)
    const control = [...controls].find(item => item.agent === agent && item.sessionId === sessionId && !item.connection.closed)
    if (!control) throw new Error('请先连接当前会话的客户端')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const existing = new Set([...tabs.values()].filter(tab => tab.sessionId === sessionId).map(tab => tab.tabId))
      const finish = (error, tabId) => {
        if (!pendingCreates.delete(requestId)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve(tabId)
      }
      const onAbort = () => finish(new Error('新建请求已取消，结果不确定，请检查侧栏'))
      const timer = setTimeout(() => finish(new Error('新建请求超时，结果不确定，请检查侧栏')), CREATE_TIMEOUT_MS)
      timer.unref()
      pendingCreates.set(requestId, { control, existing, claimed: new Set(), finish })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      try {
        if (!control.connection.sendText(JSON.stringify({ type: 'create_tab', requestId, sessionId, expiresAt: Date.now() + CREATE_TIMEOUT_MS }))) finish(new Error('无法发送新建请求，请检查侧栏'))
      } catch { finish(new Error('无法发送新建请求，请检查侧栏')) }
    })
  }

  async function servePanel(req, res) {
    const target = ASSETS.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (target === undefined) { res.writeHead(404); res.end(); return }
    const [file, type] = target
    try {
      const body = await readFile(fileURLToPath(new URL(file, PANEL_DIR)))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(503)
      res.end()
    }
  }

  function upgrade(req, socket, head) {
    // Direct upgrades bypass the Gateway. Only the authenticated owner may
    // access these unscoped browser controls; never trust a query session ID.
    let admission
    try { admission = ctx.connection.admit(req) } catch { admission = { rejection: 403 } }
    if (!admission || admission.rejection !== undefined || admission.peer?.principal?.kind !== 'owner') {
      rejectUpgrade(socket, admission?.rejection ?? 403); return
    }
    let tab, created = false
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('tabId').length !== 1) throw new Error('invalid target')
      const sessionId = url.searchParams.get('sessionId'), tabId = url.searchParams.get('tabId')
      created = !tabs.has(keyOf(sessionId, tabId))
      tab = getTab(sessionId, tabId, true)
    } catch { rejectUpgrade(socket, 403); return }
    const browser = tab.browser
    let connection
    try {
      connection = acceptWebSocket(req, socket, head)
      browser.connect(connection)
    } catch {
      if (connection) connection.close()
      if (created && tabs.get(keyOf(tab.sessionId, tab.tabId)) === tab) tabs.delete(keyOf(tab.sessionId, tab.tabId))
      return
    }
    connection.onMessage((text) => {
      let message
      try { message = JSON.parse(text) } catch { sendJson(connection, { type: 'error', message: '消息格式无效' }); return }
      if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return
      if (!sessionAgent(tab.sessionId) || tabs.get(keyOf(tab.sessionId, tab.tabId)) !== tab) { connection.close(); return }
      if (message.type === 'close') {
        tabs.delete(keyOf(tab.sessionId, tab.tabId))
        broadcastInventory(tab.sessionId)
        void browser.dispose().catch(error => logger.warn('browser-live-dispose-failed', { error: String(error) }))
      } else if (['navigate', 'back', 'forward', 'reload'].includes(message.type)) {
        browser.userNavigate(message.type, message.url).catch(error => sendJson(connection, { type: 'error', message: String(error?.message ?? error) }))
      } else if (message.type === 'subscribe') {
        browser.addViewer(connection).catch(error => sendJson(connection, { type: 'error', message: String(error?.message ?? error) }))
      } else if (message.type === 'unsubscribe') {
        browser.removeViewer(connection)
      } else if (message.type === 'input') {
        browser.input(message.input).then(reply => { if (reply.ok === false) sendJson(connection, { type: 'error', message: reply.error }) })
      } else if (message.type === 'permission-response') {
        try { browser.respondPermission(connection, message) } catch (error) { sendJson(connection, { type: 'error', message: String(error?.message ?? error) }) }
      }
    })
    connection.onClose(() => browser.disconnect(connection))
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: servePanel }))
  disposers.push(ctx.webServer.registerUpgrade({ path: WS_ROUTE, handler: upgrade }))
  disposers.push(ctx.webServer.registerUpgrade({ path: CONTROL_ROUTE, handler: controlUpgrade }))

  const owners = new Map()
  function liveAgent(agent) {
    return !!agent && ctx.agents.get(agent.id) === agent
  }
  async function detach(agent) {
    const owner = owners.get(agent)
    if (!owner) return
    owners.delete(agent)
    for (const control of [...controls]) {
      if (control.agent !== agent) continue
      control.connection.close()
    }
    for (const [key, tab] of tabs) {
      if (tab.sessionId !== agent.session?.id) continue
      tabs.delete(key)
      void tab.browser.dispose().catch(error => logger.warn('browser-live-dispose-failed', { error: String(error) }))
    }
    try { await owner.scope.dispose() } catch (error) { logger.warn('browser-live-agent-dispose-failed', { error: String(error) }) }
  }
  async function attach(agent) {
    if (!liveAgent(agent) || owners.has(agent)) return
    const scope = createScope(agent.ctx, agent)
    const owner = { scope }
    owners.set(agent, owner)
    try {
      scope.ctx.effect(() => () => detach(agent), 'dsh-fnos-browser-live.agent')
      scope.ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'browser_live_control',
        rawName: 'browser_live_control',
        description: mode === 'network' ? NETWORK_DESCRIPTION : FIXTURE_DESCRIPTION,
        inputSchema: toolSchema(mode),
        async call(args, exec) {
          if (exec?.agent !== agent || exec.signal === undefined) throw new Error('需要有效且匹配的 Agent 调用')
          const sessionId = exec.agent.session?.id
          if (!sessionAgent(sessionId) || sessionAgent(sessionId) !== agent) throw new Error('需要有效且匹配的会话')
          if (args?.action === 'create_tab') {
            if (Object.keys(args).some(key => key !== 'action')) throw new Error('无效的操作参数')
            const tabId = await createTab(agent, exec.signal)
            const tab = getTab(sessionId, tabId)
            await tab.browser.waitForConnection(AbortSignal.any([exec.signal, AbortSignal.timeout(CREATE_TIMEOUT_MS)]))
            if (sessionAgent(sessionId) !== agent || agent.session?.id !== sessionId) throw new Error('浏览器会话已变化，新建结果不确定，请检查侧栏')
            if (tabs.get(keyOf(sessionId, tabId)) !== tab) throw new Error('浏览器标签已关闭，请检查侧栏')
            return { content: [{ type: 'text', text: JSON.stringify({ tabId }) }] }
          }
          if (args?.action === 'list_tabs') {
            if (Object.keys(args).some(key => key !== 'action')) throw new Error('无效的操作参数')
            return { content: [{ type: 'text', text: JSON.stringify({ tabs: [...tabs.values()].filter(tab => tab.sessionId === sessionId).map(tab => ({ tabId: tab.tabId, ...tab.browser.state })) }) }] }
          }
          const { tabId, ...fields } = args ?? {}
          const tab = getTab(sessionId, tabId)
          const result = await tab.browser.invokeTool(fields, exec.signal)
          if (args.action === 'screenshot') {
            if (result?.mime !== 'image/png' || typeof result.base64 !== 'string' || result.base64.length > 16 * 1024 * 1024) throw new Error('截图格式无效')
            return { content: [{ type: 'image', mimeType: 'image/png', data: result.base64 }] }
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        },
      }))
    } catch (error) {
      owners.delete(agent)
      await scope.dispose().catch(failure => logger.warn('browser-live-register-rollback-failed', { error: String(failure) }))
      throw error
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* disposers must not throw */ } }
    for (const control of [...controls]) control.connection.close()
    for (const agent of [...owners.keys()]) void detach(agent)
    for (const tab of tabs.values()) void tab.browser.dispose().catch(error => logger.warn('browser-live-dispose-failed', { error: String(error) }))
    tabs.clear()
  }, 'dsh-fnos-browser-live')

  ctx.on('agent/created', ({ agent }) => { void attach(agent).catch(error => logger.warn('browser-live-attach-failed', { error: String(error) })) })
  for (const agent of ctx.agents.list()) await attach(agent)
  return { tabs }
}

/** Cordis entry; never return the runtime as the plugin's resolved value. */
export async function apply(ctx) {
  await activate(ctx)
}
