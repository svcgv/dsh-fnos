import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { root } from './build.mjs'
import { architectureSpec, detectElfArchitecture } from './release-config.mjs'

const cacheRoot = join(root, '.local', 'cache', 'node')
const downloadRoot = join(root, '.local', 'cache', 'downloads')

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? 'signal'}): ${result.stderr?.trim() ?? ''}`)
  }
  return result
}

async function download(url, destination) {
  if (existsSync(destination)) return
  await mkdir(dirname(destination), { recursive: true })
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }
  const partial = `${destination}.partial`
  await rm(partial, { force: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  await rename(partial, destination)
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function verifyDownload(archive, checksums) {
  const filename = archive.slice(archive.lastIndexOf('/') + 1)
  const line = checksums.split('\n').find((entry) => entry.trimEnd().endsWith(`  ${filename}`))
  if (line === undefined) throw new Error(`Node checksum missing for ${filename}`)
  const expected = line.slice(0, 64)
  const actual = await sha256(archive)
  if (actual !== expected) throw new Error(`Node checksum mismatch for ${filename}`)
}

async function prepareNodeRuntime(arch, version) {
  const target = architectureSpec(arch)
  const distName = `node-v${version}-linux-${target.nodeArch}`
  const installDir = join(cacheRoot, `v${version}`, distName)
  const nodeBinary = join(installDir, 'bin', 'node')
  if (existsSync(nodeBinary)) {
    const detected = await detectElfArchitecture(nodeBinary)
    if (detected.architecture !== target.id) {
      throw new Error(`cached Node runtime is ${detected.architecture}, expected ${target.id}: ${nodeBinary}`)
    }
    return installDir
  }

  const filename = `${distName}.tar.xz`
  const archive = join(downloadRoot, filename)
  const checksumsPath = join(downloadRoot, `node-v${version}-SHASUMS256.txt`)
  await download(`https://nodejs.org/dist/v${version}/${filename}`, archive)
  await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, checksumsPath)
  await verifyDownload(archive, await readFile(checksumsPath, 'utf8'))

  const staging = `${installDir}.tmp`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  runChecked('tar', ['-xJf', archive, '-C', staging])
  const extracted = join(staging, distName)
  if (!existsSync(join(extracted, 'bin', 'node'))) {
    throw new Error(`Node archive did not contain ${distName}/bin/node`)
  }
  await rm(installDir, { recursive: true, force: true })
  await mkdir(dirname(installDir), { recursive: true })
  await rename(extracted, installDir)
  await rm(staging, { recursive: true, force: true })

  const detected = await detectElfArchitecture(nodeBinary)
  if (detected.architecture !== target.id) {
    throw new Error(`downloaded Node runtime is ${detected.architecture}, expected ${target.id}`)
  }
  return installDir
}

/** Stage a verified Node 26 Linux runtime for one FPK target. */
export async function stageNodeRuntime(destination, options) {
  const target = architectureSpec(options.arch)
  const source = options.sourceDir ?? await prepareNodeRuntime(options.arch, options.version)
  const sourceBinary = join(source, 'bin', 'node')
  if (!existsSync(sourceBinary)) throw new Error(`Node distribution has no bin/node: ${source}`)
  const detected = await detectElfArchitecture(sourceBinary)
  if (detected.architecture !== target.id) {
    throw new Error(`Node runtime is ${detected.architecture}, expected ${target.id}`)
  }

  await rm(destination, { recursive: true, force: true })
  await mkdir(join(destination, 'bin'), { recursive: true })
  await copyFile(sourceBinary, join(destination, 'bin', 'node'))
  await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE')).catch(() => undefined)
  await writeFile(join(destination, 'VERSION'), `${options.version}\n`)
  return source
}
