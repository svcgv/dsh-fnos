import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { root } from './build.mjs'
import {
  architectureSpec,
  detectElfArchitecture,
  loadReleaseConfig,
  normalizeArchitecture,
} from './release-config.mjs'

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'signal'}): ${result.stderr.trim()}`)
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--file' || argument === '--arch') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      values[argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`unknown argument ${argument}`)
    }
  }
  return values
}

async function artifactSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Unpack an FPK and verify its architecture, runtime and required files. */
export async function verifyFpk(file, arch) {
  if (!existsSync(file)) throw new Error(`FPK not found: ${file}`)
  const config = await loadReleaseConfig()
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const target = architectureSpec(arch)
  // Extracting inside the repository can hit ACL/filesystem quirks (fnOS
  // `trimacl` reports zero modes for freshly extracted trees) and misreport a
  // valid FPK as broken. Use the host temp dir instead.
  const work = await mkdtemp(join(tmpdir(), 'dsh-fpk-verify-'))
  try {
    runChecked('tar', ['-xzf', file, '-C', work])
    const manifest = await readFile(join(work, 'manifest'), 'utf8')
    const platform = /^platform\s*=\s*(\S+)/mu.exec(manifest)?.[1]
    if (platform !== target.fnosPlatform) {
      throw new Error(`manifest platform is ${JSON.stringify(platform)}, expected ${target.fnosPlatform}`)
    }
    const version = /^version\s*=\s*(\S+)/mu.exec(manifest)?.[1]
    if (version !== packageJson.version) {
      throw new Error(`manifest version is ${JSON.stringify(version)}, expected ${packageJson.version}`)
    }
    const dependencies = /^install_dep_apps\s*=\s*(.*)$/mu.exec(manifest)?.[1]?.split(':') ?? []
    if (!dependencies.includes(config.nodeRuntimeDependency)) {
      throw new Error(`manifest does not depend on ${config.nodeRuntimeDependency}`)
    }

    for (const required of ['cmd/main', 'app.tgz']) {
      if (!existsSync(join(work, required))) throw new Error(`FPK is missing ${required}`)
    }
    const appDir = join(work, 'app')
    await mkdir(appDir, { recursive: true })
    runChecked('tar', ['-xzf', join(work, 'app.tgz'), '-C', appDir])
    for (const required of [
      'server/index.js',
      'harness/entry.js',
      'harness/.dsh-fnos-arch.json',
      `harness/node_modules/@koromix/koffi-linux-${target.nodeArch}`,
      `harness/node_modules/@deepseek-ai/node-addon-system-linux-${target.nodeArch}`,
      `harness/node_modules/sherpa-onnx-linux-${target.nodeArch}`,
      'runtime/lib/libatomic.so.1',
      'runtime/lib/VERSION',
      'runtime/bin/pnpm',
      'runtime/bin/pnpx',
      'runtime/bin/dsh-ptc-node',
      'runtime/pnpm/bin/pnpm.cjs',
      'runtime/pnpm/VERSION',
    ]) {
      if (!existsSync(join(appDir, required))) throw new Error(`FPK is missing app/${required}`)
    }

    const libatomicVersion = (await readFile(join(appDir, 'runtime', 'lib', 'VERSION'), 'utf8')).trim()
    if (libatomicVersion !== config.libatomic.version) {
      throw new Error(`libatomic version is ${JSON.stringify(libatomicVersion)}, expected ${config.libatomic.version}`)
    }
    const elf = await detectElfArchitecture(join(appDir, 'runtime', 'lib', 'libatomic.so.1'))
    if (elf.architecture !== target.id) {
      throw new Error(`libatomic ELF is ${elf.architecture}, expected ${target.id}`)
    }
    const pnpmVersion = (await readFile(join(appDir, 'runtime', 'pnpm', 'VERSION'), 'utf8')).trim()
    if (pnpmVersion !== config.pnpm.version) {
      throw new Error(`pnpm version is ${JSON.stringify(pnpmVersion)}, expected ${config.pnpm.version}`)
    }
    for (const command of ['pnpm', 'pnpx', 'dsh-ptc-node']) {
      const mode = (await stat(join(appDir, 'runtime', 'bin', command))).mode
      if ((mode & 0o111) === 0) throw new Error(`runtime/bin/${command} is not executable`)
    }
    // The launcher must stay the app-local library injector, not a copy of Node
    // or a stale script that silently leaves the PTC worker unstartable.
    const launcher = await readFile(join(appDir, 'runtime', 'bin', 'dsh-ptc-node'), 'utf8')
    for (const marker of ['libatomic.so.1', 'nodejs_v26', 'LD_LIBRARY_PATH']) {
      if (!launcher.includes(marker)) {
        throw new Error(`runtime/bin/dsh-ptc-node does not mention ${marker}`)
      }
    }
    const marker = JSON.parse(await readFile(join(appDir, 'harness', '.dsh-fnos-arch.json'), 'utf8'))
    if (marker.architecture !== target.id || marker.fnosPlatform !== target.fnosPlatform) {
      throw new Error(`Harness payload marker is ${JSON.stringify(marker)}, expected ${target.id}`)
    }

    return {
      file,
      architecture: target.id,
      fnosPlatform: target.fnosPlatform,
      nodeRuntimeDependency: config.nodeRuntimeDependency,
      pnpmVersion,
      libatomicVersion,
      harnessVersion: marker.harnessVersion,
      sha256: await artifactSha256(file),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.file === undefined || args.arch === undefined) {
    throw new Error('usage: node scripts/verify-fpk.mjs --file <artifact.fpk> --arch <amd64|arm64>')
  }
  const summary = await verifyFpk(args.file, normalizeArchitecture(args.arch))
  console.log(JSON.stringify(summary, undefined, 2))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
