// Local experiments only. This is not a domain, URL, or production policy.
import net from 'node:net'
import http from 'node:http'

export function createFixedEndpointTestProxy(options) {
  // No arbitrary routes: this experiment is deliberately constrained to a
  // locally-created host test service, never an actual network site.
  if (!options || options.address !== '127.0.0.1' || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || options.authority !== `allowed.test:${options.port}`) throw Error('invalid test-only endpoint policy')
  const address = options.address, port = options.port, authority = options.authority
  const active = new Set(), timers = new Map()
  let closed = false
  const server = http.createServer({maxHeaderSize:8192},(_req,res)=>{res.writeHead(405,{'connection':'close'});res.end()})
  server.on('clientError',(_err,socket)=>socket.destroy())
  server.on('connect',(req,client,head)=>{
    const headers = req.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase())
    if (req.httpVersion!=='1.1' || req.url!==authority || req.headers.host!==authority || new Set(headers).size!==headers.length || headers.some(x=>['authorization','proxy-authorization','cookie','content-length','transfer-encoding','upgrade','expect'].includes(x))) {client.destroy();return}
    client.pause()
    const upstream=net.connect({host:address,port,family:4})
    active.add(upstream);upstream.once('close',()=>active.delete(upstream));upstream.on('error',()=>client.destroy());client.once('close',()=>upstream.destroy())
    upstream.setTimeout(3000,()=>upstream.destroy())
    upstream.once('connect',()=>{
      if (closed || client.destroyed || upstream.remoteAddress!==address || upstream.remotePort!==port) {upstream.destroy();client.destroy();return}
      clearTimeout(timers.get(client));timers.delete(client)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream);upstream.pipe(client);client.resume()
    })
  })
  return {
    accept(socket) {
      if (!(socket instanceof net.Socket)) throw Error('expected socket')
      if(closed || active.size>=16){socket.destroy();return}
      active.add(socket);socket.on('error',()=>{});timers.set(socket,setTimeout(()=>socket.destroy(),3000));socket.once('close',()=>{active.delete(socket);clearTimeout(timers.get(socket));timers.delete(socket)})
      server.emit('connection',socket);socket.resume()
    },
    close(){closed=true;for(const socket of active)socket.destroy();server.close()}
  }
}
