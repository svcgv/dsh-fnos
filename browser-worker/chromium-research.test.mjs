import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Explicit local-only research fixture: not used by worker.mjs or the plugin.
// This copy of the launcher is modified IN MEMORY, not installed or executed as
// a production policy. Its fixed host tools are experimental prerequisites.
test('sample real Chromium descendants, capabilities, namespaces and inherited fds', {skip:process.env.DSH_FNOS_CHROMIUM_RESEARCH_TEST !== '1',timeout:30000}, async t => {
  let src=await readFile(new URL('./isolation.mjs',import.meta.url),'utf8')
  function replaceOnce(before,after) {
    assert.equal(src.split(before).length,2,`fixture source changed: ${before}`)
    src=src.replace(before,after)
  }
  replaceOnce("'./fixture-http.mjs'", JSON.stringify(new URL('./fixture-http.mjs',import.meta.url).href))
  replaceOnce('for program in unshare umount;', 'for program in unshare umount setpriv;')
  replaceOnce('libpcre2-8.so.0; do', 'libpcre2-8.so.0 libcap-ng.so.0; do')
  replaceOnce('exec /usr/bin/unshare --user --map-user=1000 --map-group=1000 /usr/bin/node', 'exec /usr/bin/unshare --keep-caps --user --map-user=1000 --map-group=1000 /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/node')
  // The inner instrumentation observes only its own PID namespace; it emits
  // inode numbers/types, never file names, request data, or environment values.
  const instrumentation = String.raw`
  const procfs=require('node:fs');
  function readSnapshot(){
    const nodes=[];let unreadableProcesses=0;
    for(const pid of procfs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
      try {
        const status=procfs.readFileSync('/proc/'+pid+'/status','utf8');
        const fields=Object.fromEntries(status.split('\n').filter(x=>/^(Name|Pid|PPid|Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/.test(x)).map(x=>{const i=x.indexOf(':');return [x.slice(0,i),x.slice(i+1).trim()]}));
        let network,userns;try{network=procfs.readlinkSync('/proc/'+pid+'/ns/net')}catch(e){network='unreadable:'+e.code}
        try{userns=procfs.readlinkSync('/proc/'+pid+'/ns/user')}catch(e){userns='unreadable:'+e.code}
        let fds;try{fds=procfs.readdirSync('/proc/'+pid+'/fd').map(fd=>{try{const target=procfs.readlinkSync('/proc/'+pid+'/fd/'+fd);return {fd:Number(fd),kind:target.startsWith('socket:[')?'socket':target.startsWith('pipe:[')?'pipe':target.startsWith('anon_inode:')?'anon':'other',inode:(target.match(/^socket:\[(\d+)\]$/)||[])[1]||null}}catch(e){return {fd:Number(fd),kind:'unreadable',error:e.code}}})}catch(e){fds=[{kind:'unreadable',error:e.code}]}
        nodes.push({fields,network,userns,fds})
      }catch(e){unreadableProcesses++}
    }
    let owned=new Set([String(p.pid)]),changed=true;
    while(changed){changed=false;for(const n of nodes)if(owned.has(n.fields.PPid)&&!owned.has(n.fields.Pid)){owned.add(n.fields.Pid);changed=true}}
    const selected=nodes.filter(n=>owned.has(n.fields.Pid));
    console.error('RESEARCH_SAMPLE '+JSON.stringify({selfNet:procfs.readlinkSync('/proc/self/ns/net'),browser:String(p.pid),nodes:selected,unreadableProcesses}));
  }
  let sampleCount=0;const sampler=setInterval(()=>{readSnapshot();if(++sampleCount===12)clearInterval(sampler)},200);
  p.once('exit',()=>clearInterval(sampler));
  `
  replaceOnce("  p.on('error',e=>",`${instrumentation}\n  p.on('error',e=>`)
  const {createIsolationProbe,spawnIsolatedBrowser}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'))
  const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-browser-worker-'))
  const root=path.join(dir,'root');await mkdir(root,{mode:0o700})
  let probe,child,closed=false,stderr='',timer
  try {
    probe=await createIsolationProbe()
    child=spawnIsolatedBrowser(root,probe)
    child.stderr.on('data',x=>stderr+=x)
    child.stdio[3].on('error',()=>{});child.stdio[4].on('error',()=>{})
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal})})})
    let buffer=Buffer.alloc(0),seq=0;const pending=new Map()
    child.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);let i;while((i=buffer.indexOf(0))>=0){const message=JSON.parse(buffer.subarray(0,i));buffer=buffer.subarray(i+1);const resolve=pending.get(message.id);if(resolve){pending.delete(message.id);resolve(message)}}})
    const command=(method,params={},sessionId)=>Promise.race([
      new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')}),
      exited.then(result=>{throw Error(`browser exited ${JSON.stringify(result)}: ${stderr}`)}),
      new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('CDP deadline')),6000);t.unref()}),
    ])
    const created=await command('Target.createTarget',{url:'data:text/html,<button>fixture</button>'})
    assert.ok(created.result?.targetId,JSON.stringify(created))
    const sandbox=await command('Target.createTarget',{url:'chrome://sandbox'})
    const attached=await command('Target.attachToTarget',{targetId:sandbox.result.targetId,flatten:true})
    await new Promise(resolve=>{timer=setTimeout(resolve,2300)})
    const status=await command('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true},attached.result.sessionId)
    const sandboxText=status.result?.result?.value||''
    assert.match(sandboxText,/PID namespaces\s+Yes/);assert.match(sandboxText,/Seccomp-BPF sandbox\s+Yes/)
    const samples=stderr.split('\n').filter(x=>x.startsWith('RESEARCH_SAMPLE ')).map(x=>JSON.parse(x.slice('RESEARCH_SAMPLE '.length)))
    assert(samples.length>=3,`insufficient live samples: ${stderr}`)
    const browser=samples.flatMap(s=>s.nodes).find(n=>n.fields.Pid===samples[0].browser)
    assert(browser,'browser process was not observed')
    assert.match(browser.fields.Uid,/^1000\s+1000\s+1000\s+1000$/)
    assert.match(browser.fields.Gid,/^1000\s+1000\s+1000\s+1000$/)
    for(const cap of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.equal(BigInt('0x'+browser.fields[cap]),0n,cap)
    assert.equal(browser.fields.NoNewPrivs,'1')
    const all=samples.flatMap(s=>s.nodes), unique=new Set(all.map(n=>n.fields.Pid))
    assert(unique.size>1,'fixture did not observe Chromium descendants')
    const unreadableNet=all.filter(n=>n.network.startsWith('unreadable:')).length
    const unreadableFd=all.filter(n=>n.fds.some(fd=>fd.kind==='unreadable')).length
    const unreadableUser=all.filter(n=>n.userns.startsWith('unreadable:')).length
    const unreadableProcesses=samples.reduce((sum,s)=>sum+s.unreadableProcesses,0)
    const sockets=all.flatMap(n=>n.fds.filter(fd=>fd.kind==='socket')).length
    const differingNet=all.filter(n=>!n.network.startsWith('unreadable:')&&n.network!==samples[0].selfNet).length
    const capFields=['CapInh','CapPrm','CapEff','CapBnd','CapAmb']
    const nonzeroCaps=Object.fromEntries(capFields.map(cap=>[cap,all.filter(n=>!n.fields[cap]||BigInt('0x'+n.fields[cap])!==0n).length]))
    const nnpNotOne=all.filter(n=>n.fields.NoNewPrivs!=='1').length
    const allUids=[...new Set(all.map(n=>n.fields.Uid))],allGids=[...new Set(all.map(n=>n.fields.Gid))]
    console.log(JSON.stringify({samples:samples.length,observedPidCount:unique.size,observedProcessSamples:all.length,unreadableNet,unreadableFd,unreadableUser,unreadableProcesses,observedSocketDescriptors:sockets,differingNetSamples:differingNet,nonzeroCaps,nnpNotOne,allUids,allGids,browserFiveCapsZero:true,browserNnp:1,sandboxPidAndSeccomp:true,limitations:'samples only; socket ownership/family, host-network descriptors, all descendants and production isolation are not proven'}))
    await command('Browser.close')
    await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('browser close deadline')),4000))])
    if(unreadableNet||unreadableFd||unreadableUser||unreadableProcesses)t.skip('incomplete process, namespace or fd observation; results inconclusive')
  } finally {
    clearTimeout(timer)
    let cleanupFailure
    if(child?.pid&&!closed){
      try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')cleanupFailure=e}
      await new Promise(resolve=>{if(closed)return resolve();const timeout=setTimeout(resolve,3000);child.once('close',()=>{clearTimeout(timeout);resolve()})})
      if(!closed)cleanupFailure=new Error('process-group close unverified')
    }
    if(probe)try{await probe.dispose()}catch(e){cleanupFailure=e}
    if(!cleanupFailure)await rm(dir,{recursive:true,force:true})
    if(cleanupFailure)throw new Error(`cleanup unverified; preserved ${dir}: ${cleanupFailure.message}`)
  }
})
