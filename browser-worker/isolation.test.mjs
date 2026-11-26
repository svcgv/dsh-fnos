import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdtempSync, mkdirSync, rmSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { namespaceGuard, isolatedInner, createIsolationProbe, spawnIsolatedBrowser } from './isolation.mjs'

async function runGuard(flags, missing = false) {
  const descriptors = []
  try {
    for (const ns of ['user','mnt','pid','net']) descriptors.push(openSync(`/proc/self/ns/${ns}`,'r'))
    const stdio = ['ignore','pipe','pipe','ignore','ignore',...descriptors]
    if (missing) stdio[8] = 'ignore'
    const command = flags.length ? '/usr/bin/unshare' : '/bin/bash'
    const args = flags.length ? [...flags,'/bin/bash','-c',`${namespaceGuard}\necho PASSED`] : ['-c',`${namespaceGuard}\necho PASSED`]
    const child = spawn(command,args,{stdio})
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x)
    const status = await new Promise((resolve,reject) => { child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal})) })
    return {...status,out,err}
  } finally { descriptors.forEach(closeSync) }
}

test('guard rejects missing descriptors before mounting', {timeout:10000}, async () => {
  const result = await runGuard(['--map-root-user','--mount','--pid','--net','--fork'],true)
  assert.equal(result.code,70,result.err);assert.equal(result.out,'')
})
test('guard rejects unchanged mount namespace before mounting', {timeout:10000}, async () => {
  const result = await runGuard(['--map-root-user','--pid','--net','--fork'])
  assert.equal(result.code,71,result.err);assert.match(result.err,/namespace not isolated: mnt/);assert.equal(result.out,'')
})
test('guard permits only independently changed namespaces', {timeout:10000}, async () => {
  const result = await runGuard(['--map-root-user','--mount','--pid','--net','--fork'])
  assert.equal(result.code,0,result.err);assert.equal(result.out,'PASSED\n')
})
test('isolated launcher hides a reachable self-owned host Unix socket and directory', {timeout:30000}, async () => {
  const parent=mkdtempSync(path.join(os.tmpdir(),'dsh-browser-worker-'))
  const root=path.join(parent,'root')
  mkdirSync(root,{mode:0o700})
  let child, probe
  try {
    probe=await createIsolationProbe()
    await new Promise((resolve,reject)=>{let data='';const s=net.createConnection(probe.socketPath);s.on('data',x=>data+=x);s.once('end',()=>{try {assert.equal(data,'ok');resolve()} catch(e){reject(e)}});s.once('error',reject)})
    child=spawnIsolatedBrowser(root,probe)
    let stderr='';child.stderr.on('data',x=>stderr+=x)
    const version=await new Promise((resolve,reject)=>{
      let buffer='';const timer=setTimeout(()=>reject(new Error(`browser startup timeout: ${stderr}`)),20000)
      child.once('error',reject);child.once('exit',code=>reject(new Error(`browser exited ${code}: ${stderr}`)))
      child.stdio[4].on('data',data=>{buffer+=data;const end=buffer.indexOf('\0');if(end>=0){clearTimeout(timer);resolve(JSON.parse(buffer.slice(0,end)))}})
      child.stdio[3].write(JSON.stringify({id:1,method:'Browser.getVersion'})+'\0')
    })
    assert.match(version.result.product,/Chrome/)
  } finally {
    if(child && child.exitCode===null) {try {process.kill(-child.pid,'SIGKILL')} catch {} await new Promise(resolve=>child.once('close',resolve))}
    if (probe) {const dir=path.dirname(probe.socketPath);await probe.dispose();assert.equal(existsSync(dir),false)}
    rmSync(parent,{recursive:true,force:true})
  }
})
test('inner guard rejects an actually reachable host socket', {timeout:10000}, async () => {
  const probe=await createIsolationProbe()
  try {
    const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:'/var/apps/dsh-fnos/target/runtime/lib',HOST_SOCKET:probe.socketPath,HOST_CHECK:path.join(path.dirname(probe.socketPath),'absent')}
    const child=spawn('/usr/bin/unshare',['--user','--map-user=1000','--map-group=1000',process.execPath,'--input-type=commonjs','-e',isolatedInner],{env,stdio:['ignore','ignore','pipe']})
    let stderr='';child.stderr.on('data',x=>stderr+=x)
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    assert.equal(code,73,stderr);assert.match(stderr,/host socket is reachable/)
  } finally {await probe.dispose()}
})
test('isolated worker succeeds with long TMPDIR and removes both temporary roots', {timeout:30000}, async () => {
  const base=mkdtempSync(path.join(os.tmpdir(),'dsh-long-tmp-test-'))
  const longTmp=path.join(base,'x'.repeat(80))
  mkdirSync(longTmp,{mode:0o700})
  assert(Buffer.byteLength(path.join(longTmp,'dsh-browser-worker-123456','probe.sock'))>108)
  const before=new Set(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')))
  let child, exited
  try {
    child=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname,'--experimental-filesystem-isolation'],{env:{...process.env,TMPDIR:longTmp},stdio:['pipe','pipe','pipe']})
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
    exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
    child.stdin.end('{"id":1,"op":"open","html":"<button>long tmp</button>"}\n{"id":2,"op":"close"}\n')
    const result=await exited
    assert.equal(result.code,0,stderr);assert.equal(result.signal,null)
    const replies=stdout.trim().split('\n').map(line=>JSON.parse(line))
    assert.deepEqual(replies.map(x=>x.result),[{offline:true},{closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false}])
    assert.deepEqual(readdirSync(longTmp),[])
    assert.deepEqual(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')&&!before.has(x)),[])
  } finally {
    if(child && child.exitCode===null && child.signalCode===null) {
      child.kill('SIGTERM')
      let timer;const cleaned=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000)})]);clearTimeout(timer)
      if (!cleaned) {child.kill('SIGKILL');throw new Error(`worker cleanup unverified; preserved ${base}`)}
    }
    rmSync(base,{recursive:true,force:true})
  }
})
test('cancelled probe startup removes its own short temporary directory', {timeout:10000}, async () => {
  const before = new Set(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')))
  for (let i=0;i<10;i++) {
    const controller=new AbortController()
    const pending=createIsolationProbe(controller.signal)
    controller.abort(new Error('test cancellation'))
    await assert.rejects(pending,/test cancellation/)
  }
  assert.deepEqual(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')&&!before.has(x)),[])
})
test('failed positive control and cancellation during connection clean up', {timeout:10000}, async () => {
  const before=new Set(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')))
  const realConnect=net.createConnection
  const controller=new AbortController()
  try {
    net.createConnection=(...args)=>{const socket=realConnect(...args);queueMicrotask(()=>controller.abort(new Error('cancel positive control')));return socket}
    await assert.rejects(createIsolationProbe(controller.signal),/cancel positive control/)
    net.createConnection=(...args)=>{const socket=realConnect(...args);queueMicrotask(()=>socket.destroy(new Error('injected connection failure')));return socket}
    await assert.rejects(createIsolationProbe(),/injected connection failure/)
  } finally {net.createConnection=realConnect}
  assert.deepEqual(readdirSync('/tmp').filter(x=>x.startsWith('dsh-browser-probe-')&&!before.has(x)),[])
})
test('removed positive-control socket rejects launch and cleans up', {timeout:10000}, async () => {
  const probe=await createIsolationProbe(), dir=path.dirname(probe.socketPath)
  try {
    unlinkSync(probe.socketPath)
    assert.throws(()=>spawnIsolatedBrowser('/',probe))
  } finally {await probe.dispose()}
  assert.equal(existsSync(dir),false)
})
test('unknown isolation arguments do not downgrade silently', {timeout:10000}, async () => {
  const child=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname,'--experimental-filesystem-isolatio'],{stdio:['ignore','ignore','pipe']})
  let err='';child.stderr.on('data',x=>err+=x)
  const code=await new Promise(resolve=>child.on('close',resolve))
  assert.equal(code,1,err);assert.match(err,/不支持的启动参数/)
})
test('launcher rejects arbitrary or insecure mount roots', async () => {
  const probe=await createIsolationProbe()
  const parent = mkdtempSync(path.join(os.tmpdir(),'dsh-browser-worker-'))
  const root = path.join(parent,'root');mkdirSync(root,{mode:0o755})
  try {
    assert.throws(() => spawnIsolatedBrowser('/',probe),/invalid isolated root/)
    assert.throws(() => spawnIsolatedBrowser(root,probe),/invalid isolated root owner or permissions/)
    assert.throws(() => spawnIsolatedBrowser(root,{}),/active isolation probe required/)
  } finally {await probe.dispose();rmSync(parent,{recursive:true,force:true})}
})
