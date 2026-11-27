import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppConfig } from './config.ts'
import type { HarnessManager } from './harness.ts'
import { HarnessStartError, type HarnessInstance } from './harness.ts'
import { readIdentity, type Identity } from './identity.ts'
import type { Logger } from './logger.ts'
import { proxyHttp, proxyUpgrade, type ProxyTarget } from './proxy.ts'
import { WorkspacePreparationError, type WorkspaceStore } from './workspaces.ts'

const PROXY_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE'

/**
 * One administrator acceptance instance. This is an explicit, opt-in exception
 * to the single-workspace rule: it never reads or writes the user's workspace,
 * profile or credentials. Implementations must fail closed when disabled.
 */
export interface ExperimentalAcceptanceSession {
  /** Loopback port of the disposable Harness process. */
  readonly port: number
  /** Supervisor-held Harness cookie; never sent to the browser. */
  readonly cookie: string | undefined
  /** Re-mint the cookie when the disposable instance rejects a stale one. */
  reauthenticate(): Promise<string | undefined>
}

/** Administrator-only disposable instance source; absent when the feature is off. */
export interface ExperimentalAcceptance {
  /** Exactly one NAS uid may use the acceptance mount. */
  readonly uid: string
  open(identity: Identity, signal?: AbortSignal): Promise<ExperimentalAcceptanceSession>
  close(identity: Identity): Promise<void>
}

/** Everything the HTTP layer needs. */
export interface ServerDeps {
  readonly config: AppConfig
  readonly store: WorkspaceStore
  readonly harness: HarnessManager
  readonly logger: Logger
  /** Present only when the administrator acceptance experiment is enabled. */
  readonly acceptance?: ExperimentalAcceptance
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

/** Reserved stop action under the acceptance mount; never proxied upstream. */
const ACCEPTANCE_STOP = '/_stop'

interface AcceptanceRoute {
  /** Path after the mount, always starting with '/'; '/' means the mount root. */
  readonly rest: string
}

/**
 * Match the administrator acceptance mount.
 * The mount is deliberately not listed anywhere unless it is enabled, and the
 * path is matched after removing the gateway mount prefix.
 */
export function matchAcceptance(pathname: string, appName: string): AcceptanceRoute | undefined {
  const { path } = splitMount(pathname, appName)
  if (path === '/acceptance' || path === '/acceptance/') return { rest: '/' }
  if (!path.startsWith('/acceptance/')) return undefined
  return { rest: path.slice('/acceptance'.length) }
}

/** Only the configured administrator may use the acceptance mount. */
function acceptanceCaller(deps: ServerDeps, req: IncomingMessage): Identity | undefined {
  const acceptance = deps.acceptance
  if (acceptance === undefined) return undefined
  const identity = readIdentity(req.headers, deps.config.devUid)
  if (identity === undefined || !identity.isAdmin || identity.uid !== acceptance.uid) return undefined
  return identity
}

function acceptanceTarget(url: URL, appName: string, mountPathRoot: string, route: AcceptanceRoute, session: ExperimentalAcceptanceSession): ProxyTarget {
  const base = applicationBase(url.pathname, appName)
  return {
    port: session.port,
    cookie: session.cookie,
    upstreamPath: (route.rest === '/' ? '/' : route.rest) + url.search,
    mountPath: `${base}${mountPathRoot}`,
    reauth: () => session.reauthenticate(),
  }
}

/** Serve one HTTP request for the disposable acceptance instance. */
async function serveAcceptance(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  route: AcceptanceRoute,
): Promise<void> {
  const acceptance = deps.acceptance
  const identity = acceptanceCaller(deps, req)
  if (acceptance === undefined || identity === undefined) {
    // The mount does not exist for anyone else: no 401/403 oracle.
    sendNotFound(res)
    return
  }

  if (route.rest === '/' && !url.pathname.endsWith('/')) {
    redirect(res, 308, `${url.pathname}/`)
    return
  }

  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
    res.writeHead(405, { allow: PROXY_METHODS })
    res.end()
    return
  }

  if (route.rest === ACCEPTANCE_STOP) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    await acceptance.close(identity)
    deps.logger.info('acceptance-stopped', { uid: identity.uid })
    sendJson(res, 200, { stopped: true })
    return
  }

  const session = await acceptance.open(identity)
  deps.logger.info('acceptance-opened', { uid: identity.uid, port: session.port })
  proxyHttp(req, res, acceptanceTarget(url, deps.config.appName, '/acceptance', route, session))
}

/** Serve one WebSocket upgrade for the disposable acceptance instance. */
async function upgradeAcceptance(
  deps: ServerDeps,
  req: IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
  url: URL,
  route: AcceptanceRoute,
): Promise<void> {
  const acceptance = deps.acceptance
  const identity = acceptanceCaller(deps, req)
  if (acceptance === undefined || identity === undefined) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const session = await acceptance.open(identity)
  proxyUpgrade(req, socket, head, acceptanceTarget(url, deps.config.appName, '/acceptance', route, session))
}

/** Create the HTTP request handler. */
export function createHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = deps.logger

  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const acceptanceRoute = matchAcceptance(url.pathname, deps.config.appName)
      if (acceptanceRoute !== undefined) {
        await serveAcceptance(deps, req, res, url, acceptanceRoute)
        return
      }
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
      const acceptanceRoute = matchAcceptance(url.pathname, deps.config.appName)
      if (acceptanceRoute !== undefined) {
        await upgradeAcceptance(deps, req, socket, head, url, acceptanceRoute)
        return
      }
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
