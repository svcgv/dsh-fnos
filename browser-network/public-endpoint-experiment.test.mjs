// Offline tests: socket connection to the public target is mocked. Only a
// loopback listener is created and no external DNS or network is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import dns from 'node:dns'
import {once} from 'node:events'
import {createPublicEndpointExperiment,createOfflineMockEndpointExperiment,passesStaticIpv4Filter} from './public-endpoint-experiment.mjs'
const config={domain:'browser.example.com',port:443,address:'8.8.8.8'}
const local=()=>({lo:[{address:'127.0.0.1',family:'IPv4'}],eth:[{address:'10.2.3.4',family:'IPv4'}]})
class FakeSocket extends net.Socket {
  constructor(address,port){super();this.addr=address;this.port=port;this.writes=[]}
  get remoteAddress(){return this.addr} get remotePort(){return this.port}
  _read(){} _write(chunk,_enc,cb){this.writes.push(Buffer.from(chunk));cb()}
}
async function fixture(t,{destination='8.8.8.8',remotePort=443,interfaces=local}={}) {
  const calls=[],sockets=[]
  const connect=opts=>{calls.push(opts);const s=new FakeSocket(destination,remotePort);sockets.push(s);process.nextTick(()=>s.emit('connect'));return s}
  const proxy=createOfflineMockEndpointExperiment(config,{interfaces,connect}),bridge=net.createServer({pauseOnConnect:true},s=>proxy.accept(s));bridge.listen(0,'127.0.0.1');await once(bridge,'listening')
  t.after(()=>{proxy.close();bridge.close()});return {port:bridge.address().port,calls,sockets,proxy}
}
async function client(port,request){const s=net.connect(port,'127.0.0.1');s.on('error',()=>{});await once(s,'connect');if(request)s.write(request);return s}
const request=(authority='browser.example.com:443',extras='')=>`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extras}\r\n`
test('rejects empty, reserved, noncanonical and local policy addresses',()=>{
  assert.throws(()=>createPublicEndpointExperiment())
  for(const address of ['0.1.2.3','10.1.1.1','100.64.0.1','127.0.0.1','169.254.2.3','172.31.4.5','192.0.0.9','192.0.2.1','192.88.99.1','192.168.1.1','198.18.0.1','198.51.100.3','203.0.113.2','224.1.1.1','240.1.1.1','255.255.255.255','::ffff:8.8.8.8','::1','8.8.8.008','not-an-ip']){
    assert.equal(passesStaticIpv4Filter(address),false,address)
    assert.throws(()=>createOfflineMockEndpointExperiment({...config,address},{interfaces:local,connect:()=>{throw Error('no')}}))
  }
  assert.throws(()=>createOfflineMockEndpointExperiment(config,{interfaces:()=>({}),connect:()=>{}}))
  assert.throws(()=>createOfflineMockEndpointExperiment(config,{interfaces:()=>({eth:[{address:'::ffff:808:808'}]}),connect:()=>{}}))
  for(const domain of ['BROWSER.example.com','browser.example.com.','localhost','other.local','127.0.0.1','a..b','bad@host.com'])assert.throws(()=>createOfflineMockEndpointExperiment({...config,domain},{interfaces:local,connect:()=>{}}),domain)
})
test('only fixed approved IP/port is requested; TLS bytes pass without DNS',async t=>{
  const f=await fixture(t);let lookups=0;const original=dns.lookup;dns.lookup=(...args)=>{lookups++;return original(...args)};t.after(()=>{dns.lookup=original})
  const s=await client(f.port,request());const [headers]=await once(s,'data');assert.match(headers.toString(),/^HTTP\/1.1 200/)
  assert.deepEqual(f.calls,[{host:'8.8.8.8',port:443,family:4}]);assert.equal(lookups,0)
  const opaque=Buffer.from([22,3,1,0,4,0xfe,0x0d,0,0]);s.write(opaque)
  for(let i=0;i<50&&!f.sockets[0].writes.length;i++)await new Promise(r=>setTimeout(r,5))
  assert.deepEqual(Buffer.concat(f.sockets[0].writes),opaque);s.destroy()
})
test('rejects forged authority, duplicates, auth, ordinary HTTP, and IPv6 target',async t=>{
  const f=await fixture(t)
  const bad=[request('forged.example.com:443'),request('browser.example.com:444'),request('[::ffff:8.8.8.8]:443'),request('browser.example.com:443','Host: browser.example.com:443\r\n'),request('browser.example.com:443','Proxy-Authorization: Basic eA==\r\n'),'GET http://browser.example.com/ HTTP/1.1\r\nHost: browser.example.com\r\n\r\n']
  for(const r of bad){const s=await client(f.port,r);s.resume();await once(s,'close')}
  assert.equal(f.calls.length,0)
})
test('rejects actual remote IP or port mismatch before client receives tunnel',async t=>{
  for(const opts of [{destination:'8.8.4.4'},{destination:'::ffff:8.8.8.8'},{remotePort:444}]){
    const f=await fixture(t,opts),s=await client(f.port,request());const chunks=[];s.on('data',c=>chunks.push(c));await once(s,'close');assert.equal(Buffer.concat(chunks).length,0)
  }
})
test('rechecks dynamic local interfaces and denies when inventory fails',async t=>{
  for(const interfaces of [(()=>{let n=0;return ()=>++n===1?local():({eth:[{address:'8.8.8.8'}]})})(),(()=>{let n=0;return ()=>{if(++n===1)return local();throw Error('interface failure')}})()]){
    const f=await fixture(t,{interfaces}),s=await client(f.port,request());s.resume();await once(s,'close');assert.equal(f.calls.length,0)
  }
})
test('rechecks interface assignment after upstream connects',async t=>{
  let count=0;const interfaces=()=>++count<3?local():({eth:[{address:'8.8.8.8'}]})
  const f=await fixture(t,{interfaces}),s=await client(f.port,request());const chunks=[];s.on('data',x=>chunks.push(x));await once(s,'close');assert.equal(f.calls.length,1);assert.equal(Buffer.concat(chunks).length,0)
})
test('tunnel terminates on byte limit', {timeout:10000},async t=>{
  const f=await fixture(t),s=await client(f.port,request());await once(s,'data');const closed=new Promise(r=>s.once('close',r));s.write(Buffer.alloc(8*1024*1024+65536));await closed
  assert.ok(Buffer.concat(f.sockets[0].writes).length<=8*1024*1024)
})
test('eight incomplete connections maximum; close fails closed',async t=>{
  const f=await fixture(t),clients=[];for(let i=0;i<8;i++)clients.push(await client(f.port))
  const extra=await client(f.port);await once(extra,'close');const closes=clients.map(s=>once(s,'close'));f.proxy.close();await Promise.all(closes)
  const after=await client(f.port);await once(after,'close');assert.equal(f.calls.length,0)
})
test('incomplete request times out', {timeout:8000},async t=>{
  const f=await fixture(t),s=await client(f.port);s.write('CONNECT ');await once(s,'close');assert.equal(f.calls.length,0)
})
