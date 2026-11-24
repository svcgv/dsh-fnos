import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { build, root } from './build.mjs'

await build()

const testDir = join(root, 'dist', 'test')
const files = (await readdir(testDir))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDir, name))

if (files.length === 0) {
  console.error('test: no compiled test files found')
  process.exit(1)
}

const args = process.argv.slice(2)
const result = spawnSync(process.execPath, ['--test', ...args, ...files], {
  stdio: 'inherit',
  cwd: root,
})
process.exit(result.status ?? 1)
