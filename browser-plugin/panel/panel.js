/*
 * dsh-fnos Web GUI “可见浏览器面板”前端资源。
 *
 * 由宿主通过 `<script type="module" src="browser-live/panel.js"></script>` 注入。
 * 本文件不依赖 npm / React / 构建步骤，只使用原生 DOM 与 ES module 语法。
 *
 * 安全边界：
 * - 不读取宿主页面 DOM（只向 document.body 追加自己的 shadow host）。
 * - 不访问 cookie / localStorage / sessionStorage。
 * - 不注入 iframe，不 fetch 任意 HTTP 端点；唯一的网络通道是同源 WebSocket
 *   `browser-live/ws`（协议见 panel/README.md）。
 * - 所有资源与 WebSocket 地址都用 document-relative URL 计算，兼容网关前缀。
 *
 * 工具自检：`node --check browser-plugin/panel/panel.js`
 * （文件刻意不使用 import/export，因此既可作为 module 加载，也能被 node --check 解析。）
 */
(() => {
  'use strict'

  // 防止宿主重复注入脚本导致两份面板 / 两条 WebSocket 连接。
  const GUARD = '__dshFnosBrowserLivePanel'
  if (window[GUARD]) return
  window[GUARD] = true

  const WS_RELATIVE = 'browser-live/ws'
  const CSS_RELATIVE = 'browser-live/panel.css'
  const INITIAL_PANEL_WIDTH = 420
  const MIN_PANEL_WIDTH = 320
  const MAX_PANEL_WIDTH_RATIO = 0.7
  const MOVE_THROTTLE_MS = 16
  const RECONNECT_BASE_MS = 500
  const RECONNECT_MAX_MS = 15000
  const MAX_ERROR_LENGTH = 240

  // 远端页面按 CSS viewport 1280×800 接收输入坐标（与 worker 的 live_input 对齐）。
  const LIVE_VIEWPORT_WIDTH = 1280
  const LIVE_VIEWPORT_HEIGHT = 800
  // text/粘贴消息的 UTF-8 字节上限（协议 m00442）。
  const MAX_TEXT_BYTES = 4096

  // 不转发给远端浏览器、留给宿主/浏览器的保留键（F5/F12 等）。
  const RESERVED_KEYS = new Set(
    Array.from({ length: 12 }, (_, index) => `F${index + 1}`).concat(['Tab'])
  )

  // event.keyCode 在部分合成事件/非美式键盘上可能缺失，这里补一份常用键映射。
  const VIRTUAL_KEY_CODES = {
    Enter: 13,
    Backspace: 8,
    Tab: 9,
    Escape: 27,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Meta: 91
  }

  // ---------------------------------------------------------------------------
  // 会话状态
  // ---------------------------------------------------------------------------

  const session = {
    panelOpen: false,
    paused: false,
    pageClosing: false,
    disabled: false,
    gotServerMessage: false,
    panelWidth: INITIAL_PANEL_WIDTH,

    ws: null,
    wsConnected: false,
    subscribed: false,
    reconnectAttempt: 0,
    reconnectTimer: null,

    lastState: null,
    pendingPermission: null,
    lastError: '',
    lastSeq: -1,
    frameSize: null,
    pendingFrame: null,
    decoding: false,
    framesInWindow: 0,
    fps: 0,
    fpsTimer: null,

    moveTimer: null,
    pendingMove: null,
    lastMoveSentAt: 0,
    lastPointer: null,
    pressedButtons: new Set(),
    forwardedKeys: new Map(),

    gripDrag: null,
    documentListeners: false
  }

  /** @type {null | Record<string, any>} */
  let ui = null

  // ---------------------------------------------------------------------------
  // URL / 小工具
  // ---------------------------------------------------------------------------

  /**
   * 取页面所在目录（document-relative 基准）。
   * - `.../workspace/` 直接使用；
   * - 若 baseURI 指向文件（不以 / 结尾），去掉最后一段作为目录；
   * - 丢弃 query / hash，保留网关前缀。
   */
  function pageDirectoryUrl() {
    const url = new URL(document.baseURI, window.location.href)
    if (!url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/[^/]*$/, '')
    }
    url.search = ''
    url.hash = ''
    return url
  }

  function toPositiveInt(value) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return Math.round(number)
  }

  function modifiersOf(event) {
    const alt = event.altKey ? 1 : 0
    const control = event.ctrlKey ? 2 : 0
    const meta = event.metaKey ? 4 : 0
    const shift = event.shiftKey ? 8 : 0
    return alt | control | meta | shift
  }

  function virtualKeyCodeOf(event) {
    const legacy = Number(event.keyCode)
    if (Number.isFinite(legacy) && legacy > 0) return Math.round(legacy)
    const key = typeof event.key === 'string' ? event.key : ''
    if (VIRTUAL_KEY_CODES[key]) return VIRTUAL_KEY_CODES[key]
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0)
      if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return code
    }
    return 0
  }

  /** 只有单个可打印字符才作为 text 附带（Enter/方向键等不带 text）。 */
  function printableTextOf(event) {
    if (typeof event.key !== 'string') return ''
    const characters = Array.from(event.key)
    if (characters.length !== 1) return ''
    const codePoint = characters[0].codePointAt(0)
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return ''
    return event.key
  }

  function createElement(tag, properties, children) {
    const element = document.createElement(tag)
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        if (value === undefined || value === null) continue
        if (key === 'class') element.className = value
        else if (key === 'text') element.textContent = value
        else if (key === 'dataset') Object.assign(element.dataset, value)
        else if (key === 'style') element.style.cssText = value
        else element.setAttribute(key, String(value))
      }
    }
    if (children) {
      for (const child of children) {
        if (child === null || child === undefined) continue
        element.append(child)
      }
    }
    return element
  }

  // ---------------------------------------------------------------------------
  // 面板 DOM（Shadow DOM 隔离，避免污染宿主样式）
  // ---------------------------------------------------------------------------

  function buildUi(cssHref) {
    const host = document.createElement('div')
    host.setAttribute('data-dsh-fnos-browser-live', '')
    // display:contents 让 shadow 里的 fixed 元素不影响宿主布局。
    host.style.cssText = 'display:contents'
    const shadow = host.attachShadow({ mode: 'open' })

    const stylesheet = document.createElement('link')
    stylesheet.rel = 'stylesheet'
    stylesheet.href = cssHref
    stylesheet.addEventListener('error', () => setError('无法加载 panel.css'))
    shadow.append(stylesheet)

    const toggle = createElement('button', {
      class: 'dsh-bp-toggle',
      type: 'button',
      title: '打开/关闭浏览器面板',
      'aria-expanded': 'false',
      'aria-controls': 'dsh-bp-panel',
      text: '浏览器'
    })
    toggle.dataset.connected = '0'

    const dot = createElement('span', { class: 'dsh-bp-dot', 'aria-hidden': 'true' })
    dot.dataset.state = 'off'

    const titleEl = createElement('div', { class: 'dsh-bp-title', text: '浏览器' })
    const urlEl = createElement('div', { class: 'dsh-bp-url', text: '' })

    const pauseBtn = createElement('button', {
      class: 'dsh-bp-btn dsh-bp-pause',
      type: 'button',
      title: '暂停/恢复远端画面',
      'aria-pressed': 'false',
      text: '暂停'
    })
    const closeBtn = createElement('button', {
      class: 'dsh-bp-btn dsh-bp-close',
      type: 'button',
      title: '关闭',
      'aria-label': '关闭浏览器面板',
      text: '×'
    })

    const head = createElement('div', { class: 'dsh-bp-head' }, [
      dot,
      createElement('div', { class: 'dsh-bp-meta' }, [titleEl, urlEl]),
      createElement('div', { class: 'dsh-bp-actions' }, [pauseBtn, closeBtn])
    ])

    const canvas = createElement('canvas', {
      class: 'dsh-bp-canvas',
      tabindex: '0',
      'aria-label': '远端浏览器画面'
    })
    const placeholder = createElement('div', {
      class: 'dsh-bp-placeholder',
      text: '等待远端画面…'
    })
    const permissionTitle = createElement('div', {
      class: 'dsh-bp-permission-title',
      text: '模型请求访问网站'
    })
    const permissionUrl = createElement('div', { class: 'dsh-bp-permission-url' })
    const permissionHint = createElement('div', {
      class: 'dsh-bp-permission-hint',
      text: '批准后，模型可在此浏览器中读取和操作该页面。请确认地址可信。'
    })
    const permissionAllow = createElement('button', {
      class: 'dsh-bp-permission-button dsh-bp-permission-allow',
      type: 'button',
      text: '允许本次访问'
    })
    const permissionDeny = createElement('button', {
      class: 'dsh-bp-permission-button dsh-bp-permission-deny',
      type: 'button',
      text: '拒绝'
    })
    const permission = createElement('div', {
      class: 'dsh-bp-permission',
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-labelledby': 'dsh-bp-permission-title'
    }, [
      createElement('div', { class: 'dsh-bp-permission-card' }, [
        permissionTitle,
        permissionUrl,
        permissionHint,
        createElement('div', { class: 'dsh-bp-permission-actions' }, [permissionDeny, permissionAllow])
      ])
    ])
    permission.hidden = true
    permissionTitle.id = 'dsh-bp-permission-title'
    const view = createElement('div', { class: 'dsh-bp-view' }, [canvas, placeholder, permission])

    const connEl = createElement('span', { class: 'dsh-bp-conn', text: '未连接' })
    const sizeEl = createElement('span', { class: 'dsh-bp-size', text: '—' })
    const fpsEl = createElement('span', { class: 'dsh-bp-fps', text: '0 fps' })
    const errorEl = createElement('span', { class: 'dsh-bp-error', text: '' })
    const status = createElement('div', { class: 'dsh-bp-status' }, [
      connEl,
      sizeEl,
      fpsEl,
      errorEl
    ])

    const grip = createElement('div', {
      class: 'dsh-bp-grip',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '拖动调整面板宽度',
      'aria-valuemin': String(MIN_PANEL_WIDTH),
      'aria-valuenow': String(INITIAL_PANEL_WIDTH),
      tabindex: '0'
    })

    const panel = createElement(
      'section',
      {
        class: 'dsh-bp-panel',
        id: 'dsh-bp-panel',
        role: 'dialog',
        'aria-label': '浏览器面板',
        'aria-modal': 'false'
      },
      [grip, head, view, status]
    )
    panel.hidden = true

    const root = createElement('div', { class: 'dsh-bp-root' }, [toggle, panel])
    shadow.append(root)

    return {
      host,
      shadow,
      root,
      toggle,
      panel,
      grip,
      dot,
      titleEl,
      urlEl,
      pauseBtn,
      closeBtn,
      canvas,
      placeholder,
      view,
      permission,
      permissionUrl,
      permissionAllow,
      permissionDeny,
      permissionHint,
      connEl,
      sizeEl,
      fpsEl,
      errorEl
    }
  }

  // ---------------------------------------------------------------------------
  // 状态渲染
  // ---------------------------------------------------------------------------

  let renderQueued = false

  function scheduleRender() {
    if (renderQueued) return
    renderQueued = true
    window.requestAnimationFrame(() => {
      renderQueued = false
      renderStatus()
    })
  }

  function setError(message) {
    const text = typeof message === 'string' && message ? message : '未知错误'
    session.lastError =
      text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text
    renderStatus()
  }

  function renderStatus() {
    if (!ui) return
    let dotState = 'off'
    let connectionText = '未连接'

    if (session.disabled) {
      dotState = 'off'
      connectionText = '浏览器面板未启用'
    } else if (session.pendingPermission) {
      dotState = 'loading'
      connectionText = '等待访问授权'
    } else if (session.wsConnected) {
      if (session.paused) {
        dotState = 'paused'
        connectionText = '已暂停'
      } else if (session.lastError) {
        dotState = 'error'
        connectionText = '连接异常'
      } else if (session.lastState && session.lastState.loading) {
        dotState = 'loading'
        connectionText = '加载中…'
      } else if (session.lastState && !session.lastState.open) {
        dotState = 'ok'
        connectionText = '已连接（远端未打开页面）'
      } else {
        dotState = 'ok'
        connectionText = '已连接'
      }
    } else if (session.reconnectAttempt > 0) {
      dotState = 'error'
      connectionText = `重连中（第 ${session.reconnectAttempt} 次）`
    }

    ui.dot.dataset.state = dotState
    ui.connEl.textContent = connectionText

    const size =
      session.frameSize ||
      (session.lastState && session.lastState.width
        ? { width: session.lastState.width, height: session.lastState.height }
        : null)
    ui.sizeEl.textContent = size ? `${size.width}×${size.height}` : '—'
    ui.fpsEl.textContent = `${session.fps} fps`
    ui.errorEl.textContent = session.lastError
    ui.errorEl.title = session.lastError
    ui.pauseBtn.textContent = session.paused ? '恢复' : '暂停'
    ui.pauseBtn.setAttribute('aria-pressed', session.paused ? 'true' : 'false')
    ui.toggle.dataset.connected = session.wsConnected ? '1' : '0'
    ui.panel.dataset.paused = session.paused ? '1' : '0'
  }

  function updateFps() {
    session.fps = session.framesInWindow
    session.framesInWindow = 0
    renderStatus()
  }

  // ---------------------------------------------------------------------------
  // 面板开关 / 暂停 / 宽度
  // ---------------------------------------------------------------------------

  function maxPanelWidth() {
    const viewportLimit = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 32)
    return Math.max(
      MIN_PANEL_WIDTH,
      Math.min(Math.round(window.innerWidth * MAX_PANEL_WIDTH_RATIO), viewportLimit)
    )
  }

  function clampPanelWidth(width) {
    return Math.min(maxPanelWidth(), Math.max(MIN_PANEL_WIDTH, Math.round(width)))
  }

  function setPanelWidth(width) {
    const clamped = clampPanelWidth(width)
    session.panelWidth = clamped
    if (!ui) return
    ui.panel.style.width = `${clamped}px`
    ui.grip.setAttribute('aria-valuenow', String(clamped))
    ui.grip.setAttribute('aria-valuemax', String(maxPanelWidth()))
  }

  function openPanel() {
    if (session.panelOpen || !ui) return
    session.panelOpen = true
    session.paused = false
    session.lastError = ''
    ui.panel.hidden = false
    ui.toggle.setAttribute('aria-expanded', 'true')
    ui.root.dataset.open = '1'
    attachDocumentInputListeners()
    syncSubscription()
    renderStatus()
    if (session.pendingPermission) ui.permissionAllow.focus({ preventScroll: true })
    else ui.canvas.focus({ preventScroll: true })
  }

  function closePanel() {
    if (!session.panelOpen || !ui) return
    if (session.pendingPermission) respondPermission(false)
    releaseAllInputs()
    session.panelOpen = false
    session.paused = false
    session.pendingFrame = null
    session.forwardedKeys.clear()
    session.pressedButtons.clear()
    clearMouseMoveQueue()
    detachDocumentInputListeners()
    syncSubscription()
    ui.panel.hidden = true
    ui.toggle.setAttribute('aria-expanded', 'false')
    ui.root.dataset.open = '0'
    renderStatus()
    ui.toggle.focus({ preventScroll: true })
  }

  function togglePanel() {
    if (session.panelOpen) closePanel()
    else openPanel()
  }

  function togglePause() {
    if (!session.panelOpen) return
    if (!session.paused) releaseAllInputs()
    session.paused = !session.paused
    session.pendingFrame = null
    syncSubscription()
    renderStatus()
  }

  function beginGripDrag(event) {
    if (event.button !== 0) return
    event.preventDefault()
    session.gripDrag = {
      startX: event.clientX,
      startWidth: session.panelWidth
    }
    if (ui) ui.grip.classList.add('is-dragging')
    window.addEventListener('pointermove', onGripDragMove)
    window.addEventListener('pointerup', endGripDrag)
    window.addEventListener('pointercancel', endGripDrag)
  }

  function onGripDragMove(event) {
    if (!session.gripDrag) return
    setPanelWidth(session.gripDrag.startWidth + (session.gripDrag.startX - event.clientX))
  }

  function endGripDrag() {
    if (!session.gripDrag) return
    session.gripDrag = null
    if (ui) ui.grip.classList.remove('is-dragging')
    window.removeEventListener('pointermove', onGripDragMove)
    window.removeEventListener('pointerup', endGripDrag)
    window.removeEventListener('pointercancel', endGripDrag)
  }

  function onGripKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setPanelWidth(session.panelWidth - 24)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setPanelWidth(session.panelWidth + 24)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPanelWidth(MIN_PANEL_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPanelWidth(maxPanelWidth())
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  function sendMessage(payload) {
    const socket = session.ws
    if (!socket || socket.readyState !== 1) return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  function canSendInput() {
    return (
      session.panelOpen &&
      !session.paused &&
      session.pendingPermission === null &&
      session.wsConnected &&
      session.ws !== null &&
      session.ws.readyState === 1
    )
  }

  function sendInput(input) {
    if (!input || !canSendInput()) return false
    return sendMessage({ type: 'input', input })
  }

  function syncSubscription() {
    const shouldSubscribe = session.panelOpen && !session.paused
    if (!session.wsConnected) {
      session.subscribed = false
      return
    }
    if (shouldSubscribe === session.subscribed) return
    if (sendMessage({ type: shouldSubscribe ? 'subscribe' : 'unsubscribe' })) {
      session.subscribed = shouldSubscribe
    }
  }

  function clearReconnectTimer() {
    if (session.reconnectTimer !== null) {
      window.clearTimeout(session.reconnectTimer)
      session.reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    if (session.pageClosing || session.disabled || session.reconnectTimer !== null) {
      return
    }
    const exponent = Math.min(session.reconnectAttempt, 5)
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent) +
      Math.floor(Math.random() * 250)
    session.reconnectAttempt += 1
    renderStatus()
    session.reconnectTimer = window.setTimeout(() => {
      session.reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (session.pageClosing || session.disabled) return
    if (
      session.ws &&
      (session.ws.readyState === 0 || session.ws.readyState === 1)
    ) {
      return
    }
    clearReconnectTimer()

    if (typeof WebSocket !== 'function') {
      setError('当前浏览器不支持 WebSocket')
      return
    }

    let socket
    try {
      socket = new WebSocket(wsUrl)
    } catch {
      setError('无法创建 WebSocket 连接')
      scheduleReconnect()
      return
    }

    session.ws = socket
    session.wsConnected = false
    renderStatus()

    socket.addEventListener('open', () => {
      if (session.ws !== socket) return
      session.wsConnected = true
      session.reconnectAttempt = 0
      session.lastError = ''
      // 新连接的 seq 从头开始，避免沿用上一连接的 lastSeq 把画面全部去重掉。
      session.lastSeq = -1
      session.gotServerMessage = false
      renderStatus()
      syncSubscription()
    })

    socket.addEventListener('message', (event) => {
      if (session.ws !== socket) return
      session.gotServerMessage = true
      handleServerMessage(event.data)
    })

    socket.addEventListener('close', () => {
      if (session.ws !== socket) return
      const neverTalked = !session.gotServerMessage
      session.ws = null
      session.wsConnected = false
      session.subscribed = false
      session.pendingFrame = null
      renderStatus()
      if (session.pageClosing) return
      if (!neverTalked) {
        scheduleReconnect()
        return
      }
      // 握手可能因未启用被 401 拒绝；用同一 WS 地址的 HTTP GET 探测一次，
      // 只有 401 才判定“未启用”，避免把普通断网误判成禁用而停止重连。
      void probeNotEnabled().then((notEnabled) => {
        if (notEnabled) {
          session.disabled = true
          setError('浏览器面板未启用')
          return
        }
        scheduleReconnect()
      })
    })

    socket.addEventListener('error', () => {
      // 出错后浏览器一定会触发 close，这里不做重复处理，避免重连风暴。
    })
  }

  function probeUrl() {
    const url = new URL(wsUrl)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return url.href
  }

  /** 仅探测同源 WS 地址对应的 HTTP 端点是否返回 401（未启用）。 */
  async function probeNotEnabled() {
    if (typeof fetch !== 'function' || !wsUrl) return false
    try {
      const response = await fetch(probeUrl(), {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error'
      })
      return response.status === 401
    } catch {
      return false
    }
  }

  function handleServerMessage(raw) {
    if (typeof raw !== 'string') return
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      setError('无法解析服务端消息')
      return
    }
    if (!message || typeof message !== 'object') return

    switch (message.type) {
      case 'state':
        applyServerState(message)
        break
      case 'frame':
        acceptFrame(message)
        break
      case 'show':
        openPanel()
        break
      case 'permission':
        openPanel()
        showPermission(message)
        break
      case 'permission-clear':
        clearPermission(message.requestId)
        break
      case 'error':
        setError(typeof message.message === 'string' ? message.message : '服务端返回错误')
        break
      default:
        break
    }
  }

  function showPermission(message) {
    if (!ui || typeof message.requestId !== 'string' || typeof message.url !== 'string') return
    session.pendingPermission = { requestId: message.requestId, url: message.url, scope: message.scope }
    ui.permissionUrl.textContent = message.url
    ui.permissionHint.textContent = message.scope === 'local'
      ? '目标是本机服务。批准后，模型可读取和操作该页面，请确认端口和应用来源。'
      : message.scope === 'lan'
        ? '目标是局域网服务。批准后，模型可访问该地址并读取页面内容。'
        : '目标是公网网站。批准后，模型可读取和操作该页面，请确认地址可信。'
    ui.permissionUrl.title = message.url
    ui.permission.hidden = false
    ui.permissionAllow.disabled = false
    ui.permissionDeny.disabled = false
    renderStatus()
    if (session.panelOpen) ui.permissionAllow.focus({ preventScroll: true })
  }

  function clearPermission(requestId) {
    if (!ui) return
    if (requestId && session.pendingPermission && session.pendingPermission.requestId !== requestId) return
    session.pendingPermission = null
    ui.permission.hidden = true
    ui.permissionUrl.textContent = ''
    ui.permissionUrl.title = ''
    ui.permissionAllow.disabled = false
    ui.permissionDeny.disabled = false
    renderStatus()
    if (session.panelOpen) ui.canvas.focus({ preventScroll: true })
  }

  function respondPermission(allow) {
    const pending = session.pendingPermission
    if (!pending) return
    if (!sendMessage({ type: 'permission-response', requestId: pending.requestId, allow: allow === true })) {
      setError('访问授权响应发送失败')
      return
    }
    if (ui) {
      ui.permissionAllow.disabled = true
      ui.permissionDeny.disabled = true
    }
  }

  function applyServerState(message) {
    const width = toPositiveInt(message.width)
    const height = toPositiveInt(message.height)
    session.lastState = {
      open: message.open === true,
      url: typeof message.url === 'string' ? message.url : '',
      title: typeof message.title === 'string' ? message.title : '',
      width,
      height,
      loading: message.loading === true
    }
    if (ui) {
      ui.titleEl.textContent = session.lastState.title || '浏览器'
      ui.titleEl.title = session.lastState.title
      ui.urlEl.textContent = session.lastState.url
      ui.urlEl.title = session.lastState.url
    }
    session.lastError = ''
    renderStatus()
  }

  // ---------------------------------------------------------------------------
  // 画面帧
  // ---------------------------------------------------------------------------

  function base64PayloadOf(data) {
    const comma = data.indexOf(',')
    return data.startsWith('data:') && comma >= 0 ? data.slice(comma + 1) : data
  }

  /** 协议只接受 JPEG；base64(FF D8 FF ...) 以 "/9j/" 开头。 */
  function frameLooksLikeJpeg(data) {
    return base64PayloadOf(data).startsWith('/9j/')
  }

  function acceptFrame(message) {
    if (!session.panelOpen || session.paused) return
    if (typeof message.data !== 'string' || message.data.length === 0) return
    const width = toPositiveInt(message.width)
    const height = toPositiveInt(message.height)
    if (!width || !height) return
    if (!frameLooksLikeJpeg(message.data)) {
      setError('收到非 JPEG 画面帧，已忽略')
      return
    }

    const sequence = Number(message.seq)
    if (Number.isFinite(sequence)) {
      if (sequence <= session.lastSeq) return
      session.lastSeq = sequence
    }

    // 只保留最新一帧；解码慢时直接覆盖，避免帧积压。
    session.pendingFrame = { data: message.data, width, height }
    if (!session.decoding) void drainFrames()
  }

  function decodeFrameData(data) {
    const binary = window.atob(base64PayloadOf(data))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: 'image/jpeg' })
  }

  async function decodeFrame(data) {
    const blob = decodeFrameData(data)
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        cleanup: () => {
          if (typeof bitmap.close === 'function') bitmap.close()
        }
      }
    }
    const objectUrl = URL.createObjectURL(blob)
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('图像解码失败'))
        element.src = objectUrl
      })
      return {
        source: image,
        cleanup: () => URL.revokeObjectURL(objectUrl)
      }
    } catch (error) {
      URL.revokeObjectURL(objectUrl)
      throw error
    }
  }

  async function drainFrames() {
    if (session.decoding) return
    session.decoding = true
    try {
      while (session.pendingFrame) {
        const frame = session.pendingFrame
        session.pendingFrame = null
        let decoded
        try {
          decoded = await decodeFrame(frame.data)
        } catch {
          setError('画面解码失败')
          continue
        }
        try {
          drawFrame(decoded.source, frame.width, frame.height)
        } finally {
          if (decoded.cleanup) decoded.cleanup()
        }
      }
    } finally {
      session.decoding = false
    }
  }

  function drawFrame(source, width, height) {
    if (!ui) return
    const canvas = ui.canvas
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      setError('无法创建 canvas 2D 上下文')
      return
    }
    context.drawImage(source, 0, 0, width, height)
    session.frameSize = { width, height }
    session.framesInWindow += 1
    session.lastError = ''
    ui.placeholder.hidden = true
    ui.view.dataset.hasFrame = '1'
    scheduleRender()
  }

  // ---------------------------------------------------------------------------
  // 输入：坐标 / 鼠标 / 滚轮
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 输入映射（唯一需要随 worker 最终字段表调整的地方）
  // ---------------------------------------------------------------------------
  //
  // worker 端 live_input 采用紧凑的 kind: 'mouse' | 'key' | 'text'。
  // 精确字段表仍在与 worker 对齐，因此**所有 DOM 事件 → input 对象的转换都集中在
  // 下面这些 map* 函数里**；其余代码只调用它们，调整字段时不需要改事件处理逻辑。
  // 坐标统一按远端 CSS viewport 1280×800 换算。

  function clampLiveX(value) {
    return Math.max(0, Math.min(LIVE_VIEWPORT_WIDTH - 1, Math.round(value)))
  }

  function clampLiveY(value) {
    return Math.max(0, Math.min(LIVE_VIEWPORT_HEIGHT - 1, Math.round(value)))
  }

  /** 面板显示坐标 → 远端固定 CSS viewport（1280×800）坐标。 */
  function mapPointerPosition(event) {
    if (!ui) return null
    const rect = ui.canvas.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return {
      x: clampLiveX((event.clientX - rect.left) * (LIVE_VIEWPORT_WIDTH / rect.width)),
      y: clampLiveY((event.clientY - rect.top) * (LIVE_VIEWPORT_HEIGHT / rect.height))
    }
  }

  const MOUSE_BUTTON_NAMES = Object.freeze({
    0: 'left',
    1: 'middle',
    2: 'right',
    3: 'back',
    4: 'forward'
  })

  function mouseButtonNameOf(button) {
    return MOUSE_BUTTON_NAMES[Number(button)] || null
  }

  function clampClickCount(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 1
    return Math.max(1, Math.min(3, Math.round(number)))
  }

  function clampWheelDelta(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.max(-1200, Math.min(1200, Math.round(number)))
  }

  function stripNul(value) {
    return String(value).replace(/\u0000/g, '')
  }

  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

  /** 按 UTF-8 字节数截断，避免拆开代理对。 */
  function truncateUtf8(value, limit) {
    if (!textEncoder) return Array.from(value).slice(0, limit).join('')
    let result = ''
    let bytes = 0
    for (const character of value) {
      const size = textEncoder.encode(character).length
      if (bytes + size > limit) break
      result += character
      bytes += size
    }
    return result
  }

  function cleanLiveText(value, limit) {
    return truncateUtf8(stripNul(value), limit)
  }

  /**
   * 鼠标/滚轮 DOM 事件 → live input（协议 m00442）。
   * phase: 'move' | 'press' | 'release' | 'wheel'
   */
  function mapPointerEvent(event, phase) {
    const position = mapPointerPosition(event)
    if (!position) return null
    if (phase === 'move') {
      // mouseMoved 只允许 x/y，不能带 button/delta/modifiers。
      return { kind: 'mouse', type: 'mouseMoved', x: position.x, y: position.y }
    }
    if (phase === 'wheel') {
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? LIVE_VIEWPORT_HEIGHT
            : 1
      return {
        kind: 'mouse',
        type: 'mouseWheel',
        x: position.x,
        y: position.y,
        deltaX: clampWheelDelta(Number(event.deltaX) * unit),
        deltaY: clampWheelDelta(Number(event.deltaY) * unit)
      }
    }
    const button = mouseButtonNameOf(event.button)
    if (!button) return null
    return {
      kind: 'mouse',
      type: phase === 'press' ? 'mousePressed' : 'mouseReleased',
      x: position.x,
      y: position.y,
      button,
      clickCount: clampClickCount(event.detail),
      modifiers: modifiersOf(event)
    }
  }

  /** 键盘 DOM 事件 → live input（协议 m00442）。phase: 'down' | 'up' */
  function mapKeyEvent(event, phase) {
    const key = stripNul(typeof event.key === 'string' ? event.key : '')
    const code = stripNul(typeof event.code === 'string' ? event.code : '')
    const input = {
      kind: 'key',
      type: phase === 'down' ? 'keyDown' : 'keyUp',
      key,
      modifiers: modifiersOf(event)
    }
    if (code) input.code = code
    const virtualKeyCode = virtualKeyCodeOf(event)
    if (virtualKeyCode > 0) input.windowsVirtualKeyCode = virtualKeyCode
    if (phase === 'down') {
      const text = cleanLiveText(printableTextOf(event), 64)
      if (text) input.text = text
    }
    return input
  }

  /** 画布粘贴 → live input（整段文本走 insertText）。 */
  function mapTextInput(text) {
    const cleaned = cleanLiveText(text, MAX_TEXT_BYTES)
    if (!cleaned) return null
    return { kind: 'text', text: cleaned }
  }

  /** 面板关闭/失焦时补发的释放输入（无对应 DOM 事件）。 */
  function mapSyntheticKeyUp(tracked) {
    const input = {
      kind: 'key',
      type: 'keyUp',
      key: stripNul(tracked.key || ''),
      modifiers: 0
    }
    if (tracked.code) input.code = stripNul(tracked.code)
    if (tracked.windowsVirtualKeyCode > 0) {
      input.windowsVirtualKeyCode = tracked.windowsVirtualKeyCode
    }
    return input
  }

  function mapSyntheticMouseRelease(button, point) {
    const name = mouseButtonNameOf(button)
    if (!name) return null
    return {
      kind: 'mouse',
      type: 'mouseReleased',
      x: clampLiveX(point ? point.x : 0),
      y: clampLiveY(point ? point.y : 0),
      button: name,
      clickCount: 1,
      modifiers: 0
    }
  }

  function queueMouseMove(input) {
    session.pendingMove = input
    if (session.moveTimer !== null) return
    const elapsed = window.performance.now() - session.lastMoveSentAt
    const wait = Math.max(0, MOVE_THROTTLE_MS - elapsed)
    session.moveTimer = window.setTimeout(flushMouseMove, wait)
  }

  function flushMouseMove() {
    session.moveTimer = null
    const input = session.pendingMove
    session.pendingMove = null
    if (!input) return
    session.lastMoveSentAt = window.performance.now()
    sendInput(input)
  }

  function clearMouseMoveQueue() {
    if (session.moveTimer !== null) {
      window.clearTimeout(session.moveTimer)
      session.moveTimer = null
    }
    session.pendingMove = null
  }

  function onCanvasMouseDown(event) {
    if (!session.panelOpen) return
    event.preventDefault()
    if (ui) ui.canvas.focus({ preventScroll: true })
    const input = mapPointerEvent(event, 'press')
    if (!input) return
    session.lastPointer = { x: input.x, y: input.y }
    session.pressedButtons.add(event.button)
    sendInput(input)
  }

  function onCanvasMouseUp(event) {
    if (!session.panelOpen) return
    if (!session.pressedButtons.has(event.button)) return
    const input = mapPointerEvent(event, 'release')
    session.pressedButtons.delete(event.button)
    if (!input) return
    session.lastPointer = { x: input.x, y: input.y }
    sendInput(input)
  }

  function onWindowMouseUp(event) {
    if (!session.panelOpen) return
    if (!session.pressedButtons.has(event.button)) return
    session.pressedButtons.delete(event.button)
    sendInput(mapSyntheticMouseRelease(event.button, session.lastPointer || { x: 0, y: 0 }))
  }

  function onCanvasMouseMove(event) {
    if (!session.panelOpen || !canSendInput()) return
    const input = mapPointerEvent(event, 'move')
    if (!input) return
    session.lastPointer = { x: input.x, y: input.y }
    queueMouseMove(input)
  }

  function onCanvasWheel(event) {
    if (!session.panelOpen) return
    event.preventDefault()
    if (!canSendInput()) return
    const input = mapPointerEvent(event, 'wheel')
    if (!input) return
    session.lastPointer = { x: input.x, y: input.y }
    sendInput(input)
  }

  // ---------------------------------------------------------------------------
  // 输入：键盘 / 粘贴
  // ---------------------------------------------------------------------------

  function shadowActiveElement() {
    return ui && ui.shadow ? ui.shadow.activeElement : null
  }

  function isPanelFocusWithin() {
    if (!ui) return false
    const active = shadowActiveElement()
    return active !== null && (active === ui.toggle || ui.panel.contains(active))
  }

  function isBrowserCanvasFocused() {
    return session.panelOpen && !!ui && shadowActiveElement() === ui.canvas
  }

  function isPanelControlTarget(event) {
    if (!ui) return false
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const target = path.length > 0 ? path[0] : event.target
    // 只按身份判断面板自己的控件，避免遍历/读取宿主页面 DOM。
    return (
      target === ui.grip ||
      target === ui.toggle ||
      target === ui.pauseBtn ||
      target === ui.closeBtn ||
      target === ui.permissionAllow ||
      target === ui.permissionDeny
    )
  }

  function onDocumentKeyDown(event) {
    if (!session.panelOpen) return

    if (event.key === 'Escape' && isPanelFocusWithin()) {
      event.preventDefault()
      event.stopPropagation()
      if (session.pendingPermission) respondPermission(false)
      else closePanel()
      return
    }

    if (session.pendingPermission) return
    if (isPanelControlTarget(event)) return
    // 浏览器只接管明确聚焦在远端画面上的键盘。聊天框、终端或宿主输入框
    // 获得焦点时，keydown 必须保持完全透传，不能 preventDefault。
    if (!isBrowserCanvasFocused()) return

    // 不劫持宿主的 Ctrl/Cmd/Alt 快捷键，也不碰浏览器保留键。
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.isComposing) return
    if (RESERVED_KEYS.has(event.key)) return
    if (!canSendInput()) return

    event.preventDefault()
    event.stopPropagation()

    const input = mapKeyEvent(event, 'down')
    const identifier = input.code || input.key
    if (identifier && !session.forwardedKeys.has(identifier)) {
      session.forwardedKeys.set(identifier, {
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.windowsVirtualKeyCode,
        modifiers: input.modifiers
      })
    }
    sendInput(input)
  }

  function onDocumentKeyUp(event) {
    if (!session.panelOpen) return
    if (isPanelControlTarget(event)) return
    const identifier = (event.code || event.key) || ''
    const tracked = session.forwardedKeys.get(identifier)
    if (!tracked) return
    session.forwardedKeys.delete(identifier)
    event.preventDefault()
    event.stopPropagation()
    sendInput(mapKeyEvent(event, 'up'))
  }

  function onDocumentPaste(event) {
    if (!session.panelOpen || !canSendInput() || !ui) return
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const target = path.length > 0 ? path[0] : event.target
    if (target !== ui.canvas) return
    const text = event.clipboardData ? event.clipboardData.getData('text/plain') : ''
    if (!text) return
    const input = mapTextInput(text)
    if (!input) return
    event.preventDefault()
    sendInput(input)
  }

  function releaseAllInputs() {
    if (!session.wsConnected) {
      session.forwardedKeys.clear()
      session.pressedButtons.clear()
      return
    }
    for (const tracked of session.forwardedKeys.values()) {
      sendInput(mapSyntheticKeyUp(tracked))
    }
    session.forwardedKeys.clear()

    const point = session.lastPointer || { x: 0, y: 0 }
    for (const button of session.pressedButtons) {
      const input = mapSyntheticMouseRelease(button, point)
      if (input) sendInput(input)
    }
    session.pressedButtons.clear()
  }

  function attachDocumentInputListeners() {
    if (session.documentListeners) return
    document.addEventListener('keydown', onDocumentKeyDown, true)
    document.addEventListener('keyup', onDocumentKeyUp, true)
    document.addEventListener('paste', onDocumentPaste, true)
    session.documentListeners = true
  }

  function detachDocumentInputListeners() {
    if (!session.documentListeners) return
    document.removeEventListener('keydown', onDocumentKeyDown, true)
    document.removeEventListener('keyup', onDocumentKeyUp, true)
    document.removeEventListener('paste', onDocumentPaste, true)
    session.documentListeners = false
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  function shutdown() {
    session.pageClosing = true
    clearReconnectTimer()
    clearMouseMoveQueue()
    if (session.fpsTimer !== null) {
      window.clearInterval(session.fpsTimer)
      session.fpsTimer = null
    }
    detachDocumentInputListeners()
    const socket = session.ws
    session.ws = null
    session.wsConnected = false
    if (socket) {
      try {
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(1000, 'pagehide')
        }
      } catch {
        // 页面卸载阶段忽略。
      }
    }
  }

  function bindEvents() {
    if (!ui) return
    ui.toggle.addEventListener('click', togglePanel)
    ui.closeBtn.addEventListener('click', closePanel)
    ui.pauseBtn.addEventListener('click', togglePause)
    ui.permissionAllow.addEventListener('click', () => respondPermission(true))
    ui.permissionDeny.addEventListener('click', () => respondPermission(false))
    ui.grip.addEventListener('pointerdown', beginGripDrag)
    ui.grip.addEventListener('keydown', onGripKeyDown)

    ui.canvas.addEventListener('mousedown', onCanvasMouseDown)
    ui.canvas.addEventListener('blur', releaseAllInputs)
    ui.canvas.addEventListener('mouseup', onCanvasMouseUp)
    ui.canvas.addEventListener('mousemove', onCanvasMouseMove)
    ui.canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    ui.canvas.addEventListener('wheel', onCanvasWheel, { passive: false })

    window.addEventListener('mouseup', onWindowMouseUp)
    window.addEventListener('blur', releaseAllInputs)
    window.addEventListener('resize', () => setPanelWidth(session.panelWidth))
    window.addEventListener('online', () => {
      if (!session.wsConnected) connect()
    })
    window.addEventListener('pagehide', shutdown, { once: true })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseAllInputs()
    })
  }

  function start() {
    if (!document.body) return

    const pageDirectory = pageDirectoryUrl()
    const cssHref = new URL(CSS_RELATIVE, pageDirectory).href
    const socketUrl = new URL(WS_RELATIVE, pageDirectory)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl = socketUrl.href

    ui = buildUi(cssHref)
    document.body.appendChild(ui.host)
    bindEvents()
    setPanelWidth(INITIAL_PANEL_WIDTH)
    renderStatus()
    session.fpsTimer = window.setInterval(updateFps, 1000)
    connect()
  }

  let wsUrl = ''

  if (document.body) {
    start()
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  }
})()
