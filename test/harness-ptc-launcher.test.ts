import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../src/config.ts'
import { FNOS_NODE_APP, HarnessManager, resolvePtcLauncher } from '../src/harness.ts'
import { createLogger } from '../src/logger.ts'
import { WorkspaceStore } from '../src/workspaces.ts'

const fixture = fileURLToPath(new URL('./fixtures/capture-harness.mjs', import.meta.url))

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-node-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Write a tiny stand-in executable; these tests never execute Node itself. */
async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

test('resolves the launcher only for the same real Node runtime', async (t) => {
  const root = await tempRoot(t)
  const appDest = join(root, 'app')
  const bin = join(appDest, 'runtime', 'bin')
  await mkdir(bin, { recursive: true })
  const launcher = join(bin, 'dsh-ptc-node')
  await writeExecutable(launcher)
  const nodeApp = join(root, 'fnos-node')
  await writeExecutable(nodeApp)
  const other = join(root, 'other-node')
  await writeExecutable(other)
  const link = join(root, 'nodejs_v26')
  await symlink(nodeApp, link)

  assert.equal(resolvePtcLauncher(appDest, nodeApp, nodeApp), launcher)
  // The installed path is a symlink chain; the comparison follows it.
  assert.equal(resolvePtcLauncher(appDest, link, nodeApp), launcher)
  assert.equal(resolvePtcLauncher(appDest, other, nodeApp), undefined)
  assert.equal(resolvePtcLauncher(appDest, join(root, 'missing-node'), nodeApp), undefined)
  assert.equal(resolvePtcLauncher(appDest, nodeApp, join(root, 'missing-node')), undefined)
})

test('requires a present and executable app-local launcher', async (t) => {
  const root = await tempRoot(t)
  const appDest = join(root, 'app')
  const nodeApp = join(root, 'fnos-node')
  await writeExecutable(nodeApp)
  const launcher = join(appDest, 'runtime', 'bin', 'dsh-ptc-node')
  await mkdir(join(appDest, 'runtime', 'bin'), { recursive: true })

  assert.equal(resolvePtcLauncher(appDest, nodeApp, nodeApp), undefined)
  await writeFile(launcher, '#!/bin/sh\n')
  await chmod(launcher, 0o644)
  assert.equal(resolvePtcLauncher(appDest, nodeApp, nodeApp), undefined)
  await chmod(launcher, 0o755)
  assert.equal(resolvePtcLauncher(appDest, nodeApp, nodeApp), launcher)
})

interface ManagerFixture {
  readonly manager: HarnessManager
  readonly store: WorkspaceStore
  readonly root: string
  readonly appDest: string
  readonly close: () => Promise<void>
}

async function createManager(
  t: TestContext,
  options: { launcher?: boolean; sharedEnv?: string; browserLive?: boolean } = {},
): Promise<ManagerFixture> {
  const root = await tempRoot(t)
  const appDest = join(root, 'app')
  const pkgEtc = join(root, 'etc')
  const pkgHome = join(root, 'home')
  await mkdir(appDest, { recursive: true })
  await mkdir(pkgEtc, { recursive: true })
  if (options.launcher === true) {
    const bin = join(appDest, 'runtime', 'bin')
    await mkdir(bin, { recursive: true })
    await writeExecutable(join(bin, 'dsh-ptc-node'))
  }
  if (options.sharedEnv !== undefined) {
    await writeFile(join(pkgEtc, 'shared.env'), options.sharedEnv)
  }

  const config: AppConfig = {
    appName: 'dsh-fnos',
    appDest,
    pkgEtc,
    pkgVar: join(root, 'var'),
    pkgHome,
    socketPath: join(appDest, 'app.sock'),
    listenPort: undefined,
    harness: { entry: fixture, executable: process.execPath, profile: 'web', extraArgs: [] },
    devUid: undefined,
    startTimeoutMs: 20_000,
  }
  const store = new WorkspaceStore({ homeRoot: pkgHome })
  const logger = createLogger({ test: 'harness-ptc-launcher' })
  let manager: HarnessManager
  if (options.browserLive === true) {
    const patch = join(appDest, 'harness', 'browser-plugin', 'live.patch.yml')
    await mkdir(join(appDest, 'harness', 'browser-plugin'), { recursive: true })
    await writeFile(patch, '# test overlay\n')
    manager = new HarnessManager(config, store, logger, {
      uid: '1000',
      patch,
      env: { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_BROWSER_NETWORK: '1' },
    })
  } else {
    manager = new HarnessManager(config, store, logger)
  }
  return { manager, store, root, appDest, close: () => manager.stopAll() }
}

/** Capture the environment the supervisor hands to one Harness instance. */
async function captureEnvironment(fixtureRoot: ManagerFixture): Promise<Record<string, string | null>> {
  const envFile = join(fixtureRoot.root, 'env.json')
  process.env.CAPTURE_ENV = envFile
  try {
    await fixtureRoot.manager.ensure('1000', await fixtureRoot.store.ensure('1000'))
    return JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string | null>
  } finally {
    delete process.env.CAPTURE_ENV
  }
}

test('never takes the PTC launcher path from a shared environment file', async (t) => {
  const created = await createManager(t, {
    sharedEnv: 'DSH_FNOS_PTC_NODE=/tmp/evil-ptc-node\n',
  })
  try {
    const env = await captureEnvironment(created)
    assert.equal(env.DSH_FNOS_PTC_NODE, null)
  } finally {
    await created.close()
  }
})

const runsUnderFnOSNode = await (async (): Promise<boolean> => {
  try {
    const [current, runtime] = await Promise.all([realpath(process.execPath), realpath(FNOS_NODE_APP)])
    return current === runtime
  } catch {
    return false
  }
})()

test('hands the app-local launcher to an installed fnOS Node instance', { skip: !runsUnderFnOSNode }, async (t) => {
  const created = await createManager(t, {
    launcher: true,
    sharedEnv: 'DSH_FNOS_PTC_NODE=/tmp/evil-ptc-node\n',
  })
  try {
    const env = await captureEnvironment(created)
    assert.equal(env.DSH_FNOS_PTC_NODE, join(created.appDest, 'runtime', 'bin', 'dsh-ptc-node'))
  } finally {
    await created.close()
  }
})

test('the browser-live overlay cannot replace the launcher path', { skip: !runsUnderFnOSNode }, async (t) => {
  const created = await createManager(t, { launcher: true, browserLive: true })
  try {
    const env = await captureEnvironment(created)
    assert.equal(env.DSH_FNOS_PTC_NODE, join(created.appDest, 'runtime', 'bin', 'dsh-ptc-node'))
  } finally {
    await created.close()
  }
})
