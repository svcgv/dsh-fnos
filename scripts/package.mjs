import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, copyTree, normalizeModes, removeTree, root, run } from './build.mjs'
import { validateHarnessPayload } from './build-harness-payload.mjs'
import { stageRuntimeLibraries } from './runtime-libraries.mjs'
import {
  architectureSpec,
  loadReleaseConfig,
  normalizeArchitecture,
} from './release-config.mjs'
import { verifyFpk } from './verify-fpk.mjs'

function parseArgs(argv) {
  const values = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--arch' || argument === '--harness') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      values[argument.slice(2)] = value
      index += 1
    } else if (argument === '--allow-missing-payload') {
      values.allowMissingPayload = true
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown argument ${argument}`)
    } else {
      values.positional.push(argument)
    }
  }
  return values
}

function fnpackArgs(stageRoot) {
  const args = ['build', '--directory', join(stageRoot, 'fpk')]
  const key = process.env.FNPACK_KEY
  const cert = process.env.FNPACK_CERT
  if (key !== undefined && cert !== undefined) {
    args.push('--key', key, '--cert', cert)
  } else {
    args.push('--nosign')
  }
  return args
}

/** Build one complete, architecture-specific fnOS FPK artifact. */
export async function packageFpk(options) {
  const config = await loadReleaseConfig()
  const target = architectureSpec(options.arch)
  if (!config.architectures.includes(target.id)) {
    throw new Error(`release.json does not list ${target.id}`)
  }
  await build()

  const stageRoot = join(root, '.local', 'build', `fpk-${target.id}`)
  const stageFpk = join(stageRoot, 'fpk')
  await removeTree(stageRoot)
  await mkdir(stageRoot, { recursive: true })
  await copyTree(join(root, 'packaging', 'fpk'), stageFpk)
  const appServer = join(stageFpk, 'app', 'server')
  await removeTree(appServer)
  await removeTree(join(stageFpk, 'app', 'harness'))
  await removeTree(join(stageFpk, 'app', 'runtime'))
  await copyTree(join(root, 'dist', 'src'), appServer)
  console.log(`package: server staged for ${target.id}`)

  if (options.harnessDir !== undefined) {
    await validateHarnessPayload(options.harnessDir, target.id)
    await copyTree(options.harnessDir, join(stageFpk, 'app', 'harness'))
  } else if (!options.allowMissingPayload) {
    throw new Error('Harness payload is required; run scripts/build-harness-payload.mjs or pass --harness')
  } else {
    console.warn('package: Harness payload missing; artifact is development-only')
  }

  const runtimeLibDir = join(stageFpk, 'app', 'runtime', 'lib')
  await stageRuntimeLibraries(runtimeLibDir, { arch: target.id, libatomic: config.libatomic })
  console.log(`package: staged libatomic ${config.libatomic.version} ${target.id}`)

  const manifestPath = join(stageFpk, 'manifest')
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = await readFile(manifestPath, 'utf8')
  if (!/^platform\s*=/mu.test(manifest)) throw new Error(`manifest has no platform field: ${manifestPath}`)
  if (!/^version\s*=/mu.test(manifest)) throw new Error(`manifest has no version field: ${manifestPath}`)
  const withPlatform = manifest.replace(/^platform\s*=\s*.*$/mu, `platform               = ${target.fnosPlatform}`)
  const rewritten = withPlatform.replace(/^version\s*=\s*.*$/mu, `version               = ${packageJson.version}`)
  await writeFile(manifestPath, rewritten)

  // fnpack copies stat modes verbatim; normalize ACL-managed modes first.
  await normalizeModes(stageFpk, false)
  for (const script of await readdir(join(stageFpk, 'cmd'))) {
    await chmod(join(stageFpk, 'cmd', script), 0o755)
  }
  await chmod(manifestPath, 0o644)
  run(process.env.FNPACK ?? 'fnpack', fnpackArgs(stageRoot), { cwd: stageRoot })
  const produced = join(stageRoot, 'dsh-fnos.fpk')
  if (!existsSync(produced)) throw new Error(`fnpack did not create ${produced}`)

  const artifact = join(root, 'dist', `dsh-fnos-${packageJson.version}-linux-${target.id}.fpk`)
  await mkdir(join(root, 'dist'), { recursive: true })
  await cp(produced, artifact)
  await chmod(artifact, 0o644)
  if (options.allowMissingPayload) {
    console.warn('package: development artifact produced; strict release verification was skipped')
    return { artifact, summary: undefined }
  }
  const summary = await verifyFpk(artifact, target.id)
  console.log(`package: ${artifact}`)
  console.log(`package: sha256 ${summary.sha256}`)
  return { artifact, summary }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const arch = normalizeArchitecture(args.arch ?? process.env.DSH_FNOS_ARCH ?? process.arch)
  const harnessDir = args.harness ?? process.env.DSH_FNOS_HARNESS_PAYLOAD ?? join(root, 'packaging', 'fpk', 'app', 'harness')
  return packageFpk({
    arch,
    harnessDir: existsSync(join(harnessDir, 'entry.js')) ? harnessDir : undefined,
    allowMissingPayload: args.allowMissingPayload,
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
