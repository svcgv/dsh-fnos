import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const worker = new URL('./worker.mjs', import.meta.url)
const workerArgs = [worker.pathname, ...(process.env.DSH_TEST_ISOLATED === '1' ? ['--experimental-filesystem-isolation'] : [])]
test('offline worker: actions, diagnostics, screenshot, network denial and cleanup', { timeout: 30000 }, async () => {
  let hits = 0
  const server = createServer((req, res) => { hits++; res.end('should-not-be-reachable') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const before = new Set((await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-')))
  const child = spawn(process.execPath, workerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', x => { stderr += x })
  const output = readline.createInterface({ input: child.stdout })
  let serial = 0; const pending = new Map()
  output.on('line', line => { const response = JSON.parse(line); const p = pending.get(response.id); if (p) { pending.delete(response.id); response.error ? p.reject(Error(response.error)) : p.resolve(response.result) } })
  child.on('exit', () => { for (const p of pending.values()) p.reject(Error(`worker exited: ${stderr}`)); pending.clear() })
  const call = (op, data = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, {resolve,reject}); child.stdin.write(JSON.stringify({id,op,...data})+'\n') })
  try {
    const port = server.address().port
    await assert.rejects(call('open_test_site'), /不支持/)
    await assert.rejects(call('live_start'), /固定测试页/)
    await assert.rejects(call('live_input', {kind:'text',text:'test'}), /不支持/)
    await assert.rejects(call('live_stop'), /不支持/)
    const html = `<input aria-label="name"><button onclick="console.error('secret log');fetch('http://127.0.0.1:${port}/secret').catch(()=>{})">Send</button>`
    assert.deepEqual(await call('open', {html}), {offline:true})
    const snap = await call('snapshot'); assert.equal(snap.elements.length, 2)
    await call('fill', {generation:snap.generation,index:0,value:'hello'})
    await call('click', {generation:snap.generation,index:1})
    await new Promise(resolve => setTimeout(resolve, 500))
    const diagnostics = await call('diagnostics')
    assert(diagnostics.events.some(e => e.type === 'console' && e.level === 'error'))
    assert(diagnostics.events.some(e => e.type === 'network-failed'))
    assert(!JSON.stringify(diagnostics).includes('secret'))
    assert.equal(hits, 0, 'namespace must block host loopback')
    const shot = await call('screenshot'); assert.equal(shot.mime, 'image/png'); assert(Buffer.from(shot.base64,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    await assert.rejects(call('open', {html: 'x'.repeat(65537)}))
    await assert.rejects(call('click', {generation:snap.generation-1,index:1}))
    for (let i = 0; i < 30; i++) {
      await call('open', {html:`<button>page-${i}</button><input type="password" value="sensitive-${i}" aria-label="sensitive-${i}">`})
      const current = await call('snapshot')
      assert.equal(current.elements[0].text, `page-${i}`, 'open must wait for its own loader')
      assert.equal(current.elements[1].text, '[REDACTED]')
      assert(!JSON.stringify(current).includes(`sensitive-${i}`), 'password values must never appear in snapshots')
      await assert.rejects(call('fill', {generation:current.generation,index:1,value:'cannot-fill-password'}))
    }
    assert.deepEqual(await call('close'), {closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false})
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({code,signal})))
    assert.equal(exit.code,0,stderr)
    const after = (await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-') && !before.has(x))
    assert.deepEqual(after, [])
  } finally { child.kill('SIGKILL'); await new Promise(resolve => server.close(resolve)) }
})

test('oversized unterminated input is rejected and worker exits', {timeout:20000}, async () => {
  const before = new Set((await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-')))
  const child = spawn(process.execPath, workerArgs, {stdio:['pipe','pipe','pipe']})
  let stderr = ''; child.stderr.on('data', x => { stderr += x }); child.stdout.resume()
  child.stdin.on('error', () => {})
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code,signal})))
  child.stdin.write('x'.repeat(200000))
  const result = await exited
  assert.equal(result.code, 1, stderr)
  assert.match(stderr, /请求行超过大小限制/)
  assert.deepEqual((await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-') && !before.has(x)), [])
})

test('network namespace has no host interfaces or external routes', {timeout:10000}, async () => {
  const script = `const fs=require('node:fs');const interfaces=fs.readFileSync('/proc/net/dev','utf8').split('\\n').slice(2).filter(x=>x.includes(':')).map(x=>x.split(':')[0].trim());const routes=fs.readFileSync('/proc/net/route','utf8').split('\\n').slice(1).filter(Boolean).map(x=>x.trim().split(/\\s+/)[0]);console.log(JSON.stringify({interfaces,routes}))`
  const proc = spawn('/usr/bin/unshare',['--user','--map-current-user','--net',process.execPath,'-e',script],{stdio:['ignore','pipe','pipe']})
  let out='',err=''; proc.stdout.on('data',x=>out+=x);proc.stderr.on('data',x=>err+=x)
  const code=await new Promise(resolve=>proc.on('close',resolve));assert.equal(code,0,err)
  const result=JSON.parse(out);assert.deepEqual(result.interfaces,['lo']);assert(result.routes.every(route => route === 'lo'))
})
