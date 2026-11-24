import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { build, root } from './build.mjs'

await build()

const state = join(root, '.local')
await mkdir(state, { recursive: true })

const child = spawn(process.execPath, [join(root, 'dist', 'src', 'index.js')], {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    TRIM_APPNAME: 'dsh-fnos',
    TRIM_APPDEST: join(root, 'packaging', 'fpk', 'app'),
    TRIM_PKGETC: join(state, 'etc'),
    TRIM_PKGVAR: join(state, 'var'),
    TRIM_PKGHOME: join(state, 'home'),
    DSH_FNOS_LISTEN_PORT: process.env.DSH_FNOS_LISTEN_PORT ?? '3081',
    DSH_FNOS_DEV_UID: process.env.DSH_FNOS_DEV_UID ?? '1000',
  },
})

process.on('SIGINT', () => child.kill('SIGINT'))
child.on('exit', (code) => process.exit(code ?? 0))
console.log('dev: http://127.0.0.1:' + (process.env.DSH_FNOS_LISTEN_PORT ?? '3081') + '/')
