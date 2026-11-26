// Opt-in visible browser panel for one Web GUI session.
//
// The panel is a same-origin document-relative script injected into the served
// index; it streams Chromium screencast frames from a private-CDP worker and
// forwards pointer/keyboard input to the same page the Agent tools operate on.
// Fixed-page only: the worker runs the reviewed private HTTP fixture and never
// opens a caller-supplied URL or HTML. No CDP socket is exposed to the client:
// the client speaks one small JSON protocol over the authenticated upgrade.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startWorker } from './worker-client.mjs'
import { acceptWebSocket, rejectUpgrade } from './live-ws.mjs'

export const inject = ['tools', 'agents', 'webServer', 'connection']

/** Trusted host switch; absent or different means the plugin stays inert. */
export const LIVE_ENV = 'DSH_FNOS_BROWSER_LIVE'
/** The fixed-page worker mode the live panel is only allowed to drive. */
export const FIXTURE_ENV = 'DSH_FNOS_ACCEPTANCE_FIXTURE'

const ROUTE = '/browser-live'
const WS_ROUTE = '/browser-live/ws'
const SCRIPT_TAG = `<script type="module" src="browser-live/panel.js"></script>`
const ASSETS = new Map([
  ['/browser-live/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/browser-live/panel.css', ['panel.css', 'text/css; charset=utf-8']],
])
const PANEL_DIR = new URL('./panel/', import.meta.url)
const FIXTURE_URL = 'http://127.0.0.1:38179/'
const FIXTURE_TITLE = '内置固定测试页'
const PANEL_VIEWPORT = Object.freeze({ maxWidth: 1280, maxHeight: 800, quality: 60 })
const MAX_SESSIONS_PAGE_OPEN = 30_000
const MAX_TOOL_MS = 30_000

/** Both trusted switches must be exactly on; tool input can never enable them. */
export function liveMode(env = process.env) {
  return env?.[LIVE_ENV] === '1' && env?.[FIXTURE_ENV] === '1'
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

const TOOL_ACTIONS = new Set(['open_test_site', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics'])
const TOOL_TOOL_FIELDS = Object.freeze({
  open_test_site: Object.freeze([]),
  snapshot: Object.freeze([]),
  click: Object.freeze(['generation', 'index']),
  fill: Object.freeze(['generation', 'index', 'value']),
  screenshot: Object.freeze([]),
  diagnostics: Object.freeze([]),
})
const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...TOOL_ACTIONS], description: '对内置固定测试页的操作' },
    generation: { type: 'integer', description: 'snapshot 返回的页面代次' },
    index: { type: 'integer', description: 'snapshot 返回的元素索引' },
    value: { type: 'string', description: '仅 fill：测试输入' },
  },
  required: ['action'],
}
const TOOL_DESCRIPTION = '操作界面右侧可见的内置固定测试页（用户与 AI 共用同一页面）；只支持内置页，不访问网站或任意 URL。'

/** Validate one tool request; returns the worker fields for the chosen action. */
export function toolFields(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string' || !TOOL_ACTIONS.has(args.action)) {
    throw new Error('无效的浏览器面板操作')
  }
  const allowed = TOOL_TOOL_FIELDS[args.action]
  if (Object.keys(args).some(key => key !== 'action' && !allowed.includes(key))) throw new Error('无效的操作参数')
  if ((args.action === 'click' || args.action === 'fill') && (!Number.isSafeInteger(args.generation) || args.generation < 0 || !Number.isSafeInteger(args.index) || args.index < 0 || args.index >= 100)) {
    throw new Error('元素引用无效')
  }
  if (args.action === 'fill' && (typeof args.value !== 'string' || args.value.length > 4096)) throw new Error('输入内容无效')
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
 * One shared browser per plugin process: viewers and Agent tools drive the
 * same page, so frames and input stay consistent.
 */
class LiveBrowser {
  #worker = null
  #starting = null
  #screencasting = false
  #tail = Promise.resolve()
  #disposed = false
  #viewers = new Set()
  #logger
  #onState
  #workerFactory

  constructor(logger, onState, workerFactory = startWorker) {
    this.#logger = logger
    this.#onState = onState
    this.#workerFactory = workerFactory
  }

  get worker() { return this.#worker }
  get viewerCount() { return this.#viewers.size }

  #broadcast(value) {
    let sent = 0
    for (const connection of this.#viewers) {
      if (connection.closed) { this.#viewers.delete(connection); continue }
      if (connection.sendText(JSON.stringify(value))) sent += 1
    }
    return sent
  }

  #broadcastState() {
    this.#broadcast({ type: 'state', open: true, url: FIXTURE_URL, title: FIXTURE_TITLE, width: PANEL_VIEWPORT.maxWidth, height: PANEL_VIEWPORT.maxHeight, loading: false })
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
      this.#broadcast({ type: 'state', open: true, url: String(event.url ?? FIXTURE_URL), title: String(event.title ?? FIXTURE_TITLE), width: PANEL_VIEWPORT.maxWidth, height: PANEL_VIEWPORT.maxHeight, loading: Boolean(event.loading) })
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
      const worker = this.#workerFactory({ acceptanceFixture: true, livePanel: true, onEvent: event => this.#onEvent(event) })
      this.#worker = worker
      try {
        await worker.request('open_test_site', {}, AbortSignal.timeout(MAX_SESSIONS_PAGE_OPEN))
        await worker.request('live_start', { ...PANEL_VIEWPORT }, AbortSignal.timeout(MAX_SESSIONS_PAGE_OPEN))
      } catch (error) {
        this.#worker = null
        await worker.stop().catch(() => {})
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
      await this.ensureWorker()
    } catch (error) {
      this.#viewers.delete(connection)
      sendJson(connection, { type: 'error', message: `无法启动浏览器面板：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    sendJson(connection, { type: 'state', open: true, url: FIXTURE_URL, title: FIXTURE_TITLE, width: PANEL_VIEWPORT.maxWidth, height: PANEL_VIEWPORT.maxHeight, loading: false })
  }

  removeViewer(connection) {
    this.#viewers.delete(connection)
  }

  async input(value) {
    let cleaned
    try { cleaned = validateInput(value) } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (this.#worker === null) return { ok: false, error: '浏览器尚未启动' }
    try {
      await this.#serialize(() => this.#worker.request('live_input', cleaned, AbortSignal.timeout(15_000)))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async invokeTool(args, signal) {
    if (this.#disposed) throw new Error('浏览器面板已关闭')
    const fields = toolFields(args)
    let result
    try {
      result = await this.#serialize(async () => {
        await this.ensureWorker()
        return this.#worker.request(args.action, fields, signal)
      })
    } catch (error) {
      // A failed call may have partially executed; retire the worker so the next
      // call cannot observe a wedged browser.
      this.#retireWorker()
      throw error
    }
    if (args.action === 'open_test_site') {
      this.#broadcast({ type: 'show' })
      this.#broadcastState()
    }
    return result
  }

  #retireWorker() {
    const worker = this.#worker
    this.#worker = null
    this.#screencasting = false
    if (worker !== null) {
      worker.stop().catch(error => this.#logger.warn('browser-live-worker-stop-failed', { error: String(error) }))
    }
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const connection of this.#viewers) { try { connection.close() } catch { /* ignore */ } }
    this.#viewers.clear()
    const worker = this.#worker
    this.#worker = null
    if (worker !== null) {
      if (this.#screencasting) await worker.request('live_stop', {}, AbortSignal.timeout(5_000)).catch(() => {})
      await worker.stop().catch(error => { throw new Error(`浏览器 worker 未确认停止：${error instanceof Error ? error.message : String(error)}`) })
    }
  }

  get screencasting() { return this.#screencasting }
}

/**
 * Register the panel routes, index injection, WebSocket upgrade and Agent
 * tools. Every registered surface is owned by the caller's effect scope.
 */
export async function activate(ctx, { env = process.env, load = loadHostDeps, workerFactory = startWorker } = {}) {
  if (!liveMode(env)) return undefined
  const { createScope, createMcpToolDefinition } = await load()
  const logger = ctx.logger ?? { warn: () => {}, info: () => {} }
  const browser = new LiveBrowser(logger, () => {}, workerFactory)
  const disposers = []

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
    let rejection
    try { rejection = ctx.connection.requestRejection(req) } catch { rejection = 403 }
    if (rejection !== undefined) { rejectUpgrade(socket, rejection); return }
    let connection
    try {
      connection = acceptWebSocket(req, socket, head)
    } catch { /* acceptWebSocket already rejected the socket */ return }
    connection.onMessage((text) => {
      let message
      try { message = JSON.parse(text) } catch { sendJson(connection, { type: 'error', message: '消息格式无效' }); return }
      if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return
      if (message.type === 'subscribe') {
        browser.addViewer(connection).catch(error => sendJson(connection, { type: 'error', message: String(error?.message ?? error) }))
      } else if (message.type === 'unsubscribe') {
        browser.removeViewer(connection)
      } else if (message.type === 'input') {
        browser.input(message.input).then(reply => { if (reply.ok === false) sendJson(connection, { type: 'error', message: reply.error }) })
      }
    })
    connection.onClose(() => browser.removeViewer(connection))
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: servePanel }))
  disposers.push(ctx.webServer.registerUpgrade({ path: WS_ROUTE, handler: upgrade }))
  disposers.push(ctx.webServer.tapIndex(html => html.includes('browser-live/panel.js') ? html : html.replace(/<\/body>/i, `${SCRIPT_TAG}</body>`)))

  const owners = new Map()
  function liveAgent(agent) {
    return !!agent && ctx.agents.get(agent.id) === agent
  }
  async function detach(agent) {
    const owner = owners.get(agent)
    if (!owner) return
    owners.delete(agent)
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
        description: TOOL_DESCRIPTION,
        inputSchema: TOOL_SCHEMA,
        async call(args, exec) {
          if (exec?.agent !== agent || exec.signal === undefined) throw new Error('需要有效且匹配的 Agent 调用')
          const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(MAX_TOOL_MS)])
          const result = await browser.invokeTool(args, signal)
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
    for (const agent of [...owners.keys()]) void detach(agent)
    void browser.dispose().catch(error => logger.warn('browser-live-dispose-failed', { error: String(error) }))
  }, 'dsh-fnos-browser-live')

  ctx.on('agent/created', ({ agent }) => { void attach(agent).catch(error => logger.warn('browser-live-attach-failed', { error: String(error) })) })
  for (const agent of ctx.agents.list()) await attach(agent)
  return { browser }
}

/** Cordis entry; never return the runtime as the plugin's resolved value. */
export async function apply(ctx) {
  await activate(ctx)
}
