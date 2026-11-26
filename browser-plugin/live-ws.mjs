// Minimal RFC 6455 server side for the fixed-path browser panel socket.
// Only text messages are used: JSON control/input upward, base64 frames down.
// No extensions, no subprotocols, no fragmentation support (messages are tiny
// JSON documents; a fragmented client message is rejected by closing).
import { createHash } from 'node:crypto'
import { STATUS_CODES } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_CLIENT_MESSAGE = 64 * 1024
const MAX_SERVER_MESSAGE = 4 * 1024 * 1024
const OUTBOUND_HIGH_WATER = 1024 * 1024

/** Write a raw HTTP rejection and destroy the socket. */
export function rejectUpgrade(socket, status) {
  const reason = STATUS_CODES[status] ?? 'Rejected'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  socket.destroy()
}

function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/**
 * Complete the server handshake. Returns a connection object, or throws after
 * rejecting the socket.
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  if (typeof key !== 'string' || key.length === 0 || Buffer.from(key, 'base64').length !== 16) {
    rejectUpgrade(socket, 400)
    throw new Error('invalid websocket key')
  }
  if (version !== '13') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nsec-websocket-version: 13\r\nconnection: close\r\n\r\n')
    socket.destroy()
    throw new Error('unsupported websocket version')
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'upgrade: websocket\r\n'
    + 'connection: Upgrade\r\n'
    + `sec-websocket-accept: ${accept}\r\n\r\n`,
  )

  const handlers = { message: () => {}, close: () => {} }
  let buffered = head
  let closed = false
  let fragmented = null
  let queued = false

  function teardown() {
    if (closed) return
    closed = true
    try { handlers.close() } catch { /* a close handler must not crash the Host */ }
    socket.destroy()
  }

  function emitClose() {
    if (closed) return
    closed = true
    try { handlers.close() } catch { /* ignore */ }
  }

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      socket.end(encodeFrame(0x8, Buffer.alloc(0)))
      emitClose()
      return
    }
    if (opcode === 0x9) {
      socket.write(encodeFrame(0xa, payload))
      return
    }
    if (opcode === 0xa) return
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x0 && fragmented === null) { teardown(); return }
      if (opcode === 0x1 && fragmented !== null) { teardown(); return }
      const total = (fragmented ?? Buffer.alloc(0)).length + payload.length
      if (total > MAX_CLIENT_MESSAGE) { teardown(); return }
      const message = Buffer.concat([fragmented ?? Buffer.alloc(0), payload])
      if (!fin) { fragmented = message; return }
      fragmented = null
      try { handlers.message(message.toString('utf8')) } catch { /* handler isolation */ }
      return
    }
    // Binary and reserved opcodes are outside the panel protocol.
    teardown()
  }

  function consume() {
    for (;;) {
      if (buffered.length < 2) return
      const first = buffered[0]
      const second = buffered[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (!masked) { teardown(); return }
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        const big = buffered.readBigUInt64BE(2)
        if (big > BigInt(MAX_CLIENT_MESSAGE)) { teardown(); return }
        length = Number(big)
        offset = 10
      }
      if (buffered.length < offset + 4 + length) return
      const mask = buffered.subarray(offset, offset + 4)
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
      buffered = buffered.subarray(offset + 4 + length)
      handleFrame(fin, opcode, payload)
    }
  }

  function flush() {
    queued = false
    consume()
  }

  socket.on('data', (chunk) => {
    if (closed) return
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    if (buffered.length > MAX_CLIENT_MESSAGE * 2) { teardown(); return }
    // Re-entrancy guard: input events can arrive while a handler is emitting.
    if (queued) return
    queued = true
    queueMicrotask(flush)
  })
  socket.on('error', teardown)
  socket.on('close', emitClose)
  socket.on('end', teardown)

  if (head !== undefined && head.length > 0) queueMicrotask(() => { if (!closed) consume() })

  return {
    onMessage(handler) { handlers.message = handler },
    onClose(handler) { handlers.close = handler },
    get closed() { return closed },
    /** Send a text message; returns false when the socket cannot take more now. */
    sendText(text) {
      if (closed) return false
      const payload = Buffer.from(text)
      if (payload.length > MAX_SERVER_MESSAGE) return false
      if (socket.writableLength > OUTBOUND_HIGH_WATER) return false
      socket.write(encodeFrame(0x1, payload))
      return true
    },
    close() {
      if (closed) return
      socket.write(encodeFrame(0x8, Buffer.alloc(0)))
      socket.end()
      emitClose()
    },
  }
}
