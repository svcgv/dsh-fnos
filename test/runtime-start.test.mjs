import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const main = await readFile(new URL('../packaging/fpk/cmd/main', import.meta.url), 'utf8')
const functions = main.slice(0, main.indexOf('\ncase "${1:-}" in'))

test('startup reports a missing bundled libatomic before launching Node', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { ...process.env, TRIM_APPDEST: join(root, 'app'), TRIM_PKGVAR: root }
  const result = spawnSync('/bin/bash', ['-c', `${functions}\nprepare_runtime`], { env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(await readFile(join(root, 'dsh-fnos.log'), 'utf8'), /libatomic\.so\.1/u)
})

test('startup puts the bundled library first even when it was already in the inherited path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'app with spaces')
  const lib = join(app, 'runtime', 'lib')
  await mkdir(lib, { recursive: true })
  await writeFile(join(lib, 'libatomic.so.1'), '')
  const env = { ...process.env, TRIM_APPDEST: app, TRIM_PKGVAR: root, LD_LIBRARY_PATH: `/other:${lib}` }
  const result = spawnSync('/bin/bash', ['-c', `${functions}\nprepare_runtime\nprintf '%s' "$LD_LIBRARY_PATH"`], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${lib}:/other:${lib}`)
})
