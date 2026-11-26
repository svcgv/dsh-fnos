// ONLY FOR browser-network/namespace-e2e.test.mjs; no production security boundary.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

if (!process.send || !process.env.TEST_PROFILE || !process.env.TEST_PORT) process.exit(70)
const route = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
if (route.length) { console.error('unexpected IPv4 route'); process.exit(71) }
const server = net.createServer({pauseOnConnect:true}, socket => {
  socket.pause()
  process.send({ type: 'socket' }, socket, error => { if (error) socket.destroy() })
})
server.listen(0, '127.0.0.1', () => {
  const proxyPort = server.address().port
  const root='/vol1/@appcenter/fygo-browser/app/vendor/runtime'
  const env={HOME:process.env.TEST_PROFILE,PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:[`${root}/usr/lib/x86_64-linux-gnu`,`${root}/lib/x86_64-linux-gnu`,`${root}/usr/lib`,`${root}/usr/lib/chromium`].join(':')}
  const child=spawn(`${root}/usr/lib/chromium/chromium`,['--headless','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-quic','--disable-http2','--disable-features=EncryptedClientHello','--no-first-run','--ignore-certificate-errors',`--proxy-server=http://127.0.0.1:${proxyPort}`,'--proxy-bypass-list=<-loopback>','--remote-debugging-pipe',`--user-data-dir=${process.env.TEST_PROFILE}/profile`,'about:blank'],{env,stdio:['ignore','ignore','ignore','pipe','pipe']})
  let buf=Buffer.alloc(0)
  child.stdio[3].on('error',()=>{})
  child.stdio[4].on('data', chunk => { buf=Buffer.concat([buf,chunk]); let i;while((i=buf.indexOf(0))>=0){const message=JSON.parse(buf.subarray(0,i));buf=buf.subarray(i+1);process.send?.({type:'cdp',message})} })
  process.on('message', msg => { if (msg?.type==='cdp') child.stdio[3].write(`${JSON.stringify(msg.message)}\0`) })
  child.on('error',e=>{console.error(e.message);process.exit(72)})
  child.on('exit',()=>{server.close();process.disconnect?.()})
  // This address is the host test server, but in this namespace it is a different loopback.
  const direct=net.connect(Number(process.env.TEST_PORT),'127.0.0.1')
  direct.on('connect',()=>{direct.destroy();process.send?.({type:'direct',connected:true})})
  direct.on('error',()=>process.send?.({type:'direct',connected:false}))
  process.send({type:'ready',proxyPort})
})
process.on('disconnect',()=>process.exit(0))
