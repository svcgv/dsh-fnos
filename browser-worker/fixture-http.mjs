// Administrator-only offline research fixture. Not a production isolation boundary.
// No input controls URL, port, HTML, process paths or network policy.
import net from 'node:net'

export const fixtureHostPort = 38180
export const fixtureUrl = 'http://127.0.0.1:38179/'

const controls = new WeakMap()
function bounded(setup, signal) {
  return new Promise((resolve,reject)=>{
    let settled=false
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(value)}
    const aborted=()=>finish(signal.reason||new Error('fixture control cancelled'))
    const timer=setTimeout(()=>finish(new Error('fixture control timed out')),3000)
    if(signal?.aborted){aborted();return}
    signal?.addEventListener('abort',aborted,{once:true})
    try{setup(finish)}catch(error){finish(error)}
  })
}
export async function createFixtureControl(signal) {
  let server,client,closed
  const state={server:undefined,error:undefined}
  const sockets=new Set()
  async function dispose(){
    if(closed)return closed
    closed=(async()=>{
      client?.destroy()
      for(const socket of sockets)socket.destroy()
      if(server)await bounded(done=>server.close(error=>done(error?.code==='ERR_SERVER_NOT_RUNNING'?null:error)))
    })()
    return closed
  }
  try{
    server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));socket.end('fixture-control')})
    state.server=server
    server.on('error',error=>{state.error=error})
    await bounded(done=>{server.once('error',done);server.listen(fixtureHostPort,'127.0.0.1',()=>done())},signal)
    const address=server.address()
    if(!address||address.address!=='127.0.0.1'||address.port!==fixtureHostPort)throw Error('invalid fixture control listener')
    await bounded(done=>{
      client=net.createConnection({host:'127.0.0.1',port:fixtureHostPort})
      let value=''
      client.on('data',data=>{value+=data;if(value.length>100)done(Error('fixture control response too large'))})
      client.once('error',done)
      client.once('end',()=>done(value==='fixture-control'?null:Error('fixture positive control failed')))
    },signal)
    client.destroy();client=undefined
    const control=Object.freeze({dispose})
    controls.set(control,state)
    return control
  }catch(error){try{await dispose()}catch(cleanupError){throw new AggregateError([error,cleanupError],'fixture control cleanup failed')}throw error}
}
export function assertFixtureControl(control){const state=controls.get(control);if(!state?.server.listening||state.error)throw Error('active fixture positive control required')}

// This block is executed only after namespaceGuard and before enabling lo.
export const fixtureNetworkSetup = String.raw`
/usr/bin/mount --make-rprivate /
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc /proc
ownerline=$(/usr/bin/lsns -p $$ -t net -o NS,TYPE,ONS -n -r)
[[ "$ownerline" =~ ^[0-9]+\ net\ [0-9]+$ ]] || { echo 'invalid netns owner output' >&2; exit 90; }
read -r netino kind owner <<< "$ownerline"
userinode=$(/usr/bin/stat -Lc %i /proc/self/ns/user)
netinode=$(/usr/bin/stat -Lc %i /proc/self/ns/net)
[[ "$userinode" =~ ^[0-9]+$ && "$netinode" =~ ^[0-9]+$ ]] || exit 90
[[ "$owner" != 0 && "$owner" == "$userinode" && "$netino" == "$netinode" ]] || { echo 'netns owner mismatch' >&2; exit 90; }
/usr/bin/ip link set lo up
`

// Keep /proc/self/fd open throughout: even transient or unreadable descriptors fail.
// fd 2/3/4 are the explicit stderr and CDP socketpairs created by the parent.
export function assertNoAdditionalSocketFds() {
  const fs = process.getBuiltinModule('node:fs')
  const directory=fs.opendirSync('/proc/self/fd')
  try {
    let entry
    while((entry=directory.readSync())!==null) {
      const fd=Number(entry.name)
      if(!Number.isSafeInteger(fd))throw Error('fd name')
      const target=fs.readlinkSync('/proc/self/fd/'+entry.name)
      if(target.startsWith('socket:[')&&![2,3,4].includes(fd))throw Error('unexpected socket fd')
    }
  } finally { directory.closeSync() }
  for(const fd of [0,1])if(fs.readlinkSync('/proc/self/fd/'+fd)!=='/dev/null')throw Error('unexpected stdio')
  for(const fd of [2,3,4])if(!fs.readlinkSync('/proc/self/fd/'+fd).startsWith('socket:['))throw Error('unexpected stdio')
}

// Runs inside pivoted root and the inner non-root userns, after setpriv.
export const fixtureInner = String.raw`
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),os=require('node:os'),{spawn}=require('node:child_process');
function fail(message){console.error('fixture: '+message);process.exit(90)}
function checkStatus(file){
  const s=fs.readFileSync(file,'utf8');
  for(const n of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){const l=s.split('\n').find(x=>x.startsWith(n+':'));if(!l||BigInt('0x'+l.split(':')[1].trim())!==0n)throw Error('capability '+n)}
  if(!s.split('\n').includes('NoNewPrivs:\t1'))throw Error('NoNewPrivs');
  for(const n of ['Uid','Gid']){const l=s.split('\n').find(x=>x.startsWith(n+':'));if(!new RegExp('^'+n+':\\s+1000\\s+1000\\s+1000\\s+1000$').test(l||''))throw Error(n)}
}
try{
  checkStatus('/proc/self/status');
  if(JSON.stringify(Object.keys(os.networkInterfaces()))!==JSON.stringify(['lo']))throw Error('network interfaces');
  const r4=fs.readFileSync('/proc/net/route','utf8').split('\n').slice(1).filter(Boolean).map(x=>x.trim().split(/\s+/));
  if(r4.some(x=>x[0]!=='lo'||x[2]!=='00000000'))throw Error('IPv4 routes');
  const r6=fs.readFileSync('/proc/net/ipv6_route','utf8').split('\n').filter(Boolean).map(x=>x.trim().split(/\s+/));
  if(r6.some(x=>x.at(-1)!=='lo'||x[4]!=='00000000000000000000000000000000'))throw Error('IPv6 routes');
  (${assertNoAdditionalSocketFds.toString()})();
  try{fs.statSync(process.env.HOST_CHECK);throw Error('host directory visible')}catch(e){if(e.code!=='ENOENT')throw e}
}catch(e){fail('startup guard '+e.message)}
const check=net.createConnection(process.env.HOST_SOCKET);
check.on('connect',()=>{check.destroy();fail('host unix socket reachable')});
check.on('error',e=>{
  if(e.code!=='ENOENT')fail('host unix socket check');
  const negative=net.createConnection({host:'127.0.0.1',port:38180});
  negative.setTimeout(1000,()=>fail('host TCP check timed out'));
  negative.on('connect',()=>{negative.destroy();fail('host TCP reachable')});
  negative.on('error',err=>{
    if(err.code!=='ECONNREFUSED')fail('host TCP check inconclusive');
    const sockets=new Set();
    const site=http.createServer((req,res)=>{
      if(req.method!=='GET'){res.writeHead(405);return res.end()}
      if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end('<!doctype html><input aria-label="fixture" id="value"><button onclick="console.error(\'fixture-console\');fetch(\'/500\');fetch(\'/cut\').catch(()=>{})">Go</button>')}
      if(req.url==='/500'){res.writeHead(500);return res.end('fixture error')}
      if(req.url==='/cut'){req.socket.destroy();return}
      res.writeHead(404);res.end()
    });
    site.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s))});
    site.on('error',()=>fail('fixture listener'));
    site.listen(38179,'127.0.0.1',()=>{
      const env={HOME:'/tmp/home',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:'/runtime/usr/lib/x86_64-linux-gnu:/runtime/lib/x86_64-linux-gnu:/runtime/usr/lib/chromium:/runtime/usr/lib/x86_64-linux-gnu/pulseaudio'};
      const p=spawn('/runtime/usr/lib/chromium/chromium',['--headless','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir=/tmp/home/profile','about:blank'],{env,stdio:['ignore','ignore','ignore',3,4]});
      p.on('error',()=>fail('Chromium launch'));
      p.on('exit',(code)=>{for(const socket of sockets)socket.destroy();site.close();process.exitCode=code===0?0:1});
      setTimeout(()=>{try{checkStatus('/proc/'+p.pid+'/status');console.error('FIXTURE_READY')}catch(e){fail('Chromium status '+e.message)}},300);
    });
  });
});
`
