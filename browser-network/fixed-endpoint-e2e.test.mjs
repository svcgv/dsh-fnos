// Test-only fixed IP:port model. Never use this harness for a real website.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createFixedEndpointTestProxy } from './fixed-endpoint-test-only.mjs'

const script=fileURLToPath(new URL('./fixed-endpoint-child-test-only.mjs',import.meta.url))
test('fixed destination policy defaults to reject',()=>{
  assert.throws(()=>createFixedEndpointTestProxy())
  assert.throws(()=>createFixedEndpointTestProxy({address:'1.1.1.1',port:443,authority:'allowed.test:443'}))
  assert.throws(()=>createFixedEndpointTestProxy({address:'127.0.0.1',port:443,authority:'other.test:443'}))
})
test('closed proxy rejects new sockets',async t=>{
  const proxy=createFixedEndpointTestProxy({address:'127.0.0.1',port:443,authority:'allowed.test:443'});proxy.close()
  const bridge=net.createServer(s=>proxy.accept(s));bridge.listen(0,'127.0.0.1');await once(bridge,'listening');t.after(()=>bridge.close())
  const socket=net.connect(bridge.address().port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'close')
})
test('Chromium can only reach pinned local endpoint via namespaced IPC bridge', {timeout:40000},async t=>{
  assert.notEqual(process.getuid(),0,'must run as non-root')
  const dir=mkdtempSync(path.join(os.tmpdir(),'dsh-fixed-test-'))
  const children=new Set(),servers=new Set(),proxies=new Set()
  t.after(async()=>{
    for(const p of proxies)p.close()
    for(const c of children){if(c.pid&&c.exitCode===null&&c.signalCode===null){const exited=once(c,'exit');try{process.kill(-c.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}await exited}}
    for(const s of servers)await new Promise(r=>s.close(r))
    rmSync(dir,{recursive:true,force:true})
  })
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem')
  const openssl=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=allowed.test','-addext','subjectAltName=DNS:allowed.test'],{stdio:'ignore',timeout:10000})
  assert.equal(openssl.status,0,'cannot create ephemeral test certificate')
  const certPem=readFileSync(cert),certKey=readFileSync(key)
  const spki=createHash('sha256').update(new X509Certificate(certPem).publicKey.export({type:'spki',format:'der'})).digest('base64')
  let hits=0, controlConnections=0;const hosts=[]
  const origin=https.createServer({key:certKey,cert:certPem},(req,res)=>{hits++;hosts.push(req.headers.host);res.setHeader('Connection','close');res.end('fixed-endpoint-ok')});servers.add(origin);origin.listen(0,'127.0.0.1');await once(origin,'listening');const port=origin.address().port
  const control=https.createServer({key:certKey,cert:certPem},(_req,res)=>res.end('FORBIDDEN'));servers.add(control);control.on('connection',()=>controlConnections++);control.listen(0,'127.0.0.1');await once(control,'listening');const otherPort=control.address().port
  const policy=createFixedEndpointTestProxy({address:'127.0.0.1',port,authority:`allowed.test:${port}`});proxies.add(policy)
  let echObserved=false
  const hasEch=b=>{try{if(b.length<9||b[0]!==22||b.length<5+b.readUInt16BE(3))return false;let p=43;p+=1+b[p];const c=b.readUInt16BE(p);p+=2+c;p+=1+b[p];const end=p+2+b.readUInt16BE(p);p+=2;while(p+4<=end){const kind=b.readUInt16BE(p),len=b.readUInt16BE(p+2);p+=4;if(kind===0xfe0d)return true;p+=len}return false}catch{return false}}
  async function browser(pin,name){
    const profile=path.join(dir,name);mkdirSync(profile,{mode:0o700})
    const shell='set -eu; /usr/sbin/ip link set lo up; test -z "$(/usr/sbin/ip route show)"; test -z "$(/usr/sbin/ip -6 route show)"; exec /usr/bin/unshare --user --map-user="$1" --map-group="$2" "$3" "$4"'
    const env={PATH:'/usr/sbin:/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:'/vol1/@appcenter/dsh-fnos/runtime/lib',TEST_PROFILE:profile,TEST_PORT:String(port),TEST_SPKI:pin}
    const child=spawn('/usr/bin/unshare',['--map-root-user','--net','/bin/sh','-c',shell,'--',String(process.getuid()),String(process.getgid()),process.execPath,script],{env,detached:true,stdio:['ignore','ignore','pipe','ipc']});children.add(child)
    let stderr='',direct,id=0;const pending=new Map();child.stderr.on('data',c=>stderr+=c)
    child.on('message',(m,handle)=>{if(m.type==='socket'){if(handle){handle.on('data',chunk=>{if(hasEch(chunk))echObserved=true});policy.accept(handle)}}else if(m.type==='direct')direct=m.connected;else if(m.type==='cdp'&&m.message.id){const p=pending.get(m.message.id);if(p){pending.delete(m.message.id);m.message.error?p.reject(Error(JSON.stringify(m.message.error))):p.resolve(m.message.result)}}})
    const ready=await Promise.race([new Promise(r=>child.on('message',m=>{if(m.type==='ready')r(m)})),new Promise((_,reject)=>child.once('exit',()=>reject(Error(`namespace startup failed: ${stderr}`)))),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timed out')),10000).unref())])
    assert.notEqual(ready.port,port,'loopback port collision');for(let i=0;i<100&&direct===undefined;i++)await new Promise(r=>setTimeout(r,20));assert.equal(direct,false,'direct host loopback access succeeded')
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.send({type:'cdp',message:{id:n,method,params,...(sessionId?{sessionId}:{})}},e=>{if(e){pending.delete(n);reject(e)}})})
    await call('Browser.getVersion');const target=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});await call('Page.enable',{},sessionId)
    return {call,sessionId}
  }
  const ok=await browser(spki,'trusted')
  const good=await ok.call('Page.navigate',{url:`https://allowed.test:${port}/`},ok.sessionId);assert.equal(good.errorText,undefined,`approved endpoint did not load: ${good.errorText}`)
  for(let i=0;i<100&&!hits;i++)await new Promise(r=>setTimeout(r,20));assert.ok(hits>0);assert.equal(echObserved,true,'test Chromium should send ECH extension')
  for(const url of [`https://forged.test:${port}/`,`https://allowed.test:${otherPort}/`]){const nav=await ok.call('Page.navigate',{url},ok.sessionId);assert.ok(nav.errorText,'forged authority or endpoint unexpectedly succeeded')}
  assert.equal(controlConnections,0,'non-approved local endpoint received a connection');assert.ok(hosts.every(h=>h===`allowed.test:${port}`),'forged Host reached approved target')
  await ok.call('Browser.close')
  await new Promise(r=>setTimeout(r,100));const before=hits
  const wrong=await browser(randomBytes(32).toString('base64'),'wrong-pin')
  const nav=await wrong.call('Page.navigate',{url:`https://allowed.test:${port}/`},wrong.sessionId);assert.ok(nav.errorText,'incorrect SPKI pin must reject the test certificate')
  assert.equal(hits,before,'wrong-pin browser sent an HTTP request')
  await wrong.call('Browser.close')
})
