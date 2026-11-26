import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const workerArgs = [new URL('./worker.mjs', import.meta.url).pathname, ...(process.env.DSH_TEST_ISOLATED === '1' ? ['--experimental-filesystem-isolation'] : [])]

test('signals during startup clean resources before exit', {timeout:30000}, async () => {
  for (const [signal, delay] of [['SIGTERM', 0], ['SIGINT', 60]]) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dsh-worker-signal-test-'))
    const child = spawn(process.execPath, workerArgs, {stdio:['pipe','pipe','pipe'], env:{...process.env,TMPDIR:parent}})
    let stderr=''; child.stderr.on('data', x => stderr += x); child.stdout.resume()
    let exited = false
    const exit = new Promise(resolve => child.once('exit', (code, termSignal) => { exited=true; resolve({code,termSignal}) }))
    try {
      const deadline = Date.now() + 8000
      while (!(await readdir(parent)).some(x => x.startsWith('dsh-browser-worker-'))) {
        assert(!exited, `worker exited before startup: ${stderr}`)
        assert(Date.now() < deadline, 'worker did not create its temporary profile')
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      assert(child.kill(signal), 'worker must still be running when signalled')
      const result = await exit
      assert.equal(result.code, 1, stderr)
      assert.equal(result.termSignal, null, stderr)
      assert.deepEqual(await readdir(parent), [], 'startup cancellation must clean worker temp')
    } finally { if (!exited) child.kill('SIGKILL'); await exit; await rm(parent,{recursive:true,force:true}) }
  }
})

test('SIGTERM during isolated startup cleans the owned socket probe', {timeout:20000}, async () => {
  const parent=await mkdtemp(path.join(os.tmpdir(),'dsh-probe-signal-test-'))
  const before=new Set((await readdir('/tmp')).filter(x=>x.startsWith('dsh-browser-probe-')))
  const child=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname,'--experimental-filesystem-isolation'],{stdio:['pipe','pipe','pipe'],env:{...process.env,TMPDIR:parent}})
  let stderr='',exited=false;child.stderr.on('data',x=>stderr+=x);child.stdout.resume()
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}))
  try {
    const deadline=Date.now()+8000
    while (!(await readdir('/tmp')).some(x=>x.startsWith('dsh-browser-probe-')&&!before.has(x))) {
      assert(!exited,`worker exited before probe: ${stderr}`);assert(Date.now()<deadline,'probe not observed')
      await new Promise(resolve=>setTimeout(resolve,1))
    }
    assert(child.kill('SIGTERM'))
    const result=await exit;assert.equal(result.code,1,stderr);assert.equal(result.signal,null)
    assert.deepEqual(await readdir(parent),[])
    assert.deepEqual((await readdir('/tmp')).filter(x=>x.startsWith('dsh-browser-probe-')&&!before.has(x)),[])
  } finally {if(!exited) child.kill('SIGKILL');await exit;await rm(parent,{recursive:true,force:true})}
})

test('SIGTERM cleans the worker-owned temporary profile', { timeout: 20000 }, async () => {
  const before = new Set((await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-')))
  const child = spawn(process.execPath, workerArgs, {stdio:['pipe','pipe','pipe']})
  let stderr='';child.stderr.on('data', x=>stderr+=x)
  const rl = readline.createInterface({input:child.stdout})
  try {
    child.stdin.write('{"id":1,"op":"snapshot"}\n')
    const line = await new Promise((resolve,reject)=>{rl.once('line',resolve);child.once('exit',()=>reject(Error(stderr)))})
    assert.ok(JSON.parse(line).result)
    child.kill('SIGTERM')
    const code = await new Promise(resolve=>child.once('exit',resolve))
    assert.equal(code,1,stderr)
    assert.deepEqual((await readdir(os.tmpdir())).filter(x => x.startsWith('dsh-browser-worker-') && !before.has(x)),[])
  } finally { child.kill('SIGKILL');rl.close() }
})
