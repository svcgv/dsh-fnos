import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { HarnessManager } from './harness.ts'
import { createLogger } from './logger.ts'
import { ensureDir } from './paths.ts'
import { ProjectStore } from './projects.ts'
import { createHandler, createUpgradeHandler } from './server.ts'

const logger = createLogger({ app: 'dsh-fnos' })
const config = loadConfig(process.env, process.cwd())

await Promise.all([ensureDir(config.pkgHome), ensureDir(config.pkgVar), ensureDir(config.pkgEtc)])

const store = new ProjectStore({
  homeRoot: config.pkgHome,
  varRoot: config.pkgVar,
  maxProjectsPerUser: 50,
})
const harness = new HarnessManager(config, store, logger)

const server = createServer(createHandler({ config, store, harness, logger }))
server.on('upgrade', createUpgradeHandler({ config, store, harness, logger }))

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
  await harness.stopAll()
  if (config.listenPort === undefined) {
    await unlink(config.socketPath).catch(() => undefined)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
