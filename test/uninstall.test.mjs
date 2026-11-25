import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { root } from '../scripts/build.mjs'

const script = join(root, 'packaging', 'fpk', 'cmd', 'uninstall_init')

async function createUninstallState() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-fnos-uninstall-'))
  const appDest = join(base, 'app')
  const home = join(base, '@apphome', 'dsh-fnos')
  const etc = join(base, '@appconf', 'dsh-fnos')
  const data = join(base, '@appdata', 'dsh-fnos')
  const log = join(base, 'uninstall.log')
  await mkdir(join(appDest, 'cmd'), { recursive: true })
  await writeFile(join(appDest, 'cmd', 'main'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(join(appDest, 'cmd', 'main'), 0o755)
  for (const directory of [home, etc, data]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'residual'), 'x\n')
  }
  return { appDest, home, etc, data, log }
}

function runUninstall(state, extraEnv = {}) {
  return spawnSync('bash', [script], {
    env: {
      PATH: process.env.PATH,
      TRIM_APPNAME: 'dsh-fnos',
      TRIM_APPDEST: state.appDest,
      TRIM_PKGHOME: state.home,
      TRIM_PKGETC: state.etc,
      TRIM_PKGVAR: state.data,
      TRIM_TEMP_LOGFILE: state.log,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

test('uninstall keeps application data by default', async () => {
  const state = await createUninstallState()
  const result = runUninstall(state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(state.home), true)
  assert.equal(existsSync(state.etc), true)
  assert.equal(existsSync(state.data), true)
})

test('uninstall can remove application data when explicitly selected', async () => {
  const state = await createUninstallState()
  const result = runUninstall(state, { wizard_uninstall_mode: 'delete' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(state.home), false)
  assert.equal(existsSync(state.etc), false)
  assert.equal(existsSync(state.data), false)
})
