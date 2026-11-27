#!/usr/bin/env node
// Experimental offline worker. The network namespace isolates the network stack only.
// It does not isolate filesystem access, Unix sockets, or processes sharing the OS UID;
// this is not an MCP server and is not a tenant isolation mechanism.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { createIsolationProbe, spawnIsolatedBrowser } from './isolation.mjs'
import { assertFixtureControl, createFixtureControl, fixtureUrl } from './fixture-http.mjs'
import { cleanupOwnedResources, createOwnedGroupRegistry } from './process-groups.mjs'
import { createLivePanel } from './live-panel.mjs'
import { normalizeBrowserUrl } from './browser-url.mjs'
import { historyTarget, historyAvailability } from './browser-history.mjs'

const root = '/vol1/@appcenter/fygo-browser/app/vendor/runtime'
const executable = `${root}/usr/lib/chromium/chromium`
const libraryPath = [`${root}/usr/lib/x86_64-linux-gnu`, `${root}/lib/x86_64-linux-gnu`, `${root}/usr/lib`, `${root}/usr/lib/chromium`].join(':')
const MAX_INPUT = 128 * 1024
const args=process.argv.slice(2)
const fixtureMode=args.includes('--experimental-private-http-fixture')
const networkMode=args.includes('--experimental-network-browser')
const liveMode=args.includes('--experimental-live-panel')
const validArgs=new Set(args).size===args.length && (args.length===0 || (args.length===1 && args[0]==='--experimental-filesystem-isolation') || (fixtureMode && args.every(arg=>['--experimental-private-http-fixture','--experimental-live-panel'].includes(arg))) || (networkMode && liveMode && args.every(arg=>['--experimental-network-browser','--experimental-live-panel'].includes(arg)))) && (!liveMode || fixtureMode || networkMode)
const isolatedMode = fixtureMode || networkMode || args.includes('--experimental-filesystem-isolation')
let child, temp, session, buffer = Buffer.alloc(0), nextId = 0, sequence = 0, closed = false, fixtureOpened = false
let topFrameId, navigationOrigin, pageTargetId
let cancelRequested = false, stopInput, probe, fixtureControl, groupToken, closePromise
const ownedGroups = createOwnedGroupRegistry()
const startupAbort = new AbortController()
function abortWorker(message) {
  process.exitCode = 1
  cancelRequested = true
  startupAbort.abort(new Error(message))
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)) }
  pending.clear()
  stopInput?.()
}
// Register before creating resources, including throughout asynchronous startup.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abortWorker('worker 已取消'))
function checkCancelled() { if (cancelRequested) throw new Error('启动已取消') }
const pending = new Map()
const events = []
const livePanel=createLivePanel({
  call,
  writeFrame:(event,done)=>process.stdout.write(`${JSON.stringify(event)}\n`,done),
  onError:()=>{if(!closed)process.stdout.write(`${JSON.stringify({event:'live_error',error:'live stream failed'})}\n`)}
})
process.stdout.on('error',()=>abortWorker('worker 输出失败'))
const snapshotKey = `__dsh_${randomBytes(16).toString('hex')}`
const fail = (message) => { throw new Error(message) }
function record(entry) { events.push(entry); if (events.length > 100) events.shift() }
function call(method, params = {}, target = session) {
  if (!child || child.exitCode !== null || closed || cancelRequested) return Promise.reject(new Error('浏览器未运行'))
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器命令超时')) }, 10000)
    pending.set(id, { resolve, reject, timer })
    const message = { id, method, params, ...(target ? { sessionId: target } : {}) }
    child.stdio[3].write(`${JSON.stringify(message)}\0`, (error) => { if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(error) } })
  })
}
function onMessage(message) {
  if (message.id && pending.has(message.id)) {
    const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer)
    if (message.error) p.reject(new Error(`CDP error: ${message.error.message}`)); else p.resolve(message.result)
    return
  }
  if (networkMode && message.method === 'Target.targetCreated' && message.params?.targetInfo?.type === 'page' && message.params.targetInfo.targetId !== pageTargetId) {
    void call('Target.closeTarget', { targetId: message.params.targetInfo.targetId }, null).catch(() => {})
    return
  }
  if (message.sessionId !== session) return
  if (message.method === 'Fetch.requestPaused') {
    const request = message.params
    if (request.frameId === topFrameId && request.resourceType === 'Document') {
      let origin
      try { origin = new URL(request.request.url).origin } catch { origin = undefined }
      if (navigationOrigin !== undefined && origin === navigationOrigin) {
        void call('Fetch.continueRequest', { requestId: request.requestId }).catch(() => {})
      } else {
        record({ type: 'navigation-blocked' })
        void call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      }
    } else {
      void call('Fetch.continueRequest', { requestId: request.requestId }).catch(() => {})
    }
    return
  }
  if (message.method === 'Page.screencastFrame' && liveMode) { livePanel.frame(message.params); return }
  if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) sequence++
  if (message.method === 'Runtime.consoleAPICalled') record({ type: 'console', level: message.params.type })
  if (message.method === 'Runtime.exceptionThrown') record({ type: 'exception' })
  if (message.method === 'Network.responseReceived') record({ type: 'response', status: message.params.response.status })
  if (message.method === 'Network.loadingFailed') record({ type: 'network-failed', canceled: !!message.params.canceled })
}
function waitFixtureReady(process) {
  return new Promise((resolve,reject)=>{
    let text='',done=false
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);startupAbort.signal.removeEventListener('abort',aborted);process.stdio[2].removeListener('data',data);process.removeListener('exit',exited);process.removeListener('error',exited);error?reject(error):resolve()}
    const data=chunk=>{text+=chunk.toString('utf8');if(text.length>16384)return finish(new Error('实验 fixture 启动日志过长'));if(text.split('\n').includes('FIXTURE_READY'))finish()}
    const exited=()=>finish(new Error('实验 fixture 安全检查失败'))
    const aborted=()=>finish(new Error('启动已取消'))
    const timer=setTimeout(()=>finish(new Error('实验 fixture 启动超时')),10000)
    process.stdio[2].on('data',data);process.once('exit',exited);process.once('error',exited);startupAbort.signal.addEventListener('abort',aborted,{once:true})
    if(startupAbort.signal.aborted)aborted();else if(process.exitCode!==null||process.signalCode!==null)exited()
  })
}
async function checkFixtureSandbox() {
  const {targetId}=await call('Target.createTarget',{url:'chrome://sandbox'},null)
  try{
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true},null)
    let status=''
    for(let i=0;i<40;i++){
      const r=await call('Runtime.evaluate',{expression:'document.body?.innerText || ""',returnByValue:true},sessionId)
      status=r.result?.value||''
      if(/Seccomp-BPF sandbox\s+Yes/.test(status))break
      await new Promise(resolve=>setTimeout(resolve,50))
    }
    if(!/Layer 1 Sandbox\s+Namespace/.test(status)||!/PID namespaces\s+Yes/.test(status)||!/Network namespaces\s+Yes/.test(status)||!/Seccomp-BPF sandbox\s+Yes/.test(status))throw new Error('实验 fixture Chromium 沙箱检查失败')
  } finally { await call('Target.closeTarget',{targetId},null).catch(()=>{}) }
}
async function start() {
  checkCancelled()
  temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-worker-'))
  checkCancelled()
  await mkdir(path.join(temp, 'home'), { mode: 0o700 })
  checkCancelled()
  // No inherited credentials, proxies or sockets. fd 3/4 are CDP pipes only.
  const env = { HOME: path.join(temp, 'home'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: libraryPath }
  let fixtureReady
  if (isolatedMode) {
    const isolatedRoot = path.join(temp, 'root')
    await mkdir(isolatedRoot, {mode:0o700})
    checkCancelled()
    probe = await createIsolationProbe(startupAbort.signal)
    checkCancelled()
    if (fixtureMode) { fixtureControl = await createFixtureControl(startupAbort.signal); assertFixtureControl(fixtureControl) }
    checkCancelled()
    child = spawnIsolatedBrowser(isolatedRoot, probe, fixtureControl, { hostNetwork: networkMode })
    child.on('error',()=>{})
    if (child.pid) { groupToken=ownedGroups.register(child); ownedGroups.assertReady(groupToken) }
    if (fixtureMode) fixtureReady = waitFixtureReady(child)
    else child.stdio[2].resume()
  } else {
    child = spawn('/usr/bin/unshare', ['--user', '--map-current-user', '--net', executable, '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-pipe', `--user-data-dir=${temp}/profile`, 'about:blank'], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    child.on('error',()=>{})
    if (child.pid) { groupToken=ownedGroups.register(child); ownedGroups.assertReady(groupToken) }
  }
  child.stdio[3].on('error', () => {})
  child.stdio[4].on('error', () => {})
  child.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 20 * 1024 * 1024) { abortWorker('浏览器消息过大'); return }
    let index
    while ((index = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0, index); buffer = buffer.subarray(index + 1)
      try { onMessage(JSON.parse(frame.toString('utf8'))) } catch { abortWorker('浏览器消息无效'); return }
    }
  })
  child.on('error', () => {})
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('浏览器启动失败或已退出；网络隔离可能不可用')) }; pending.clear() })
  if (fixtureReady) { await fixtureReady; assertFixtureControl(fixtureControl) }
  await call('Browser.getVersion', {}, null)
  if (fixtureMode) await checkFixtureSandbox()
  if (probe) { await probe.dispose(); probe = undefined }
  if (fixtureControl) { await fixtureControl.dispose(); fixtureControl = undefined }
  checkCancelled()
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null)
  pageTargetId = targetId
  ;({ sessionId: session } = await call('Target.attachToTarget', { targetId, flatten: true }, null))
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable')
  topFrameId = (await call('Page.getFrameTree')).frameTree.frame.id
  if (networkMode) {
    await call('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    await call('Target.setDiscoverTargets', { discover: true }, null)
  }
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 5000 })
  if (r.exceptionDetails) fail('页面执行失败')
  return r.result.value
}
const query = `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}).slice(0,100)`
async function execute(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('无效请求')
  switch (request.op) {
    case 'open_test_site': {
      if (!fixtureMode || Object.keys(request).some(key=>key!=='op' && key!=='id')) fail('不支持的操作')
      fixtureOpened=false
      events.length = 0
      const navigation = await call('Page.navigate', {url:fixtureUrl})
      if (navigation.errorText || !navigation.frameId || !navigation.loaderId) fail('固定测试页导航失败')
      for (let i=0;i<100;i++) {
        const before=(await call('Page.getFrameTree')).frameTree.frame
        if (before.id===navigation.frameId && before.loaderId===navigation.loaderId && before.url===fixtureUrl) {
          const ready=await evaluate(`document.readyState === "complete" && location.href === ${JSON.stringify(fixtureUrl)}`)
          const after=(await call('Page.getFrameTree')).frameTree.frame
          if (ready && after.id===navigation.frameId && after.loaderId===navigation.loaderId && after.url===fixtureUrl) {fixtureOpened=true;return {fixture:true}}
        }
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      fail('固定测试页加载超时或导航已改变')
    }
    case 'open': {
      if (fixtureMode) fail('实验 fixture 模式不接受 HTML 或 URL')
      if (typeof request.html !== 'string' || Buffer.byteLength(request.html) > 65536) fail('仅允许 64 KiB 以内的离线 HTML')
      events.length = 0
      const navigation = await call('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(request.html)}` })
      if (navigation.errorText || !navigation.frameId || !navigation.loaderId) fail('页面导航失败')
      // A prior data: page may already be complete; require this navigation's loader
      // both before and after evaluating readiness, otherwise fail closed on redirects.
      for (let i = 0; i < 100; i++) {
        const before = (await call('Page.getFrameTree')).frameTree.frame
        if (before.id === navigation.frameId && before.loaderId === navigation.loaderId) {
          const ready = await evaluate('document.readyState === "complete" && location.protocol === "data:"')
          const after = (await call('Page.getFrameTree')).frameTree.frame
          if (ready && after.id === navigation.frameId && after.loaderId === navigation.loaderId) return { offline: true }
        }
        await new Promise(r => setTimeout(r, 25))
      }
      fail('页面加载超时或导航已改变')
    }
    case 'navigate': {
      if (!networkMode) fail('当前浏览器模式不允许网络导航')
      if (Object.keys(request).some(key => !['id', 'op', 'url'].includes(key))) fail('访问请求包含未知字段')
      const url = normalizeBrowserUrl(request.url)
      const requested = new URL(url)
      navigationOrigin = requested.origin
      const before = await call('Page.getFrameTree')
      topFrameId = before.frameTree.frame.id
      const navigation = await call('Page.navigate', { url })
      if (navigation.errorText || !navigation.frameId || !navigation.loaderId) fail(`页面打开失败：${navigation.errorText ?? '未知错误'}`)
      const deadline = Date.now() + 20_000
      let state
      for (;;) {
        state = await evaluate(`({href:location.href,title:document.title,ready:document.readyState})`)
        const frame = (await call('Page.getFrameTree')).frameTree.frame
        if (frame.id === navigation.frameId && frame.loaderId === navigation.loaderId && state.ready !== 'loading') break
        if (Date.now() >= deadline) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const finalUrl = typeof state?.href === 'string' ? state.href : url
      let finalOrigin
      try { finalOrigin = new URL(finalUrl).origin } catch { finalOrigin = undefined }
      if (finalOrigin !== navigationOrigin) fail('页面跳转到了未获批准的其他网站，已停止')
      return { url: finalUrl, title: typeof state?.title === 'string' ? state.title : '', loading: state?.ready === 'loading' }
    }
    case 'browser_navigation': {
      if (!networkMode) fail('当前浏览器模式不允许网络导航')
      if (Object.keys(request).some(key => !['id', 'op', 'direction'].includes(key)) || !['back', 'forward', 'reload'].includes(request.direction)) fail('浏览器导航请求无效')
      // Never grant a history entry a broader scheme or redirect policy than a
      // typed URL. In particular, Chromium's initial about:blank is not revisited.
      const entry = historyTarget(await call('Page.getNavigationHistory'), request.direction)
      navigationOrigin = new URL(entry.url).origin
      topFrameId = (await call('Page.getFrameTree')).frameTree.frame.id
      if (request.direction === 'reload') await call('Page.reload')
      else await call('Page.navigateToHistoryEntry', { entryId: entry.id })
      return { url: entry.url, title: entry.title, loading: true }
    }
    case 'browser_history': {
      if (!networkMode || Object.keys(request).some(key => !['id', 'op'].includes(key))) fail('浏览器历史请求无效')
      return historyAvailability(await call('Page.getNavigationHistory'))
    }
    case 'snapshot': {
      const elements = await evaluate(`(globalThis[${JSON.stringify(snapshotKey)}]=${query}).map((e,i)=>({index:i,tag:e.tagName.toLowerCase(),text:e.tagName==='INPUT'&&e.type==='password'?'[REDACTED]':(e.innerText||e.value||e.getAttribute('aria-label')||'').slice(0,200)}))`)
      return { generation: sequence, elements }
    }
    case 'click':
    case 'fill': {
      if (!Number.isInteger(request.generation) || request.generation !== sequence || !Number.isInteger(request.index) || request.index < 0 || request.index >= 100) fail('元素引用无效或已过期')
      if (request.op === 'fill' && (typeof request.value !== 'string' || request.value.length > 4096)) fail('输入内容无效')
      const body = request.op === 'click' ? 'e.click()' : `if(!['INPUT','TEXTAREA'].includes(e.tagName)||['file','password'].includes(e.type))throw Error('unsupported'); e.value=${JSON.stringify(request.value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))`
      const ok = await evaluate(`(()=>{const e=globalThis[${JSON.stringify(snapshotKey)}]?.[${request.index}];if(!e||!e.isConnected||!e.getBoundingClientRect().width||!e.getBoundingClientRect().height||getComputedStyle(e).visibility==='hidden'||getComputedStyle(e).display==='none')throw Error('missing');${body};return true})()`)
      return { ok }
    }
    case 'screenshot': { const r = await call('Page.captureScreenshot', { format: 'png' }); return { mime: 'image/png', base64: r.data } }
    case 'diagnostics': return { events: events.slice() }
    case 'live_start':
      if (!liveMode || (fixtureMode && !fixtureOpened)) fail('live 需要有效的浏览器模式')
      return await livePanel.start(request)
    case 'live_stop':
      if (!liveMode) fail('不支持的操作')
      return await livePanel.stop(request)
    case 'live_input':
      if (!liveMode) fail('不支持的操作')
      return await livePanel.input(request)
    case 'close': return await close()
    default: fail('不支持的操作')
  }
}
function close() {
  if (closePromise) return closePromise
  closed = true
  livePanel.deactivate()
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('浏览器已关闭')) }
  pending.clear()
  closePromise = cleanupOwnedResources({
    registry:ownedGroups, token:groupToken, temp,
    dispose:[...(probe ? [()=>probe.dispose()] : []), ...(fixtureControl ? [()=>fixtureControl.dispose()] : [])]
  }).then(result=>{
    if(!result.closed) {
      process.exitCode=1
      process.stderr.write(`worker: cleanup unconfirmed: ${result.error}; retained directory: ${result.temporaryDirectory ?? '(none)'}\n`)
    }
    return result
  })
  return closePromise
}
let queue = Promise.resolve()
try {
  if (!validArgs) throw new Error('不支持的启动参数')
  await start()
  checkCancelled()
  // Enforce the byte limit before readline buffers a line, including input with no newline.
  let lineBytes = 0
  const bounded = new Transform({ transform(chunk, encoding, done) {
    for (const byte of chunk) {
      if (byte === 10) lineBytes = 0
      else if (++lineBytes > MAX_INPUT) return done(new Error('请求行超过大小限制'))
    }
    done(null, chunk)
  } })
  const rl = readline.createInterface({ input: bounded, crlfDelay: Infinity })
  rl.on('error', () => {}) // The bounded stream's handler below reports and closes.
  let stopped = false, inputEnded = false
  rl.once('close', () => { inputEnded = true })
  const stop = () => { stopped = true; process.stdin.unpipe(bounded); process.stdin.destroy(); rl.close() }
  stopInput = stop
  bounded.on('error', error => { process.stderr.write(`worker: ${error.message}\n`); process.exitCode = 1; stop() })
  rl.on('line', line => {
    rl.pause()
    queue = queue.then(async () => {
      let request
      try { request = JSON.parse(line); const result = await execute(request); process.stdout.write(`${JSON.stringify({ id: request.id ?? null, result })}\n`); if (request.op === 'close') stop() }
      catch (error) { process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, error: String(error.message || error) })}\n`) }
      finally { if (!stopped && !inputEnded) rl.resume() }
    })
  })
  const inputClosed = new Promise(resolve => rl.once('close', resolve))
  process.stdin.pipe(bounded)
  await inputClosed; await queue
} catch (error) { process.stderr.write(`worker: ${error.message}\n`); process.exitCode = 1 }
finally { await close() }
