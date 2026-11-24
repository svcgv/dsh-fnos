import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../src/config.ts'
import { HarnessManager } from '../src/harness.ts'
import { createLogger } from '../src/logger.ts'
import { ProjectStore } from '../src/projects.ts'
import { createHandler, createUpgradeHandler } from '../src/server.ts'

const fixture = fileURLToPath(new URL('./fixtures/mock-harness.mjs', import.meta.url))

interface Harness {
  readonly base: string
  readonly close: () => Promise<void>
  readonly config: AppConfig
}

async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fnos-http-'))
  const appDest = join(root, 'app')
  const pkgEtc = join(root, 'etc')
  const pkgVar = join(root, 'var')
  const pkgHome = join(root, 'home')
  await mkdir(appDest, { recursive: true })
  await mkdir(pkgEtc, { recursive: true })
  await writeFile(join(pkgEtc, 'shared.env'), 'MOCK_SHARED=shared-yes\n')

  const config: AppConfig = {
    appName: 'dsh-fnos',
    appDest,
    pkgEtc,
    pkgVar,
    pkgHome,
    socketPath: join(appDest, 'app.sock'),
    listenPort: undefined,
    harness: { entry: fixture, executable: process.execPath, profile: 'web', extraArgs: [] },
    devUid: undefined,
    idleStopMs: 60_000,
    startTimeoutMs: 20_000,
    maxBodyBytes: 64 * 1024,
  }

  const logger = createLogger({ test: 'server' })
  const store = new ProjectStore({ homeRoot: pkgHome, varRoot: pkgVar, maxProjectsPerUser: 5 })
  const manager = new HarnessManager(config, store, logger)
  const deps = { config, store, harness: manager, logger }

  const server: Server = createServer(createHandler(deps))
  server.on('upgrade', createUpgradeHandler(deps))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')

  return {
    base: `http://127.0.0.1:${address.port}`,
    config,
    close: async () => {
      await manager.stopAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function headers(uid: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-trim-userid': uid, 'x-trim-username': `user-${uid}`, ...extra }
}

test('browser sessions are isolated per project and per NAS user', { timeout: 60_000 }, async () => {
  process.env.TRIM_API_TOKEN = 'gateway-secret'
  const harness = await startHarness()

  try {
    const created = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, {
      method: 'POST',
      headers: headers('1000', { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: '博客重构' }),
    })
    assert.equal(created.status, 201)
    const payload = await created.json() as { project: { id: string; name: string } }
    assert.equal(payload.project.name, '博客重构')

    const list = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, { headers: headers('1000') })
    const listed = await list.json() as { projects: Array<{ id: string }>; user: { name: string } }
    assert.equal(listed.projects.length, 1)
    assert.equal(listed.user.name, 'user-1000')

    const otherUser = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, { headers: headers('2000') })
    const otherList = await otherUser.json() as { projects: unknown[] }
    assert.equal(otherList.projects.length, 0)

    const openPath = `/app/dsh-fnos/p/${payload.project.id}/`
    const page = await fetch(`${harness.base}${openPath}`, { headers: headers('1000') })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /MOCK_HARNESS/u)
    assert.equal(page.headers.get('set-cookie'), null)

    const denied = await fetch(`${harness.base}${openPath}`, { headers: headers('2000') })
    assert.equal(denied.status, 404)

    const echo = await fetch(`${harness.base}${openPath}api/echo`, {
      headers: headers('1000', { cookie: 'browser-cookie=should-not-forward' }),
    })
    const echoed = await echo.json() as Record<string, unknown>
    assert.equal(echoed.shared, 'shared-yes')
    assert.equal(echoed.leakedTrimToken, null)
    assert.equal(echoed.cookie, 'dsh_session=ok')
    assert.match(String(echoed.host), /^127\.0\.0\.1:\d+$/u)
    assert.equal(echoed.url, '/api/echo')

    const redirect = await fetch(`${harness.base}${openPath}redirect`, { headers: headers('1000'), redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), openPath + 'api/echo')

    const removed = await fetch(`${harness.base}/app/dsh-fnos/api/projects/${payload.project.id}`, {
      method: 'DELETE',
      headers: headers('1000', { 'content-type': 'application/json' }),
    })
    assert.equal(removed.status, 200)

    const after = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, { headers: headers('1000') })
    const afterList = await after.json() as { projects: unknown[] }
    assert.equal(afterList.projects.length, 0)
  } finally {
    delete process.env.TRIM_API_TOKEN
    await harness.close()
  }
})

test('cross-user ids never leak project existence', { timeout: 30_000 }, async () => {
  const harness = await startHarness()
  try {
    const created = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, {
      method: 'POST',
      headers: headers('1000', { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'private' }),
    })
    const { project } = await created.json() as { project: { id: string } }

    for (const uid of ['2000', '1001']) {
      const page = await fetch(`${harness.base}/app/dsh-fnos/p/${project.id}/`, { headers: headers(uid) })
      assert.equal(page.status, 404)
      const del = await fetch(`${harness.base}/app/dsh-fnos/api/projects/${project.id}`, {
        method: 'DELETE',
        headers: headers(uid, { 'content-type': 'application/json' }),
      })
      assert.equal(del.status, 404)
    }
  } finally {
    await harness.close()
  }
})

test('requests without a gateway identity are rejected', { timeout: 15_000 }, async () => {
  const harness = await startHarness()
  try {
    const page = await fetch(`${harness.base}/app/dsh-fnos/`)
    assert.equal(page.status, 401)
    const api = await fetch(`${harness.base}/app/dsh-fnos/api/projects`)
    assert.equal(api.status, 401)
    const health = await fetch(`${harness.base}/healthz`)
    assert.equal(health.status, 200)
  } finally {
    await harness.close()
  }
})

test('WebSocket upgrades are authenticated and proxied', { timeout: 30_000 }, async () => {
  const harness = await startHarness()
  try {
    const created = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, {
      method: 'POST',
      headers: headers('1000', { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'ws' }),
    })
    const { project } = await created.json() as { project: { id: string } }
    // Warm the instance so the upgrade does not race the startup token.
    await fetch(`${harness.base}/app/dsh-fnos/p/${project.id}/`, { headers: headers('1000') })

    const url = new URL(harness.base)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname)
      socket.on('connect', () => {
        socket.write([
          `GET /app/dsh-fnos/p/${project.id}/ws HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'x-trim-userid: 1000',
          '',
          '',
        ].join('\r\n'))
      })
      socket.once('data', (chunk) => {
        resolve(chunk.toString().split('\r\n', 1)[0] ?? '')
        socket.destroy()
      })
      socket.on('error', reject)
    })
    assert.match(status, /101/u)
  } finally {
    await harness.close()
  }
})
