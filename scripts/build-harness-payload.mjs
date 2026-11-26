import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { normalizeModes, root } from './build.mjs'
import { patchAttachmentLocalFsync, verifyAttachmentLocalPatch } from './attachment-local-patch.mjs'
import {
  architectureSpec,
  assertNativeTarget,
  loadReleaseConfig,
  normalizeArchitecture,
} from './release-config.mjs'

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'signal'}`)
}

function parseArgs(argv) {
  const values = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--from-source' || argument === '--arch' || argument === '--dest' || argument === '--version') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      values[argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value
      index += 1
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown argument ${argument}`)
    } else {
      values.positional.push(argument)
    }
  }
  return values
}

async function prune(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) {
      if (item.name === 'docs' || item.name === 'tests') {
        await rm(path, { recursive: true, force: true })
        continue
      }
      await prune(path)
      continue
    }
    if (item.name.endsWith('.map') || item.name.endsWith('.d.ts') || item.name.endsWith('.d.ts.map')) {
      await rm(path, { force: true })
    }
  }
}

const nativePackages = (nodeArch) => [
  join('node_modules', '@koromix', `koffi-linux-${nodeArch}`),
  join('node_modules', '@deepseek-ai', `node-addon-system-linux-${nodeArch}`),
  join('node_modules', `sherpa-onnx-linux-${nodeArch}`),
]

/** Validate that a Harness payload is complete and was built for the target architecture. */
export async function validateHarnessPayload(directory, arch) {
  const target = architectureSpec(arch)
  if (!existsSync(join(directory, 'entry.js'))) throw new Error(`Harness payload has no entry.js: ${directory}`)
  const markerPath = join(directory, '.dsh-fnos-arch.json')
  if (!existsSync(markerPath)) throw new Error(`Harness payload has no architecture marker: ${markerPath}`)
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker.architecture !== target.id || marker.fnosPlatform !== target.fnosPlatform || marker.nodeArch !== target.nodeArch) {
    throw new Error(`Harness payload architecture mismatch: expected ${target.id}, received ${JSON.stringify(marker)}`)
  }
  const missing = nativePackages(target.nodeArch).filter((path) => !existsSync(join(directory, path)))
  if (missing.length > 0) {
    throw new Error(`Harness payload is missing Linux/${target.nodeArch} native packages: ${missing.join(', ')}`)
  }
  await verifyAttachmentLocalPatch(directory)
  return marker
}

/** Build and prune one architecture-specific Harness payload. */
export async function buildHarnessPayload(options) {
  const target = architectureSpec(options.arch)
  const version = options.version ?? 'latest'
  const dest = options.dest
  if (!options.allowCross) assertNativeTarget(target.id)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  let entry
  if (options.fromSource !== undefined) {
    runChecked(process.env.PNPM ?? 'pnpm', [
      '--filter',
      '@deepseek-ai/dsh',
      'deploy',
      '--prod',
      '--legacy',
      dest,
    ], { cwd: options.fromSource })
    entry = [
      join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(dest, 'lib', 'bin.js'),
    ].find((candidate) => existsSync(candidate))
    if (entry === undefined) throw new Error(`deployed harness has no lib/bin.js under ${dest}`)
  } else {
    await writeFile(join(dest, 'package.json'), `${JSON.stringify({
      name: 'dsh-fnos-harness',
      private: true,
      type: 'module',
    }, undefined, 2)}\n`)
    runChecked(process.env.NPM ?? 'npm', [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--os=linux',
      `--cpu=${target.nodeArch}`,
      '--libc=glibc',
      `@deepseek-ai/dsh@${version}`,
    ], { cwd: dest })
    entry = join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(entry)) throw new Error(`installed harness has no lib/bin.js under ${dest}`)
  }

  await prune(dest)
  await patchAttachmentLocalFsync(dest)
  const relative = entry.slice(dest.length + 1).split('\\').join('/')
  await writeFile(join(dest, 'entry.js'), `import { runCli } from './${relative}'\n\nawait runCli()\n`)
  await writeFile(join(dest, '.dsh-fnos-arch.json'), `${JSON.stringify({
    architecture: target.id,
    fnosPlatform: target.fnosPlatform,
    nodeArch: target.nodeArch,
    harnessVersion: version,
  }, undefined, 2)}\n`)

  // pnpm/npm copy source modes; `trimacl` reports 000 for ACL-managed files.
  await normalizeModes(dest, false)
  await validateHarnessPayload(dest, target.id)
  const smoke = spawnSync(process.execPath, [join(dest, 'entry.js'), '--version'], {
    encoding: 'utf8',
    cwd: dest,
  })
  if (smoke.error !== undefined) throw smoke.error
  if (smoke.status !== 0 || smoke.stdout.trim() === '') {
    throw new Error(`Harness entry smoke test failed (${smoke.status ?? 'signal'}): ${smoke.stderr.trim()}`)
  }
  console.log(`harness payload: ${dest} (${version}, ${target.id})`)
  console.log(`harness entry:   ${relative}`)
  return { dest, entry: relative }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadReleaseConfig()
  const arch = normalizeArchitecture(args.arch ?? process.env.DSH_FNOS_ARCH ?? process.arch)
  const dest = args.dest ?? args.positional[0] ?? join(root, 'packaging', 'fpk', 'app', 'harness')
  return buildHarnessPayload({
    arch,
    dest,
    fromSource: args.fromSource ?? process.env.DSH_HARNESS_SOURCE,
    version: args.version ?? process.env.DSH_HARNESS_VERSION ?? config.harnessVersion,
    allowCross: process.env.DSH_FNOS_ALLOW_CROSS === '1',
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
