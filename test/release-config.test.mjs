import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateHarnessPayload } from '../scripts/build-harness-payload.mjs'
import {
  REQUIRED_ARCHITECTURES,
  architectureSpec,
  assertNativeTarget,
  loadReleaseConfig,
  normalizeArchitecture,
  readElfArchitecture,
} from '../scripts/release-config.mjs'

test('pins Node 26, the nodejs_v26 dependency and both release architectures', async () => {
  const config = await loadReleaseConfig()
  assert.match(config.nodeVersion, /^26\.\d+\.\d+$/u)
  assert.equal(config.nodeRuntimeDependency, 'nodejs_v26')
  assert.match(config.pnpm.version, /^10\./u)
  assert.match(config.pnpm.sha256, /^[0-9a-f]{64}$/u)
  assert.match(config.libatomic.version, /^12\./u)
  assert.match(config.libatomic.sha256.amd64, /^[0-9a-f]{64}$/u)
  assert.match(config.libatomic.sha256.arm64, /^[0-9a-f]{64}$/u)
  assert.deepEqual([...config.architectures], [...REQUIRED_ARCHITECTURES])
})

test('maps release architectures to fnOS, Node and ELF identities', () => {
  assert.equal(normalizeArchitecture('x86_64'), 'amd64')
  assert.equal(normalizeArchitecture('aarch64'), 'arm64')
  assert.deepEqual(architectureSpec('amd64'), {
    id: 'amd64',
    fnosPlatform: 'x86',
    nodeArch: 'x64',
    elfMachine: 62,
  })
  assert.deepEqual(architectureSpec('arm64'), {
    id: 'arm64',
    fnosPlatform: 'arm',
    nodeArch: 'arm64',
    elfMachine: 183,
  })
})

test('only permits native payload builds on the matching Linux architecture', () => {
  assert.doesNotThrow(() => assertNativeTarget('amd64', 'linux', 'x86_64'))
  assert.doesNotThrow(() => assertNativeTarget('arm64', 'linux', 'aarch64'))
  assert.throws(() => assertNativeTarget('arm64', 'linux', 'x64'), /must be built on arm64/u)
  assert.throws(() => assertNativeTarget('amd64', 'darwin', 'arm64'), /must be built on Linux/u)
})

test('reads amd64 and arm64 from little-endian ELF headers', () => {
  const header = (machine) => {
    const buffer = Buffer.alloc(20)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(buffer)
    buffer.writeUInt16LE(machine, 18)
    return buffer
  }
  assert.deepEqual(readElfArchitecture(header(62)), { architecture: 'amd64', machine: 62 })
  assert.deepEqual(readElfArchitecture(header(183)), { architecture: 'arm64', machine: 183 })
  assert.throws(() => readElfArchitecture(Buffer.alloc(20)), /not an ELF binary/u)
})

test('rejects a Harness payload built for the wrong architecture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-fnos-payload-'))
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'entry.js'), "import './index.js'\n")
    await writeFile(join(directory, '.dsh-fnos-arch.json'), `${JSON.stringify({
      architecture: 'arm64',
      fnosPlatform: 'arm',
      nodeArch: 'arm64',
    })}\n`)
    await assert.rejects(() => validateHarnessPayload(directory, 'amd64'), /architecture mismatch/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
