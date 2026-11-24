import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Upstream Harness facts needed by one proxied request. */
export interface ProxyTarget {
  readonly port: number
  /** Harness cookie held by the supervisor, never exposed to the browser. */
  readonly cookie: string | undefined
  /** Path on the upstream origin, including the query string. */
  readonly upstreamPath: string
  /** Full browser-facing mount path used to rewrite absolute redirects. */
  readonly mountPath: string
  /** Re-mint the cookie after the upstream rejects it. */
  readonly reauth: () => Promise<string | undefined>
}

function origin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Rewrite an upstream Location so the browser stays under the mount. */
export function rewriteLocation(value: string, port: number, mountPath: string): string {
  if (value.startsWith(`${origin(port)}/`)) {
    return mountPath + value.slice(origin(port).length)
  }
  if (value === origin(port)) return `${mountPath}/`
  if (value.startsWith('/') && !value.startsWith('//')) return mountPath + value
  return value
}

function buildHeaders(req: IncomingMessage, port: number, cookie: string | undefined): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${port}`
  headers.origin = origin(port)
  if (cookie !== undefined) headers.cookie = cookie
  return headers
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

/**
 * Proxy one HTTP request to a project Harness instance.
 * Browser cookies are replaced by the cookie the supervisor minted, so the
 * Harness never sees NAS session material and the browser never sees Harness tokens.
 */
export function proxyHttp(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
  const retryable = req.method === 'GET' || req.method === 'HEAD'

  const attempt = (cookie: string | undefined, renewed: boolean): void => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target.port,
        method: req.method,
        path: target.upstreamPath,
        headers: buildHeaders(req, target.port, cookie),
      },
      (up) => {
        if (up.statusCode === 401 && retryable && !renewed) {
          up.resume()
          void target.reauth().then(
            (next) => attempt(next ?? cookie, true),
            () => sendError(res, 502, '无法重新认证 DeepSeek Harness'),
          )
          return
        }

        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(name) || name === 'set-cookie') continue
          headers[name] = name === 'location' ? rewriteLocation(String(value), target.port, target.mountPath) : value
        }
        headers['cache-control'] = headers['cache-control'] ?? 'no-store'
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
      },
    )

    upstream.on('error', () => sendError(res, 502, 'DeepSeek Harness 实例不可用'))
    if (retryable) {
      upstream.end()
      return
    }
    req.pipe(upstream)
  }

  attempt(target.cookie, false)
}

/** Proxy a WebSocket upgrade to the same instance. */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
): void {
  const upstream = connect({ host: '127.0.0.1', port: target.port })

  const lines = [`${req.method ?? 'GET'} ${target.upstreamPath} HTTP/1.1`]
  const headers = buildHeaders(req, target.port, target.cookie)
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  lines.push('connection: Upgrade', 'upgrade: websocket')

  upstream.write(lines.join('\r\n') + '\r\n\r\n')
  if (head.length > 0) upstream.write(head)

  upstream.pipe(socket)
  socket.pipe(upstream)
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}
