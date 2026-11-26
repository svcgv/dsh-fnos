#!/usr/bin/env node
/*
 * 零依赖假 WebSocket 服务端，用于“可见浏览器面板”的手动验证与自测。
 *
 * 用法：
 *   node browser-plugin/panel/mock-ws.mjs             # 启动演示服务端，打印页面 URL
 *   node browser-plugin/panel/mock-ws.mjs --selftest  # 自测 HTTP/WS 协议，打印 PASS/FAIL
 *
 * 仅用于开发自测，不会被宿主加载。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = '/app/dsh-fnos/workspace/'
const ASSET_PREFIX = `${PAGE_PATH}browser-live/`
const WS_PATH = `${ASSET_PREFIX}ws`
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// 固定 JPEG 测试画面（640×400，由 ffmpeg testsrc2 生成后内嵌，避免自测依赖外部命令）。
// 前端只接受 JPEG 帧；演示时会把这帧缩放绘制到 canvas。
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 400
const FRAME_INTERVAL_MS = 200
const MAX_FRAME_BYTES = 1024 * 1024
const FRAME_JPEG = Buffer.from(
  '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',
  'base64'
)

// ---------------------------------------------------------------------------
// WebSocket 帧编解码（仅服务端视角，够自测用）
// ---------------------------------------------------------------------------

function encodeServerFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (data.length < 126) {
    header = Buffer.alloc(2)
    header[1] = data.length
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

function createClientFrameParser(handlers) {
  let buffer = Buffer.alloc(0)
  let stopped = false

  function fail(reason) {
    if (stopped) return
    stopped = true
    handlers.onProtocolError(reason)
  }

  function loop() {
    while (!stopped) {
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_FRAME_BYTES)) {
          fail('帧过大')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (length > MAX_FRAME_BYTES) {
        fail('帧过大')
        return
      }
      if (!masked) {
        fail('客户端帧必须设置 mask')
        return
      }
      if (buffer.length < offset + 4 + length) return

      const mask = buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4]
      }
      buffer = buffer.subarray(offset + length)

      if (opcode === 0x8) {
        stopped = true
        handlers.onClose()
        return
      }
      if (opcode === 0x9) {
        handlers.onPing(payload)
        continue
      }
      if (opcode === 0x1) {
        if (!fin) {
          fail('不支持分片文本帧')
          return
        }
        handlers.onText(payload.toString('utf8'))
      }
      // 0x0 分片续帧、0xA pong 忽略
    }
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0 || stopped) return
      buffer = Buffer.concat([buffer, chunk])
      loop()
    }
  }
}

// ---------------------------------------------------------------------------
// 假服务端
// ---------------------------------------------------------------------------

function createMockServer(options = {}) {
  const state = {
    inputs: [],
    messages: [],
    clients: new Set(),
    showSent: 0
  }

  function readAsset(fileName) {
    return readFile(path.join(HERE, fileName))
  }

  function sendJson(client, payload) {
    if (client.closed || client.socket.destroyed) return
    client.socket.write(encodeServerFrame(JSON.stringify(payload)))
  }

  function stopFrames(client) {
    if (client.timer !== null) {
      clearInterval(client.timer)
      client.timer = null
    }
  }

  function sendFrame(client) {
    if (client.closed || !client.subscribed) return
    client.tick += 1
    sendJson(client, {
      type: 'frame',
      seq: client.tick,
      data: FRAME_JPEG.toString('base64'),
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT
    })
  }

  function startFrames(client) {
    stopFrames(client)
    sendFrame(client)
    client.timer = setInterval(() => sendFrame(client), FRAME_INTERVAL_MS)
  }

  // 与 worker live_input 的最终紧凑协议（m00442）保持一致；多余字段一律拒绝。
  const MOUSE_TYPES = new Set(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'])
  const KEY_TYPES = new Set(['keyDown', 'keyUp'])
  const MOUSE_BUTTONS = new Set(['left', 'middle', 'right', 'back', 'forward'])
  const MOUSE_MOVE_KEYS = new Set(['kind', 'type', 'x', 'y'])
  const MOUSE_WHEEL_KEYS = new Set(['kind', 'type', 'x', 'y', 'deltaX', 'deltaY'])
  const MOUSE_BUTTON_KEYS = new Set([
    'kind',
    'type',
    'x',
    'y',
    'button',
    'clickCount',
    'modifiers'
  ])
  const KEY_KEYS = new Set([
    'kind',
    'type',
    'key',
    'code',
    'windowsVirtualKeyCode',
    'nativeVirtualKeyCode',
    'text',
    'unmodifiedText',
    'modifiers'
  ])
  const TEXT_KEYS = new Set(['kind', 'text'])

  function onlyKeys(input, allowed) {
    return Object.keys(input).every((key) => allowed.has(key))
  }

  function isIntInRange(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max
  }

  function isCleanString(value) {
    return typeof value === 'string' && !value.includes('\u0000')
  }

  function validateLiveInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return 'input 必须是对象'
    }
    if (typeof input.kind !== 'string') return 'input.kind 必须是字符串'

    if (input.kind === 'mouse') {
      if (!MOUSE_TYPES.has(input.type)) return 'mouse.type 无效'
      if (!isIntInRange(input.x, 0, 1279) || !isIntInRange(input.y, 0, 799)) {
        return 'mouse 坐标必须是 0..1279 / 0..799 的整数'
      }
      if (input.type === 'mouseMoved') {
        if (!onlyKeys(input, MOUSE_MOVE_KEYS)) return 'mouseMoved 不允许 button/deltaX/deltaY/modifiers'
        return null
      }
      if (input.type === 'mouseWheel') {
        if (!onlyKeys(input, MOUSE_WHEEL_KEYS)) return 'mouseWheel 不允许额外字段'
        if (!isIntInRange(input.deltaX, -1200, 1200)) return 'mouseWheel.deltaX 超出 -1200..1200'
        if (!isIntInRange(input.deltaY, -1200, 1200)) return 'mouseWheel.deltaY 超出 -1200..1200'
        return null
      }
      if (!onlyKeys(input, MOUSE_BUTTON_KEYS)) return 'mousePressed/mouseReleased 不允许额外字段'
      if (!MOUSE_BUTTONS.has(input.button)) return 'mouse.button 无效'
      if (input.clickCount !== undefined && !isIntInRange(input.clickCount, 1, 3)) {
        return 'mouse.clickCount 必须是 1..3 的整数'
      }
      if (input.modifiers !== undefined && !isIntInRange(input.modifiers, 0, 15)) {
        return 'mouse.modifiers 必须是 0..15 的整数'
      }
      return null
    }

    if (input.kind === 'key') {
      if (!KEY_TYPES.has(input.type)) return 'key.type 无效'
      if (!onlyKeys(input, KEY_KEYS)) return 'key 不允许额外字段'
      if (!isCleanString(input.key)) return 'key.key 必须是字符串且不含 NUL'
      if (input.code !== undefined && !isCleanString(input.code)) return 'key.code 无效'
      if (
        input.windowsVirtualKeyCode !== undefined &&
        !isIntInRange(input.windowsVirtualKeyCode, 0, 255)
      ) {
        return 'key.windowsVirtualKeyCode 无效'
      }
      if (
        input.nativeVirtualKeyCode !== undefined &&
        !isIntInRange(input.nativeVirtualKeyCode, 0, 65535)
      ) {
        return 'key.nativeVirtualKeyCode 无效'
      }
      if (input.modifiers !== undefined && !isIntInRange(input.modifiers, 0, 15)) {
        return 'key.modifiers 必须是 0..15 的整数'
      }
      if (input.type === 'keyUp' && (input.text !== undefined || input.unmodifiedText !== undefined)) {
        return 'keyUp 不允许 text/unmodifiedText'
      }
      if (input.text !== undefined) {
        if (!isCleanString(input.text) || Array.from(input.text).length !== 1) {
          return 'keyDown.text 必须是单个字符'
        }
      }
      if (input.unmodifiedText !== undefined && !isCleanString(input.unmodifiedText)) {
        return 'key.unmodifiedText 无效'
      }
      return null
    }

    if (input.kind === 'text') {
      if (!onlyKeys(input, TEXT_KEYS)) return 'text 不允许额外字段'
      if (!isCleanString(input.text) || input.text.length === 0) return 'text.text 必须是非空字符串'
      if (Buffer.byteLength(input.text, 'utf8') > 4096) return 'text.text 超过 4096 字节'
      return null
    }

    return `不支持的 input.kind：${input.kind}`
  }

  function handleClientMessage(client, text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      state.messages.push({ type: 'malformed' })
      sendJson(client, { type: 'error', message: '无法解析 JSON 消息' })
      return
    }
    if (!message || typeof message !== 'object') return
    state.messages.push({ type: message.type })

    if (message.type === 'subscribe') {
      client.subscribed = true
      sendJson(client, {
        type: 'state',
        open: true,
        url: 'https://example.test/mock-page',
        title: '假服务端演示页',
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        loading: false
      })
      startFrames(client)
      return
    }
    if (message.type === 'unsubscribe') {
      client.subscribed = false
      stopFrames(client)
      return
    }
    if (message.type === 'input') {
      const input = message.input
      const problem = validateLiveInput(input)
      if (problem) {
        sendJson(client, { type: 'error', message: problem })
        return
      }
      state.inputs.push(input)
      client.inputCount = (client.inputCount || 0) + 1
      if (typeof options.onInput === 'function') options.onInput(input)
      return
    }
    sendJson(client, { type: 'error', message: `未知消息类型：${String(message.type)}` })
  }

  function closeClient(client, code, reason) {
    if (client.closed) return
    client.closed = true
    stopFrames(client)
    if (client.showTimer !== null) clearTimeout(client.showTimer)
    state.clients.delete(client)
    try {
      if (!client.socket.destroyed) {
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(code, 0)
        client.socket.end(encodeServerFrame(Buffer.concat([payload, Buffer.from(reason)]), 0x8))
      }
    } catch {
      // 忽略
    }
  }

  function onUpgrade(request, socket, head) {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (!pathname.endsWith('/browser-live/ws')) {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )

    const client = {
      socket,
      subscribed: false,
      timer: null,
      tick: 0,
      showTimer: null,
      inputCount: 0,
      closed: false
    }
    state.clients.add(client)

    const parser = createClientFrameParser({
      onText(text) {
        handleClientMessage(client, text)
      },
      onClose() {
        closeClient(client, 1000, 'client closed')
      },
      onPing(payload) {
        if (!socket.destroyed) socket.write(encodeServerFrame(payload, 0xa))
      },
      onProtocolError(reason) {
        closeClient(client, 1002, reason)
      }
    })

    // 让面板测试“服务端请求展开”路径。
    client.showTimer = setTimeout(() => {
      client.showTimer = null
      if (client.closed) return
      state.showSent += 1
      sendJson(client, { type: 'show' })
    }, 400)

    parser.push(head)
    socket.on('data', (chunk) => parser.push(chunk))
    socket.on('close', () => closeClient(client, 1000, 'socket closed'))
    socket.on('error', () => closeClient(client, 1000, 'socket error'))
  }

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    try {
      if (pathname === PAGE_PATH || pathname === PAGE_PATH.slice(0, -1)) {
        const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>dsh-fnos 可见浏览器面板 · 假服务端</title>
<style>
  body { margin: 0; padding: 24px; font: 15px/1.6 system-ui, sans-serif; background: #f0f2f5; color: #24292f; }
  code { padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.06); }
  @media (prefers-color-scheme: dark) { body { background: #16191d; color: #e6e8eb; } code { background: rgba(255,255,255,.1); } }
</style>
</head>
<body>
<h1>dsh-fnos 可见浏览器面板 · 假服务端</h1>
<p>右下角应出现“浏览器”按钮；连接后面板自动展开并显示静态测试画面（640×400 JPEG）。</p>
<p>在画布上移动/点击/滚轮/键入，运行 <code>mock-ws.mjs</code> 的终端会打印收到的 input 消息。</p>
<script type="module" src="browser-live/panel.js"></script>
</body>
</html>`
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(body)
        return
      }
      if (pathname === `${ASSET_PREFIX}panel.js`) {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        response.end(await readAsset('panel.js'))
        return
      }
      if (pathname === `${ASSET_PREFIX}panel.css`) {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
        response.end(await readAsset('panel.css'))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`server error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  server.on('upgrade', onUpgrade)

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve(server.address())
      })
    })
  }

  function close() {
    for (const client of state.clients) {
      client.closed = true
      stopFrames(client)
      if (client.showTimer !== null) clearTimeout(client.showTimer)
      try {
        client.socket.destroy()
      } catch {
        // 忽略
      }
    }
    state.clients.clear()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  return { server, state, listen, close }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(40)
  }
  throw new Error(`超时等待：${label}`)
}

async function readMessage(ws, predicate, timeoutMs, label) {
  const messages = []
  const listener = (event) => messages.push(event.data)
  ws.addEventListener('message', listener)
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = messages.find(predicate)
      if (found !== undefined) return found
      await delay(30)
    }
    throw new Error(`超时等待消息：${label}`)
  } finally {
    ws.removeEventListener('message', listener)
  }
}

async function selftest() {
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    console.log('SKIP: 当前 Node 缺少全局 WebSocket/fetch，跳过 mock-ws 自测')
    return
  }

  const mock = createMockServer({
    onInput(input) {
      // 自测时不刷屏
      void input
    }
  })
  const address = await mock.listen(0)
  const port = address.port
  const pageUrl = `http://127.0.0.1:${port}${PAGE_PATH}`

  try {
    // 1) HTTP 资源
    const pageResponse = await fetch(pageUrl)
    const pageHtml = await pageResponse.text()
    assert(pageResponse.status === 200, `页面 HTTP 状态 ${pageResponse.status}`)
    assert(pageHtml.includes('browser-live/panel.js'), '页面未引用 panel.js')

    const jsResponse = await fetch(new URL('browser-live/panel.js', pageUrl))
    const jsText = await jsResponse.text()
    assert(jsResponse.status === 200, `panel.js HTTP 状态 ${jsResponse.status}`)
    assert(jsText.includes('dsh-bp-toggle'), 'panel.js 内容不符合预期')
    assert(jsText.includes("browser-live/ws"), 'panel.js 未使用 browser-live/ws')
    assert(jsText.includes('document.baseURI'), 'panel.js 未使用 document.baseURI')

    const cssResponse = await fetch(new URL('browser-live/panel.css', pageUrl))
    const cssText = await cssResponse.text()
    assert(cssResponse.status === 200, `panel.css HTTP 状态 ${cssResponse.status}`)
    assert(cssText.includes('.dsh-bp-panel'), 'panel.css 内容不符合预期')
    console.log('PASS http: 页面 / panel.js / panel.css 可访问')

    // 2) WebSocket 握手 + show / state / frame
    const wsUrl = `ws://127.0.0.1:${port}${WS_PATH}`
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('WebSocket 连接失败'))
      })
    })
    assert(socket.readyState === WebSocket.OPEN, 'WebSocket 未处于 OPEN')
    console.log('PASS ws: 握手成功')

    const showMessage = await readMessage(
      socket,
      (raw) => typeof raw === 'string' && JSON.parse(raw).type === 'show',
      5000,
      'show'
    )
    assert(showMessage, '未收到 show')
    console.log('PASS ws: 收到 show')

    socket.send(JSON.stringify({ type: 'subscribe' }))
    const stateRaw = await readMessage(
      socket,
      (raw) => typeof raw === 'string' && JSON.parse(raw).type === 'state',
      5000,
      'state'
    )
    const state = JSON.parse(stateRaw)
    assert(state.open === true, 'state.open 应为 true')
    assert(state.width === FRAME_WIDTH && state.height === FRAME_HEIGHT, 'state 尺寸错误')
    assert(typeof state.title === 'string' && state.title.length > 0, 'state.title 缺失')
    assert(typeof state.url === 'string' && state.url.length > 0, 'state.url 缺失')

    const frameRaw = await readMessage(
      socket,
      (raw) => typeof raw === 'string' && JSON.parse(raw).type === 'frame',
      5000,
      'frame'
    )
    const frame = JSON.parse(frameRaw)
    assert(frame.width === FRAME_WIDTH && frame.height === FRAME_HEIGHT, 'frame 尺寸错误')
    assert(typeof frame.seq === 'number' && frame.seq > 0, 'frame.seq 应为正数')
    const frameBytes = Buffer.from(frame.data, 'base64')
    assert(
      frameBytes.length > 8 && frameBytes[0] === 0xff && frameBytes[1] === 0xd8,
      'frame.data 不是有效 JPEG/base64'
    )
    console.log(`PASS ws: state/frame 推送（seq=${frame.seq}, ${frameBytes.length} bytes）`)

    // 3) 最终紧凑协议（m00442）：mouseMoved 带多余字段必须被拒绝
    socket.send(
      JSON.stringify({
        type: 'input',
        input: { kind: 'mouse', type: 'mouseMoved', x: 10, y: 20, button: 'left' }
      })
    )
    const rejectedRaw = await readMessage(
      socket,
      (raw) => typeof raw === 'string' && JSON.parse(raw).type === 'error',
      5000,
      'input 拒绝错误'
    )
    assert(
      JSON.parse(rejectedRaw).message.includes('mouseMoved'),
      '服务端未拒绝 mouseMoved 的多余字段'
    )
    assert(mock.state.inputs.length === 0, '被拒绝的 input 不应进入 state.inputs')
    console.log('PASS ws: 非法 input（mouseMoved 带 button）被拒绝')

    // 4) 各类合法 input 消息都应被服务端解析并原样保存
    const inputs = [
      { kind: 'mouse', type: 'mouseMoved', x: 10, y: 20 },
      { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 120 },
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 0 },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
      { kind: 'text', text: '粘贴文本' }
    ]
    for (const input of inputs) {
      socket.send(JSON.stringify({ type: 'input', input }))
    }
    await waitFor(() => mock.state.inputs.length >= inputs.length, 5000, '服务端收到全部 input')
    const received = mock.state.inputs.map((input) => `${input.kind}:${input.type || ''}`)
    for (const input of inputs) {
      const expected = `${input.kind}:${input.type || ''}`
      assert(received.includes(expected), `服务端未收到 ${expected}`)
    }
    assert(
      JSON.stringify(mock.state.inputs[0]) === JSON.stringify(inputs[0]),
      '服务端保存的 mouseMoved 字段与发送内容不一致'
    )
    console.log(
      `PASS ws: 服务端解析 ${inputs.length} 条 input（${inputs.map((input) => `${input.kind}:${input.type || ''}`).join(', ')}）`
    )

    socket.send(JSON.stringify({ type: 'unsubscribe' }))
    await waitFor(
      () => mock.state.messages.some((message) => message.type === 'unsubscribe'),
      3000,
      '服务端收到 unsubscribe'
    )
    console.log('PASS ws: unsubscribe 被服务端接收')

    socket.close()
    console.log('ALL PASS: mock-ws 自测通过（HTTP/WS/show/state/JPEG frame/紧凑 input/unsubscribe）')
  } finally {
    await mock.close()
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) {
    await selftest()
    return
  }

  const mock = createMockServer({
    onInput(input) {
      const point = input.x !== undefined ? ` @(${input.x},${input.y})` : ''
      console.log(`[input] ${input.kind}${point}`)
    }
  })
  const port = Number(process.env.MOCK_WS_PORT || 0)
  const address = await mock.listen(port)
  const pageUrl = `http://127.0.0.1:${address.port}${PAGE_PATH}`
  console.log('dsh-fnos 可见浏览器面板 · 假服务端')
  console.log(`页面：${pageUrl}`)
  console.log('按 Ctrl+C 停止。宿主真实部署时由 DSH 插件提供同路径资源与 WS 端点。')

  const shutdown = async () => {
    await mock.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
