import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { readFile, readlink, mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Optional research only. This intentionally passes ONE self-owned host TCP
// connection to a copied launcher as a positive control. It never passes the
// connection deliberately to Chromium or connects to a non-test service.
test('identify a self-owned host TCP fd across netns and inspect Chromium startup', {skip:process.env.DSH_FNOS_SOCKET_FD_RESEARCH_TEST!=='1',timeout:30000}, async t => {
  const accepted=new Set();let received=''
  const server=net.createServer(socket=>{accepted.add(socket);socket.on('data',x=>received+=x);socket.on('error',()=>{});socket.on('close',()=>accepted.delete(socket))})
  let client,probe,child,dir,exitPromise,closed=false,stderr=''
  const readDeadline=(promise,ms,label)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(label)),ms);promise.then(v=>{clearTimeout(t);resolve(v)},e=>{clearTimeout(t);reject(e)})})
  try {
    await readDeadline(new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)}),3000,'host server start deadline')
    client=net.createConnection({host:'127.0.0.1',port:server.address().port})
    await readDeadline(new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject)}),3000,'host positive control connect deadline')
    // _handle.fd is deliberately restricted to this Node-26-only test fixture;
    // it must resolve to a live socket inode in our own /proc/net/tcp table.
    const controlFd=client._handle?.fd
    assert(Number.isSafeInteger(controlFd)&&controlFd>=3,'test-owned socket fd unavailable')
    const controlLink=await readlink(`/proc/self/fd/${controlFd}`)
    const match=/^socket:\[(\d+)\]$/.exec(controlLink);assert(match,'test socket inode unavailable')
    const controlInode=match[1]
    const hostRows=(await readFile('/proc/net/tcp','utf8')).split('\n').slice(1).filter(Boolean).map(x=>x.trim().split(/\s+/))
    assert(hostRows.some(row=>row[9]===controlInode&&row[3]==='01'),'positive control is not an established host TCP socket')

    let src=await readFile(new URL('./isolation.mjs',import.meta.url),'utf8')
    function replaceOnce(before,after){assert.equal(src.split(before).length,2,`fixture source changed: ${before}`);src=src.replace(before,after)}
    replaceOnce("'./fixture-http.mjs'", JSON.stringify(new URL('./fixture-http.mjs',import.meta.url).href))
    replaceOnce('for program in unshare umount;', 'for program in unshare umount setpriv;')
    replaceOnce('libpcre2-8.so.0; do', 'libpcre2-8.so.0 libcap-ng.so.0; do')
    replaceOnce('exec /usr/bin/unshare --user --map-user=1000 --map-group=1000 /usr/bin/node', 'exec /usr/bin/unshare --keep-caps --user --map-user=1000 --map-group=1000 /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/node')
    replaceOnce("stdio:['ignore','ignore','pipe','pipe','pipe',...descriptors]",`stdio:['ignore','ignore','pipe','pipe','pipe',...descriptors,${controlFd}]`)
    const beforeSpawn=String.raw`
    const inheritedLink=fs.readlinkSync('/proc/self/fd/9');
    const inode=(/^socket:\[(\d+)\]$/.exec(inheritedLink)||[])[1];
    const tcp=fs.readFileSync('/proc/net/tcp','utf8').split('\n').slice(1).filter(Boolean).map(row=>row.trim().split(/\s+/)[9]);
    function scan(pid){try{let unreadable=0,found=false;for(const fd of fs.readdirSync('/proc/'+pid+'/fd')){try{if(fs.readlinkSync('/proc/'+pid+'/fd/'+fd)===inheritedLink)found=true}catch(e){unreadable++}}return {found,unreadable}}catch(e){return {unavailable:e.code}}}
    console.error('FD_CONTROL '+JSON.stringify({inode,visibleInOwnTcp:tcp.includes(inode),selfScan:scan('self')}));
    const inherited=new net.Socket({fd:9,readable:true,writable:true});inherited.on('error',()=>{});inherited.write('CONTROL_ONLY\n');inherited.unref();
    `
    replaceOnce("  const p = spawn('/runtime/usr/lib/chromium/chromium'",`${beforeSpawn}\n  const p = spawn('/runtime/usr/lib/chromium/chromium'`)
    const sampling=String.raw`
    let sampleCount=0,timer;function sample(){
      console.error('FD_SAMPLE '+JSON.stringify(scan(p.pid)));
      if(++sampleCount===21)clearInterval(timer)
    }
    sample();timer=setInterval(sample,50);p.once('exit',()=>clearInterval(timer));
    `
    replaceOnce("  p.on('error',e=>",`${sampling}\n  p.on('error',e=>`)
    const mod=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'))
    dir=await mkdtemp(path.join(os.tmpdir(),'dsh-browser-worker-'));const root=path.join(dir,'root');await mkdir(root,{mode:0o700})
    probe=await mod.createIsolationProbe();child=mod.spawnIsolatedBrowser(root,probe)
    child.stderr.on('data',data=>stderr+=data);child.stdio[3].on('error',()=>{});child.stdio[4].on('error',()=>{})
    exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal})})})
    let buffer=Buffer.alloc(0),id=0;const pending=new Map()
    child.stdio[4].on('data',data=>{buffer=Buffer.concat([buffer,data]);let i;while((i=buffer.indexOf(0))>=0){const m=JSON.parse(buffer.subarray(0,i));buffer=buffer.subarray(i+1);const r=pending.get(m.id);if(r){pending.delete(m.id);r(m)}}})
    const cmd=(method,params={})=>readDeadline(Promise.race([new Promise(resolve=>{const n=++id;pending.set(n,resolve);child.stdio[3].write(JSON.stringify({id:n,method,params})+'\0')}),exitPromise.then(x=>{throw new Error(`launcher exited ${JSON.stringify(x)} ${stderr}`)})]),6000,'CDP deadline')
    assert((await cmd('Browser.getVersion')).result?.product?.startsWith('Chrome/'))
    await new Promise(resolve=>setTimeout(resolve,1300))
    const controlLines=stderr.split('\n').filter(x=>x.startsWith('FD_CONTROL '))
    const samples=stderr.split('\n').filter(x=>x.startsWith('FD_SAMPLE ')).map(x=>JSON.parse(x.slice('FD_SAMPLE '.length)))
    function validatePositiveControl(){
      assert.equal(controlLines.length,1,stderr)
      const observed=JSON.parse(controlLines[0].slice('FD_CONTROL '.length))
      assert.equal(observed.inode,controlInode,'namespace child must inherit the exact host socket')
      assert.equal(observed.visibleInOwnTcp,false,'host TCP socket should not appear in child netns TCP table')
      assert.equal(observed.selfScan.found,true,'same inode scanner must detect the injected fd as a positive control')
      assert.equal(received,'CONTROL_ONLY\n','host socket positive-control handshake missing or duplicated')
    }
    validatePositiveControl()
    await t.test('mandatory host TCP inheritance positive control',validatePositiveControl)
    await t.test('Chromium main process descriptor observations',t=>{
      assert(samples.length>=10,`insufficient samples ${stderr}`)
      assert(!samples.some(x=>x.found),'positive-control socket observed in Chromium')
      const incomplete=samples.filter(x=>x.unavailable||x.unreadable).length
      console.log(JSON.stringify({hostTcpEstablished:true,childInheritedExactInode:true,childCanUseHostSocket:true,childNetnsTcpTableContainsIt:false,browserSamples:samples.length,completeSamples:samples.length-incomplete,incompleteSamples:incomplete,browserObservedControl:false,limitations:'observed snapshots only; no atomic exec-time fd audit; other sockets, transient descriptors, userns owner and all Chromium descendants remain unproven'}))
      if(incomplete)t.skip(`${incomplete} fd snapshots incomplete; browser inheritance result inconclusive`)
    })
    await cmd('Browser.close');await readDeadline(exitPromise,4000,'browser close deadline')
  } finally {
    let cleanupFailure
    if(child?.pid&&!closed){try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')cleanupFailure=e}try{await readDeadline(exitPromise,3000,'process-group close unverified')}catch(e){cleanupFailure=e}}
    if(probe)try{await probe.dispose()}catch(e){cleanupFailure=e}
    client?.destroy();for(const s of accepted)s.destroy()
    if(server.listening)try{await readDeadline(new Promise(resolve=>server.close(resolve)),3000,'host server close deadline')}catch(e){cleanupFailure=e}
    if(dir&&!cleanupFailure)await rm(dir,{recursive:true,force:true})
    if(cleanupFailure)throw new Error(`cleanup unverified${dir?`; preserved ${dir}`:''}: ${cleanupFailure.message}`)
  }
})
