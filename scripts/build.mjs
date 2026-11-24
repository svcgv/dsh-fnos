import { chmod, copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
export const root = dirname(scriptsDir)

/** Run a command and exit with its status when it fails. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

/**
 * Copy a tree with explicit modes.
 * fnOS `trimacl` volumes report mode 000 for objects whose effective mode lives in
 * the ACL, so tooling that preserves `stat().mode` would create unreadable output.
 */
export async function copyTree(from, to) {
  await mkdir(to, { recursive: true, mode: 0o755 })
  await chmod(to, 0o755)
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyTree(source, destination)
    } else if (entry.isFile()) {
      await copyFile(source, destination)
      await chmod(destination, 0o644)
    }
  }
}

/** Restore owner access before deleting a tree built on a `trimacl` volume. */
export async function unlockTree(path) {
  try {
    await chmod(path, 0o755)
  } catch {
    return
  }
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => unlockTree(join(path, entry.name))))
}

/** Remove a tree even when a previous run created mode-000 directories. */
export async function removeTree(path) {
  await unlockTree(path)
  await rm(path, { recursive: true, force: true })
}

/**
 * Give every entry concrete mode bits.
 * `fnpack` copies `stat().mode` into its staging directory; on a `trimacl` volume
 * an unmodified directory reports 000 and the copy becomes unreadable.
 */
export async function normalizeModes(path, executable = false) {
  let info
  try {
    info = await stat(path)
  } catch {
    return
  }
  const mode = info.isDirectory() ? 0o755 : executable ? 0o755 : 0o644
  await chmod(path, mode)
  if (!info.isDirectory()) return
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await normalizeModes(join(path, entry.name), executable)
  }
}

/** Compile TypeScript and stage the assets that `tsc` does not copy. */
export async function build() {
  await removeTree(join(root, 'dist'))
  run(process.execPath, [tsc, '-p', 'tsconfig.json'])
  await copyTree(join(root, 'src', 'ui'), join(root, 'dist', 'src', 'ui'))
  await copyTree(join(root, 'test', 'fixtures'), join(root, 'dist', 'test', 'fixtures'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build()
  console.log('build: dist ready')
}
