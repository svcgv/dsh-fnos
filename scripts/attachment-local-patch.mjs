import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/** Marker identifying the fnOS-specific attachment-local durability fallback. */
export const ATTACHMENT_LOCAL_PATCH_MARKER = 'dsh-fnos: inaccessible durable ancestors are mount boundaries'

const ORIGINAL_SYNC_DIRECTORY = `async function syncDirectory(path) {
\t/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
\tif (process.platform === "win32") return;
\t/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
\tconst handle = await open(path, constants.O_RDONLY);
\ttry {
\t\tawait handle.sync();
\t} finally {
\t\tawait handle.close();
\t}
\t/* v8 ignore stop */
}`

const PATCHED_SYNC_DIRECTORY = `async function syncDirectory(path) {
\t/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
\tif (process.platform === "win32") return;
\t/* ${ATTACHMENT_LOCAL_PATCH_MARKER}. */
\tlet handle;
\ttry {
\t\thandle = await open(path, constants.O_RDONLY);
\t} catch (error) {
\t\tif (error?.code === "EACCES" || error?.code === "EPERM") return;
\t\tthrow error;
\t}
\ttry {
\t\tawait handle.sync();
\t} finally {
\t\tawait handle.close();
\t}
}`

/** Locate the exact attachment-local package resolved by the deployed Harness entry. */
function attachmentLocalBundle(directory) {
  const entry = [
    join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(directory, 'lib', 'bin.js'),
  ].find((candidate) => existsSync(candidate))
  if (entry === undefined) throw new Error(`cannot locate the Harness entry below ${directory}`)
  let packageJson
  try {
    packageJson = createRequire(entry).resolve('@deepseek-ai/dsh-attachment-local/package.json')
  } catch (error) {
    throw new Error(`cannot resolve @deepseek-ai/dsh-attachment-local from ${entry}`, { cause: error })
  }
  const bundle = join(dirname(packageJson), 'lib', 'index.js')
  if (!existsSync(bundle)) throw new Error(`attachment-local bundle is missing: ${bundle}`)
  return bundle
}

/**
 * Patch attachment-local's directory fsync so an unreadable, already-mounted
 * ancestor such as fnOS `/vol1` does not reject every attachment upload.
 * The upstream walk still syncs every writable directory inside DSH_HOME.
 */
export async function patchAttachmentLocalFsync(directory) {
  const bundle = attachmentLocalBundle(directory)
  let source = await readFile(bundle, 'utf8')
  if (source.includes(ATTACHMENT_LOCAL_PATCH_MARKER)) return { bundle, changed: false }
  if (!source.includes(ORIGINAL_SYNC_DIRECTORY)) {
    throw new Error(
      `unsupported attachment-local bundle at ${bundle}; update the fnOS fsync patch for the bundled Harness version`,
    )
  }
  source = source.replace(ORIGINAL_SYNC_DIRECTORY, PATCHED_SYNC_DIRECTORY)
  await writeFile(bundle, source)
  return { bundle, changed: true }
}

/** Refuse to package a Harness whose attachment-local fallback was not applied. */
export async function verifyAttachmentLocalPatch(directory) {
  const bundle = attachmentLocalBundle(directory)
  const source = await readFile(bundle, 'utf8')
  if (!source.includes(ATTACHMENT_LOCAL_PATCH_MARKER)) {
    throw new Error(`Harness payload is missing the fnOS attachment-local fsync patch: ${bundle}`)
  }
  return bundle
}

export const attachmentLocalPatchFixture = Object.freeze({
  original: ORIGINAL_SYNC_DIRECTORY,
  patched: PATCHED_SYNC_DIRECTORY,
})
