import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { startWorker } from './worker-client.mjs'

// Explicit opt-in: requires this machine's x86 fygo-browser and unprivileged namespaces.
test('real offline worker accepts requests and closes', { skip: process.env.DSH_FNOS_REAL_WORKER_TEST !== '1', timeout: 30000 }, async () => {
  const worker = startWorker()
  const signal = new AbortController().signal
  try {
    assert.deepEqual(await worker.request('open', {html:'<button>integration test</button>'}, signal), {offline:true})
    const snapshot = await worker.request('snapshot', {}, signal)
    assert.equal(snapshot.elements[0].text, 'integration test')
    const screenshot = await worker.request('screenshot', {}, signal)
    assert.equal(screenshot.mime, 'image/png')
    assert(Buffer.from(screenshot.base64, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    const closed = await worker.request('close', {}, signal)
    assert.equal(closed.closed, true)
    assert.equal(closed.groupConfirmedEmpty, true)
    assert.equal(closed.temporaryDirectoryRetained, false)
  } finally { await worker.stop() }
})

// Explicit opt-in: requires the same machine prerequisites as the filesystem-isolation worker.
// The acceptance supervisor always provides a private TMPDIR; prove the fixture
// worker creates (and removes) its temp root exactly there, not in the Host /tmp.
test('real acceptance fixture worker opens only the fixed built-in page under its private TMPDIR', { skip: process.env.DSH_FNOS_FIXTURE_WORKER_TEST !== '1', timeout: 60000 }, async () => {
  const tmp = await mkdtemp('/tmp/dsh-fixture-tmp-')
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = tmp
  let worker
  try {
    worker = startWorker({ acceptanceFixture: true })
    const signal = new AbortController().signal
    await assert.rejects(worker.request('open', {html:'<p>untrusted</p>'}, signal), /fixture 模式不接受 HTML 或 URL/)
    assert.deepEqual(await worker.request('open_test_site', {}, signal), {fixture:true})
    const snapshot = await worker.request('snapshot', {}, signal)
    assert(Array.isArray(snapshot.elements))
    assert(snapshot.elements.length > 0)
    const closed = await worker.request('close', {}, signal)
    assert.equal(closed.closed, true)
    assert.equal(closed.groupConfirmedEmpty, true)
    assert.equal(closed.temporaryDirectoryRetained, false)
    assert.deepEqual((await readdir(tmp)).filter(name => name.startsWith('dsh-browser-worker-')), [], 'fixture temp root must live under and be cleaned from the private TMPDIR')
  } finally {
    await worker?.stop()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    const leftover = await readdir(tmp).then(names => names.filter(name => name.startsWith('dsh-browser-worker-'))).catch(() => ['unknown'])
    if (leftover.length === 0) await rm(tmp, {recursive:true, force:true})
    else console.error('fixture worker cleanup unverified; preserved', tmp, leftover)
  }
})
