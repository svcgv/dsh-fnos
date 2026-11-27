/* DSH client module. The factory is lazy and owns no resources until apply. */
window.__ModuleLoader__.load({
  id: '@dsh-fnos/controlled-browser-sidebar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ID = '@dsh-fnos/controlled-browser-sidebar'
    const KIND = 'controlled-browser'
    const IDENTITY_STORAGE = 'dsh-fnos.controlled-browser.tab-identities.v1'
    const copy = {
      en: { title: 'Controlled browser', new: 'New controlled browser', description: 'View and control an agent browser', address: 'HTTP or HTTPS address', go: 'Go', back: 'Back', forward: 'Forward', reload: 'Reload', connecting: 'Connecting…', connected: 'Connected', retry: 'Reconnecting…', waiting: 'Waiting for a browser frame', permission: 'Allow the agent to visit this address?', permissionHint: 'Review the full address. Approval applies to this visit only, and the agent will be able to read and interact with the page.', allow: 'Allow this visit', deny: 'Deny', disconnected: 'Disconnected', canvas: 'Remote browser view', invalidAddress: 'Enter a valid HTTP or HTTPS address without credentials' },
      zh: { title: '受控浏览器', new: '新建受控浏览器', description: '查看并操作智能体浏览器', address: 'HTTP 或 HTTPS 地址', go: '前往', back: '后退', forward: '前进', reload: '刷新', connecting: '连接中…', connected: '已连接', retry: '正在重连…', waiting: '等待浏览器画面', permission: '允许智能体访问此地址？', permissionHint: '请核对完整地址。仅允许本次访问；批准后，智能体可以读取并操作该页面。', allow: '允许本次访问', deny: '拒绝', disconnected: '连接断开', canvas: '远端浏览器画面', invalidAddress: '请输入不含账号密码的有效 HTTP 或 HTTPS 地址' }
    }
    const css = `
.dfb-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-text-primary,inherit);font:inherit;container-type:inline-size}
.dfb-toolbar{display:flex;gap:4px;padding:8px;align-items:center}.dfb-toolbar input{min-width:0;min-height:36px;flex:1;padding:6px;border:1px solid var(--dsw-alias-border, #888);border-radius:6px;background:transparent;color:inherit}
.dfb-root button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border,#888);border-radius:6px;padding:5px;min-height:36px;cursor:pointer}.dfb-root button:disabled{opacity:.5;cursor:default}
.dfb-root button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
.dfb-view{position:relative;min-height:0;flex:1;display:flex;align-items:center;justify-content:center;overflow:auto}.dfb-view canvas{display:block;max-width:100%;max-height:100%;aspect-ratio:8/5;object-fit:contain;outline-offset:-2px}.dfb-status{padding:6px 8px;font-size:12px;overflow-wrap:anywhere}
.dfb-permission{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;overscroll-behavior:contain;background:#fff;color:#171717;color-scheme:light}
.dfb-dialog{width:min(100%,440px);max-height:100%;box-sizing:border-box;padding:24px;overflow-y:auto;border:1px solid #d7dce3;border-radius:16px;background:#fff;box-shadow:0 12px 40px #0000001a}
.dfb-permission-title{margin:0 0 10px;font-size:19px;font-weight:650;line-height:1.4}
.dfb-permission-url{margin:0;padding:12px;border:1px solid #e2e6ec;border-radius:8px;background:#f5f7fa;color:#27364b;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;-webkit-user-select:text;user-select:text}
.dfb-permission-hint{margin:14px 0 0;color:#4b5565;font-size:13px;line-height:1.65}
.dfb-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:20px}.dfb-permission button{min-height:44px;padding:10px 16px;font-weight:600}.dfb-permission-allow{flex:1 1 150px;background:#2563eb!important;border-color:#2563eb!important;color:#fff!important}.dfb-permission-deny{flex:0 1 auto;color:#374151!important;background:#fff!important;border-color:#aab3bf!important}.dfb-permission-allow:hover{background:#1d4ed8!important}.dfb-permission-deny:hover{background:#f1f3f6!important}
@container (max-width: 360px){.dfb-permission{padding:12px}.dfb-dialog{padding:18px;border-radius:12px}.dfb-actions{flex-direction:column-reverse}.dfb-permission-allow,.dfb-permission-deny{width:100%;flex:0 0 auto}}
@media (max-width:600px),(pointer:coarse){.dfb-permission{padding:12px;align-items:flex-start}.dfb-dialog{margin:auto;padding:20px}.dfb-permission-title{font-size:18px}.dfb-actions{flex-direction:column-reverse}.dfb-permission-allow,.dfb-permission-deny{width:100%;flex:0 0 auto;min-height:48px!important}.dfb-toolbar button{min-width:36px;min-height:44px}.dfb-toolbar input{min-height:44px;font-size:16px}}
@media (prefers-reduced-motion:no-preference){.dfb-dialog{animation:dfb-appear 160ms ease-out}.dfb-permission button{transition:background-color 120ms,border-color 120ms}}@keyframes dfb-appear{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
`
    function socketUrl(sessionId, tabId) {
      const base = new URL(document.baseURI, window.location.href)
      if (!base.pathname.endsWith('/')) base.pathname = base.pathname.replace(/[^/]*$/, '')
      base.search = ''; base.hash = ''
      const url = new URL('browser-live/ws', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('sessionId', sessionId)
      if (tabId === undefined) url.pathname = url.pathname.replace(/\/ws$/, '/control')
      else url.searchParams.set('tabId', tabId)
      return url.href
    }
    // The public openTab returns void. Compare the synchronously committed inventory
    // and require the unique new record to also be active; never guess an identity.
    function openLocalTab(sidebar, owner) {
      const before = new Set(sidebar.openTabs.getSnapshot().filter(item => item.sessionId === owner).map(item => item.tabId))
      if (sidebar.mounted.getSnapshot() !== owner) throw Error('Session changed')
      sidebar.openTab(KIND)
      if (sidebar.mounted.getSnapshot() !== owner) throw Error('Session changed')
      const added = sidebar.openTabs.getSnapshot().filter(item => item.sessionId === owner && item.kind === KIND && !before.has(item.tabId))
      const active = sidebar.active()
      if (added.length !== 1 || !active || active.kind !== KIND || active.id !== added[0].tabId) throw Error('Unable to identify the created tab')
      return active.id
    }

    // A device may use different local sidebar ids from the device that created
    // the host tab. Persist only that routing map; page content never enters it.
    function createIdentity(sidebar, closeLocal) {
      const byLocal = new Map(), byRemote = new Map()
      const key = (session, tab) => JSON.stringify([session, tab])
      const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
      try {
        const saved = JSON.parse(localStorage.getItem(IDENTITY_STORAGE) || '[]')
        if (Array.isArray(saved)) for (const item of saved.slice(0, 256)) {
          if (!item || !valid(item.sessionId) || !valid(item.localId) || !valid(item.remoteId)) continue
          const localKey = key(item.sessionId, item.localId), remoteKey = key(item.sessionId, item.remoteId)
          if (byLocal.has(localKey) || byRemote.has(remoteKey)) continue
          byLocal.set(localKey, { sessionId: item.sessionId, localId: item.localId, remoteId: item.remoteId, known: item.known === true })
          byRemote.set(remoteKey, item.localId)
        }
      } catch { /* unavailable or invalid storage starts with device-local ids */ }
      const persist = () => {
        try { localStorage.setItem(IDENTITY_STORAGE, JSON.stringify([...byLocal.values()].map(({ sessionId, localId, remoteId, known }) => ({ sessionId, localId, remoteId, known })))) } catch { /* routing still works for this window */ }
      }
      const forgetLocal = (sessionId, localId) => {
        const localKey = key(sessionId, localId), item = byLocal.get(localKey)
        if (!item) return
        byLocal.delete(localKey); byRemote.delete(key(sessionId, item.remoteId)); persist()
      }
      const forgetRemote = (sessionId, remoteId) => {
        const remoteKey = key(sessionId, remoteId), localId = byRemote.get(remoteKey)
        if (localId !== undefined) forgetLocal(sessionId, localId)
      }
      const bind = (sessionId, localId, remoteId, known = false) => {
        const localKey = key(sessionId, localId), remoteKey = key(sessionId, remoteId)
        const previous = byLocal.get(localKey)
        if (previous && previous.remoteId !== remoteId) byRemote.delete(key(sessionId, previous.remoteId))
        const other = byRemote.get(remoteKey)
        if (other !== undefined && other !== localId) forgetLocal(sessionId, other)
        const item = { sessionId, localId, remoteId, known: known || previous?.known === true }
        byLocal.set(localKey, item); byRemote.set(remoteKey, localId); persist()
        return item
      }
      const markKnown = (sessionId, remoteId) => {
        const localId = byRemote.get(key(sessionId, remoteId))
        if (localId === undefined) return
        bind(sessionId, localId, remoteId, true)
      }
      const reconcile = (sessionId, remoteIds) => {
        const locals = sidebar.openTabs.getSnapshot().filter(item => item.sessionId === sessionId && item.kind === KIND)
        const desired = new Set(remoteIds)
        // Reuse an existing local id when it already is the host id (normal
        // refresh and tabs created by this device).
        for (const tab of locals) {
          if (byLocal.has(key(sessionId, tab.tabId)) || !desired.has(tab.tabId)) continue
          bind(sessionId, tab.tabId, tab.tabId, true)
        }
        for (const remoteId of remoteIds) {
          const localId = byRemote.get(key(sessionId, remoteId))
          if (localId !== undefined && locals.some(tab => tab.tabId === localId)) { markKnown(sessionId, remoteId); continue }
          if (localId !== undefined) forgetRemote(sessionId, remoteId)
          bind(sessionId, openLocalTab(sidebar, sessionId), remoteId, true)
        }
        // Only identities already acknowledged by the host are stale. A newly
        // clicked local tab may not have opened its panel WebSocket yet.
        for (const item of [...byLocal.values()]) {
          if (item.sessionId !== sessionId || !item.known || desired.has(item.remoteId)) continue
          if (sidebar.mounted.getSnapshot() === sessionId && locals.some(tab => tab.tabId === item.localId)) closeLocal(sessionId, item.localId)
          else forgetRemote(sessionId, item.remoteId)
        }
      }
      return {
        remoteFor(sessionId, localId) { return byLocal.get(key(sessionId, localId))?.remoteId ?? localId },
        bind, markKnown, reconcile, forgetLocal,
      }
    }

    function createSessionControl(sidebar, identity) {
      let session, ws, timer, attempt = 0, disposed = false
      const results = new Map()
      const send = (socket, value) => { if (socket.readyState === 1) { try { socket.send(JSON.stringify(value)) } catch {} } }
      const connect = () => {
        if (disposed || !session || ws) return
        const owner = session
        try { ws = new WebSocket(socketUrl(owner)) } catch { retry(); return }
        const socket = ws
        socket.onopen = () => { if (ws === socket) attempt = 0 }
        socket.onmessage = event => {
          if (disposed || socket !== ws || session !== owner || sidebar.mounted.getSnapshot() !== owner || typeof event.data !== 'string') return
          let message; try { message = JSON.parse(event.data) } catch { return }
          if (message?.type === 'tabs_sync' && message.sessionId === owner && Array.isArray(message.tabs) && message.tabs.length <= 64) {
            const remoteIds = [], seen = new Set()
            for (const tab of message.tabs) {
              if (!tab || typeof tab.tabId !== 'string' || !tab.tabId || tab.tabId.length > 256 || tab.tabId.includes('\0') || seen.has(tab.tabId)) return
              seen.add(tab.tabId); remoteIds.push(tab.tabId)
            }
            try { identity.reconcile(owner, remoteIds) } catch { /* a later inventory or explicit user action can retry */ }
            return
          }
          if (!message || message.type !== 'create_tab' || message.sessionId !== owner || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 256) return
          const cached = results.get(message.requestId)
          if (cached) { send(socket, cached); return }
          let result = { type: 'create_tab_result', requestId: message.requestId, sessionId: owner }
          try {
            if (!Number.isSafeInteger(message.expiresAt) || message.expiresAt <= Date.now()) throw Error('Create request expired')
            const tabId = openLocalTab(sidebar, owner)
            identity.bind(owner, tabId, tabId)
            result = { ...result, tabId }
          } catch (error) { result = { ...result, error: String(error?.message || error).slice(0, 240) } }
          results.set(message.requestId, result)
          if (results.size > 256) results.delete(results.keys().next().value)
          send(socket, result)
        }
        socket.onclose = () => { if (socket !== ws) return; ws = null; retry() }
      }
      const retry = () => {
        if (disposed || !session || timer) return
        timer = setTimeout(() => { timer = undefined; connect() }, Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)) + Math.random() * 250)
      }
      const sync = () => {
        const next = sidebar.mounted.getSnapshot()
        if (next === session) return
        session = next; attempt = 0; results.clear(); clearTimeout(timer); timer = undefined
        const old = ws; ws = null; if (old) old.close(1000, 'session changed')
        connect()
      }
      const unsubscribe = sidebar.mounted.subscribe(sync)
      sync()
      return () => { disposed = true; unsubscribe(); clearTimeout(timer); const old = ws; ws = null; if (old) old.close(1000, 'plugin disposed') }
    }
    // Controllers are keyed by the pair: Sidebar tab ids are only unique within a Session.
    function createController(sessionId, tabId, remoteIdOf, forget, reveal) {
      let ws, timer, attempt = 0, disposed = false, closing = false, subscribed = false
      let visible = false, permission = null, seq = -1, pending = null, decoding = false
      let canvas = null, state = { connection: 'connecting', url: '', error: '', frame: false, permission: null }
      const listeners = new Set(), keys = new Map(), buttons = new Set()
      let lastPoint = { x: 0, y: 0 }, moveTimer, lastMove
      const publish = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
      const send = payload => {
        if (!ws || ws.readyState !== 1) return false
        try { ws.send(JSON.stringify(payload)); return true } catch { return false }
      }
      const input = value => !permission && send({ type: 'input', input: value })
      const sync = () => {
        if (!ws || ws.readyState !== 1) return
        if (visible !== subscribed && send({ type: visible ? 'subscribe' : 'unsubscribe' })) subscribed = visible
      }
      const release = () => {
        for (const value of keys.values()) input({ ...value, type: 'keyUp', modifiers: 0 })
        keys.clear()
        for (const button of buttons) input({ kind: 'mouse', type: 'mouseReleased', ...lastPoint, button, clickCount: 1, modifiers: 0 })
        buttons.clear()
        clearTimeout(moveTimer); moveTimer = undefined; lastMove = undefined
      }
      const retry = () => {
        if (disposed || timer) return
        publish({ connection: 'retry' })
        timer = setTimeout(() => { timer = undefined; connect() }, Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)) + Math.random() * 250)
      }
      const connect = () => {
        if (disposed || ws) return
        try { ws = new WebSocket(socketUrl(sessionId, remoteIdOf())) } catch { retry(); return }
        const socket = ws
        socket.onopen = () => {
          if (socket !== ws || disposed) return
          attempt = 0; seq = -1; subscribed = false
          if (closing) {
            if (send({ type: 'close' })) { disposed = true; socket.close(1000, 'tab closed'); ws = null; forget() }
            else socket.close()
            return
          }
          publish({ connection: 'connected', error: '' }); sync()
        }
        socket.onmessage = event => {
          if (socket !== ws || disposed || typeof event.data !== 'string') return
          let message; try { message = JSON.parse(event.data) } catch { return }
          if (!message || typeof message !== 'object') return
          if (message.type === 'state') publish({ url: typeof message.url === 'string' ? message.url : '', error: '' })
          else if (message.type === 'error') publish({ error: String(message.message || '').slice(0, 240) })
          else if (message.type === 'show') reveal()
          else if (message.type === 'permission' && typeof message.requestId === 'string' && typeof message.url === 'string') {
            release(); permission = { requestId: message.requestId, url: message.url }; publish({ permission }); reveal()
          } else if (message.type === 'permission-clear' && (!message.requestId || permission?.requestId === message.requestId)) {
            permission = null; publish({ permission: null })
          } else if (message.type === 'frame' && visible && typeof message.data === 'string' && message.width > 0 && message.height > 0) {
            const n = Number(message.seq); if (Number.isFinite(n) && n <= seq) return
            if (Number.isFinite(n)) seq = n
            const data = message.data.replace(/^data:image\/jpeg;base64,/, '')
            if (!data.startsWith('/9j/')) return
            pending = { data, width: message.width, height: message.height }; void draw()
          }
        }
        socket.onclose = () => {
          if (socket !== ws) return
          ws = null; subscribed = false; keys.clear(); buttons.clear(); pending = null
          permission = null; publish({ permission: null, connection: 'disconnected' }); retry()
        }
      }
      async function draw() {
        if (decoding) return
        decoding = true
        try {
          while (pending && !disposed) {
            const frame = pending; pending = null
            try {
              const bytes = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0))
              const blob = new Blob([bytes], { type: 'image/jpeg' })
              let image, url
              if (typeof createImageBitmap === 'function') image = await createImageBitmap(blob)
              else { url = URL.createObjectURL(blob); image = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = url }) }
              try {
                if (!disposed && visible && canvas) {
                  canvas.width = frame.width; canvas.height = frame.height
                  canvas.getContext('2d')?.drawImage(image, 0, 0, frame.width, frame.height)
                  publish({ frame: true })
                }
              } finally { image.close?.(); if (url) URL.revokeObjectURL(url) }
            } catch { if (!disposed) publish({ error: 'Frame decode failed' }) }
          }
        } finally { decoding = false }
      }
      function point(event) {
        const rect = canvas?.getBoundingClientRect()
        if (!rect || !rect.width || !rect.height) return null
        return { x: Math.max(0, Math.min(1279, Math.round((event.clientX - rect.left) * 1280 / rect.width))), y: Math.max(0, Math.min(799, Math.round((event.clientY - rect.top) * 800 / rect.height))) }
      }
      function mouse(event, type) {
        if (!visible || permission || !canvas) return
        const p = point(event); if (!p) return
        lastPoint = p
        if (type === 'mouseMoved') {
          lastMove = { kind: 'mouse', type, ...p }
          if (!moveTimer) moveTimer = setTimeout(() => { moveTimer = undefined; if (lastMove) input(lastMove); lastMove = undefined }, 16)
          return
        }
        if (type === 'mouseWheel') {
          event.preventDefault(); const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1
          const delta = v => Math.max(-1200, Math.min(1200, Math.round(v * unit)))
          input({ kind: 'mouse', type, ...p, deltaX: delta(event.deltaX), deltaY: delta(event.deltaY) }); return
        }
        const button = ['left', 'middle', 'right', 'back', 'forward'][event.button]; if (!button) return
        event.preventDefault()
        if (type === 'mousePressed') { canvas.focus(); buttons.add(button) } else { if (!buttons.has(button)) return; buttons.delete(button) }
        input({ kind: 'mouse', type, ...p, button, clickCount: Math.max(1, Math.min(3, event.detail || 1)), modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) })
      }
      function key(event, down) {
        if (!visible || permission || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key === 'Tab' || /^F(?:[1-9]|1[0-2])$/.test(event.key)) return
        const id = event.code || event.key
        if (!down && !keys.has(id)) return
        event.preventDefault(); event.stopPropagation()
        const value = { kind: 'key', type: down ? 'keyDown' : 'keyUp', key: event.key.replace(/\0/g, ''), modifiers: event.shiftKey ? 8 : 0 }
        if (event.code) value.code = event.code.replace(/\0/g, '')
        if (event.keyCode > 0 && event.keyCode <= 255) value.windowsVirtualKeyCode = event.keyCode
        if (down && Array.from(event.key).length === 1 && event.key >= ' ') value.text = event.key
        if (down) { const held = { ...value }; delete held.text; keys.set(id, held) } else keys.delete(id)
        input(value)
      }
      return {
        start: connect,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => state,
        attach: node => { canvas = node; if (!node && state.frame) publish({ frame: false }) }, setVisible: value => { if (!value) release(); visible = value; sync() }, mouse, key, release,
        paste: event => { if (!visible || permission) return; const text = event.clipboardData?.getData('text/plain')?.replace(/\0/g, ''); if (!text) return; let value = '', count = 0; for (const char of text) { count += new TextEncoder().encode(char).length; if (count > 4096) break; value += char } if (value && input({ kind: 'text', text: value })) event.preventDefault() },
        command: (type, url) => send(url === undefined ? { type } : { type, url }),
        respond: allow => { if (permission && send({ type: 'permission-response', requestId: permission.requestId, allow })) publish({ permission: { ...permission, sent: true } }) },
        close: () => { if (disposed || closing) return; release(); closing = true; visible = false; if (send({ type: 'close' })) { disposed = true; clearTimeout(timer); ws.close(1000, 'tab closed'); ws = null; forget() } else { if (ws) ws.close(); else { clearTimeout(timer); timer = undefined; connect() } } },
        dispose: () => { if (disposed) return; release(); disposed = true; clearTimeout(timer); clearTimeout(moveTimer); if (ws) { if (subscribed) send({ type: 'unsubscribe' }); ws.close(1000, 'plugin disposed'); ws = null } listeners.clear() }
      }
    }
    function Body(props) {
      const { tab } = props.useTabInfo()
      const controller = React.useMemo(() => props.controller(tab.id), [props.controller, tab.id])
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [addressError, setAddressError] = React.useState(false)
      const canvasRef = React.useCallback(node => controller.attach(node), [controller])
      React.useEffect(() => { controller.start(); controller.setVisible(tab.visible); return () => controller.setVisible(false) }, [controller, tab.visible])
      React.useEffect(() => { const release = () => controller.release(); const hide = () => { if (document.visibilityState === 'hidden') release() }; window.addEventListener('blur', release); window.addEventListener('mouseup', release); document.addEventListener('visibilitychange', hide); return () => { window.removeEventListener('blur', release); window.removeEventListener('mouseup', release); document.removeEventListener('visibilitychange', hide); controller.release(); controller.attach(null) } }, [controller])
      React.useEffect(() => tab.actions.bindCommands({ refresh: () => controller.command('reload') }), [controller, tab.actions])
      const t = props.t
      const button = (label, type, text) => h('button', { type: 'button', title: t(label), 'aria-label': t(label), disabled: state.connection !== 'connected', onClick: () => controller.command(type) }, text)
      return h('div', { className: 'dfb-root' }, h('style', null, css),
        h('form', { className: 'dfb-toolbar', onSubmit: event => { event.preventDefault(); const value = (editing ? draft : state.url).trim(); let url; try { if (!value) throw Error(); const address = /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:https?|file|data|javascript):/i.test(value) ? value : `https://${value}`; url = new URL(address); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error() } catch { setAddressError(true); return } setAddressError(false); if (controller.command('navigate', url.href)) setEditing(false) } },
          button('back', 'back', '←'), button('forward', 'forward', '→'), button('reload', 'reload', '↻'),
          h('input', { type: 'text', inputMode: 'url', enterKeyHint: 'go', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, value: editing ? draft : state.url, placeholder: t('address'), 'aria-label': t('address'), onChange: e => { setDraft(e.target.value); setEditing(true); setAddressError(false) } }),
          h('button', { type: 'submit', disabled: state.connection !== 'connected' }, t('go'))),
        h('div', { className: 'dfb-view' }, h('canvas', { ref: canvasRef, tabIndex: 0, 'aria-label': t('canvas'), onMouseDown: e => controller.mouse(e, 'mousePressed'), onMouseUp: e => controller.mouse(e, 'mouseReleased'), onMouseMove: e => controller.mouse(e, 'mouseMoved'), onWheel: e => controller.mouse(e, 'mouseWheel'), onKeyDown: e => controller.key(e, true), onKeyUp: e => controller.key(e, false), onPaste: controller.paste, onBlur: controller.release, onContextMenu: e => e.preventDefault() }),
          !state.frame && h('span', null, t('waiting')),
          state.permission && h('div', { className: 'dfb-permission', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'dfb-permission-title', 'aria-describedby': 'dfb-permission-hint' }, h('div', { className: 'dfb-dialog' }, h('h2', { id: 'dfb-permission-title', className: 'dfb-permission-title' }, t('permission')), h('p', { className: 'dfb-permission-url', title: state.permission.url }, state.permission.url), h('p', { id: 'dfb-permission-hint', className: 'dfb-permission-hint' }, t('permissionHint')), h('div', { className: 'dfb-actions' }, h('button', { type: 'button', className: 'dfb-permission-deny', disabled: state.permission.sent, onClick: () => controller.respond(false) }, t('deny')), h('button', { type: 'button', className: 'dfb-permission-allow', autoFocus: true, disabled: state.permission.sent, onClick: () => controller.respond(true) }, t('allow')))))),
        h('div', { className: 'dfb-status', role: 'status' }, t(state.connection), addressError ? ` — ${t('invalidAddress')}` : state.error ? ` — ${state.error}` : ''))
    }
    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const controllers = new Map()
        const key = (session, tab) => JSON.stringify([session, tab])
        const remotelyClosed = new Set()
        const identity = createIdentity(ctx.sidebarRight, (session, tab) => {
          const id = key(session, tab); remotelyClosed.add(id)
          try { ctx.sidebarRight.close(tab) } finally { remotelyClosed.delete(id) }
        })
        const get = (session, tab) => {
          const id = key(session, tab)
          if (!controllers.has(id)) controllers.set(id, createController(session, tab, () => identity.remoteFor(session, tab), () => { controllers.delete(id); identity.forgetLocal(session, tab) }, () => {
            const sidebar = ctx.sidebarRight
            // Never navigate another Session, or resurrect an already removed tab.
            if (sidebar.mounted.getSnapshot() !== session || !sidebar.openTabs.getSnapshot().some(item => item.sessionId === session && item.tabId === tab && item.kind === KIND)) return
            if (!sidebar.isExpanded()) sidebar.toggleExpanded()
            if (sidebar.mounted.getSnapshot() === session) sidebar.focus(tab)
          }))
          return controllers.get(id)
        }
        const t = ctx.locale.bind('controlledBrowser')
        ctx.effect(() => ctx.locale.register('controlledBrowser', copy), 'controlled-browser.copy')
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, multiple: true, title: () => t('title'), guide: [{ id: 'new', order: 31, title: () => t('new'), description: () => t('description') }] }), 'controlled-browser.type')
        ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (sessionId, tab) => {
          const id = key(sessionId, tab.id)
          if (remotelyClosed.has(id)) {
            controllers.get(id)?.dispose(); controllers.delete(id); identity.forgetLocal(sessionId, tab.id)
            return
          }
          get(sessionId, tab.id).close()
        }), 'controlled-browser.close')
        ctx.effect(() => createSessionControl(ctx.sidebarRight, identity), 'controlled-browser.session-control')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: 'controlledBrowser', inject: sessionId => ({ controller: tabId => get(sessionId, tabId) }) }, Body)), 'controlled-browser.body')
        ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() }, 'controlled-browser.connections')
      }
    }
  }
})
