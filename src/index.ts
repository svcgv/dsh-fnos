import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readBrowserAcceptanceOptIn } from './browser-acceptance-optin.ts'
import { loadConfig } from './config.ts'
import { ExperimentalBrowserAcceptance } from './experimental-browser-harness.ts'
import { HarnessManager } from './harness.ts'
import { createLogger } from './logger.ts'
import { ensureDir } from './paths.ts'
import { createHandler, createUpgradeHandler } from './server.ts'
import { WorkspaceStore } from './workspaces.ts'

const logger = createLogger({ app: 'dsh-fnos' })
const config = loadConfig(process.env, process.cwd())

await Promise.all([ensureDir(config.pkgHome), ensureDir(config.pkgVar), ensureDir(config.pkgEtc)])

const store = new WorkspaceStore({ homeRoot: config.pkgHome })

// The experimental browser features stay off unless an administrator created the
// marker files in the app data directory. They are a manual acceptance aid for
// one trusted administrator, never a tenant boundary.
const optIn = await readBrowserAcceptanceOptIn(config.pkgVar)
const harness = new HarnessManager(config, store, logger, optIn.enabled
  ? {
      uid: optIn.uid,
      patch: join(config.appDest, 'harness', 'browser-plugin', 'live.patch.yml'),
      env: { DSH_FNOS_BROWSER_LIVE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' },
    }
  : undefined)
let acceptance: ExperimentalBrowserAcceptance | undefined
if (optIn.enabled) {
  process.env.DSH_FNOS_BROWSER_ACCEPTANCE = '1'
  acceptance = new ExperimentalBrowserAcceptance({
    appHome: config.pkgHome,
    appDest: config.appDest,
    enabled: true,
    uid: optIn.uid,
  })
  logger.info('browser-acceptance-enabled', { uid: optIn.uid, livePanel: true })
} else if (optIn.reason !== 'not-configured') {
  logger.warn('browser-acceptance-disabled', { reason: optIn.reason })
}

const deps = acceptance === undefined
  ? { config, store, harness, logger }
  : { config, store, harness, logger, acceptance }

const server = createServer(createHandler(deps))
server.on('upgrade', createUpgradeHandler(deps))

async function listen(): Promise<void> {
  if (config.listenPort !== undefined) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.listenPort, '127.0.0.1', () => resolve())
    })
    logger.info('listening', { transport: 'tcp', port: config.listenPort })
    return
  }

  await ensureDir(dirname(config.socketPath))
  try {
    await unlink(config.socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.socketPath, () => resolve())
  })
  await chmod(config.socketPath, 0o660)
  logger.info('listening', { transport: 'unix', socket: config.socketPath })
}

await listen()

const reaper = setInterval(() => {
  void harness.reapIdle().catch((error: unknown) => {
    logger.warn('idle-reap-failed', { error: error instanceof Error ? error.message : String(error) })
  })
}, 60_000)
reaper.unref()

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('shutdown', { signal })
  clearInterval(reaper)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await acceptance?.stopAll()
  await harness.stopAll()
  if (config.listenPort === undefined) {
    await unlink(config.socketPath).catch(() => undefined)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
