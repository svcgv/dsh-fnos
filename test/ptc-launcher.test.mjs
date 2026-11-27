import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../packaging/runtime/bin/dsh-ptc-node', import.meta.url))

/** Build a throwaway installed-runtime tree; the space proves quoting works. */
async function runtimeTree(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-launcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime with space')
  const bin = join(runtime, 'bin')
  const lib = join(runtime, 'lib')
  await mkdir(bin, { recursive: true })
  await mkdir(lib, { recursive: true })
  const launcher = join(bin, 'dsh-ptc-node')
  await copyFile(source, launcher)
  await chmod(launcher, 0o755)
  if (options.withLibrary !== false) await writeFile(join(lib, 'libatomic.so.1'), '')
  return { root, runtime, bin, lib, launcher }
}

/** Run the launcher with a controlled environment and no inherited lib path. */
function run(launcher, args, environment, cwd) {
  return spawnSync(launcher, args, {
    encoding: 'utf8',
    cwd,
    env: { PATH: '/usr/bin:/bin', ...environment },
  })
}

test('fails with a diagnostic when the bundled library is missing', async (t) => {
  const { lib, launcher } = await runtimeTree(t, { withLibrary: false })
  const result = run(launcher, ['--version'], {})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /libatomic\.so\.1 is missing/u)
  assert.ok(result.stderr.includes(join(lib, 'libatomic.so.1')), result.stderr)
})

test('fails with a diagnostic when the fnOS Node runtime is unavailable', async (t) => {
  const { root, launcher } = await runtimeTree(t)
  const result = run(launcher, [], { DSH_FNOS_PTC_NODE_APP: join(root, 'missing-node') })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /nodejs_v26 runtime is not executable/u)
})

test('injects only the app-local library directory and forwards argv verbatim', async (t) => {
  const { root, lib, launcher } = await runtimeTree(t)
  const fakeNode = join(root, 'fake node')
  await writeFile(fakeNode, [
    '#!/bin/sh',
    'printf "LD_LIBRARY_PATH=%s\\n" "${LD_LIBRARY_PATH-<unset>}"',
    'for argument in "$@"; do printf "ARG=%s\\n" "$argument"; done',
    '',
  ].join('\n'))
  await chmod(fakeNode, 0o755)
  const args = ['--max-old-space-size=512', '/tmp/with space/process.js', '134217728']
  const result = run(launcher, args, {
    DSH_FNOS_PTC_NODE_APP: fakeNode,
    LD_LIBRARY_PATH: '/caller/lib:/more',
  }, tmpdir())
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    `LD_LIBRARY_PATH=${lib}`,
    ...args.map((argument) => `ARG=${argument}`),
  ])
})

test('replaces itself with the Node runtime so its exit status passes through', async (t) => {
  const { root, launcher } = await runtimeTree(t)
  const fakeNode = join(root, 'fake-node')
  await writeFile(fakeNode, '#!/bin/sh\nexit 7\n')
  await chmod(fakeNode, 0o755)
  const result = run(launcher, [], { DSH_FNOS_PTC_NODE_APP: fakeNode })
  assert.equal(result.status, 7)
})
