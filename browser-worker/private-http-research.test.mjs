import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { readFile, readlink, mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Research fixture only. No URL, content, port, profile or runtime tool is
// supplied by a caller; there is no integration into worker.mjs or a plugin.
test('fixed HTTP fixture inside private namespace with real Chromium', {skip:process.env.DSH_FNOS_PRIVATE_HTTP_RESEARCH_TEST!=='1',timeout:45000}, async t => {
  const FIXTURE_PORT=38179, CONTROL_PORT=38180
  let fixtureHostHits=0,controlHostHits=0,child,probe,dir,closed=false,stderr='',exitPromise,controlSocket,groupUnverified=false
  const accepted=new Set()
  function hostServer(handler){const s=http.createServer(handler);s.on('connection',c=>{accepted.add(c);c.on('error',()=>{});c.on('close',()=>accepted.delete(c))});return s}
  const hostSamePort=hostServer((req,res)=>{fixtureHostHits++;res.end('HOST_ONLY')})
  const hostControl=hostServer((req,res)=>{controlHostHits++;res.end('HOST_CONTROL')})
  const deadline=(promise,ms,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(label)),ms);promise.then(v=>{clearTimeout(timer);resolve(v)},e=>{clearTimeout(timer);reject(e)})})
  const listen=(server,port)=>deadline(new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)}),3000,'own host listener deadline')
  const getHost=port=>deadline(new Promise((resolve,reject)=>{http.get(`http://127.0.0.1:${port}/`,res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve(data))}).on('error',reject)}),3000,'own host positive control deadline')
  try {
    await listen(hostSamePort,FIXTURE_PORT);await listen(hostControl,CONTROL_PORT)
    assert.equal(await getHost(FIXTURE_PORT),'HOST_ONLY');assert.equal(await getHost(CONTROL_PORT),'HOST_CONTROL')
    // A still-open connection to our own host listener is a sensitive FD control.
    controlSocket=net.createConnection({host:'127.0.0.1',port:CONTROL_PORT})
    await deadline(new Promise((resolve,reject)=>{controlSocket.once('connect',resolve);controlSocket.once('error',reject)}),3000,'host control socket deadline')
    const fd=controlSocket._handle?.fd;assert(Number.isSafeInteger(fd)&&fd>=3)
    const link=await readlink(`/proc/self/fd/${fd}`);assert.match(link,/^socket:\[\d+\]$/)
    const inode=link.slice(8,-1)
    const rows=(await readFile('/proc/net/tcp','utf8')).split('\n').slice(1).filter(Boolean).map(x=>x.trim().split(/\s+/))
    assert(rows.some(row=>row[9]===inode&&row[3]==='01'),'host control TCP socket not established')

    // Transform a private launcher COPY in memory. Fail if source has changed;
    // no source patch, installed binary, plugin or user configuration is altered.
    let src=await readFile(new URL('./isolation.mjs',import.meta.url),'utf8')
    assert.equal(src.split("stdio:['ignore','ignore','pipe','pipe','pipe',...descriptors]").length,2,'launcher fd allowlist changed')
    assert.equal(src.split("stdio:['ignore','ignore','ignore',3,4]").length,2,'Chromium fd allowlist changed')
    function replaceOnce(before,after){assert.equal(src.split(before).length,2,`fixture source changed: ${before}`);src=src.replace(before,()=>after)}
    replaceOnce("'./fixture-http.mjs'", JSON.stringify(new URL('./fixture-http.mjs',import.meta.url).href))
    const setup=String.raw`/usr/bin/mount --make-rprivate /
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc /proc
ownerline=$(/usr/bin/lsns -p $$ -t net -o NS,TYPE,ONS -n -r)
[[ "$ownerline" =~ ^[0-9]+\ net\ [0-9]+$ ]] || { echo 'invalid netns owner output' >&2; exit 90; }
read -r netino kind owner <<< "$ownerline"
userinode=$(/usr/bin/stat -Lc %i /proc/self/ns/user)
netinode=$(/usr/bin/stat -Lc %i /proc/self/ns/net)
[[ "$userinode" =~ ^[0-9]+$ && "$netinode" =~ ^[0-9]+$ ]] || exit 90
[[ "$owner" != 0 && "$owner" == "$userinode" && "$netino" == "$netinode" ]] || { echo 'netns owner mismatch' >&2; exit 90; }
/usr/bin/ip link set lo up`
    replaceOnce('/usr/bin/mount --make-rprivate /',setup)
    replaceOnce('for program in unshare umount;', 'for program in unshare umount setpriv;')
    replaceOnce('libpcre2-8.so.0; do', 'libpcre2-8.so.0 libcap-ng.so.0; do')
    replaceOnce('exec /usr/bin/unshare --user --map-user=1000 --map-group=1000 /usr/bin/node', 'exec /usr/bin/unshare --keep-caps --user --map-user=1000 --map-group=1000 /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/node')
    const guard=String.raw`
    const http=require('node:http'),os=require('node:os');
    const status=fs.readFileSync('/proc/self/status','utf8');
    for(const n of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){const l=status.split('\n').find(x=>x.startsWith(n+':'));if(!l||BigInt('0x'+l.split(':')[1].trim())!==0n)throw Error('capability guard '+n)}
    if(!status.split('\n').includes('NoNewPrivs:\t1'))throw Error('NoNewPrivs guard');
    if(JSON.stringify(Object.keys(os.networkInterfaces()))!==JSON.stringify(['lo']))throw Error('interface guard');
    const r4=fs.readFileSync('/proc/net/route','utf8').split('\n').slice(1).filter(Boolean).map(x=>x.trim().split(/\s+/));
    if(r4.some(x=>x[0]!=='lo'||x[2]!=='00000000'))throw Error('IPv4 route guard');
    const r6=fs.readFileSync('/proc/net/ipv6_route','utf8').split('\n').filter(Boolean).map(x=>x.trim().split(/\s+/));
    if(r6.some(x=>x.at(-1)!=='lo'||x[4]!=='00000000000000000000000000000000'))throw Error('IPv6 route guard');
    const forbidden='socket:[${inode}]';
    for(const fd of [0,1,2,3,4])if(fs.readlinkSync('/proc/self/fd/'+fd)===forbidden)throw Error('host TCP fd inherited through explicit stdio');
    let descriptors=0,incomplete=0;
    for(const fd of fs.readdirSync('/proc/self/fd')){let target;try{target=fs.readlinkSync('/proc/self/fd/'+fd)}catch(e){if(e.code==='ENOENT'){incomplete++;continue}throw e}if(target===forbidden)throw Error('host TCP fd inherited');descriptors++}
    console.error('FIXTURE_GUARDS_OK '+JSON.stringify({descriptors,incomplete}));
    const sockets=new Set();
    const site=http.createServer((req,res)=>{
      if(req.method!=='GET'){res.writeHead(405);return res.end()}
      if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end('<!doctype html><input aria-label="fixture" id="value"><button onclick="console.error(\'fixture-console\');fetch(\'/500\');fetch(\'/cut\').catch(()=>{})">Go</button>')}
      if(req.url==='/500'){res.writeHead(500);return res.end('fixture error')}
      if(req.url==='/cut'){req.socket.destroy();return}
      res.writeHead(404);res.end()
    });site.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s))});
    site.on('error',()=>{console.error('fixture listener error');process.exit(91)});
    site.listen(38179,'127.0.0.1',()=>{
      const socket=net.createConnection({host:'127.0.0.1',port:38180});
      socket.setTimeout(1000,()=>{console.error('host negative control timeout');process.exit(92)});
      socket.on('connect',()=>{console.error('host unexpectedly reachable');process.exit(92)});
      socket.on('error',err=>{
        if(err.code!=='ECONNREFUSED'){console.error('host negative control inconclusive');process.exit(92)}
        console.error('HOST_CONTROL_REFUSED');
    `
    replaceOnce("  const env = {HOME:'/tmp/home'",`${guard}\n  const env = {HOME:'/tmp/home'`)
    const afterSpawn=String.raw`
    setTimeout(()=>{try{
      const s=fs.readFileSync('/proc/'+p.pid+'/status','utf8');
      for(const n of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){const l=s.split('\n').find(x=>x.startsWith(n+':'));if(!l||BigInt('0x'+l.split(':')[1].trim())!==0n)throw Error(n)}
      if(!s.split('\n').includes('NoNewPrivs:\t1'))throw Error('NoNewPrivs');
      const uid=s.split('\n').find(x=>x.startsWith('Uid:'));const gid=s.split('\n').find(x=>x.startsWith('Gid:'));
      if(!/^Uid:\s+1000\s+1000\s+1000\s+1000$/.test(uid)||!/^Gid:\s+1000\s+1000\s+1000\s+1000$/.test(gid))throw Error('uid/gid');
      console.error('CHROMIUM_STATUS_OK');
    }catch(e){console.error('CHROMIUM_STATUS_FAILED '+e.message);process.exit(93)}},300);
    `
    replaceOnce("  p.on('error',e=>",`${afterSpawn}\n  p.on('error',e=>`)
    replaceOnce("  p.on('exit',(code,signal)=>{process.exitCode=code===0?0:1});", "  p.on('exit',(code,signal)=>{for(const socket of sockets)socket.destroy();site.close();process.exitCode=code===0?0:1});\n      });\n    });")
    const mod=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'))
    dir=await mkdtemp(path.join(os.tmpdir(),'dsh-browser-worker-'));const root=path.join(dir,'root');await mkdir(root,{mode:0o700})
    probe=await mod.createIsolationProbe();child=mod.spawnIsolatedBrowser(root,probe)
    child.stderr.on('data',x=>stderr+=x);child.stdio[3].on('error',()=>{});child.stdio[4].on('error',()=>{})
    exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal})})})
    let buffer=Buffer.alloc(0),serial=0;const pending=new Map(),events=[]
    child.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);let i;while((i=buffer.indexOf(0))>=0){const m=JSON.parse(buffer.subarray(0,i));buffer=buffer.subarray(i+1);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}else if(m.method)events.push(m)}})
    const call=(method,params={},sessionId)=>deadline(Promise.race([new Promise(resolve=>{const id=++serial;pending.set(id,resolve);child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')}),exitPromise.then(x=>{throw Error(`fixture exit ${JSON.stringify(x)}: ${stderr}`)})]),6000,`CDP ${method} deadline`)
    assert((await call('Browser.getVersion')).result?.product?.startsWith('Chrome/'))
    const guardDeadline=Date.now()+5000
    while(!stderr.includes('CHROMIUM_STATUS_OK')){if(closed||Date.now()>guardDeadline)throw Error(`Chromium capability check incomplete: ${stderr}`);await new Promise(r=>setTimeout(r,30))}
    const sandbox=await call('Target.createTarget',{url:'chrome://sandbox'});const sandboxSession=(await call('Target.attachToTarget',{targetId:sandbox.result.targetId,flatten:true})).result.sessionId
    await new Promise(r=>setTimeout(r,300));const status=await call('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true},sandboxSession);assert.match(status.result.result.value,/Layer 1 Sandbox\s+Namespace/);assert.match(status.result.result.value,/PID namespaces\s+Yes/);assert.match(status.result.result.value,/Network namespaces\s+Yes/);assert.match(status.result.result.value,/Seccomp-BPF sandbox\s+Yes/)
    const target=await call('Target.createTarget',{url:'about:blank'})
    const attached=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});const session=attached.result.sessionId
    await call('Page.enable',{},session);await call('Runtime.enable',{},session);await call('Network.enable',{},session)
    const nav=await call('Page.navigate',{url:'http://127.0.0.1:38179/'},session);assert.ok(nav.result?.frameId&&nav.result.loaderId&&!nav.result.errorText,JSON.stringify(nav))
    const readyEnd=Date.now()+5000
    for(;;){const state=await call('Runtime.evaluate',{expression:'({url:location.href,ready:document.readyState})',returnByValue:true},session);const frame=(await call('Page.getFrameTree',{},session)).result.frameTree.frame;if(state.result?.result?.value?.url==='http://127.0.0.1:38179/'&&state.result.result.value.ready==='complete'&&frame.id===nav.result.frameId&&frame.loaderId===nav.result.loaderId)break;if(Date.now()>readyEnd)throw Error('fixed fixture navigation not ready');await new Promise(r=>setTimeout(r,30))}
    const evalResult=await call('Runtime.evaluate',{expression:"document.querySelector('#value').value='fixture-value';document.querySelector('#value').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('button').click();document.querySelector('#value').value",returnByValue:true},session)
    assert.equal(evalResult.result?.result?.value,'fixture-value')
    const until=Date.now()+5000
    while(!events.some(x=>x.method==='Runtime.consoleAPICalled')||!events.some(x=>x.method==='Network.responseReceived'&&x.params.response.status===500)||!events.some(x=>x.method==='Network.loadingFailed')||!stderr.includes('CHROMIUM_STATUS_OK')){if(Date.now()>until)throw Error(`missing fixture observations: ${stderr}`);await new Promise(r=>setTimeout(r,30))}
    assert(stderr.includes('FIXTURE_GUARDS_OK')&&stderr.includes('HOST_CONTROL_REFUSED'),stderr)
    const guardLine=stderr.split('\n').find(x=>x.startsWith('FIXTURE_GUARDS_OK '))
    const guardResult=JSON.parse(guardLine.slice('FIXTURE_GUARDS_OK '.length))
    assert(Number.isSafeInteger(guardResult.incomplete)&&guardResult.incomplete>=0)
    await t.test('additional FD inventory observation',t=>{if(guardResult.incomplete)t.skip(`${guardResult.incomplete} FD read(s) incomplete; inventory inconclusive`)})
    const screenshot=await call('Page.captureScreenshot',{format:'png'},session);assert(Buffer.from(screenshot.result.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    assert.equal(await getHost(FIXTURE_PORT),'HOST_ONLY');assert.equal(controlHostHits,1,'isolated process must not contact the host control')
    await call('Browser.close');const result=await deadline(exitPromise,5000,'fixture close deadline');assert.equal(result.code,0,stderr)
    // This observes our original group only, not potentially detached descendants.
    const groupDeadline=Date.now()+2000
    for(;;){try{process.kill(-child.pid,0)}catch(e){if(e.code==='ESRCH')break;groupUnverified=true;throw e}if(Date.now()>groupDeadline){groupUnverified=true;throw Error('fixture process group still exists; cleanup unverified')}await new Promise(r=>setTimeout(r,30))}
    await t.test('empty netns owner output refuses startup',async()=>{
      const marker='ownerline=$(/usr/bin/lsns -p $$ -t net -o NS,TYPE,ONS -n -r)'
      assert.equal(src.split(marker).length,2)
      const bad=src.replace(marker,()=>"ownerline=''")
      const badMod=await import('data:text/javascript;base64,'+Buffer.from(bad).toString('base64'))
      const badDir=await mkdtemp(path.join(os.tmpdir(),'dsh-browser-worker-'));const badRoot=path.join(badDir,'root');await mkdir(badRoot,{mode:0o700})
      let badChild,badProbe,badClosed=false,badError='',badExit
      try{
        badProbe=await badMod.createIsolationProbe()
        badChild=badMod.spawnIsolatedBrowser(badRoot,badProbe);badChild.stderr.on('data',x=>badError+=x);badChild.stdio[3].on('error',()=>{});badChild.stdio[4].on('error',()=>{});badChild.stdio[4].resume()
        badExit=new Promise((resolve,reject)=>{badChild.once('error',reject);badChild.once('close',(code,signal)=>{badClosed=true;resolve({code,signal})})})
        const failure=await deadline(badExit,5000,'invalid owner guard deadline')
        assert.equal(failure.code,90,badError);assert.match(badError,/invalid netns owner output/)
      }finally{
        if(badChild?.pid&&!badClosed){try{process.kill(-badChild.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}await deadline(badExit,3000,`bad guard cleanup unverified; preserved ${badDir}`)}
        if(badProbe)await badProbe.dispose()
        await rm(badDir,{recursive:true,force:true})
      }
    })
    console.log(JSON.stringify({fixedPrivateHttp:true,ownerChecked:true,chromeCapsAndNnpChecked:true,sandboxPidAndSeccomp:true,clickFillScreenshotConsole500AndDisconnect:true,hostNegativeControl:true,hostSamePortOwnService:true,controlNotObservedOnExplicitStdio:true,otherFdScanIncomplete:guardResult.incomplete,limitations:'single known host socket only; incomplete other-FD scan is inconclusive; transient descriptors, all Chromium descendants, full cleanup under SIGKILL and production security remain unproven'}))
  } finally {
    let failure=groupUnverified?new Error('original process group cleanup unverified'):undefined
    if(child?.pid&&!closed){try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')failure=e}try{await deadline(exitPromise,3000,'fixture group cleanup unverified')}catch(e){failure=e}}
    if(probe)try{await probe.dispose()}catch(e){failure=e}
    controlSocket?.destroy();for(const s of accepted)s.destroy()
    for(const s of [hostSamePort,hostControl])if(s.listening)try{await deadline(new Promise(resolve=>s.close(resolve)),3000,'host server close deadline')}catch(e){failure=e}
    if(dir&&!failure)await rm(dir,{recursive:true,force:true})
    if(failure)throw new Error(`cleanup unverified${dir?`; preserved ${dir}`:''}: ${failure.message}`)
  }
})
