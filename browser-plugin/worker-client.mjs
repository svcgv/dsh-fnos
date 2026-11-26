import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

// The path is fixed by the installed source tree, never by a model argument.
const WORKER = fileURLToPath(new URL('../browser-worker/worker.mjs', import.meta.url))
const LIMIT = 20 * 1024 * 1024
const FILESYSTEM_ISOLATION = '--experimental-filesystem-isolation'
const FIXTURE_ISOLATION = '--experimental-private-http-fixture'
const NETWORK_BROWSER = '--experimental-network-browser'
// Screencast plus input injection; the live panel pairs with fixture or network browser mode.
const LIVE_PANEL = '--experimental-live-panel'
// The worker never inherits the Host environment. The acceptance instance's
// supervisor sets a private 0700 TMPDIR; passing only that one variable keeps
// fixture temp roots (and any retained failure residue) inside the retained
// acceptance directory instead of the Host default /tmp.
const BASE_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib' })

/** Exactly one mode switch, chosen by trusted host environment, never by tool input. */
export function workerArgs(acceptanceFixture = false, livePanel = false, networkBrowser = false) {
  if (typeof acceptanceFixture !== 'boolean') throw new Error('无效的验收固定页模式配置')
  if (typeof livePanel !== 'boolean') throw new Error('无效的可见面板模式配置')
  if (typeof networkBrowser !== 'boolean') throw new Error('无效的网络浏览模式配置')
  if (acceptanceFixture && networkBrowser) throw new Error('固定测试页模式与网络浏览模式不能同时启用')
  if (livePanel && !acceptanceFixture && !networkBrowser) throw new Error('可见面板模式必须与浏览器模式同时启用')
  const args = [WORKER, networkBrowser ? NETWORK_BROWSER : acceptanceFixture ? FIXTURE_ISOLATION : FILESYSTEM_ISOLATION]
  if (livePanel) args.push(LIVE_PANEL)
  return args
}

/** The only parent variable an isolated browser worker may inherit: a private tmp root. */
export function workerEnv(acceptanceFixture = false, env = process.env, networkBrowser = false) {
  if (typeof acceptanceFixture !== 'boolean') throw new Error('无效的验收固定页模式配置')
  if (typeof networkBrowser !== 'boolean') throw new Error('无效的网络浏览模式配置')
  if (!acceptanceFixture && !networkBrowser) return { ...BASE_ENV }
  const tmpdir = env?.TMPDIR
  if (typeof tmpdir !== 'string' || tmpdir.length === 0 || !path.isAbsolute(tmpdir) || tmpdir.includes('\0')) {
    throw new Error('隔离浏览器模式需要父进程提供非空绝对路径的 TMPDIR')
  }
  return { ...BASE_ENV, TMPDIR: tmpdir }
}

export function startWorker(options = {}) {
  return launchWorker(spawn, options)
}

// spawnImpl is a test seam, never exposed as an agent tool input.
export function launchWorker(spawnImpl, { acceptanceFixture = false, networkBrowser = false, livePanel = false, onEvent } = {}) {
  const child = spawnImpl(process.execPath, workerArgs(acceptanceFixture, livePanel, networkBrowser), {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: workerEnv(acceptanceFixture, process.env, networkBrowser),
  })
  return createWorkerClient(child, { onEvent })
}

// Exported for transport tests; callers cannot select a process through a tool argument.
export function createWorkerClient(child, { onCleanupError = () => process.emitWarning('离线浏览器清理失败，无法保证子进程已退出'), onEvent = () => {} } = {}) {
  let sequence = 0
  let buffer = ''
  const decoder = new StringDecoder('utf8')
  let ended = false
  let stopping
  let cleanupReported = false
  const waiting = new Map()
  // Event handlers cannot await cleanup. Observe its rejection and retain the
  // same rejected stop promise for callers; never claim cleanup succeeded.
  function scheduleStop() {
    void stop().catch(error => {
      if (cleanupReported) return
      cleanupReported = true
      try { onCleanupError(error) } catch { /* Reporting must not crash the Host. */ }
    })
  }
  let resolveExit
  const exited = new Promise(resolve => { resolveExit = resolve })

  function failAll(message) {
    for (const waiter of waiting.values()) waiter.reject(new Error(message))
    waiting.clear()
  }
  function finish() {
    if (ended) return
    ended = true
    failAll('离线浏览器 worker 已退出')
    resolveExit()
  }
  child.once('error', finish)
  child.once('close', finish)
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > LIMIT) { scheduleStop(); return }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let reply
      try { reply = JSON.parse(line) } catch { scheduleStop(); return }
      // Event lines (screencast frames) carry no id and never satisfy a request.
      if (reply !== null && typeof reply === 'object' && Object.hasOwn(reply, 'event')) {
        try { onEvent(reply) } catch { scheduleStop(); return }
        continue
      }
      const waiter = waiting.get(reply?.id)
      if (!waiter) { scheduleStop(); return }
      waiting.delete(reply.id)
      if (typeof reply.error === 'string') waiter.reject(new Error(reply.error))
      else if (Object.hasOwn(reply, 'result')) waiter.resolve(reply.result)
      else waiter.reject(new Error('无效的 worker 响应'))
    }
  })
  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      failAll('离线浏览器已关闭')
      if (!ended) {
        child.kill('SIGTERM')
        // The worker owns a detached Chromium group and normally cleans it up on SIGTERM.
        // Forced worker termination cannot prove Chromium cleanup; callers must report failure.
        let timer
        const graceful = await Promise.race([
          exited.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); timer.unref() }),
        ])
        clearTimeout(timer)
        if (!graceful) {
          child.kill('SIGKILL')
          let killTimer
          await Promise.race([exited, new Promise(resolve => { killTimer = setTimeout(resolve, 2000); killTimer.unref() })])
          clearTimeout(killTimer)
          throw new Error('worker 未能及时清理，无法保证浏览器子进程已退出')
        }
      }
    })()
    return stopping
  }
  function request(op, fields, signal) {
    signal?.throwIfAborted()
    if (ended || stopping) return Promise.reject(new Error('离线浏览器未运行'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        waiting.delete(id)
        if (!settled) { settled = true; reject(signal.reason ?? new Error('已取消')) }
        scheduleStop()
      }
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      waiting.set(id, { resolve: value => settle(resolve, value), reject: error => settle(reject, error) })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`, error => {
        if (error && waiting.has(id)) { waiting.delete(id); settle(reject, error); scheduleStop() }
      })
    })
  }
  return { request, stop }
}
