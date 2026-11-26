import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { constants } from 'node:fs'
import { get as httpGet } from 'node:http'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { Identity } from './identity.ts'
import { getFreePort } from './ports.ts'

/**
 * TEST-ONLY lifecycle scaffold. This module has no production process launcher,
 * HTTP authentication, network sandbox, port allocator or server route. It must
 * not be wired to a real Harness until those boundaries are independently built
 * and verified. The injected backend is a test double, not a security boundary.
 */
export interface ExperimentalHarnessMockProcess {
  /** Settles when the mock leader exits; stop still confirms all descendants. */
  readonly exited: Promise<void>
  ready(signal: AbortSignal): Promise<{ readonly port: number; readonly authenticated: boolean }>
  /** Resolves only when this process and everything it owns are confirmed gone. */
  stop(): Promise<void>
}

export interface ExperimentalHarnessMockSpec {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly port: number
}

/** No implementation of this test seam is supplied by production code. */
export interface ExperimentalHarnessMockBackend {
  readonly kind: 'mock-only'
  allocatePort(): number
  launch(spec: ExperimentalHarnessMockSpec): ExperimentalHarnessMockProcess
}

export interface ExperimentalHarnessTestOptions {
  /** Trusted application-owned directories, never derived from a request. */
  readonly appHome: string
  readonly appDest: string
  readonly enabled?: boolean
  readonly allowUid?: string
  readonly backend?: ExperimentalHarnessMockBackend
  readonly timeoutMs?: number
}

export interface ExperimentalHarnessTestHandle {
  readonly uid: string
  /** Mock-only port. Not authenticated or suitable for a production proxy. */
  readonly port: number
}

interface Entry {
  readonly uid: string
  readonly cancel: AbortController
  start: Promise<ExperimentalHarnessTestHandle> | undefined
  cleanup: Promise<void> | undefined
  base: string | undefined
  root: string | undefined
  baseIdentity: { dev: number; ino: number } | undefined
  rootIdentity: { dev: number; ino: number } | undefined
  child: ExperimentalHarnessMockProcess | undefined
}

const UID = /^[1-9][0-9]{0,9}$/u
const TIMEOUT = 5_000
const CANCELLED = 'experimental browser test cancelled'

function identityAllowed(identity: Identity, enabled: boolean, allowUid: string | undefined): boolean {
  return enabled && identity.isAdmin && UID.test(identity.uid) && identity.uid === allowUid
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(CANCELLED)
}

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolvePromise, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error(CANCELLED)) }
    const cleanup = (): void => { signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    operation.then(value => { cleanup(); resolvePromise(value) }, error => { cleanup(); reject(error) })
  })
}

async function checkedDirectory(path: string, expected?: { dev: number; ino: number }): Promise<{ dev: number; ino: number }> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error('experimental temporary directory is not private and owned')
  }
  if (await realpath(path) !== path || (expected !== undefined && (expected.dev !== info.dev || expected.ino !== info.ino))) {
    throw new Error('experimental temporary directory identity changed')
  }
  return { dev: info.dev, ino: info.ino }
}

async function checkedFileInside(base: string, ...parts: string[]): Promise<string> {
  const file = join(base, ...parts)
  const info = await lstat(file)
  const canonical = await realpath(file)
  if (!info.isFile() || info.isSymbolicLink() || canonical !== file || !canonical.startsWith(base + sep)) {
    throw new Error('experimental fixed application file is unavailable or unsafe')
  }
  return file
}

/**
 * One test instance globally; concurrent starts fail rather than sharing caller
 * cancellation or a port. All options are trusted host wiring, not request data.
 */
export class ExperimentalBrowserHarnessTestManager {
  readonly #options: ExperimentalHarnessTestOptions
  #entry: Entry | undefined

  constructor(options: ExperimentalHarnessTestOptions) { this.#options = options }

  async start(identity: Identity, signal?: AbortSignal): Promise<ExperimentalHarnessTestHandle> {
    if (!identityAllowed(identity, this.#options.enabled === true, this.#options.allowUid)) throw new Error('experimental browser test is not authorized')
    if (this.#options.backend?.kind !== 'mock-only') throw new Error('experimental browser test backend unavailable; real launch is disabled')
    if (this.#entry !== undefined) throw new Error('experimental browser test is already active or cleanup is unresolved')
    if (signal?.aborted === true) throwIfAborted(signal)
    const entry: Entry = { uid: identity.uid, cancel: new AbortController(), start: undefined, cleanup: undefined, base: undefined, root: undefined, baseIdentity: undefined, rootIdentity: undefined, child: undefined }
    this.#entry = entry
    const combined = AbortSignal.any([entry.cancel.signal, ...(signal === undefined ? [] : [signal])])
    entry.start = this.#start(entry, combined)
    return entry.start
  }

  async stop(identity: Identity): Promise<void> {
    if (!identityAllowed(identity, this.#options.enabled === true, this.#options.allowUid)) throw new Error('experimental browser test is not authorized')
    const entry = this.#entry
    if (entry === undefined) return
    if (identity.uid !== entry.uid) throw new Error('experimental browser test is not owned by this user')
    entry.cancel.abort(new Error(CANCELLED))
    if (entry.start !== undefined) {
      try { await entry.start } catch { /* cleanup failure is returned below */ }
    }
    await this.#cleanup(entry)
  }

  async #start(entry: Entry, caller: AbortSignal): Promise<ExperimentalHarnessTestHandle> {
    try {
      const timeout = this.#options.timeoutMs ?? TIMEOUT
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('invalid experimental test timeout')
      const signal = AbortSignal.any([caller, AbortSignal.timeout(timeout)])
      throwIfAborted(signal)
      const appHome = await realpath(resolve(this.#options.appHome))
      const appDest = await realpath(resolve(this.#options.appDest))
      const cli = await checkedFileInside(appDest, 'harness', 'entry.js')
      const overlay = await checkedFileInside(appDest, 'harness', 'browser-plugin', 'acceptance.patch.yml')
      throwIfAborted(signal)
      const base = join(appHome, 'experimental-browser-tmp')
      await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      entry.base = base
      entry.baseIdentity = await checkedDirectory(base)
      throwIfAborted(signal)
      entry.root = await mkdtemp(join(base, 'instance-'))
      entry.rootIdentity = await checkedDirectory(entry.root)
      throwIfAborted(signal)
      const home = join(entry.root, 'home'), dshHome = join(entry.root, 'dsh-home')
      const agents = join(entry.root, 'agents-home'), tmp = join(entry.root, 'tmp'), cwd = join(entry.root, 'workspace')
      for (const path of [home, dshHome, agents, tmp, cwd]) { await mkdir(path, { mode: 0o700 }); throwIfAborted(signal) }
      const backend = this.#options.backend
      if (backend === undefined) throw new Error('mock backend unavailable')
      const port = backend.allocatePort()
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('invalid mock loopback port')
      const env = Object.freeze({ HOME: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: agents, TMPDIR: tmp, PWD: cwd, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT: '1' })
      const args = Object.freeze([cli, '--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)])
      throwIfAborted(signal)
      entry.child = backend.launch(Object.freeze({ executable: process.execPath, args, cwd, env, port }))
      const child = entry.child
      // An unexpected leader exit invalidates readiness and triggers the same
      // confirmed-stop path. Rejected cleanup remains in entry.cleanup and
      // keeps this manager closed to new starts; stop() reports that failure.
      void child.exited.then(
        () => this.#handleExit(entry),
        () => this.#handleExit(entry),
      ).catch(() => {})
      const ready = await waitFor(child.ready(signal), signal)
      if (ready.port !== port || ready.authenticated !== true) throw new Error('mock authentication or loopback readiness failed')
      throwIfAborted(signal)
      return Object.freeze({ uid: entry.uid, port })
    } catch (error) {
      try { await this.#cleanup(entry) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'experimental test startup and cleanup failed') }
      throw error
    }
  }

  async #handleExit(entry: Entry): Promise<void> {
    if (this.#entry !== entry || entry.cleanup !== undefined) return
    entry.cancel.abort(new Error('experimental mock process exited'))
    await this.#cleanup(entry)
  }

  #cleanup(entry: Entry): Promise<void> {
    if (entry.cleanup !== undefined) return entry.cleanup
    entry.cleanup = (async () => {
      if (entry.child !== undefined) {
        const timeout = this.#options.timeoutMs ?? TIMEOUT
        await waitFor(entry.child.stop(), AbortSignal.timeout(timeout))
      }
      if (entry.root !== undefined) {
        if (entry.base === undefined || entry.baseIdentity === undefined || entry.rootIdentity === undefined
          || dirname(entry.root) !== entry.base || !/^instance-[A-Za-z0-9]{6}$/u.test(basename(entry.root))) throw new Error('experimental cleanup target is invalid')
        await checkedDirectory(entry.base, entry.baseIdentity)
        await checkedDirectory(entry.root, entry.rootIdentity)
        await rm(entry.root, { recursive: true })
      }
      if (this.#entry === entry) this.#entry = undefined
    })()
    return entry.cleanup
  }
}

/**
 * Disposable acceptance server, NOT a security sandbox. Standard Web tools run
 * with the application's host privileges. Only trusted administrators may use
 * this during a short acceptance window. A process group cannot contain setsid
 * descendants, so every private run directory is retained for manual review.
 */
export interface BrowserAcceptanceOptions {
  readonly appHome: string
  readonly appDest: string
  readonly uid: string
  /** Host-owned explicit switch; callers must also set the process env switch. */
  readonly enabled?: boolean
  readonly timeoutMs?: number
}
export interface BrowserAcceptanceSession {
  readonly port: number
  readonly cookie: string | undefined
  reauthenticate(): Promise<string | undefined>
}
type AcceptanceChild = ChildProcessByStdio<null, Readable, Readable>
interface AcceptanceEntry {
  readonly uid: string
  readonly cancel: AbortController
  readonly startedAt: string
  start?: Promise<BrowserAcceptanceSession>
  stop?: Promise<void>
  base?: string
  root?: string
  baseIdentity?: { dev: number; ino: number }
  rootIdentity?: { dev: number; ino: number }
  port?: number
  child?: AcceptanceChild
  exit?: Promise<void>
  exited: boolean
  startupFailed?: boolean
  tokenUrl?: string | undefined
  cookie?: string | undefined
  state: 'starting' | 'ready' | 'stopping' | 'blocked'
}

const FIXTURE_UNVERIFIED = 'private fixed-page browser plugin not verified; real acceptance launch disabled'
const UNPROVEN = 'Process groups do not contain setsid descendants; full process-tree cleanup is unproven. Review running processes before manually deleting this directory.'

/** Intentionally never includes token, cookies, child output, environment or paths inside a secret. */
async function acceptanceManifest(entry: AcceptanceEntry, state: string): Promise<void> {
  if (entry.root === undefined) return
  if (entry.base === undefined || entry.baseIdentity === undefined || entry.rootIdentity === undefined
    || dirname(entry.root) !== entry.base || !/^instance-[A-Za-z0-9]{6}$/u.test(basename(entry.root))) throw new Error('invalid retained acceptance directory')
  await checkedDirectory(entry.base, entry.baseIdentity)
  await checkedDirectory(entry.root, entry.rootIdentity)
  const handle = await open(join(entry.root, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error('invalid acceptance manifest')
    await handle.writeFile(JSON.stringify({ runId: basename(entry.root), uid: entry.uid, startedAt: entry.startedAt, updatedAt: new Date().toISOString(), state, unproven: UNPROVEN }, null, 2) + '\n')
  } finally { await handle.close() }
}

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}
async function waitGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (groupExists(pgid)) {
    if (Date.now() >= until) return false
    await new Promise(resolvePromise => setTimeout(resolvePromise, 40))
  }
  return true
}
async function portReleased(port: number): Promise<void> {
  const { createServer } = await import('node:net')
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('acceptance loopback port remains in use')))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(new Error('failed to confirm port release')) : resolvePromise()))
  })
}
function tokenFromOutput(child: AcceptanceChild, port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let pending = '', settled = false
    const done = (error?: Error, url?: string): void => {
      if (settled) return
      settled = true
      child.stdout.off('data', data); child.off('error', failed); child.off('exit', exited); signal.removeEventListener('abort', cancelled)
      // Drain output but never log it: it contains the startup token.
      child.stdout.resume()
      if (error !== undefined) reject(error); else resolvePromise(url!)
    }
    const failed = (): void => done(new Error('acceptance process failed before readiness'))
    const exited = (): void => done(new Error('acceptance process exited before readiness'))
    const cancelled = (): void => done(new Error('acceptance startup cancelled or timed out'))
    const data = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      if (pending.length > 65536) { done(new Error('acceptance output exceeded limit')); return }
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1)
        const prefix = `dsh web: http://127.0.0.1:${port}/?token=`
        if (line.startsWith(prefix)) {
          const token = line.slice(prefix.length)
          if (!/^[A-Za-z0-9._~%-]{16,512}$/u.test(token)) { done(new Error('invalid acceptance startup token')); return }
          done(undefined, `http://127.0.0.1:${port}/?token=${token}`); return
        }
        newline = pending.indexOf('\n')
      }
    }
    child.stdout.on('data', data); child.once('error', failed); child.once('exit', exited); signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
  })
}
async function directLoopback(url: string, signal: AbortSignal, cookie?: string): Promise<{ status: number; cookies: string[] }> {
  const address = new URL(url)
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port) throw new Error('invalid acceptance loopback address')
  // Use a dedicated direct HTTP connection, never global fetch/proxy settings.
  return new Promise((resolvePromise, reject) => {
    const req = httpGet(address, { agent: false, signal, ...(cookie === undefined ? {} : { headers: { cookie } }) }, response => {
      response.resume()
      response.once('end', () => resolvePromise({ status: response.statusCode ?? 0, cookies: response.headers['set-cookie'] ?? [] }))
      response.once('error', () => reject(new Error('acceptance loopback response failed')))
    })
    req.once('error', () => reject(new Error('acceptance loopback request failed')))
  })
}
async function acceptanceCookie(url: string, signal: AbortSignal): Promise<string> {
  let response: Awaited<ReturnType<typeof directLoopback>>
  try { response = await directLoopback(url, signal) }
  catch { throw new Error('acceptance token exchange failed') }
  if (response.cookies.length === 0) throw new Error(`acceptance token exchange returned no cookie (status ${response.status})`)
  return response.cookies.map(cookie => cookie.split(';', 1)[0]).join('; ')
}

/** Single per-process acceptance lease, wired only by an explicitly opted-in host. */
export class ExperimentalBrowserAcceptance {
  readonly uid: string
  readonly #options: BrowserAcceptanceOptions
  #entry: AcceptanceEntry | undefined
  constructor(options: BrowserAcceptanceOptions) { this.#options = options; this.uid = options.uid }
  #authorize(identity: Identity): void {
    if (!identityAllowed(identity, this.#options.enabled === true && process.env.DSH_FNOS_BROWSER_ACCEPTANCE === '1', this.uid)) throw new Error('acceptance experiment not authorized')
  }
  async open(identity: Identity, signal?: AbortSignal): Promise<BrowserAcceptanceSession> {
    this.#authorize(identity)
    if (signal?.aborted) throwIfAborted(signal)
    const existing = this.#entry
    if (existing !== undefined) {
      if (existing.state === 'stopping' || existing.state === 'blocked' || existing.start === undefined) throw new Error('acceptance instance is stopping or blocked')
      return signal === undefined ? existing.start : waitFor(existing.start, signal)
    }
    const entry: AcceptanceEntry = { uid: identity.uid, cancel: new AbortController(), startedAt: new Date().toISOString(), exited: false, state: 'starting' }
    this.#entry = entry
    const combined = AbortSignal.any([entry.cancel.signal, ...(signal === undefined ? [] : [signal])])
    entry.start = this.#startReal(entry, combined)
    return entry.start
  }
  async close(identity: Identity): Promise<void> {
    this.#authorize(identity)
    const entry = this.#entry
    if (entry === undefined) return
    entry.cancel.abort(new Error('acceptance stopped'))
    try { await entry.start } catch { /* stop reports cleanup failure below */ }
    await this.#stopReal(entry)
  }
  /** Best-effort shutdown hook; failures remain recorded as blocked/retained. */
  async stopAll(): Promise<void> {
    const entry = this.#entry
    if (entry === undefined) return
    entry.cancel.abort(new Error('acceptance supervisor stopping'))
    try { await entry.start } catch { /* shutdown continues below */ }
    try { await this.#stopReal(entry) } catch { /* manifest retains failed state */ }
  }
  async #startReal(entry: AcceptanceEntry, caller: AbortSignal): Promise<BrowserAcceptanceSession> {
    try {
      const timeout = this.#options.timeoutMs ?? 30_000
      if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) throw new Error('invalid acceptance timeout')
      const signal = AbortSignal.any([caller, AbortSignal.timeout(timeout)])
      throwIfAborted(signal)
      const appHome = await realpath(resolve(this.#options.appHome))
      const appDest = await realpath(resolve(this.#options.appDest))
      const cli = await checkedFileInside(appDest, 'harness', 'entry.js')
      const overlay = await checkedFileInside(appDest, 'harness', 'browser-plugin', 'acceptance.patch.yml')
      // This marker is installed only after the separately-owned fixed-page
      // plugin is checked. It is an integration guard, not a security boundary.
      if (!(await readFile(overlay, 'utf8')).includes('# fixed-private-fixture-reviewed-v1')) throw new Error(FIXTURE_UNVERIFIED)
      throwIfAborted(signal)
      const base = join(appHome, 'experimental-browser-tmp')
      await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      entry.base = base; entry.baseIdentity = await checkedDirectory(base)
      throwIfAborted(signal)
      entry.root = await mkdtemp(join(base, 'instance-')); entry.rootIdentity = await checkedDirectory(entry.root)
      await acceptanceManifest(entry, 'starting')
      const home = join(entry.root, 'home'), dshHome = join(entry.root, 'dsh-home')
      const agents = join(entry.root, 'agents-home'), tmp = join(entry.root, 'tmp'), cwd = join(entry.root, 'workspace')
      for (const path of [home, dshHome, agents, tmp, cwd]) { await mkdir(path, { mode: 0o700 }); throwIfAborted(signal) }
      const port = await waitFor(getFreePort(), signal)
      if (port < 1024 || port > 65535) throw new Error('invalid acceptance loopback port')
      entry.port = port
      const env = {
        HOME: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: agents, TMPDIR: tmp, PWD: cwd,
        PATH: `${join(appDest, 'runtime', 'bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8',
        LD_LIBRARY_PATH: join(appDest, 'runtime', 'lib'),
        DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1',
      }
      const args = [cli, '--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)]
      throwIfAborted(signal)
      const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      entry.child = child
      child.stderr.resume() // Do not log potentially sensitive user content.
      entry.exit = new Promise(resolvePromise => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true; entry.exited = true; resolvePromise()
          if (entry.state === 'starting' || entry.state === 'ready') {
            entry.cancel.abort(new Error('acceptance process exited'))
            if (entry.state === 'ready') void this.#stopReal(entry).catch(() => {})
          }
        }
        child.once('error', finish); child.once('exit', finish)
      })
      const tokenUrl = await tokenFromOutput(child, port, signal)
      throwIfAborted(signal)
      const cookie = await acceptanceCookie(tokenUrl, signal)
      let ready: Awaited<ReturnType<typeof directLoopback>>
      try { ready = await directLoopback(`http://127.0.0.1:${port}/`, signal, cookie) }
      catch { throw new Error('acceptance authenticated readiness failed') }
      if (ready.status !== 200) throw new Error('acceptance authenticated readiness failed')
      throwIfAborted(signal)
      entry.tokenUrl = tokenUrl; entry.cookie = cookie; entry.state = 'ready'
      await acceptanceManifest(entry, 'ready')
      const manager = this
      return Object.freeze({
        port,
        get cookie() { return entry.cookie },
        async reauthenticate() {
          if (manager.#entry !== entry || entry.state !== 'ready' || entry.tokenUrl === undefined) return undefined
          const next = await acceptanceCookie(entry.tokenUrl, AbortSignal.timeout(5000))
          if (manager.#entry !== entry || entry.state !== 'ready') return undefined
          entry.cookie = next
          return next
        },
      })
    } catch (error) {
      entry.startupFailed = true
      try { await this.#stopReal(entry) } catch (failure) { throw new AggregateError([error, failure], 'acceptance startup and shutdown failed') }
      throw error
    }
  }
  #stopReal(entry: AcceptanceEntry): Promise<void> {
    if (entry.stop !== undefined) return entry.stop
    entry.stop = (async () => {
      entry.state = 'stopping'
      try {
        const child = entry.child
        let forced = false
        if (child !== undefined && child.pid !== undefined) {
          const pgid = child.pid
          if (!entry.exited) child.kill('SIGTERM')
          if (!await waitGroupGone(pgid, 8000)) { signalGroup(pgid, 'SIGTERM'); if (!await waitGroupGone(pgid, 2000)) { forced = true; signalGroup(pgid, 'SIGKILL'); if (!await waitGroupGone(pgid, 2000)) throw new Error('acceptance process group did not exit') } }
          await entry.exit
        }
        if (entry.port !== undefined) await portReleased(entry.port)
        entry.cookie = undefined; entry.tokenUrl = undefined
        await acceptanceManifest(entry, `${entry.startupFailed === true ? 'startup-failed-' : ''}${forced ? 'stopped-forced-group-only' : 'stopped-group-only'}`)
        if (this.#entry === entry) this.#entry = undefined
      } catch (error) {
        entry.state = 'blocked'; entry.cookie = undefined; entry.tokenUrl = undefined
        await acceptanceManifest(entry, 'stop-failed-group-or-port-unverified').catch(() => {})
        throw error
      }
    })()
    return entry.stop
  }
}
