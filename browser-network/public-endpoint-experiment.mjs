// EXPERIMENT ONLY. No Harness integration; this does not prove routing, endpoint
// ownership, TLS HTTP authority, URL or tenant isolation. Never deploy as-is.
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { Transform } from 'node:stream'

const MAX_BYTES=8*1024*1024, MAX_CONNECTIONS=8, TIMEOUT_MS=5000
// Conservative static special-purpose exclusions, not proof of global routing.
const denied=[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]
const block=new net.BlockList();for(const [ip,bits] of denied)block.addSubnet(ip,bits,'ipv4')
export function passesStaticIpv4Filter(address) {
  return typeof address==='string' && net.isIP(address)===4 && !block.check(address,'ipv4')
}
function validDomain(name) {
  return typeof name==='string' && name.length<=253 && name===name.toLowerCase() && name.includes('.') && net.isIP(name)===0 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) && !/(?:^|\.)(?:localhost|local|internal)$/.test(name)
}
function localAddress(address, getInterfaces) {
  const entries=getInterfaces()
  if(!entries || typeof entries!=='object' || !Object.keys(entries).length) throw Error('local interface inventory unavailable')
  let count=0
  for(const records of Object.values(entries)) {
    if(!Array.isArray(records)) throw Error('invalid interface inventory')
    for(const item of records) {
      if(!item || typeof item.address!=='string' || !net.isIP(item.address.split('%')[0])) throw Error('invalid interface address')
      count++
      if(item.address===address || item.address.toLowerCase()===`::ffff:${address}`) return true
      // Normalise hex-form IPv4-mapped IPv6 by URL canonical form.
      if(net.isIP(item.address)===6) {
        const octets=address.split('.').map(Number), mapped=`[::ffff:${((octets[0]<<8)|octets[1]).toString(16)}:${((octets[2]<<8)|octets[3]).toString(16)}]`
        try {if(new URL(`http://[${item.address}]/`).hostname===mapped)return true}catch {throw Error('invalid IPv6 interface address')}
      }
    }
  }
  if(!count)throw Error('empty interface inventory')
  return false
}
function validate(policy,interfaces) {
  if(!policy || Object.keys(policy).sort().join(',')!=='address,domain,port' || !validDomain(policy.domain) || !Number.isInteger(policy.port) || policy.port<1 || policy.port>65535 || !passesStaticIpv4Filter(policy.address) || localAddress(policy.address,interfaces)) throw Error('invalid or unsafe experimental endpoint')
}
function limit() {
  let n=0
  return new Transform({transform(chunk,_enc,callback){n+=chunk.length;if(n>MAX_BYTES){callback(Error('experimental byte limit exceeded'));return}callback(null,chunk)}})
}
function make(policy,{interfaces,connect}) {
  validate(policy,interfaces)
  const {domain,port,address}=policy,authority=`${domain}:${port}`
  const active=new Set(),clients=new Set(),timers=new Map();let closed=false
  const server=http.createServer({maxHeaderSize:8192},(_req,res)=>{res.writeHead(405,{connection:'close'});res.end()})
  server.on('clientError',(_err,socket)=>socket.destroy())
  server.on('connect',(req,client,head)=>{
    const headers=req.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase())
    if(closed || req.httpVersion!=='1.1' || req.url!==authority || req.headers.host!==authority || head.length>65536 || new Set(headers).size!==headers.length || headers.some(x=>['proxy-authorization','authorization','cookie','content-length','transfer-encoding','upgrade','expect'].includes(x))){client.destroy();return}
    client.pause()
    let upstream
    try { if(localAddress(address,interfaces))throw Error('endpoint is local'); upstream=connect({host:address,port,family:4}) } catch {client.destroy();return}
    if(!(upstream instanceof net.Socket)){client.destroy();return}
    active.add(upstream);upstream.once('close',()=>{active.delete(upstream);client.destroy()});upstream.on('error',()=>client.destroy());client.once('close',()=>upstream.destroy());upstream.setTimeout(TIMEOUT_MS,()=>upstream.destroy())
    upstream.once('connect',()=>{
      try {
        if(closed || client.destroyed || upstream.remoteAddress!==address || upstream.remotePort!==port || localAddress(address,interfaces))throw Error('destination mismatch')
        const upload=limit(),download=limit();const fail=()=>{client.destroy();upstream.destroy()};upload.on('error',fail);download.on('error',fail)
        clearTimeout(timers.get(client));timers.delete(client)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upload.write(head)
        client.pipe(upload).pipe(upstream);upstream.pipe(download).pipe(client);client.resume()
      } catch {client.destroy();upstream.destroy()}
    })
  })
  return {
    accept(socket) {
      if(!(socket instanceof net.Socket))throw Error('expected socket')
      if(closed || clients.size>=MAX_CONNECTIONS){socket.destroy();return}
      clients.add(socket);active.add(socket);socket.on('error',()=>{});socket.setTimeout(TIMEOUT_MS,()=>socket.destroy());timers.set(socket,setTimeout(()=>socket.destroy(),TIMEOUT_MS))
      socket.once('close',()=>{clients.delete(socket);active.delete(socket);clearTimeout(timers.get(socket));timers.delete(socket)})
      server.emit('connection',socket);socket.resume()
    },
    close(){closed=true;for(const s of active)s.destroy();server.close()}
  }
}
/** Experimental disconnected proxy, default denies all when policy is absent. */
export function createPublicEndpointExperiment(policy) { return make(policy,{interfaces:os.networkInterfaces,connect:net.connect}) }
/** Offline fixtures only. Injecting either hook defeats trust; never deploy or expose. */
export function createOfflineMockEndpointExperiment(policy,hooks) {
  if(!hooks || typeof hooks.interfaces!=='function' || typeof hooks.connect!=='function')throw Error('mock hooks required')
  return make(policy,hooks)
}
