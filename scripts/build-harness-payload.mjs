import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeModes, root, run } from './build.mjs'

const source = process.env.DSH_HARNESS_SOURCE ?? '/vol1/1000/code/deepseek-harness'
const dest = process.argv[2] ?? join(root, 'packaging', 'fpk', 'app', 'harness')

await mkdir(dest, { recursive: true })

// `pnpm deploy` materialises the CLI package with its workspace dependencies
// resolved into a self-contained tree, so the NAS never runs pnpm install.
run(process.env.PNPM ?? 'pnpm', [
  '--filter',
  '@deepseek-ai/dsh',
  'deploy',
  '--prod',
  '--legacy',
  dest,
], { cwd: source })

const candidates = [
  join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  join(dest, 'lib', 'bin.js'),
]
const entry = candidates.find((candidate) => existsSync(candidate))
if (entry === undefined) {
  throw new Error(`deployed harness has no lib/bin.js under ${dest}`)
}

const relative = entry.slice(dest.length + 1)
await writeFile(join(dest, 'entry.js'), `import './${relative.split('\\').join('/')}'\n`)

// pnpm copies source modes; `trimacl` reports 000 for ACL-managed files.
await normalizeModes(dest, false)

console.log(`harness payload: ${dest}`)
console.log(`harness entry:   ${relative}`)
