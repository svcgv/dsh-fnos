import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import type { AppConfig } from '../src/config.ts'
import type { Identity } from '../src/identity.ts'
import { createLogger } from '../src/logger.ts'
import {
  createHandler,
  createUpgradeHandler,
  matchAcceptance,
  type ExperimentalAcceptance,
  type ExperimentalAcceptanceSession,
} from '../src/server.ts'
import type { ServerDeps } from '../src/server.ts'
import type { HarnessManager } from '../src/harness.ts'
import type { WorkspaceStore } from '../src/workspaces.ts'

const ADMIN_UID = '1000'
const OTHER_ADMIN_UID = '1001'

interface FakeSession extends ExperimentalAcceptanceSession {
  readonly reauthCalls: number
}

function fakeSession(port: number): FakeSession {
  let reauthCalls = 0
  return {
    port,
    cookie: 'supervisor-cookie',
    get reauthCalls() {
      return reauthCalls
    },
    async reauthenticate() {
      reauthCalls += 1
      return 'supervisor-cookie'
    },
  }
}

interface Upstream {
  readonly port: number
  readonly requests: { path: string; cookie: string | undefined }[]
  close(): Promise<void>
}

/** Minimal stand-in for the disposable Harness instance. */
async function startUpstream(): Promise<Upstream> {
  const requests: { path: string; cookie: string | undefined }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const cookie = req.headers.cookie
    requests.push({ path: req.url ?? '', cookie: typeof cookie === 'string' ? cookie : undefined })
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    if (req.url?.startsWith('/stale') && cookie !== 'fresh-cookie') {
      res.writeHead(401)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=secret' })
    res.end(JSON.stringify({ upstream: req.url ?? '' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('upstream did not bind')
  return {
    port: address.port,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface AcceptanceHarness {
  readonly base: string
  readonly opened: Identity[]
  readonly closed: Identity[]
  close(): Promise<void>
}

function testConfig(appName = 'dsh-fnos'): AppConfig {
  return {
    appName,
    appDest: '/nonexistent/app',
    pkgEtc: '/nonexistent/etc',
    pkgVar: '/nonexistent/var',
    pkgHome: '/nonexistent/home',
    socketPath: '/nonexistent/app.sock',
    listenPort: undefined,
    harness: { entry: '/nonexistent/entry.mjs', executable: process.execPath, profile: 'web', extraArgs: [] },
    devUid: undefined,
    idleStopMs: 60_000,
    startTimeoutMs: 20_000,
  }
}

async function startAcceptance(
  acceptance: ExperimentalAcceptance | undefined,
  appName = 'dsh-fnos',
): Promise<AcceptanceHarness> {
  const opened: Identity[] = []
  const closed: Identity[] = []
  const logger = createLogger({ test: 'acceptance' })
  const deps: ServerDeps = {
    config: testConfig(appName),
    store: {} as unknown as WorkspaceStore,
    harness: {} as unknown as HarnessManager,
    logger,
    ...(acceptance === undefined ? {} : { acceptance }),
  }
  const server: Server = createServer(createHandler(deps))
  server.on('upgrade', createUpgradeHandler(deps))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return {
    base: `http://127.0.0.1:${address.port}`,
    opened,
    closed,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function headers(uid: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-trim-userid': uid, 'x-trim-username': `user-${uid}`, ...extra }
}

test('acceptance mount does not exist while the feature is disabled', async () => {
  const harness = await startAcceptance(undefined)
  try {
    const response = await fetch(`${harness.base}/acceptance/`, { headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }) })
    assert.equal(response.status, 404)
  } finally {
    await harness.close()
  }
})

test('acceptance mount is hidden from non-admins and other uid', async () => {
  const upstream = await startUpstream()
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      throw new Error('must not open')
    },
    async close() {},
  })
  try {
    const nonAdmin = await fetch(`${harness.base}/acceptance/`, { headers: headers(ADMIN_UID) })
    assert.equal(nonAdmin.status, 404)
    const otherAdmin = await fetch(`${harness.base}/acceptance/`, { headers: headers(OTHER_ADMIN_UID, { 'x-trim-isadmin': 'true' }) })
    assert.equal(otherAdmin.status, 404)
    const anonymous = await fetch(`${harness.base}/acceptance/`)
    assert.equal(anonymous.status, 404)
    assert.equal(upstream.requests.length, 0)
  } finally {
    await harness.close()
    await upstream.close()
  }
})

test('administrator requests are proxied to the disposable instance without leaking cookies', async () => {
  const upstream = await startUpstream()
  const opened: Identity[] = []
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open(identity) {
      opened.push(identity)
      return fakeSession(upstream.port)
    },
    async close() {},
  })
  try {
    const response = await fetch(`${harness.base}/acceptance/session/abc?x=1`, {
      headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true', cookie: 'nas-session=secret' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { upstream: '/session/abc?x=1' })
    assert.equal(upstream.requests.at(-1)?.cookie, 'supervisor-cookie')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(opened.length, 1)
    assert.equal(opened[0]?.uid, ADMIN_UID)
  } finally {
    await harness.close()
    await upstream.close()
  }
})

test('acceptance mount redirects and rewrites upstream locations under its own mount', async () => {
  const upstream = await startUpstream()
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      return fakeSession(upstream.port)
    },
    async close() {},
  })
  try {
    const bare = await fetch(`${harness.base}/acceptance`, { headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }), redirect: 'manual' })
    assert.equal(bare.status, 308)
    assert.equal(bare.headers.get('location'), '/acceptance/')

    const prefixed = await fetch(`${harness.base}/app/dsh-fnos/acceptance/redirect`, {
      headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }),
      redirect: 'manual',
    })
    assert.equal(prefixed.status, 302)
    assert.equal(prefixed.headers.get('location'), '/app/dsh-fnos/acceptance/login')
  } finally {
    await harness.close()
    await upstream.close()
  }
})

test('stale cookies are re-minted through the acceptance session', async () => {
  const upstream = await startUpstream()
  let reauthCalls = 0
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      return {
        port: upstream.port,
        cookie: 'stale-cookie',
        async reauthenticate() {
          reauthCalls += 1
          return 'fresh-cookie'
        },
      }
    },
    async close() {},
  })
  try {
    const response = await fetch(`${harness.base}/acceptance/stale`, { headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }) })
    assert.equal(response.status, 200)
    assert.equal(reauthCalls, 1)
    assert.equal(upstream.requests.at(-1)?.cookie, 'fresh-cookie')
  } finally {
    await harness.close()
    await upstream.close()
  }
})

test('reserved stop action stops the instance and is never proxied', async () => {
  const upstream = await startUpstream()
  const closed: Identity[] = []
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      return fakeSession(upstream.port)
    },
    async close(identity) {
      closed.push(identity)
    },
  })
  try {
    const get = await fetch(`${harness.base}/acceptance/_stop`, { headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }) })
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const stop = await fetch(`${harness.base}/acceptance/_stop`, {
      method: 'POST',
      headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }),
    })
    assert.equal(stop.status, 200)
    assert.deepEqual(await stop.json(), { stopped: true })
    assert.equal(closed.length, 1)
    assert.equal(closed[0]?.uid, ADMIN_UID)
    assert.equal(upstream.requests.length, 0)
  } finally {
    await harness.close()
    await upstream.close()
  }
})

test('unsupported methods on the acceptance mount are rejected', async () => {
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      throw new Error('must not open')
    },
    async close() {},
  })
  try {
    const response = await fetch(`${harness.base}/acceptance/`, {
      method: 'OPTIONS',
      headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }),
    })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST, PUT, PATCH, DELETE')
  } finally {
    await harness.close()
  }
})

test('acceptance mount path matching only accepts its own prefix', () => {
  assert.deepEqual(matchAcceptance('/acceptance', 'dsh-fnos'), { rest: '/' })
  assert.deepEqual(matchAcceptance('/acceptance/', 'dsh-fnos'), { rest: '/' })
  assert.deepEqual(matchAcceptance('/acceptance/x', 'dsh-fnos'), { rest: '/x' })
  assert.deepEqual(matchAcceptance('/app/dsh-fnos/acceptance/x', 'dsh-fnos'), { rest: '/x' })
  assert.equal(matchAcceptance('/acceptancex/', 'dsh-fnos'), undefined)
  assert.equal(matchAcceptance('/workspace/', 'dsh-fnos'), undefined)
  assert.equal(matchAcceptance('/', 'dsh-fnos'), undefined)
})

test('acceptance start failures surface as a server error, not a crash', async () => {
  const harness = await startAcceptance({
    uid: ADMIN_UID,
    async open() {
      throw new Error('disposable harness failed to start')
    },
    async close() {},
  })
  try {
    const response = await fetch(`${harness.base}/acceptance/`, { headers: headers(ADMIN_UID, { 'x-trim-isadmin': 'true' }) })
    assert.equal(response.status, 500)
  } finally {
    await harness.close()
  }
})
