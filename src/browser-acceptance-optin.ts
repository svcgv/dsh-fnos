import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Answer whether the experimental browser acceptance instance is enabled.
 *
 * The switch is off unless an administrator created both marker files inside the
 * application data directory. It only narrows exposure; it is not a security
 * boundary, because every NAS user of this installation shares one host account.
 */
export type BrowserAcceptanceOptIn =
  | { readonly enabled: true; readonly uid: string }
  | { readonly enabled: false; readonly reason: string }

/** Marker file whose content must be `1`; its absence keeps the feature off. */
export const ACCEPTANCE_ENABLED_FILE = 'browser-acceptance.enabled'
/** The single NAS uid allowed to open the acceptance instance. */
export const ACCEPTANCE_UID_FILE = 'browser-acceptance.uid'

const UID = /^[1-9][0-9]{0,9}$/u

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function parseUid(raw: string | undefined): string | undefined {
  const value = raw?.trim() ?? ''
  return UID.test(value) ? value : undefined
}

/** Read the opt-in switch from marker files, or from an explicit development override. */
export async function readBrowserAcceptanceOptIn(
  markerDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserAcceptanceOptIn> {
  if (env.DSH_FNOS_BROWSER_ACCEPTANCE === '1') {
    const uid = parseUid(env.DSH_FNOS_BROWSER_ACCEPTANCE_UID)
    return uid === undefined ? { enabled: false, reason: 'env-uid-missing' } : { enabled: true, uid }
  }
  if (env.DSH_FNOS_BROWSER_ACCEPTANCE !== undefined && env.DSH_FNOS_BROWSER_ACCEPTANCE !== '') {
    return { enabled: false, reason: 'env-invalid' }
  }
  const directory = resolve(markerDir)
  const marker = await readRegularFile(join(directory, ACCEPTANCE_ENABLED_FILE))
  if (marker === undefined) return { enabled: false, reason: 'not-configured' }
  if (marker.trim() !== '1') return { enabled: false, reason: 'marker-invalid' }
  const uid = parseUid(await readRegularFile(join(directory, ACCEPTANCE_UID_FILE)))
  return uid === undefined ? { enabled: false, reason: 'uid-missing' } : { enabled: true, uid }
}
