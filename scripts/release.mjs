import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './build.mjs'
import { buildHarnessPayload } from './build-harness-payload.mjs'
import { packageFpk } from './package.mjs'
import {
  architectureSpec,
  assertNativeTarget,
  loadReleaseConfig,
  normalizeArchitecture,
} from './release-config.mjs'

function parseArch(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--arch') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--arch requires a value')
      return value
    }
    if (argv[index].startsWith('--')) throw new Error(`unknown argument ${argv[index]}`)
  }
  return process.env.DSH_FNOS_ARCH ?? process.arch
}

async function main() {
  const config = await loadReleaseConfig()
  const arch = normalizeArchitecture(parseArch(process.argv.slice(2)))
  const target = architectureSpec(arch)
  assertNativeTarget(target.id)
  const payload = join(root, '.local', 'build', `harness-${target.id}`)
  await buildHarnessPayload({
    arch: target.id,
    version: config.harnessVersion,
    dest: payload,
  })
  const result = await packageFpk({
    arch: target.id,
    harnessDir: payload,
    nodeVersion: config.nodeVersion,
    allowMissingPayload: false,
    withoutNode: false,
  })
  console.log(`release: ${target.id} ready -> ${result.artifact}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
