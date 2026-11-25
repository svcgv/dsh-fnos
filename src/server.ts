import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppConfig } from './config.ts'
import type { HarnessManager } from './harness.ts'
import { HarnessStartError, type HarnessInstance } from './harness.ts'
import { readIdentity, type Identity } from './identity.ts'
import type { Logger } from './logger.ts'
import { proxyHttp, proxyUpgrade, type ProxyTarget } from './proxy.ts'
import { WorkspacePreparationError, type WorkspaceStore } from './workspaces.ts'

const PROXY_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE'

/** Everything the HTTP layer needs. */
export interface ServerDeps {
  readonly config: AppConfig
  readonly store: WorkspaceStore
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

function redirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, {
    location,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end()
}

function applicationBase(pathname: string, appName: string): string {
  const mount = `/app/${appName}`
  return pathname === mount || pathname.startsWith(`${mount}/`) ? mount : ''
}

/** Build the proxy target for the user's single workspace. */
async function openWorkspace(
  deps: ServerDeps,
  identity: Identity,
  base: string,
  rest: string,
  query: string,
): Promise<{ instance: HarnessInstance; target: ProxyTarget }> {
  const workspace = await deps.store.ensure(identity.uid)
  const instance = await deps.harness.ensure(identity.uid, workspace)
  deps.harness.touch(instance.key)

  return {
    instance,
    target: {
      port: instance.port,
      cookie: instance.cookie,
      upstreamPath: (rest === '' ? '/' : rest) + query,
      mountPath: `${base}/workspace`,
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
        redirect(res, 308, `${url.pathname}/`)
        return
      }

      const identity = readIdentity(req.headers, deps.config.devUid)
      if (identity === undefined) {
        sendJson(res, 401, { error: '缺少可信的飞牛用户身份' })
        return
      }

      const base = applicationBase(url.pathname, deps.config.appName)

      if (path === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        await deps.store.ensure(identity.uid)
        redirect(res, 302, `${base}/workspace/`)
        return
      }

      if (path === '/workspace') {
        redirect(res, 308, `${base}/workspace/`)
        return
      }

      const workspaceMatch = /^\/workspace(\/.*)?$/u.exec(path)
      if (workspaceMatch !== null) {
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
          res.writeHead(405, { allow: PROXY_METHODS })
          res.end()
          return
        }
        const opened = await openWorkspace(deps, identity, base, workspaceMatch[1] ?? '', url.search)
        proxyHttp(req, res, opened.target)
        return
      }

      const legacyMatch = /^\/p\/[^/]+(\/.*)?$/u.exec(path)
      if (legacyMatch !== null) {
        redirect(res, 308, `${base}/workspace${legacyMatch[1] ?? '/'}${url.search}`)
        return
      }

      sendNotFound(res)
    })().catch((error: unknown) => {
      if (error instanceof WorkspacePreparationError) {
        logger.error('workspace-migration-failed', { detail: error.detail })
        sendText(res, 503, '工作区迁移失败，请查看应用日志或恢复升级前数据快照')
        return
      }
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
      const match = /^\/workspace(\/.*)?$/u.exec(path)
      if (match === null) {
        socket.destroy()
        return
      }

      const identity = readIdentity(req.headers, deps.config.devUid)
      if (identity === undefined) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }

      const base = applicationBase(url.pathname, deps.config.appName)
      const opened = await openWorkspace(deps, identity, base, match[1] ?? '', url.search)
      proxyUpgrade(req, socket, head, opened.target)
    })().catch((error: unknown) => {
      deps.logger.error('upgrade-failed', { error: error instanceof Error ? error.message : String(error) })
      socket.destroy()
    })
  }
}
