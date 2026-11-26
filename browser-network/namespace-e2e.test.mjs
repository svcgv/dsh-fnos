// Local-only integration experiment. No Harness installation or real websites.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRestrictedProxy } from './proxy.mjs'

const childScript=fileURLToPath(new URL('./test-namespace-child.mjs',import.meta.url))
test('local Chromium uses namespaced loopback IPC proxy; destination and DNS are restricted', {timeout:30000}, async t => {
  assert.notEqual(process.getuid(),0,'do not run this test as root')
  const dir=mkdtempSync(path.join(os.tmpdir(),'dsh-net-test-'))
  let child,server,proxy
  t.after(async()=>{
    proxy?.close()
    if(child?.pid && child.exitCode===null){ try { process.kill(-child.pid,'SIGKILL') } catch(e){if(e.code!=='ESRCH')throw e} await new Promise(r=>child.once('exit',r)) }
    if(server)await new Promise(r=>server.close(r))
    rmSync(dir,{recursive:true,force:true})
  })
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem')
  const openssl=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=allowed.test'],{stdio:'ignore',timeout:10000})
  assert.equal(openssl.status,0,'self-signed test certificate generation failed')
  let requests=0
  server=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(_req,res)=>{requests++;res.end('namespace-proxy-ok')})
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port
  const queries=[]
  proxy=createRestrictedProxy({rules:[{host:'allowed.test',port,addresses:['127.0.0.1']},{host:'rebind.test',port,addresses:['127.0.0.1']}],lookup:async host=>{queries.push(host);return [{address:host==='rebind.test'?'127.0.0.2':'127.0.0.1',family:4}]},timeoutMs:2000})
  const script='set -eu; /usr/sbin/ip link set lo up; test -z "$(/usr/sbin/ip route show)"; test -z "$(/usr/sbin/ip -6 route show)"; exec /usr/bin/unshare --user --map-user="$1" --map-group="$2" "$3" "$4"'
  const env={PATH:'/usr/sbin:/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:'/vol1/@appcenter/dsh-fnos/runtime/lib',TEST_PROFILE:dir,TEST_PORT:String(port)}
  child=spawn('/usr/bin/unshare',['--map-root-user','--net','/bin/sh','-c',script,'--',String(process.getuid()),String(process.getgid()),process.execPath,childScript],{env,detached:true,stdio:['ignore','ignore','pipe','ipc']})
  let stderr='';child.stderr.on('data',c=>stderr+=c)
  let id=0, pending=new Map(), direct, echObserved=false
  const inspectHello=b=>{try{if(b.length<9||b[0]!==22||b.length<5+b.readUInt16BE(3))return false;let p=43;p+=1+b[p];const c=b.readUInt16BE(p);p+=2+c;p+=1+b[p];const end=p+2+b.readUInt16BE(p);p+=2;while(p+4<=end){const type=b.readUInt16BE(p),len=b.readUInt16BE(p+2);p+=4;if(type===0xfe0d)return true;p+=len}return false}catch{return false}}
  child.on('message',(msg,handle)=>{
    if(msg.type==='socket'){if(handle){let data=Buffer.alloc(0),body=false;handle.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(!body){if(data[0]===22)body=true;else{const n=data.indexOf('\r\n\r\n');if(n>=0){data=data.subarray(n+4);body=true}}}if(body&&inspectHello(data))echObserved=true;if(data.length>8192)data=Buffer.alloc(0)});proxy.accept(handle)}return}
    if(msg.type==='direct'){direct=msg.connected;return}
    if(msg.type==='cdp'&&msg.message.id){const p=pending.get(msg.message.id);if(p){pending.delete(msg.message.id);msg.message.error?p.reject(Error(JSON.stringify(msg.message.error))):p.resolve(msg.message.result)}}
  })
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const i=++id;pending.set(i,{resolve,reject});child.send({type:'cdp',message:{id:i,method,params,...(sessionId?{sessionId}:{})}},e=>{if(e){pending.delete(i);reject(e)}})})
  const ready=await Promise.race([new Promise(resolve=>child.on('message',m=>{if(m.type==='ready')resolve(m)})),new Promise((_,reject)=>child.once('exit',()=>reject(Error(`namespace startup failed: ${stderr}`)))),new Promise((_,reject)=>setTimeout(()=>reject(Error('namespace startup timed out')),10000).unref())])
  assert.notEqual(ready.proxyPort,port,'test ports unexpectedly collide')
  for(let i=0;i<100&&direct===undefined;i++) await new Promise(r=>setTimeout(r,20))
  assert.equal(direct,false,'namespace unexpectedly connected to host loopback')
  await call('Browser.getVersion');const target=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId)
  const good=await call('Page.navigate',{url:`https://allowed.test:${port}/`},sessionId)
  assert.ok(good.errorText, 'unexpected success: investigate ECH policy before updating this regression')
  assert.equal(echObserved,true,'expected Chromium ClientHello ECH extension 0xfe0d')
  assert.equal(requests,0,'local target must not receive ECH-bearing handshake')
  assert.ok(!queries.includes('allowed.test'),'ECH must be refused before DNS lookup')
  const denied=await call('Page.navigate',{url:`https://notallowed.test:${port}/`},sessionId)
  assert.ok(denied.errorText,'non-allowlisted hostname should fail')
  assert.ok(!queries.includes('notallowed.test'))
  t.diagnostic('BLOCKED: permitted origin remains unavailable because Chromium sends ECH extension 0xfe0d, which this proxy rejects')
  await call('Browser.close')
})
test.todo('A permitted Chromium HTTPS navigation must succeed without weakening the ECH fail-closed rule')
