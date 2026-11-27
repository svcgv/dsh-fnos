import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { AppConfig } from './config.ts'
import type { Logger } from './logger.ts'
import { ensureDir } from './paths.ts'
import { getFreePort } from './ports.ts'
import type { Workspace, WorkspacePaths, WorkspaceStore } from './workspaces.ts'

/** Child process with captured stdout/stderr and no stdin. */
export type HarnessChild = ChildProcessByStdio<null, Readable, Readable>

/** One running Harness instance serving exactly one workspace. */
export interface HarnessInstance {
  readonly key: string
  readonly uid: string
  readonly workspaceName: string
  readonly port: number
  readonly child: HarnessChild
  /** Cookie minted by the Harness startup token and held server-side. */
  cookie: string | undefined
  /** Startup URL carrying the one-time token, kept for re-authentication. */
  tokenUrl: string | undefined
  exited: boolean
}

const TOKEN_URL = /(https?:\/\/\S+[?&]token=[A-Za-z0-9._~%-]+)/u
const LOG_TAIL_LINES = 40

/** The fnOS `nodejs_v26` plugin's Node executable; the FPK manifest requires it. */
export const FNOS_NODE_APP = '/var/apps/nodejs_v26/target/bin/node'

/** App-relative path of the PTC launcher staged beside the bundled libraries. */
const PTC_LAUNCHER = 'runtime/bin/dsh-ptc-node'

/**
 * Resolve the app-local PTC launcher, or `undefined` to keep upstream's default
 * executable.
 *
 * PTC (`run_code`) workers start from a cleared environment, so the bundled
 * `libatomic.so.1` cannot reach them through an inherited `LD_LIBRARY_PATH`.
 * The launcher injects that one library directory before it execs Node. It is
 * only correct when the supervisor runs the same real Node executable the FPK
 * declares, and it only exists inside the installed application tree, so every
 * development or custom-Node launch keeps upstream behavior.
 */
export function resolvePtcLauncher(
  appDest: string,
  executable: string,
  nodeApp: string = FNOS_NODE_APP,
): string | undefined {
  let runtime: string
  let current: string
  try {
    runtime = realpathSync(nodeApp)
    current = realpathSync(executable)
  } catch {
    return undefined
  }
  if (runtime !== current) return undefined
  const launcher = join(appDest, PTC_LAUNCHER)
  try {
    accessSync(launcher, constants.X_OK)
  } catch {
    return undefined
  }
  return launcher
}

/** Error raised when a Harness instance cannot become ready. */
export class HarnessStartError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
    this.name = 'HarnessStartError'
  }
}

/** Read `KEY=VALUE` pairs from the administrator-managed shared environment file. */
export async function readSharedEnv(file: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  const env: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

/** Point a workspace profile at the administrator-managed shared plugin set. */
async function linkSharedProfile(
  config: AppConfig,
  dshHome: string,
  logger: Logger,
): Promise<void> {
  const target = join(config.appDest, 'shared', 'profile', config.harness.profile)
  if (!existsSync(target)) return

  const link = join(dshHome, 'profiles', config.harness.profile)
  if (existsSync(link)) return

  await ensureDir(join(dshHome, 'profiles'))
  try {
    await symlink(target, link, 'dir')
  } catch (error) {
    logger.warn('shared-profile-link-failed', { target, error: String(error) })
  }
}

/** Exchange the startup token for a session cookie. */
async function exchangeToken(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie()
  if (cookies.length === 0) {
    throw new Error(`startup token exchange returned no cookie (status ${response.status})`)
  }
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ')
}

/** Wait until the authenticated root page answers, proving the Host is ready. */
async function waitForReady(port: number, cookie: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { cookie },
    redirect: 'manual',
  })
  if (response.status !== 200) {
    throw new Error(`authenticated root page returned ${response.status}`)
  }
  await response.arrayBuffer()
}

/** Opt-in visible browser panel wiring for exactly one administrator UID. */
export interface BrowserLiveOptions {
  /** The only UID whose Harness child gets the overlay and environment switches. */
  readonly uid: string
  /** Absolute overlay path; missing files make upstream refuse to start. */
  readonly patch: string
  /** Trusted switches the overlay reads; never derived from user input. */
  readonly env: Readonly<Record<string, string>>
}

/** Per-user Harness process supervisor. */
export class HarnessManager {
  readonly #instances = new Map<string, HarnessInstance>()
  readonly #starting = new Map<string, Promise<HarnessInstance>>()

  constructor(
    private readonly config: AppConfig,
    private readonly store: WorkspaceStore,
    private readonly logger: Logger,
    private readonly browserLive?: BrowserLiveOptions,
  ) {}

  /** Return a ready instance, starting one on demand. */
  async ensure(uid: string, workspace: Workspace): Promise<HarnessInstance> {
    const key = uid
    const pending = this.#starting.get(key)
    if (pending !== undefined) return pending

    const running = this.#instances.get(key)
    if (running !== undefined && !running.exited) {
      return running
    }

    const start = this.#start(uid, workspace, key).finally(() => this.#starting.delete(key))
    this.#starting.set(key, start)
    return start
  }

  /** Re-mint the Harness cookie after an upstream 401. */
  async reauthenticate(key: string): Promise<string | undefined> {
    const instance = this.#instances.get(key)
    if (instance === undefined || instance.tokenUrl === undefined) return undefined
    const cookie = await exchangeToken(instance.tokenUrl)
    instance.cookie = cookie
    return cookie
  }

  async stop(uid: string): Promise<void> {
    const key = uid
    const instance = this.#instances.get(key)
    if (instance === undefined) return
    this.#instances.delete(key)
    await this.#terminate(instance)
  }

  async stopAll(): Promise<void> {
    const instances = [...this.#instances.values()]
    this.#instances.clear()
    await Promise.all(instances.map((instance) => this.#terminate(instance)))
  }

  #childEnv(paths: WorkspacePaths, sharedEnv: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      // The gateway API token must never reach model-driven commands.
      if (name.startsWith('TRIM_')) continue
      env[name] = value
    }
    return {
      ...env,
      ...sharedEnv,
      // The fnOS service account may use nologin; give Harness an interactive shell.
      SHELL: sharedEnv.SHELL || '/bin/bash',
      DSH_HOME: paths.dshHome,
      DSH_AGENTS_HOME: paths.agentsHome,
      HOME: paths.home,
      TMPDIR: paths.tmp,
      PWD: paths.workspace,
      DSH_FNOS_WORKSPACE_DOCUMENTS: paths.root,
    }
  }

  async #start(uid: string, workspace: Workspace, key: string): Promise<HarnessInstance> {
    const logger = this.logger.child({ uid, workspace: workspace.name })
    const paths = this.store.paths(uid)
    await Promise.all([
      ensureDir(paths.workspace),
      ensureDir(paths.dshHome),
      ensureDir(paths.agentsHome),
      ensureDir(paths.home),
      ensureDir(paths.tmp),
    ])
    await linkSharedProfile(this.config, paths.dshHome, logger)

    const sharedEnv = await readSharedEnv(join(this.config.pkgEtc, 'shared.env'))
    const port = await getFreePort()
    // The visible browser panel is an overlay, never a profile edit: only the
    // explicitly allowed UID receives it, and only while the host passes the
    // trusted switches the overlay checks.
    const wanted = this.browserLive?.uid === uid ? this.browserLive : undefined
    // A missing overlay must degrade to the normal instance, never block the user's GUI.
    const browserLive = wanted !== undefined && existsSync(wanted.patch) ? wanted : undefined
    if (wanted !== undefined && browserLive === undefined) {
      logger.warn('browser-live-overlay-missing', { patch: wanted.patch })
    }
    const workspacePatch = join(this.config.appDest, 'harness', 'workspace.patch.yml')
    if (!existsSync(workspacePatch)) logger.warn('workspace-overlay-missing', { patch: workspacePatch })
    const patches = [
      ...(existsSync(workspacePatch) ? ['--patch', workspacePatch] : []),
      ...(browserLive === undefined ? [] : ['--patch', browserLive.patch]),
    ]
    // Launcher-owned flags must precede the app CLI arguments. In particular,
    // --patch is parsed by `dsh`; placing it after --no-open forwards it to the
    // web app and fails startup with "unknown option '--patch'".
    const args = [
      this.config.harness.entry,
      '--profile',
      this.config.harness.profile,
      ...patches,
      '--no-open',
      '--port',
      String(port),
      ...this.config.harness.extraArgs,
    ]

    // The launcher path is a supervisor-owned internal fact: an environment file
    // or an optional overlay may never redirect which executable PTC starts.
    // The workspace overlay reads it to set `ptc-runtime.launch.executable`.
    const childEnv: NodeJS.ProcessEnv = {
      ...this.#childEnv(paths, sharedEnv),
      ...browserLive?.env,
    }
    delete childEnv.DSH_FNOS_PTC_NODE
    const ptcLauncher = resolvePtcLauncher(this.config.appDest, this.config.harness.executable)
    if (ptcLauncher !== undefined) childEnv.DSH_FNOS_PTC_NODE = ptcLauncher

    logger.info('harness-spawn', {
      port,
      entry: this.config.harness.entry,
      browserLive: browserLive !== undefined,
      ptcLauncherEnabled: ptcLauncher !== undefined,
    })
    const child = spawn(this.config.harness.executable, args, {
      cwd: paths.workspace,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const tail: string[] = []
    const remember = (line: string): void => {
      tail.push(line)
      if (tail.length > LOG_TAIL_LINES) tail.shift()
    }

    const instance: HarnessInstance = {
      key,
      uid,
      workspaceName: workspace.name,
      port,
      child,
      cookie: undefined,
      tokenUrl: undefined,
      exited: false,
    }
    this.#instances.set(key, instance)

    child.on('exit', (code, signal) => {
      instance.exited = true
      if (this.#instances.get(key) === instance) this.#instances.delete(key)
      logger.info('harness-exit', { code, signal })
    })

    const token = this.#watchForToken(child, remember)
    child.stdout.on('data', (chunk: Buffer) => logger.debug('harness-stdout', { line: chunk.toString().trimEnd() }))
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trimEnd()
      remember(line)
      logger.warn('harness-stderr', { line })
    })

    try {
      const tokenUrl = await token
      instance.tokenUrl = tokenUrl
      instance.cookie = await exchangeToken(tokenUrl)
      await waitForReady(port, instance.cookie)
      logger.info('harness-ready', { port })
      return instance
    } catch (error) {
      this.#instances.delete(key)
      await this.#terminate(instance)
      throw new HarnessStartError(
        'DeepSeek Harness 启动失败',
        `${String(error)}\n${tail.join('\n')}`,
      )
    }
  }

  #watchForToken(child: HarnessChild, remember: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('timed out waiting for the startup token'))
      }, this.config.startTimeoutMs)
      timer.unref()

      const finish = (url: string): void => {
        cleanup()
        resolve(url)
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          remember(line)
          const match = TOKEN_URL.exec(line)
          if (match !== null && match[1] !== undefined) {
            finish(match[1])
            return
          }
          newline = buffer.indexOf('\n')
        }
        if (buffer.length > 64 * 1024) buffer = buffer.slice(-4096)
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`harness exited before printing a startup URL (code ${String(code)})`))
      }

      child.stdout.on('data', onData)
      child.once('exit', onExit)
    })
  }

  async #terminate(instance: HarnessInstance): Promise<void> {
    if (instance.exited) return
    const child = instance.child
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    timer.unref()
    await exited
    clearTimeout(timer)
  }
}
