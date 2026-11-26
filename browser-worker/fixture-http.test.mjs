import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import readline from 'node:readline'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import { assertFixtureControl, createFixtureControl, fixtureUrl, fixtureNetworkSetup } from './fixture-http.mjs'

const worker=new URL('./worker.mjs',import.meta.url)
const moduleUrl=new URL('./fixture-http.mjs',import.meta.url).href
const enabled=process.env.DSH_FNOS_FIXTURE_WORKER_TEST==='1'

function childExit(child){return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))})}
function deadline(p,ms=15000){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test timeout')),ms)})]).finally(()=>clearTimeout(timer))}
function listener(port=0){
  const server=net.createServer(s=>{s.on('error',()=>{});s.end('test-only')})
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server))})
}
function closeServer(server){return new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}

test('fixture control token is not forgeable and URL is a constant',()=>{
  assert.throws(()=>assertFixtureControl({}),/active fixture positive control required/)
  assert.equal(fixtureUrl,'http://127.0.0.1:38179/')
})

test('empty and invalid owner output abort before loopback activation',async()=>{
  for(const owner of ['', '0 net 0', 'garbage']){
    // In-memory fault injection. Never mount or alter the host network.
    const setup=fixtureNetworkSetup
      .replace('/usr/bin/mount --make-rprivate /',':')
      .replace('/usr/bin/mount -t proc -o nosuid,nodev,noexec proc /proc',':')
      .replace('ownerline=$(/usr/bin/lsns -p $$ -t net -o NS,TYPE,ONS -n -r)',`ownerline=${JSON.stringify(owner)}`)
      .replace('/usr/bin/ip link set lo up',"printf 'LO_ENABLED\\n'")
    assert.notEqual(setup,fixtureNetworkSetup)
    assert(!setup.includes('/usr/bin/mount') && !setup.includes('/usr/bin/ip') && !setup.includes('/usr/bin/lsns'))
    const child=spawn('/bin/bash',['-c',`set -eu\n${setup}`],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);child.stderr.resume()
    assert.equal((await deadline(childExit(child),3000)).code,90)
    assert(!out.includes('LO_ENABLED'))
  }
})

test('FD guard detects a deliberately inherited self-owned socket', {timeout:10000}, async()=>{
  const server=await listener()
  const client=net.createConnection({host:'127.0.0.1',port:server.address().port})
  client.on('error',()=>{})
  await deadline(new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject)}),3000)
  const script=`import {assertNoAdditionalSocketFds} from ${JSON.stringify(moduleUrl)};import fs from 'node:fs';const injected=process.argv[1]==='injected';if(injected&&!fs.readlinkSync('/proc/self/fd/9').startsWith('socket:['))process.exit(10);try{assertNoAdditionalSocketFds();process.exit(injected?11:0)}catch(e){if(injected&&e.message==='unexpected socket fd')process.exit(0);console.error(e);process.exit(12)}`
  async function run(injected){
    const args=['--input-type=module','-e',script,injected?'injected':'clean']
    const stdio=['ignore','ignore','pipe','pipe','pipe','ignore','ignore','ignore','ignore',injected?client._handle.fd:'ignore']
    const child=spawn(process.execPath,args,{stdio});let err='';child.stdio[2].on('data',c=>err+=c);child.stdio[3].resume();child.stdio[4].resume()
    const result=await deadline(childExit(child),3000);assert.equal(result.code,0,err)
  }
  try{await run(false);await run(true)}finally{client.destroy();await closeServer(server)}
})

function session(child){
  const output=readline.createInterface({input:child.stdout});const pending=new Map();let id=0,stderr=''
  child.stderr.on('data',data=>stderr+=data)
  child.stdin.on('error',()=>{})
  output.on('line',line=>{const response=JSON.parse(line);const current=pending.get(response.id);if(!current)return;pending.delete(response.id);response.error?current.reject(Error(response.error)):current.resolve(response.result)})
  child.on('exit',()=>{for(const current of pending.values())current.reject(Error('worker exited: '+stderr));pending.clear()})
  return {call(op,data={}){return deadline(new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,op,...data})+'\n')}))},get stderr(){return stderr}}
}
function startFixture(){return spawn(process.execPath,[worker.pathname,'--experimental-private-http-fixture'],{stdio:['pipe','pipe','pipe']})}
async function directories(){return new Set((await readdir(os.tmpdir())).filter(x=>x.startsWith('dsh-browser-worker-')))}
async function assertNoNewDirectories(before){assert.deepEqual([...await directories()].filter(x=>!before.has(x)),[])}

// Explicit opt-in: fixed host port 38180 is bound briefly for an owned positive
// control. No real sites, user browser or user profile are involved.
test('positive control requires an active owned listener', {skip:!enabled,timeout:10000},async()=>{
  const control=await createFixtureControl()
  try{assert.doesNotThrow(()=>assertFixtureControl(control))}finally{await control.dispose()}
  assert.throws(()=>assertFixtureControl(control),/active fixture positive control required/)
})

test('fixed HTTP worker real Chromium actions and shutdown', {skip:!enabled,timeout:30000},async()=>{
  const before=await directories();const child=startFixture();const exit=childExit(child);const s=session(child)
  try{
    await assert.rejects(s.call('open_test_site',{url:'http://example.invalid/'}),/不支持/)
    await assert.rejects(s.call('open_test_site',{port:1}),/不支持/)
    await assert.rejects(s.call('open_test_site',{html:'<p>user</p>'}),/不支持/)
    await assert.rejects(s.call('open',{html:'<p>user</p>'}),/不接受/)
    assert.deepEqual(await s.call('open_test_site'),{fixture:true})
    const snap=await s.call('snapshot');assert.equal(snap.elements.length,2);assert.equal(snap.elements[1].text,'Go')
    await s.call('fill',{generation:snap.generation,index:0,value:'hello'})
    assert.equal((await s.call('snapshot')).elements[0].text,'hello')
    await s.call('click',{generation:snap.generation,index:1})
    await new Promise(r=>setTimeout(r,300))
    const diagnostics=await s.call('diagnostics')
    assert(diagnostics.events.some(e=>e.type==='console'&&e.level==='error'))
    assert(diagnostics.events.some(e=>e.type==='response'&&e.status===500))
    assert(diagnostics.events.some(e=>e.type==='network-failed'))
    const image=await s.call('screenshot');assert.equal(image.mime,'image/png');assert(Buffer.from(image.base64,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    assert.deepEqual(await s.call('close'),{closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false})
    assert.equal((await deadline(exit)).code,0,s.stderr)
    await assertNoNewDirectories(before)
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await deadline(exit).catch(()=>{})}
})

test('occupied owned control port fails closed without touching listener', {skip:!enabled,timeout:20000},async()=>{
  const before=await directories();let hits=0
  const server=net.createServer(s=>{hits++;s.destroy()});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(38180,'127.0.0.1',resolve)})
  const child=startFixture();let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.resume();child.stdin.end()
  try{const result=await deadline(childExit(child));assert.equal(result.code,1,stderr);assert.match(stderr,/EADDRINUSE/);assert.equal(hits,0);await assertNoNewDirectories(before)}finally{child.kill('SIGTERM');await closeServer(server)}
})

test('SIGTERM during fixture startup cleans owned resources', {skip:!enabled,timeout:30000},async()=>{
  for(const delay of [120,400,800]){
    const before=await directories();const child=startFixture();const exit=childExit(child);let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.resume()
    try{await new Promise(resolve=>setTimeout(resolve,delay));child.kill('SIGTERM');const result=await deadline(exit);assert.equal(result.code,1,stderr);await assertNoNewDirectories(before)}
    finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await deadline(exit).catch(()=>{})}
  }
})

test('SIGTERM after fixture startup cleans owned resources', {skip:!enabled,timeout:20000},async()=>{
  const before=await directories();const child=startFixture();const exit=childExit(child);const s=session(child)
  try{await s.call('open_test_site');child.kill('SIGTERM');const result=await deadline(exit);assert.equal(result.code,1,s.stderr);await assertNoNewDirectories(before)}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await deadline(exit).catch(()=>{})}
})
