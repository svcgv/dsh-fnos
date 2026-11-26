import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ExperimentalBrowserAcceptance, ExperimentalBrowserHarnessTestManager, type ExperimentalHarnessMockBackend, type ExperimentalHarnessMockSpec } from '../src/experimental-browser-harness.ts'
import type { Identity } from '../src/identity.ts'

const admin: Identity = { uid: '1000', username: 'tester', isAdmin: true }

async function fixture(t: TestContext): Promise<{ root: string; home: string; dest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exp-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const home = join(root, 'app-home'), dest = join(root, 'app-dest')
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(dest, 'harness', 'browser-plugin'), { recursive: true })
  await writeFile(join(dest, 'harness', 'entry.js'), '// test-only, never executed')
  await writeFile(join(dest, 'harness', 'browser-plugin', 'acceptance.patch.yml'), '[]\n')
  return { root, home, dest }
}

function backend(options: { ready?: (signal: AbortSignal) => Promise<{ port: number; authenticated: boolean }>; stop?: () => Promise<void>; exited?: Promise<void>; port?: number } = {}): { driver: ExperimentalHarnessMockBackend; specs: ExperimentalHarnessMockSpec[]; stops: () => number; launched: Promise<void> } {
  const specs: ExperimentalHarnessMockSpec[] = []
  let stopCount = 0, notifyLaunch: () => void = () => {}
  const launched = new Promise<void>(resolvePromise => { notifyLaunch = resolvePromise })
  const driver: ExperimentalHarnessMockBackend = {
    kind: 'mock-only',
    allocatePort: () => options.port ?? 12345,
    launch(spec) {
      specs.push(spec)
      notifyLaunch()
      return {
        exited: options.exited ?? new Promise<void>(() => {}),
        ready: options.ready ?? (async () => ({ port: spec.port, authenticated: true })),
        async stop() { stopCount++; await options.stop?.() },
      }
    },
  }
  return { driver, specs, stops: () => stopCount, launched }
}

function manager(home: string, dest: string, driver?: ExperimentalHarnessMockBackend): ExperimentalBrowserHarnessTestManager {
  return new ExperimentalBrowserHarnessTestManager({ appHome: home, appDest: dest, enabled: true, allowUid: '1000', ...(driver === undefined ? {} : { backend: driver }), timeoutMs: 100 })
}

const installedHarnessModules = '/vol1/@appcenter/dsh-fnos/harness/node_modules'
test('real Cordis applies isolated acceptance overlay and fixed scripted model', { timeout: 30000, skip: !existsSync(installedHarnessModules) }, async t => {
  const { root } = await fixture(t)
  const pluginDir = join(root, 'plugin'), home = join(root, 'isolated-home')
  await mkdir(pluginDir); await mkdir(home)
  for (const name of ['acceptance.patch.yml', 'acceptance-model.mjs', 'index.mjs', 'runtime.mjs', 'worker-client.mjs']) {
    await copyFile(join(process.cwd(), 'browser-plugin', name), join(pluginDir, name))
  }
  await symlink(installedHarnessModules, join(root, 'node_modules'), 'dir')
  if (process.env.DSH_FNOS_TEST_REAL_FIXTURE === '1') await symlink(join(process.cwd(), 'browser-worker'), join(root, 'browser-worker'), 'dir')
  const config = join(root, 'root.yml')
  await writeFile(config, '[]\n')
  const script = `
    import assert from 'node:assert/strict'
    import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
    import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
    import Tools from '@deepseek-ai/dsh-tools'
    import Sessions from '@deepseek-ai/dsh-session'
    import Projections from '@deepseek-ai/dsh-session-projection'
    import Agents from '@deepseek-ai/dsh-agent'
    import Llm from '@deepseek-ai/dsh-llm'
    import Loop from '@deepseek-ai/dsh-agent-loop'
    const ctx = await boot('acceptance-test', process.cwd() + '/root.yml', loadOverlayPatches('acceptance-test', process.cwd() + '/plugin/acceptance.patch.yml'), async ctx => {
      for (const [p,c] of [[SystemPrompt,{}],[Tools,{}],[Sessions,{}],[Projections,{}],[Agents,{}],[Llm,{}],[Loop,{}]]) await ctx.plugin(p,c)
    })
    let agent
    try {
      assert.equal(ctx.get('sessionPersistence'),undefined)
      assert(ctx.llm.listProviders().some(x=>x.id==='acceptance-offline'))
      assert((await ctx.llm.listModels('acceptance-offline')).some(x=>x.id==='fixture-v1'))
      agent=await ctx.agents.create({sessionId:'acceptance-test-agent'})
      const browser=ctx.tools.get('browser_offline_prototype',agent.agent)
      assert(browser)
      assert.deepEqual(browser.parameters.properties.action.enum,['open_test_site'])
      await assert.rejects(browser.execute({action:'open',html:'<p>no</p>'},{agent:agent.agent,signal:new AbortController().signal}))
      if(process.env.DSH_FNOS_TEST_REAL_FIXTURE === '1') {
        const response=await browser.execute({action:'open_test_site'},{agent:agent.agent,signal:new AbortController().signal})
        assert.equal(response.content[0].text,'{"fixture":true}')
        console.log('real agent fixture tool returned {"fixture":true}')
      }
      const { OfflineAcceptanceAdapter } = await import('./plugin/acceptance-model.mjs')
      const adapter = new OfflineAcceptanceAdapter()
      const req={provider:'acceptance-offline',model:'fixture-v1',messages:[{role:'user',content:[{type:'text',text:'https://untrusted.invalid'}]}],tools:[{name:'browser_offline_prototype'}]}
      const chunks=[];for await(const chunk of adapter.stream(req)) chunks.push(chunk)
      const routed=[];for await(const chunk of ctx.llm.stream(req)) routed.push(chunk)
      assert(routed.some(c=>c.type==='block-end'&&c.block.type==='tool-call'))
      const call=chunks.find(c=>c.type==='block-end'&&c.block.type==='tool-call').block
      assert.equal(call.name,'browser_offline_prototype')
      assert.deepEqual(JSON.parse(call.arguments),{action:'open_test_site'})
      assert(!call.arguments.includes('untrusted.invalid'))
      const next={...req,messages:[...req.messages,{role:'assistant',source:{provider:'acceptance-offline'},content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'{"fixture":true}'}]}]}
      const final=[];for await(const chunk of adapter.stream(next)) final.push(chunk)
      assert(final.some(c=>c.type==='text-delta'&&c.text.includes('内置验收固定页已打开')))
      assert(!final.some(c=>c.type==='tool-call-delta'))
      next.messages[2].isError=true
      const failed=[];for await(const chunk of adapter.stream(next)) failed.push(chunk)
      assert(failed.some(c=>c.type==='text-delta'&&c.text.includes('无法确认')))
      assert(!failed.some(c=>c.type==='text-delta'&&c.text.includes('已打开；')))
      console.log('isolated acceptance patch loaded')
    } finally { await agent?.dispose(); await ctx.fiber.dispose() }
  `
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'), TMPDIR: home, LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib', DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1', ...(process.env.DSH_FNOS_TEST_REAL_FIXTURE === '1' ? { DSH_FNOS_TEST_REAL_FIXTURE: '1' } : {}) },
    encoding: 'utf8', timeout: 25000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /isolated acceptance patch loaded/u)
  if (process.env.DSH_FNOS_TEST_REAL_FIXTURE === '1') {
    assert.match(result.stdout, /real agent fixture tool returned/u)
    console.log('real agent fixture tool returned {"fixture":true}')
  }
})

test('real supervisor uses a disposable fake loopback process and retains manifest', { timeout: 20000 }, async t => {
  const { home, dest } = await fixture(t)
  const previous = process.env.DSH_FNOS_BROWSER_ACCEPTANCE
  const oldSecret = process.env.TEST_PRIVATE_SECRET, oldTrim = process.env.TRIM_GATEWAY_SECRET
  process.env.DSH_FNOS_BROWSER_ACCEPTANCE = '1'; process.env.TEST_PRIVATE_SECRET = 'should-not-pass'; process.env.TRIM_GATEWAY_SECRET = 'should-not-pass'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_FNOS_BROWSER_ACCEPTANCE; else process.env.DSH_FNOS_BROWSER_ACCEPTANCE = previous
    if (oldSecret === undefined) delete process.env.TEST_PRIVATE_SECRET; else process.env.TEST_PRIVATE_SECRET = oldSecret
    if (oldTrim === undefined) delete process.env.TRIM_GATEWAY_SECRET; else process.env.TRIM_GATEWAY_SECRET = oldTrim
  })
  await writeFile(join(dest, 'harness', 'browser-plugin', 'acceptance.patch.yml'), '# fixed-private-fixture-reviewed-v1\n')
  if (existsSync('/var/apps/dsh-fnos/target/runtime')) await symlink('/var/apps/dsh-fnos/target/runtime', join(dest, 'runtime'), 'dir')
  await writeFile(join(dest, 'harness', 'entry.js'), `
    import http from 'node:http';
    if(process.env.TRIM_GATEWAY_SECRET || process.env.TEST_PRIVATE_SECRET || process.env.HTTPS_PROXY || process.env.http_proxy) process.exit(88);
    const port=Number(process.argv[process.argv.indexOf('--port')+1]);
    const token='abcdefghijklmnopqrstuvwxyz012345';
    const server=http.createServer((req,res)=>{
      if(req.url==='/?token='+token){res.setHeader('set-cookie','session=isolated-cookie; HttpOnly');res.statusCode=302;res.end();return}
      if(req.headers.cookie==='session=isolated-cookie'){res.end('ok');return}
      res.statusCode=401;res.end();
    });server.listen(port,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+port+'/?token='+token));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `)
  const acceptance = new ExperimentalBrowserAcceptance({ appHome: home, appDest: dest, uid: '1000', enabled: true, timeoutMs: 5000 })
  await assert.rejects(acceptance.open({ ...admin, isAdmin: false }), /not authorized/u)
  await assert.rejects(acceptance.open({ ...admin, uid: '2' }), /not authorized/u)
  const [first, second] = await Promise.all([acceptance.open(admin), acceptance.open(admin)])
  assert.equal(first, second)
  assert.equal(first.cookie, 'session=isolated-cookie')
  assert.equal(await first.reauthenticate(), 'session=isolated-cookie')
  assert.equal((await fetch(`http://127.0.0.1:${first.port}/`, { headers: { cookie: first.cookie! } })).status, 200)
  await Promise.all([acceptance.close(admin), acceptance.close(admin)])
  await acceptance.close(admin)
  assert.equal(first.cookie, undefined)
  assert.equal(await first.reauthenticate(), undefined)
  await assert.rejects(fetch(`http://127.0.0.1:${first.port}/`))
  const instances = await readdir(join(home, 'experimental-browser-tmp'))
  assert.equal(instances.length, 1)
  const manifest = await readFile(join(home, 'experimental-browser-tmp', instances[0]!, 'manifest.json'), 'utf8')
  assert.match(manifest, /stopped-group-only/u)
  assert.match(manifest, /full process-tree cleanup is unproven/u)
  assert(!manifest.includes('abcdefghijklmnopqrstuvwxyz012345'))
  assert(!manifest.includes('isolated-cookie'))
})

test('real supervisor cancellation kills its own process group and records failure', { timeout: 15000 }, async t => {
  const { home, dest } = await fixture(t)
  const previous = process.env.DSH_FNOS_BROWSER_ACCEPTANCE
  process.env.DSH_FNOS_BROWSER_ACCEPTANCE = '1'
  t.after(() => { if (previous === undefined) delete process.env.DSH_FNOS_BROWSER_ACCEPTANCE; else process.env.DSH_FNOS_BROWSER_ACCEPTANCE = previous })
  await writeFile(join(dest, 'harness', 'browser-plugin', 'acceptance.patch.yml'), '# fixed-private-fixture-reviewed-v1\n')
  if (existsSync('/var/apps/dsh-fnos/target/runtime')) await symlink('/var/apps/dsh-fnos/target/runtime', join(dest, 'runtime'), 'dir')
  await writeFile(join(dest, 'harness', 'entry.js'), `import { writeFileSync } from 'node:fs';writeFileSync(process.env.HOME+'/started','yes');setInterval(()=>{},1000)`)
  const acceptance = new ExperimentalBrowserAcceptance({ appHome: home, appDest: dest, uid: '1000', enabled: true, timeoutMs: 10000 })
  const controller = new AbortController()
  const started = acceptance.open(admin, controller.signal)
  const deadline = Date.now() + 4000
  let path: string | undefined
  while (Date.now() < deadline) {
    const names = await readdir(join(home, 'experimental-browser-tmp')).catch(() => [])
    if (names.length === 1) {
      path = join(home, 'experimental-browser-tmp', names[0]!)
      try { await access(join(path, 'home', 'started')); break } catch { /* child not yet started */ }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  assert(path !== undefined)
  await access(join(path, 'home', 'started'))
  controller.abort()
  await assert.rejects(started, /cancelled|timed out/u)
  const manifest = await readFile(join(path, 'manifest.json'), 'utf8')
  assert.match(manifest, /startup-failed-stopped-group-only/u)
  await acceptance.close(admin)
})

test('opt-in real DSH disposable web startup and group stop', { timeout: 90000, skip: process.env.DSH_FNOS_REAL_ACCEPTANCE_SMOKE !== '1' || !existsSync(installedHarnessModules) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-acceptance-'))
  const home = join(root, 'app-home'), dest = join(root, 'app-dest'), harness = join(dest, 'harness')
  await mkdir(home, { mode: 0o700 }); await mkdir(join(harness, 'browser-plugin'), { recursive: true })
  await copyFile('/vol1/@appcenter/dsh-fnos/harness/entry.js', join(harness, 'entry.js'))
  for (const name of ['acceptance.patch.yml', 'acceptance-model.mjs', 'index.mjs', 'runtime.mjs', 'worker-client.mjs']) await copyFile(join(process.cwd(), 'browser-plugin', name), join(harness, 'browser-plugin', name))
  await symlink(installedHarnessModules, join(harness, 'node_modules'), 'dir')
  await symlink(join(process.cwd(), 'browser-worker'), join(harness, 'browser-worker'), 'dir')
  if (existsSync('/var/apps/dsh-fnos/target/runtime')) await symlink('/var/apps/dsh-fnos/target/runtime', join(dest, 'runtime'), 'dir')
  const previous = process.env.DSH_FNOS_BROWSER_ACCEPTANCE
  process.env.DSH_FNOS_BROWSER_ACCEPTANCE = '1'
  t.after(() => { if (previous === undefined) delete process.env.DSH_FNOS_BROWSER_ACCEPTANCE; else process.env.DSH_FNOS_BROWSER_ACCEPTANCE = previous })
  const acceptance = new ExperimentalBrowserAcceptance({ appHome: home, appDest: dest, uid: '1000', enabled: true, timeoutMs: 60000 })
  let port: number | undefined
  console.log(`retained smoke test root: ${root}`)
  try {
    const session = await acceptance.open(admin)
    port = session.port
    assert(session.cookie)
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: session.cookie } })).status, 200)
    assert(await session.reauthenticate())
    console.log(`real acceptance web ready on 127.0.0.1:${port}`)
  } finally { await acceptance.stopAll() }
  assert(port !== undefined)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
  const names = await readdir(join(home, 'experimental-browser-tmp'))
  assert.equal(names.length, 1)
  const manifestPath = join(home, 'experimental-browser-tmp', names[0]!, 'manifest.json')
  const manifest = await readFile(manifestPath, 'utf8')
  assert.match(manifest, /stopped-(?:forced-)?group-only/u)
  console.log(`retained acceptance manifest: ${manifestPath}`)
})

test('real supervisor stays closed without reviewed fixture marker', async t => {
  const { home, dest } = await fixture(t)
  const previous = process.env.DSH_FNOS_BROWSER_ACCEPTANCE
  process.env.DSH_FNOS_BROWSER_ACCEPTANCE = '1'
  t.after(() => { if (previous === undefined) delete process.env.DSH_FNOS_BROWSER_ACCEPTANCE; else process.env.DSH_FNOS_BROWSER_ACCEPTANCE = previous })
  const acceptance = new ExperimentalBrowserAcceptance({ appHome: home, appDest: dest, uid: '1000', enabled: true })
  await assert.rejects(acceptance.open(admin), /private fixed-page browser plugin not verified/u)
  await assert.rejects(access(join(home, 'experimental-browser-tmp')))
  await acceptance.close(admin)
})

test('defaults reject, admin and exact configured uid are mandatory', async t => {
  const { home, dest } = await fixture(t)
  const mock = backend()
  const disabled = new ExperimentalBrowserHarnessTestManager({ appHome: home, appDest: dest, backend: mock.driver })
  await assert.rejects(disabled.start(admin), /not authorized/u)
  await assert.rejects(manager(home, dest).start(admin), /real launch is disabled/u)
  const current = manager(home, dest, mock.driver)
  await assert.rejects(current.start({ ...admin, isAdmin: false }), /not authorized/u)
  await assert.rejects(current.start({ ...admin, uid: '2000' }), /not authorized/u)
  assert.equal(mock.specs.length, 0)
  await assert.rejects(access(join(home, 'experimental-browser-tmp')))
})

test('mock launch has fixed overlay, isolated paths, minimal environment, and cleans up', async t => {
  const { home, dest, root } = await fixture(t)
  const outside = join(root, 'existing-user-profile')
  await writeFile(outside, 'do-not-touch')
  const mock = backend(), current = manager(home, dest, mock.driver)
  const handle = await current.start(admin)
  assert.deepEqual(handle, { uid: '1000', port: 12345 })
  assert.equal(mock.specs.length, 1)
  const spec = mock.specs[0]
  assert.ok(spec)
  assert.deepEqual(spec.args, [join(dest, 'harness', 'entry.js'), '--profile', 'web', '--patch', join(dest, 'harness', 'browser-plugin', 'acceptance.patch.yml'), '--no-open', '--port', '12345'])
  const instance = await readdir(join(home, 'experimental-browser-tmp'))
  assert.equal(instance.length, 1)
  const privateRoot = join(home, 'experimental-browser-tmp', instance[0] as string)
  assert.equal(spec.cwd, join(privateRoot, 'workspace'))
  assert.equal(spec.env.DSH_HOME, join(privateRoot, 'dsh-home'))
  assert.equal(spec.env.DSH_AGENTS_HOME, join(privateRoot, 'agents-home'))
  assert.equal(spec.env.HOME, join(privateRoot, 'home'))
  assert.equal(spec.env.TMPDIR, join(privateRoot, 'tmp'))
  assert.deepEqual(Object.keys(spec.env).sort(), ['DSH_AGENTS_HOME', 'DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT', 'DSH_HOME', 'HOME', 'LANG', 'PATH', 'PWD', 'TMPDIR'].sort())
  assert.equal(Object.keys(spec.env).some(name => /TRIM_|KEY|SECRET|TOKEN|PROXY/iu.test(name)), false)
  await assert.rejects(current.start(admin), /already active/u)
  await current.stop(admin)
  await current.stop(admin)
  assert.equal(mock.stops(), 1)
  assert.deepEqual(await readdir(join(home, 'experimental-browser-tmp')), [])
  assert.equal(await readFile(outside, 'utf8'), 'do-not-touch')
})

test('concurrent cancellation stops only the owned mock and allows later start', async t => {
  const { home, dest } = await fixture(t)
  let pending = true
  const mock = backend({ ready: async signal => {
    if (!pending) return { port: 12345, authenticated: true }
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } })
  const current = manager(home, dest, mock.driver)
  const start = current.start(admin)
  // Wait for mock launch without touching the real network or spawning processes.
  await mock.launched
  await assert.rejects(current.start(admin), /already active/u)
  const stopping = current.stop(admin)
  await assert.rejects(start, /cancelled/u)
  await stopping
  assert.equal(mock.stops(), 1)
  pending = false
  await current.start(admin)
  await current.stop(admin)
  assert.equal(mock.stops(), 2)
})

test('readiness/authentication and invalid port fail closed', async t => {
  const { home, dest } = await fixture(t)
  const badAuth = backend({ ready: async () => ({ port: 12345, authenticated: false }) })
  await assert.rejects(manager(home, dest, badAuth.driver).start(admin), /authentication/u)
  assert.equal(badAuth.stops(), 1)
  const badPort = backend({ port: 0 })
  await assert.rejects(manager(home, dest, badPort.driver).start(admin), /invalid mock loopback port/u)
  assert.equal(badPort.specs.length, 0)
  assert.deepEqual(await readdir(join(home, 'experimental-browser-tmp')), [])
})

test('mock readiness timeout confirms stop and removes owned data', async t => {
  const { home, dest } = await fixture(t)
  const mock = backend({ ready: async () => new Promise(() => {}) })
  const current = new ExperimentalBrowserHarnessTestManager({ appHome: home, appDest: dest, enabled: true, allowUid: '1000', backend: mock.driver, timeoutMs: 25 })
  // Keep the event loop alive while the unrefed timeout exercises this path.
  const keepAlive = setTimeout(() => {}, 500)
  try { await assert.rejects(current.start(admin), /timeout/iu) } finally { clearTimeout(keepAlive) }
  assert.equal(mock.stops(), 1)
  assert.deepEqual(await readdir(join(home, 'experimental-browser-tmp')), [])
})

test('unexpected mock leader exit confirms cleanup before new starts', async t => {
  const { home, dest } = await fixture(t)
  let resolveExit: () => void = () => {}, resolveStopped: () => void = () => {}
  const exit = new Promise<void>(resolvePromise => { resolveExit = resolvePromise })
  const stopped = new Promise<void>(resolvePromise => { resolveStopped = resolvePromise })
  const mock = backend({ exited: exit, stop: async () => { resolveStopped() } })
  const current = manager(home, dest, mock.driver)
  await current.start(admin)
  resolveExit()
  await stopped
  // Wait for the already-started owned filesystem cleanup, without polling.
  await current.stop(admin)
  assert.equal(mock.stops(), 1)
  assert.deepEqual(await readdir(join(home, 'experimental-browser-tmp')), [])
})

test('a linked fixed overlay is rejected before any mock launch', async t => {
  const { home, dest, root } = await fixture(t)
  const overlay = join(dest, 'harness', 'browser-plugin', 'acceptance.patch.yml')
  const outside = join(root, 'outside-overlay.yml')
  await writeFile(outside, '[]')
  await rm(overlay)
  await symlink(outside, overlay)
  const mock = backend()
  await assert.rejects(manager(home, dest, mock.driver).start(admin), /unsafe/u)
  assert.equal(mock.specs.length, 0)
  assert.equal(await readFile(outside, 'utf8'), '[]')
})

test('unconfirmed stop retains private data and blocks subsequent starts', async t => {
  const { home, dest } = await fixture(t)
  const mock = backend({ stop: async () => { throw new Error('cannot confirm stop') } })
  const current = manager(home, dest, mock.driver)
  await current.start(admin)
  await assert.rejects(current.stop(admin), /cannot confirm stop/u)
  assert.equal((await readdir(join(home, 'experimental-browser-tmp'))).length, 1)
  await assert.rejects(current.start(admin), /cleanup is unresolved/u)
  await assert.rejects(current.stop(admin), /cannot confirm stop/u)
  assert.equal(mock.stops(), 1)
})

test('a mock stop timeout retains its directory and prevents reuse', async t => {
  const { home, dest } = await fixture(t)
  const mock = backend({ stop: async () => new Promise(() => {}) })
  const current = new ExperimentalBrowserHarnessTestManager({ appHome: home, appDest: dest, enabled: true, allowUid: '1000', backend: mock.driver, timeoutMs: 25 })
  await current.start(admin)
  const keepAlive = setTimeout(() => {}, 500)
  try { await assert.rejects(current.stop(admin), /timeout/iu) } finally { clearTimeout(keepAlive) }
  assert.equal((await readdir(join(home, 'experimental-browser-tmp'))).length, 1)
  await assert.rejects(current.start(admin), /cleanup is unresolved/u)
  await assert.rejects(current.stop(admin), /timeout/iu)
  assert.equal(mock.stops(), 1)
})

test('cleanup refuses a replaced instance directory and never follows its symlink', async t => {
  const { home, dest, root } = await fixture(t)
  const mock = backend(), current = manager(home, dest, mock.driver)
  await current.start(admin)
  const base = join(home, 'experimental-browser-tmp')
  const entries = await readdir(base)
  const target = join(base, entries[0] as string)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'marker'), 'safe')
  await rename(target, join(base, 'moved-owned-instance'))
  await symlink(outside, target, 'dir')
  await assert.rejects(current.stop(admin), /not private and owned|identity changed/u)
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'safe')
})
