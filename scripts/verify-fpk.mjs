import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { root } from './build.mjs'
import { architectureSpec, detectElfArchitecture, normalizeArchitecture } from './release-config.mjs'

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
  const target = architectureSpec(arch)
  const tempRoot = join(root, '.local', 'tmp')
  await mkdir(tempRoot, { recursive: true })
  const work = await mkdtemp(join(tempRoot, 'verify-'))
  try {
    runChecked('tar', ['-xzf', file, '-C', work])
    const manifest = await readFile(join(work, 'manifest'), 'utf8')
    const platform = /^platform\s*=\s*(\S+)/mu.exec(manifest)?.[1]
    if (platform !== target.fnosPlatform) {
      throw new Error(`manifest platform is ${JSON.stringify(platform)}, expected ${target.fnosPlatform}`)
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
      'runtime/node/bin/node',
      'runtime/node/VERSION',
    ]) {
      if (!existsSync(join(appDir, required))) throw new Error(`FPK is missing app/${required}`)
    }

    const runtimeVersion = (await readFile(join(appDir, 'runtime', 'node', 'VERSION'), 'utf8')).trim()
    if (!/^26\.\d+\.\d+$/u.test(runtimeVersion)) {
      throw new Error(`bundled Node version is ${JSON.stringify(runtimeVersion)}, expected Node.js 26`)
    }
    const elf = await detectElfArchitecture(join(appDir, 'runtime', 'node', 'bin', 'node'))
    if (elf.architecture !== target.id) {
      throw new Error(`bundled Node ELF is ${elf.architecture}, expected ${target.id}`)
    }
    const marker = JSON.parse(await readFile(join(appDir, 'harness', '.dsh-fnos-arch.json'), 'utf8'))
    if (marker.architecture !== target.id || marker.fnosPlatform !== target.fnosPlatform) {
      throw new Error(`Harness payload marker is ${JSON.stringify(marker)}, expected ${target.id}`)
    }

    return {
      file,
      architecture: target.id,
      fnosPlatform: target.fnosPlatform,
      nodeVersion: runtimeVersion,
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
