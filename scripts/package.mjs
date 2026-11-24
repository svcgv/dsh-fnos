import { chmod, cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { build, copyTree, normalizeModes, removeTree, root, run } from './build.mjs'

await build()

const fpk = join(root, 'packaging', 'fpk')
const appServer = join(fpk, 'app', 'server')
await removeTree(appServer)
await copyTree(join(root, 'dist', 'src'), appServer)
console.log('package: server staged')

if (process.env.DSH_FNOS_BUNDLE_NODE === '1') {
  const candidates = [process.env.DSH_FNOS_NODE_DIR, join(dirname(dirname(process.execPath)))]
  const source = candidates.find((candidate) => typeof candidate === 'string' && existsSync(join(candidate, 'bin', 'node')))
  if (source === undefined) {
    throw new Error('DSH_FNOS_BUNDLE_NODE=1 but no Node distribution was found; set DSH_FNOS_NODE_DIR')
  }
  const target = join(fpk, 'app', 'runtime', 'node', 'bin')
  await removeTree(join(fpk, 'app', 'runtime'))
  await cp(join(source, 'bin', 'node'), join(target, 'node'))
  await chmod(join(target, 'node'), 0o755)
  await cp(join(source, 'LICENSE'), join(fpk, 'app', 'runtime', 'node', 'LICENSE')).catch(() => undefined)
  const size = (await stat(join(target, 'node'))).size
  console.log(`package: bundled node ${source} (${(size / 1024 / 1024).toFixed(0)} MiB)`)
}

if (!existsSync(join(fpk, 'app', 'harness', 'entry.js'))) {
  console.warn('package: app/harness/entry.js missing; run scripts/build-harness-payload.mjs before publishing')
}

// fnpack copies stat modes verbatim; normalize them first (see docs/development.md).
await normalizeModes(fpk, false)
for (const script of await readdir(join(fpk, 'cmd'))) {
  await chmod(join(fpk, 'cmd', script), 0o755)
}
await chmod(join(fpk, 'manifest'), 0o644)
const bundledNode = join(fpk, 'app', 'runtime', 'node', 'bin', 'node')
if (existsSync(bundledNode)) await chmod(bundledNode, 0o755)

run(process.env.FNPACK ?? 'fnpack', ['build', '--directory', fpk])

const manifest = await readFile(join(fpk, 'manifest'), 'utf8')
const appName = /^appname\s*=\s*(\S+)/mu.exec(manifest)?.[1]
const produced = appName === undefined ? undefined : join(root, `${appName}.fpk`)
if (produced !== undefined && existsSync(produced)) {
  await mkdir(join(root, 'dist'), { recursive: true })
  const artifact = join(root, 'dist', `${appName}.fpk`)
  await cp(produced, artifact)
  await chmod(artifact, 0o644)
  await removeTree(produced)
  console.log(`package: ${artifact}`)
}
