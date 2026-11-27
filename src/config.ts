import { join, resolve } from 'node:path'

/** Harness launch facts resolved once at process start. */
export interface HarnessConfig {
  /** Absolute path to the harness launcher JavaScript file. */
  readonly entry: string
  /** Node executable used for the harness process. */
  readonly executable: string
  /** `dsh` profile to boot. */
  readonly profile: string
  /** Extra arguments appended after the built-in web arguments. */
  readonly extraArgs: readonly string[]
}

/** Deployment configuration sourced from fnOS environment variables. */
export interface AppConfig {
  readonly appName: string
  /** Installed application directory (`TRIM_APPDEST`). */
  readonly appDest: string
  /** Administrator-owned configuration (`TRIM_PKGETC`). */
  readonly pkgEtc: string
  /** Non-per-user runtime data (`TRIM_PKGVAR`). */
  readonly pkgVar: string
  /** Per-user application data root (`TRIM_PKGHOME`). */
  readonly pkgHome: string
  /** Unified gateway Unix socket published for fnOS. */
  readonly socketPath: string
  /** Development-only TCP listener; the packaged app uses the socket. */
  readonly listenPort: number | undefined
  readonly harness: HarnessConfig
  /** Development-only identity used when the gateway header is absent. */
  readonly devUid: string | undefined
  readonly startTimeoutMs: number
}

export type Env = Record<string, string | undefined>

const DEFAULT_START_TIMEOUT_MS = 120 * 1000

/** Read a positive integer override, rejecting malformed values loudly. */
function readPositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`)
  }
  return value
}

/** Resolve the fnOS nodejs_v26 executable, falling back to the supervisor process. */
function resolveNodeExecutable(_appDest: string, env: Env): string {
  const configured = env.DSH_FNOS_NODE
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return process.execPath
}

/** Resolve the harness entry file, preferring an explicit development override. */
function resolveHarnessEntry(appDest: string, env: Env): string {
  const configured = env.DSH_FNOS_HARNESS_ENTRY
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(appDest, 'harness', 'entry.js')
}

/** Build the deployment configuration from the process environment. */
export function loadConfig(env: Env, cwd: string): AppConfig {
  const appName = env.TRIM_APPNAME ?? 'dsh-fnos'
  const appDest = resolve(env.TRIM_APPDEST ?? join(cwd, 'packaging', 'fpk', 'app'))
  const pkgEtc = resolve(env.TRIM_PKGETC ?? join(cwd, '.local', 'etc'))
  const pkgVar = resolve(env.TRIM_PKGVAR ?? join(cwd, '.local', 'var'))
  const pkgHome = resolve(env.TRIM_PKGHOME ?? join(cwd, '.local', 'home'))

  const listenPortRaw = env.DSH_FNOS_LISTEN_PORT
  const listenPort = listenPortRaw === undefined ? undefined : readPositiveInt(env, 'DSH_FNOS_LISTEN_PORT', 0)

  const devUid = env.DSH_FNOS_DEV_UID

  return {
    appName,
    appDest,
    pkgEtc,
    pkgVar,
    pkgHome,
    socketPath: join(appDest, 'app.sock'),
    listenPort,
    harness: {
      entry: resolveHarnessEntry(appDest, env),
      executable: resolveNodeExecutable(appDest, env),
      profile: env.DSH_FNOS_HARNESS_PROFILE ?? 'web',
      extraArgs: [],
    },
    devUid: devUid === undefined || devUid === '' ? undefined : devUid,
    startTimeoutMs: readPositiveInt(env, 'DSH_FNOS_START_TIMEOUT_MS', DEFAULT_START_TIMEOUT_MS),
  }
}
