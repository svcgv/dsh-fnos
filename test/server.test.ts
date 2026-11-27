import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../src/config.ts'
import { HarnessManager } from '../src/harness.ts'
import { createLogger } from '../src/logger.ts'
import { createHandler, createUpgradeHandler } from '../src/server.ts'
import { WorkspaceStore } from '../src/workspaces.ts'

const fixture = fileURLToPath(new URL('./fixtures/mock-harness.mjs', import.meta.url))

interface Harness {
  readonly base: string
  readonly home: string
  readonly close: () => Promise<void>
}

async function startHarness(sharedEnv = 'MOCK_SHARED=shared-yes\n'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fnos-http-'))
  const appDest = join(root, 'app')
  const pkgEtc = join(root, 'etc')
  const pkgVar = join(root, 'var')
  const pkgHome = join(root, 'home')
  await mkdir(appDest, { recursive: true })
  await mkdir(pkgEtc, { recursive: true })
  await writeFile(join(pkgEtc, 'shared.env'), sharedEnv)

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
    startTimeoutMs: 20_000,
  }

  const logger = createLogger({ test: 'server' })
  const store = new WorkspaceStore({ homeRoot: pkgHome })
  const manager = new HarnessManager(config, store, logger)
  const deps = { config, store, harness: manager, logger }

  const server: Server = createServer(createHandler(deps))
  server.on('upgrade', createUpgradeHandler(deps))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')

  return {
    base: `http://127.0.0.1:${address.port}`,
    home: pkgHome,
    close: async () => {
      await manager.stopAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

function headers(uid: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-trim-userid': uid, 'x-trim-username': `user-${uid}`, ...extra }
}

test('root opens one isolated workspace per NAS user', { timeout: 60_000 }, async () => {
  process.env.TRIM_API_TOKEN = 'gateway-secret'
  const harness = await startHarness()

  try {
    const root = await fetch(`${harness.base}/app/dsh-fnos/`, {
      headers: headers('1000'),
      redirect: 'manual',
    })
    assert.equal(root.status, 302)
    assert.equal(root.headers.get('location'), '/app/dsh-fnos/workspace/')

    const page = await fetch(`${harness.base}/app/dsh-fnos/workspace/`, { headers: headers('1000') })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /MOCK_HARNESS/u)
    assert.equal(page.headers.get('set-cookie'), null)

    const echo = await fetch(`${harness.base}/app/dsh-fnos/workspace/api/echo`, { headers: headers('1000') })
    const payload = await echo.json() as { dshHome: string; shared: string; leakedTrimToken: string | null }
    assert.equal(payload.dshHome, join(harness.home, 'users', '1000', 'harness', 'dsh-home'))
    assert.equal(payload.shared, 'shared-yes')
    assert.equal(payload.leakedTrimToken, null)

    const marker = JSON.parse(await readFile(join(harness.home, 'users', '1000', 'harness', 'instance.json'), 'utf8')) as { ownerUid: string }
    assert.equal(marker.ownerUid, '1000')

    const otherRoot = await fetch(`${harness.base}/app/dsh-fnos/`, {
      headers: headers('2000'),
      redirect: 'manual',
    })
    assert.equal(otherRoot.status, 302)
    const otherEcho = await fetch(`${harness.base}/app/dsh-fnos/workspace/api/echo`, { headers: headers('2000') })
    const otherPayload = await otherEcho.json() as { dshHome: string }
    assert.equal(otherPayload.dshHome, join(harness.home, 'users', '2000', 'harness', 'dsh-home'))
    assert.notEqual(otherPayload.dshHome, payload.dshHome)
  } finally {
    await harness.close()
  }
})

test('workspace Harness uses an interactive shell instead of the service shell', { timeout: 60_000 }, async (t) => {
  const previousShell = process.env.SHELL
  t.after(() => {
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
  })

  const cases = [
    { serviceShell: undefined, sharedEnv: '', expected: '/bin/bash' },
    { serviceShell: '/usr/sbin/nologin', sharedEnv: '', expected: '/bin/bash' },
    { serviceShell: '/usr/sbin/nologin', sharedEnv: 'SHELL=\n', expected: '/bin/bash' },
    { serviceShell: '/usr/sbin/nologin', sharedEnv: 'SHELL=/bin/sh\n', expected: '/bin/sh' },
  ]
  for (const { serviceShell, sharedEnv, expected } of cases) {
    if (serviceShell === undefined) delete process.env.SHELL
    else process.env.SHELL = serviceShell
    const harness = await startHarness(sharedEnv)
    try {
      const echo = await fetch(`${harness.base}/app/dsh-fnos/workspace/api/echo`, { headers: headers('1000') })
      assert.equal(echo.status, 200)
      const payload = await echo.json() as { shell: string | null }
      assert.equal(payload.shell, expected)
    } finally {
      await harness.close()
    }
  }
})

test('legacy project URLs redirect and project APIs are removed', async () => {
  const harness = await startHarness()
  try {
    await fetch(`${harness.base}/app/dsh-fnos/`, { headers: headers('1000'), redirect: 'manual' })

    const legacy = await fetch(`${harness.base}/app/dsh-fnos/p/pdeadbeef/timeline?x=1`, {
      headers: headers('1000'),
      redirect: 'manual',
    })
    assert.equal(legacy.status, 308)
    assert.equal(legacy.headers.get('location'), '/app/dsh-fnos/workspace/timeline?x=1')

    const projectApi = await fetch(`${harness.base}/app/dsh-fnos/api/projects`, { headers: headers('1000') })
    assert.equal(projectApi.status, 404)
  } finally {
    await harness.close()
  }
})

test('requests without a gateway identity are rejected', { timeout: 10_000 }, async () => {
  const harness = await startHarness()
  try {
    const api = await fetch(`${harness.base}/app/dsh-fnos/`)
    assert.equal(api.status, 401)
  } finally {
    await harness.close()
  }
})

test('WebSocket upgrades use the single workspace route', { timeout: 30_000 }, async () => {
  const harness = await startHarness()
  try {
    await fetch(`${harness.base}/app/dsh-fnos/`, { headers: headers('1000') })

    const url = new URL(harness.base)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname)
      socket.on('connect', () => {
        socket.write([
          'GET /app/dsh-fnos/workspace/ws HTTP/1.1',
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


test('concurrent workspace requests wait for the same ready Harness', { timeout: 30_000 }, async () => {
  const harness = await startHarness('MOCK_START_DELAY_MS=500\n')
  try {
    const first = fetch(`${harness.base}/workspace/`, { headers: headers('1000') })
    // Allow the child to spawn while its token is deliberately delayed.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const responses = await Promise.all([first, ...Array.from({ length: 5 }, () =>
      fetch(`${harness.base}/workspace/`, { headers: headers('1000') }))])
    assert.deepEqual(responses.map((response) => response.status), Array(6).fill(200))
  } finally {
    await harness.close()
  }
})
