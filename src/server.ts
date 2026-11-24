import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from './config.ts'
import type { HarnessManager } from './harness.ts'
import { HarnessStartError, type HarnessInstance } from './harness.ts'
import { readIdentity, type Identity } from './identity.ts'
import type { Logger } from './logger.ts'
import { proxyHttp, proxyUpgrade, type ProxyTarget } from './proxy.ts'
import type { ProjectStore } from './projects.ts'

const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
])
const PROJECT_ID = /^p[a-z0-9]{6,32}$/

/** Everything the HTTP layer needs. */
export interface ServerDeps {
  readonly config: AppConfig
  readonly store: ProjectStore
  readonly harness: HarnessManager
  readonly logger: Logger
}

interface Route {
  readonly path: string
}

/**
 * Remove the fnOS unified gateway mount prefix.
 * The gateway forwards the public path unchanged, but local development and
 * `index.cgi`-style callers may hit the service root, so both forms work.
 */
export function splitMount(pathname: string, appName: string): Route {
  const mount = `/app/${appName}`
  if (pathname === mount) return { path: '' }
  if (pathname.startsWith(`${mount}/`)) return { path: pathname.slice(mount.length) }
  return { path: pathname }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(message)
}

function sendNotFound(res: ServerResponse): void {
  sendText(res, 404, '404 Not Found')
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && contentType.includes('application/json')
}

/** Serve the project picker UI from a fixed allowlist. */
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const file = STATIC_FILES.get(path)
  if (file === undefined) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }

  let body: Buffer
  try {
    body = await readFile(join(UI_DIR, file))
  } catch {
    sendNotFound(res)
    return true
  }

  const contentType = file.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/javascript; charset=utf-8'

  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

/** Build the proxy target for an open project route. */
async function openProject(
  deps: ServerDeps,
  identity: Identity,
  projectId: string,
  rest: string,
  query: string,
): Promise<{ instance: HarnessInstance; target: ProxyTarget } | undefined> {
  if (!PROJECT_ID.test(projectId)) return undefined
  const project = await deps.store.get(identity.uid, projectId)
  if (project === undefined) return undefined

  const instance = await deps.harness.ensure(identity.uid, project)
  deps.harness.touch(instance.key)

  return {
    instance,
    target: {
      port: instance.port,
      cookie: instance.cookie,
      upstreamPath: (rest === '' ? '/' : rest) + query,
      mountPath: `/app/${deps.config.appName}/p/${projectId}`,
      reauth: () => deps.harness.reauthenticate(instance.key),
    },
  }
}

/** Create the HTTP request handler. */
export function createHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = deps.logger

  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const { path } = splitMount(url.pathname, deps.config.appName)

      if (path === '/healthz') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '') {
        res.writeHead(308, { location: `${url.pathname}/` })
        res.end()
        return
      }

      const identity = readIdentity(req.headers, deps.config.devUid)
      if (identity === undefined) {
        sendJson(res, 401, { error: '未登录或缺少飞牛网关身份' })
        return
      }

      if (await serveStatic(req, res, path)) return

      if (path === '/api/projects') {
        if (req.method === 'GET') {
          const projects = await deps.store.list(identity.uid)
          sendJson(res, 200, {
            user: { name: identity.username, isAdmin: identity.isAdmin },
            projects,
          })
          return
        }
        if (req.method === 'POST') {
          if (!isSameOriginRequest(req)) {
            sendJson(res, 403, { error: '请求来源不受信任' })
            return
          }
          try {
            const body = await readJsonBody(req, deps.config.maxBodyBytes)
            const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : undefined
            const project = await deps.store.create(identity.uid, name)
            logger.info('project-created', { uid: identity.uid, projectId: project.id })
            sendJson(res, 201, { project })
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : '无法创建项目' })
          }
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }

      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path)
      if (projectMatch !== null) {
        if (req.method !== 'DELETE') {
          res.writeHead(405, { allow: 'DELETE' })
          res.end()
          return
        }
        if (!isSameOriginRequest(req)) {
          sendJson(res, 403, { error: '请求来源不受信任' })
          return
        }
        const id = projectMatch[1] ?? ''
        const project = await deps.store.get(identity.uid, id)
        if (project === undefined) {
          sendNotFound(res)
          return
        }
        await deps.harness.stop(identity.uid, id)
        await deps.store.remove(identity.uid, id)
        logger.info('project-removed', { uid: identity.uid, projectId: id })
        sendJson(res, 200, { removed: true })
        return
      }

      const openMatch = /^\/p\/([^/]+)(\/.*)?$/.exec(path)
      if (openMatch !== null) {
        const projectId = openMatch[1] ?? ''
        const rest = openMatch[2] ?? ''
        const opened = await openProject(deps, identity, projectId, rest, url.search)
        if (opened === undefined) {
          sendNotFound(res)
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          proxyHttp(req, res, opened.target)
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' })
        res.end()
        return
      }

      sendNotFound(res)
    })().catch((error: unknown) => {
      if (error instanceof HarnessStartError) {
        logger.error('harness-start-failed', { detail: error.detail })
        sendText(res, 503, `DeepSeek Harness 启动失败:\n${error.detail}`)
        return
      }
      logger.error('request-failed', { error: error instanceof Error ? error.message : String(error) })
      sendText(res, 500, '500 Internal Server Error')
    })
  }
}

/** Create the WebSocket upgrade handler. */
export function createUpgradeHandler(deps: ServerDeps): (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const { path } = splitMount(url.pathname, deps.config.appName)
      const match = /^\/p\/([^/]+)(\/.*)?$/.exec(path)
      if (match === null) {
        socket.destroy()
        return
      }

      const identity = readIdentity(req.headers, deps.config.devUid)
      if (identity === undefined) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }

      const opened = await openProject(deps, identity, match[1] ?? '', match[2] ?? '', url.search)
      if (opened === undefined) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        return
      }
      proxyUpgrade(req, socket, head, opened.target)
    })().catch((error: unknown) => {
      deps.logger.error('upgrade-failed', { error: error instanceof Error ? error.message : String(error) })
      socket.destroy()
    })
  }
}
