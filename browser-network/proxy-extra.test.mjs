import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { createRestrictedProxy } from './proxy.mjs'

async function listening(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
function clientHello(host) {
  const hostbuf=Buffer.from(host), u16=n=>Buffer.from([n>>8,n&255]); const name=Buffer.concat([Buffer.from([0]),u16(hostbuf.length),hostbuf]); const list=Buffer.concat([u16(name.length),name]); const ext=Buffer.concat([u16(0),u16(list.length),list]); const body=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32),Buffer.from([0]),u16(2),Buffer.from([0x13,1,1,0]),u16(ext.length),ext]); const hs=Buffer.alloc(4);hs[0]=1;hs.writeUIntBE(body.length,1,3);return Buffer.concat([Buffer.from([22,3,1]),u16(body.length+4),hs,body])
}
async function send(port, destPort) { const s=net.connect(port,'127.0.0.1'); s.on('error',()=>{});await once(s,'connect');s.write(`CONNECT allowed.test:${destPort} HTTP/1.1\r\nHost: allowed.test:${destPort}\r\n\r\n`);await once(s,'data');s.write(clientHello('allowed.test'));return s }
async function open(port) { const s=net.connect(port,'127.0.0.1');s.on('error',()=>{});await once(s,'connect');return s }
test('resolves on every tunnel and blocks changed address', async t=>{
  let records=[{address:'127.0.0.1',family:4}]; const destination=net.createServer(s=>s.on('data',()=>s.write('ok')));const port=await listening(destination)
  const proxy=createRestrictedProxy({rules:[{host:'allowed.test',port,addresses:['127.0.0.1']}],lookup:async()=>records,timeoutMs:1000});const bridge=net.createServer(s=>proxy.accept(s));const p=await listening(bridge);t.after(()=>{proxy.close();bridge.close();destination.close()})
  let s=await send(p,port);assert.equal((await once(s,'data'))[0].toString(),'ok');s.destroy();records=[{address:'127.0.0.2',family:4}];s=await send(p,port);await once(s,'close')
})
test('rejects actual remote port mismatch before sending TLS data', async t=>{
  let received=false; const actual=net.createServer(s=>s.on('data',()=>{received=true})); const wrongPort=await listening(actual); const declared=wrongPort===65535?65534:wrongPort+1
  const proxy=createRestrictedProxy({rules:[{host:'allowed.test',port:declared,addresses:['127.0.0.1']}],lookup:async()=>[{address:'127.0.0.1',family:4}],connect:()=>net.connect(wrongPort,'127.0.0.1'),timeoutMs:1000});const bridge=net.createServer(s=>proxy.accept(s));const p=await listening(bridge);t.after(()=>{proxy.close();bridge.close();actual.close()})
  const s=await send(p,declared);await once(s,'close');assert.equal(received,false)
})
test('rejects actual remote IP mismatch before TLS data', async t=>{
  let received=false;const actual=net.createServer(s=>s.on('data',()=>{received=true}));actual.listen(0,'127.0.0.2');await once(actual,'listening');const port=actual.address().port
  const proxy=createRestrictedProxy({rules:[{host:'allowed.test',port,addresses:['127.0.0.1']}],lookup:async()=>[{address:'127.0.0.1',family:4}],connect:()=>net.connect(port,'127.0.0.2'),timeoutMs:1000});const bridge=net.createServer(s=>proxy.accept(s));const p=await listening(bridge);t.after(()=>{proxy.close();bridge.close();actual.close()})
  const s=await send(p,port);await once(s,'close');assert.equal(received,false)
})
test('truncated ClientHello expires; invalid ClientHello closes immediately', async t=>{
  let calls=0;const proxy=createRestrictedProxy({rules:[{host:'allowed.test',port:443,addresses:['127.0.0.1']}],lookup:async()=>{calls++;return [{address:'127.0.0.1'}]},timeoutMs:150});const bridge=net.createServer(s=>proxy.accept(s));const p=await listening(bridge);t.after(()=>{proxy.close();bridge.close()})
  for (const payload of [Buffer.from([22,3,1]),Buffer.from('GET /')]) { const s=await open(p);s.write('CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n');await once(s,'data');s.write(payload);await once(s,'close') }
  assert.equal(calls,0)
})
test('caps incomplete incoming sockets at 32', async t=>{
  const proxy=createRestrictedProxy({rules:[],timeoutMs:3000});const bridge=net.createServer(s=>proxy.accept(s));const p=await listening(bridge);t.after(()=>{proxy.close();bridge.close()})
  const sockets=[];for(let i=0;i<32;i++)sockets.push(await open(p));const extra=await open(p);await once(extra,'close');for(const s of sockets)s.destroy()
})
