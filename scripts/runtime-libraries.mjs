import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { root } from './build.mjs'
import { architectureSpec, detectElfArchitecture } from './release-config.mjs'

const downloadRoot = join(root, '.local', 'cache', 'debian')

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? 'signal'}): ${result.stderr?.trim() ?? ''}`)
  }
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

async function verifySha256(path, expected) {
  const actual = createHash('sha256').update(await readFile(path)).digest('hex')
  if (actual !== expected) throw new Error(`checksum mismatch for ${path}`)
}

function debianLibDir(arch) {
  if (arch === 'amd64') return 'x86_64-linux-gnu'
  if (arch === 'arm64') return 'aarch64-linux-gnu'
  throw new Error(`unsupported Debian architecture ${arch}`)
}

async function prepareLibatomic(arch, libatomic) {
  const target = architectureSpec(arch)
  const filename = `libatomic1_${libatomic.version}_${target.id}.deb`
  const archive = join(downloadRoot, filename)
  await download(`https://deb.debian.org/debian/pool/main/g/gcc-12/${filename}`, archive)
  await verifySha256(archive, libatomic.sha256[target.id])

  const tempRoot = join(root, '.local', 'tmp')
  await mkdir(tempRoot, { recursive: true })
  const work = await mkdtemp(join(tempRoot, 'libatomic-'))
  const extract = join(work, 'extract')
  try {
    runChecked('ar', ['x', archive], { cwd: work })
    const dataArchive = ['data.tar.xz', 'data.tar.gz', 'data.tar.zst'].find((name) => existsSync(join(work, name)))
    if (dataArchive === undefined) throw new Error(`Debian package has no supported data archive: ${archive}`)
    await mkdir(extract, { recursive: true })
    const tarFlag = dataArchive.endsWith('.xz') ? '-xJf' : dataArchive.endsWith('.gz') ? '-xzf' : '--zstd'
    runChecked('tar', dataArchive.endsWith('.zst') ? [tarFlag, '-f', join(work, dataArchive), '-C', extract] : [tarFlag, join(work, dataArchive), '-C', extract])
    const library = join(extract, 'usr', 'lib', debianLibDir(target.id), 'libatomic.so.1')
    if (!existsSync(library)) throw new Error(`libatomic.so.1 missing from ${archive}`)
    const detected = await detectElfArchitecture(library)
    if (detected.architecture !== target.id) {
      throw new Error(`libatomic is ${detected.architecture}, expected ${target.id}`)
    }
    return await readFile(library)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Stage the Debian 12 libatomic compatibility library for one FPK target. */
export async function stageRuntimeLibraries(destination, options) {
  const target = architectureSpec(options.arch)
  const source = await prepareLibatomic(target.id, options.libatomic)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'libatomic.so.1'), source)
  await writeFile(join(destination, 'VERSION'), `${options.libatomic.version}\n`)
}
