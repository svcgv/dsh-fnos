import { mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './build.mjs'

/**
 * Boot the supervisor against a real Harness payload and verify the picker and
 * one project page. Run after `scripts/build-harness-payload.mjs`.
 */
const entry = process.env.DSH_FNOS_HARNESS_ENTRY ?? join(root, 'packaging', 'fpk', 'app', 'harness', 'entry.js')
const port = Number(process.env.DSH_FNOS_SMOKE_PORT ?? 3099)
const state = await mkdtemp(join(tmpdir(), 'dsh-fnos-smoke-'))

const child = spawn(process.execPath, [join(root, 'dist', 'src', 'index.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TRIM_APPNAME: 'dsh-fnos',
    TRIM_APPDEST: join(root, 'packaging', 'fpk', 'app'),
    TRIM_PKGETC: join(state, 'etc'),
    TRIM_PKGVAR: join(state, 'var'),
    TRIM_PKGHOME: join(state, 'home'),
    DSH_FNOS_LISTEN_PORT: String(port),
    DSH_FNOS_DEV_UID: '1000',
    DSH_FNOS_HARNESS_ENTRY: entry,
    DSH_FNOS_START_TIMEOUT_MS: '180000',
  },
})

const logs = []
child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

const base = `http://127.0.0.1:${port}`
const headers = { 'x-trim-userid': '1000', 'x-trim-username': 'svcgv' }

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('supervisor did not become healthy')
}

try {
  await waitForHealth()

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke' }),
  })
  const { project } = await created.json()
  console.log(`smoke: project ${project.id}`)

  const page = await fetch(`${base}/p/${project.id}/`, { headers })
  const body = await page.text()
  console.log(`smoke: page ${page.status} ${page.headers.get('content-type')} ${body.length} bytes`)
  if (page.status !== 200 || !body.includes('__DSH_BOOT__')) {
    throw new Error('project page did not return the Harness shell')
  }
  console.log('smoke: ok')
} catch (error) {
  console.error(String(error))
  console.error(logs.join(''))
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
}
