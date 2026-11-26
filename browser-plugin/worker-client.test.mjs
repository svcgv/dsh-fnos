import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createWorkerClient, launchWorker, workerArgs, workerEnv } from './worker-client.mjs'

test('launch always requires filesystem isolation and never falls back after startup failure', async () => {
  const calls = []
  const worker = launchWorker((command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough()
    child.kill = () => { child.emit('close', 0); return true }
    queueMicrotask(() => child.emit('close', 1))
    return child
  })
  const request = worker.request('open', {html:'test'}, new AbortController().signal)
  await assert.rejects(request, /worker 已退出/)
  await worker.stop()
  assert.equal(calls.length, 1, 'isolation failure must not spawn a fallback')
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].args.length, 2)
  assert.equal(calls[0].args[0], new URL('../browser-worker/worker.mjs', import.meta.url).pathname)
  assert.equal(calls[0].args[1], '--experimental-filesystem-isolation')
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'ignore'])
})

test('worker responses preserve UTF-8 split across stream chunks', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough()
  child.kill = () => { child.emit('close', 0); return true }
  const worker = createWorkerClient(child)
  const pending = worker.request('snapshot', {}, new AbortController().signal)
  const bytes = Buffer.from(JSON.stringify({id:1,result:{text:'中文'}}) + '\n')
  const chineseStart = bytes.indexOf(Buffer.from('中'))
  child.stdout.write(bytes.subarray(0, chineseStart + 1))
  child.stdout.write(bytes.subarray(chineseStart + 1, chineseStart + 2))
  child.stdout.write(bytes.subarray(chineseStart + 2))
  assert.deepEqual(await pending, {text:'中文'})
  await worker.stop()
})

test('protocol errors report and retain cleanup failures without unhandled rejections', async () => {
  for (const data of ['not-json\n', '{"id":999,"result":{}}\n', 'x'.repeat(20 * 1024 * 1024 + 1)]) {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough()
    child.kill = () => { throw new Error('simulated cleanup failure') }
    const reports = []
    const worker = createWorkerClient(child, { onCleanupError: error => reports.push(error.message) })
    const pending = worker.request('snapshot', {}, new AbortController().signal)
    child.stdout.write(data)
    await assert.rejects(pending, /离线浏览器已关闭/)
    await assert.rejects(worker.stop(), /simulated cleanup failure/)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(reports, ['simulated cleanup failure'])
    await assert.rejects(worker.stop(), /simulated cleanup failure/)
    assert.equal(reports.length, 1)
  }
})

test('acceptance fixture mode passes the fixed private-fixture switch and nothing else', () => {
  const workerPath = new URL('../browser-worker/worker.mjs', import.meta.url).pathname
  assert.deepEqual(workerArgs(false), [workerPath, '--experimental-filesystem-isolation'])
  assert.deepEqual(workerArgs(true), [workerPath, '--experimental-private-http-fixture'])
  assert.deepEqual(workerArgs(false, true, true), [workerPath, '--experimental-network-browser', '--experimental-live-panel'])
  assert.deepEqual(workerArgs(false, false, true), [workerPath, '--experimental-network-browser'])
  assert.throws(() => workerArgs(true, true, true), /不能同时启用/)
  assert.throws(() => workerArgs(false, true), /必须与浏览器模式同时启用/)
  assert.throws(() => workerArgs('1'), /无效的验收固定页模式配置/)
  assert.throws(() => workerArgs({}), /无效的验收固定页模式配置/)
})

test('launch in acceptance fixture mode always passes exactly one fixed switch', async () => {
  const previous = process.env.TMPDIR
  process.env.TMPDIR = '/var/tmp/dsh-acceptance-private'
  try {
    const calls = []
    const worker = launchWorker((command, args, options) => {
      calls.push({ command, args, options })
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough()
      child.kill = () => { child.emit('close', 0); return true }
      queueMicrotask(() => child.emit('close', 1))
      return child
    }, { acceptanceFixture: true })
    await assert.rejects(worker.request('open_test_site', {}, new AbortController().signal), /worker 已退出/)
    await worker.stop()
    assert.equal(calls.length, 1, 'fixture startup failure must not spawn a fallback')
    assert.equal(calls[0].command, process.execPath)
    assert.deepEqual(calls[0].args, [
      new URL('../browser-worker/worker.mjs', import.meta.url).pathname,
      '--experimental-private-http-fixture',
    ])
    assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'ignore'])
    assert.deepEqual(calls[0].options.env, {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib',
      TMPDIR: '/var/tmp/dsh-acceptance-private',
    })
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
})

test('isolated worker env inherits only a validated private TMPDIR', () => {
  assert.deepEqual(workerEnv(false, { TMPDIR: '/var/tmp/ignored' }), {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib',
  })
  assert.deepEqual(workerEnv(true, { TMPDIR: '/var/tmp/dsh-acceptance-private' }), {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib',
    TMPDIR: '/var/tmp/dsh-acceptance-private',
  })
  assert.deepEqual(workerEnv(false, { TMPDIR: '/var/tmp/dsh-network-private' }, true), {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/var/apps/dsh-fnos/target/runtime/lib',
    TMPDIR: '/var/tmp/dsh-network-private',
  })
  for (const env of [{}, { TMPDIR: '' }, { TMPDIR: 'relative/tmp' }, { TMPDIR: '/tmp\0evil' }, { TMPDIR: 42 }]) {
    assert.throws(() => workerEnv(true, env), /需要父进程提供非空绝对路径的 TMPDIR/)
    assert.throws(() => workerEnv(false, env, true), /需要父进程提供非空绝对路径的 TMPDIR/)
  }
  assert.throws(() => workerEnv(false, {}, '1'), /无效的网络浏览模式配置/)
  assert.throws(() => workerEnv('1'), /无效的验收固定页模式配置/)
})
