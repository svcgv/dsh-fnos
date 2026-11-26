import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../src/config.ts'
import { HarnessManager } from '../src/harness.ts'
import { createLogger } from '../src/logger.ts'
import { WorkspaceStore } from '../src/workspaces.ts'

const fixture = fileURLToPath(new URL('./fixtures/capture-harness.mjs', import.meta.url))

async function createManager(options: { withOverlay?: boolean } = {}): Promise<{
  manager: HarnessManager
  store: WorkspaceStore
  root: string
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fnos-live-'))
  const appDest = join(root, 'app')
  const pkgEtc = join(root, 'etc')
  const pkgHome = join(root, 'home')
  await mkdir(appDest, { recursive: true })
  await mkdir(pkgEtc, { recursive: true })

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
    idleStopMs: 60_000,
    startTimeoutMs: 20_000,
  }

  const logger = createLogger({ test: 'harness-browser-live' })
  const store = new WorkspaceStore({ homeRoot: pkgHome })
  const patch = join(appDest, 'harness', 'browser-plugin', 'live.patch.yml')
  const workspacePatch = join(appDest, 'harness', 'workspace.patch.yml')
  await mkdir(join(appDest, 'harness', 'browser-plugin'), { recursive: true })
  await writeFile(workspacePatch, '# fixed workspace overlay\n')
  if (options.withOverlay !== false) {
    await writeFile(patch, '# test overlay\n')
  }
  const manager = new HarnessManager(config, store, logger, {
    uid: '1000',
    patch,
    env: { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' },
  })
  return { manager, store, root, close: () => manager.stopAll() }
}

test('only the opted-in uid receives the browser panel overlay and switches', { timeout: 60_000 }, async () => {
  const { manager, store, root, close } = await createManager()
  try {
    const argv1000 = join(root, 'argv-1000.json')
    const env1000 = join(root, 'env-1000.json')
    process.env.CAPTURE_ARGV = argv1000
    process.env.CAPTURE_ENV = env1000
    await manager.ensure('1000', await store.ensure('1000'))
    const allowed = JSON.parse(await readFile(argv1000, 'utf8')) as string[]
    const workspacePatch = join(root, 'app', 'harness', 'workspace.patch.yml')
    const browserPatch = join(root, 'app', 'harness', 'browser-plugin', 'live.patch.yml')
    assert.deepEqual(allowed.slice(2, 6), ['--patch', workspacePatch, '--patch', browserPatch])
    assert.ok(allowed.lastIndexOf('--patch') < allowed.indexOf('--no-open'), 'launcher-owned --patch must precede web app flags')
    assert.deepEqual(JSON.parse(await readFile(env1000, 'utf8')), {
      DSH_FNOS_BROWSER_LIVE: '1',
      DSH_FNOS_ACCEPTANCE_FIXTURE: '1',
      DSH_FNOS_WORKSPACE_DOCUMENTS: join(root, 'home', 'users', '1000', 'harness'),
      TMPDIR: join(root, 'home', 'users', '1000', 'harness', 'tmp'),
    })

    const argv2000 = join(root, 'argv-2000.json')
    const env2000 = join(root, 'env-2000.json')
    process.env.CAPTURE_ARGV = argv2000
    process.env.CAPTURE_ENV = env2000
    await manager.ensure('2000', await store.ensure('2000'))
    const normal = JSON.parse(await readFile(argv2000, 'utf8')) as string[]
    assert.deepEqual(normal.slice(2, 4), ['--patch', workspacePatch])
    assert.equal(normal.includes(browserPatch), false)
    assert.deepEqual(JSON.parse(await readFile(env2000, 'utf8')), {
      DSH_FNOS_BROWSER_LIVE: null,
      DSH_FNOS_ACCEPTANCE_FIXTURE: null,
      DSH_FNOS_WORKSPACE_DOCUMENTS: join(root, 'home', 'users', '2000', 'harness'),
      TMPDIR: join(root, 'home', 'users', '2000', 'harness', 'tmp'),
    })
  } finally {
    delete process.env.CAPTURE_ARGV
    delete process.env.CAPTURE_ENV
    await close()
  }
})

test('a missing overlay degrades to the normal instance instead of failing startup', { timeout: 60_000 }, async () => {
  const { manager, store, root, close } = await createManager({ withOverlay: false })
  try {
    const argv = join(root, 'argv-no-overlay.json')
    const env = join(root, 'env-no-overlay.json')
    process.env.CAPTURE_ARGV = argv
    process.env.CAPTURE_ENV = env
    await manager.ensure('1000', await store.ensure('1000'))
    const normal = JSON.parse(await readFile(argv, 'utf8')) as string[]
    assert.deepEqual(normal.slice(2, 4), ['--patch', join(root, 'app', 'harness', 'workspace.patch.yml')])
    assert.deepEqual(JSON.parse(await readFile(env, 'utf8')), {
      DSH_FNOS_BROWSER_LIVE: null,
      DSH_FNOS_ACCEPTANCE_FIXTURE: null,
      DSH_FNOS_WORKSPACE_DOCUMENTS: join(root, 'home', 'users', '1000', 'harness'),
      TMPDIR: join(root, 'home', 'users', '1000', 'harness', 'tmp'),
    })
  } finally {
    delete process.env.CAPTURE_ARGV
    delete process.env.CAPTURE_ENV
    await close()
  }
})
