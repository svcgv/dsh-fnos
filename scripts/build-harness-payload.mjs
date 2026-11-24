import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeModes, root, run } from './build.mjs'

/**
 * Build the Harness payload shipped inside the FPK.
 *
 * Default: install the published `@deepseek-ai/dsh` package (production deps only).
 * `--from-source <repo>`: deploy the local checkout with pnpm (requires a prior
 * `pnpm run build`; not used for release because workspace deploy is much larger).
 */
const args = process.argv.slice(2)
const fromSourceIndex = args.indexOf('--from-source')
const fromSource = fromSourceIndex !== -1
const source = fromSource ? args[fromSourceIndex + 1] ?? process.env.DSH_HARNESS_SOURCE : undefined
const version = process.env.DSH_HARNESS_VERSION ?? 'latest'
const dest = args.find((value, index) => !value.startsWith('--') && index !== fromSourceIndex + 1)
  ?? join(root, 'packaging', 'fpk', 'app', 'harness')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

let entry
if (fromSource) {
  if (source === undefined) throw new Error('--from-source requires a repository path')
  run(process.env.PNPM ?? 'pnpm', [
    '--filter',
    '@deepseek-ai/dsh',
    'deploy',
    '--prod',
    '--legacy',
    dest,
  ], { cwd: source })
  entry = [
    join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(dest, 'lib', 'bin.js'),
  ].find((candidate) => existsSync(candidate))
  if (entry === undefined) throw new Error(`deployed harness has no lib/bin.js under ${dest}`)
} else {
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: 'dsh-fnos-harness', private: true }, undefined, 2)}\n`)
  run(process.env.NPM ?? 'npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    `@deepseek-ai/dsh@${version}`,
  ], { cwd: dest })
  entry = join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`installed harness has no lib/bin.js under ${dest}`)
}

// Trim files that are never read at runtime: source maps, type declarations and docs.
async function prune(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) {
      if (item.name === 'docs' || item.name === 'tests') {
        await rm(path, { recursive: true, force: true })
        continue
      }
      await prune(path)
      continue
    }
    if (item.name.endsWith('.map') || item.name.endsWith('.d.ts') || item.name.endsWith('.d.ts.map')) {
      await rm(path, { force: true })
    }
  }
}
await prune(dest)

const relative = entry.slice(dest.length + 1).split('\\').join('/')
await writeFile(join(dest, 'entry.js'), `import './${relative}'\n`)

// pnpm/npm copy source modes; `trimacl` reports 000 for ACL-managed files.
await normalizeModes(dest, false)

console.log(`harness payload: ${dest} (${version})`)
console.log(`harness entry:   ${relative}`)
