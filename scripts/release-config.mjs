import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from './build.mjs'

/** Supported release architecture mapped to fnOS, Node and ELF identities. */
export const ARCHITECTURES = Object.freeze({
  amd64: Object.freeze({
    id: 'amd64',
    fnosPlatform: 'x86',
    nodeArch: 'x64',
    elfMachine: 62,
  }),
  arm64: Object.freeze({
    id: 'arm64',
    fnosPlatform: 'arm',
    nodeArch: 'arm64',
    elfMachine: 183,
  }),
})

/** Architectures that every release must provide. */
export const REQUIRED_ARCHITECTURES = Object.freeze(['amd64', 'arm64'])

let cachedReleaseConfig

/** Normalize host and CLI architecture aliases to the release architecture ids. */
export function normalizeArchitecture(value) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'amd64' || normalized === 'x64' || normalized === 'x86_64') return 'amd64'
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64'
  throw new Error(`unsupported architecture ${JSON.stringify(value)}; expected amd64 or arm64`)
}

/** Resolve one target architecture, including all platform-specific identities. */
export function architectureSpec(value) {
  return ARCHITECTURES[normalizeArchitecture(value)]
}

/** Load and validate the pinned Node and Harness release configuration. */
export async function loadReleaseConfig() {
  if (cachedReleaseConfig !== undefined) return cachedReleaseConfig
  const path = join(root, 'release.json')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed.nodeVersion !== 'string' || !/^26\.\d+\.\d+$/u.test(parsed.nodeVersion)) {
    throw new Error('release.json nodeVersion must pin a Node.js 26 release')
  }
  if (typeof parsed.harnessVersion !== 'string' || parsed.harnessVersion.trim() === '') {
    throw new Error('release.json harnessVersion must be a non-empty version')
  }
  if (parsed.nodeRuntimeDependency !== 'nodejs_v26') {
    throw new Error('release.json nodeRuntimeDependency must be nodejs_v26')
  }
  if (
    parsed.pnpm === null
    || typeof parsed.pnpm !== 'object'
    || typeof parsed.pnpm.version !== 'string'
    || !/^10\.\d+\.\d+$/u.test(parsed.pnpm.version)
    || !/^[0-9a-f]{64}$/u.test(parsed.pnpm.sha256 ?? '')
  ) {
    throw new Error('release.json pnpm metadata is incomplete')
  }
  if (
    parsed.libatomic === null
    || typeof parsed.libatomic !== 'object'
    || typeof parsed.libatomic.version !== 'string'
    || parsed.libatomic.version.trim() === ''
    || parsed.libatomic.sha256 === null
    || typeof parsed.libatomic.sha256 !== 'object'
  ) {
    throw new Error('release.json libatomic metadata is incomplete')
  }
  for (const required of REQUIRED_ARCHITECTURES) {
    if (!/^[0-9a-f]{64}$/u.test(parsed.libatomic.sha256[required] ?? '')) {
      throw new Error(`release.json libatomic sha256 is missing for ${required}`)
    }
  }
  if (!Array.isArray(parsed.architectures)) {
    throw new Error('release.json architectures must be an array')
  }
  const architectures = parsed.architectures.map(normalizeArchitecture)
  if (new Set(architectures).size !== architectures.length) {
    throw new Error('release.json architectures must not contain duplicates')
  }
  for (const required of REQUIRED_ARCHITECTURES) {
    if (!architectures.includes(required)) {
      throw new Error(`release.json must include ${required}`)
    }
  }
  cachedReleaseConfig = Object.freeze({
    nodeVersion: parsed.nodeVersion,
    nodeRuntimeDependency: parsed.nodeRuntimeDependency,
    harnessVersion: parsed.harnessVersion,
    pnpm: Object.freeze({ version: parsed.pnpm.version, sha256: parsed.pnpm.sha256 }),
    libatomic: Object.freeze({
      version: parsed.libatomic.version,
      sha256: Object.freeze({ ...parsed.libatomic.sha256 }),
    }),
    architectures: Object.freeze(architectures),
  })
  return cachedReleaseConfig
}

/** Ensure native binaries are built on the Linux architecture they target. */
export function assertNativeTarget(arch, platform = process.platform, hostArch = process.arch) {
  const target = architectureSpec(arch)
  if (platform !== 'linux') {
    throw new Error(`native ${target.id} payload must be built on Linux, current platform is ${platform}`)
  }
  if (normalizeArchitecture(hostArch) !== target.id) {
    throw new Error(`native ${target.id} payload must be built on ${target.id}, current architecture is ${hostArch}`)
  }
}

/** Decode the architecture from a 64-bit little-endian ELF header buffer. */
export function readElfArchitecture(buffer) {
  if (buffer.length < 20) throw new Error('ELF header is truncated')
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw new Error('file is not an ELF binary')
  }
  if (buffer[4] !== 2) throw new Error('ELF binary is not 64-bit')
  if (buffer[5] !== 1) throw new Error('ELF binary is not little-endian')
  const machine = buffer.readUInt16LE(18)
  const match = Object.values(ARCHITECTURES).find((candidate) => candidate.elfMachine === machine)
  if (match === undefined) throw new Error(`unsupported ELF machine ${machine}`)
  return { architecture: match.id, machine }
}

/** Read and validate the target architecture of one local ELF file. */
export async function detectElfArchitecture(path) {
  return readElfArchitecture(await readFile(path))
}
