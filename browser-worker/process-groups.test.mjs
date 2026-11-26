import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanupOwnedResources, createOwnedGroupRegistry } from './process-groups.mjs'

const absent=()=>Object.assign(new Error('gone'),{code:'ESRCH'})

test('owned detached group is terminated and checked before directory removal', {timeout:10000}, async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-group-test-'))
  const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','pipe']})
  const registry=createOwnedGroupRegistry({graceMs:500,killMs:1000,intervalMs:10})
  const token=registry.register(child);registry.assertReady(token)
  const exited=new Promise(resolve=>child.once('exit',resolve))
  try{
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)})
    const result=await cleanupOwnedResources({registry,token,temp})
    assert.deepEqual(result,{closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false})
    await exited
    await assert.rejects(stat(temp),{code:'ENOENT'})
  }finally{
    // The test may only signal the child/group it created and registered.
    await registry.stop(token).catch(()=>{})
  }
})

test('unregistered tokens never trigger a process signal',async()=>{
  const signals=[]
  const registry=createOwnedGroupRegistry({kill:(...args)=>signals.push(args)})
  await assert.rejects(registry.stop({}),/unregistered process group/)
  assert.deepEqual(signals,[])
})

test('a group remaining after TERM and KILL retains its directory and reports unconfirmed',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-group-test-'))
  const pid=40001,signals=[]
  const registry=createOwnedGroupRegistry({inspect:()=>({group:pid,startTime:'123'}),members:()=>[{pid,state:'S'}],kill:(group,signal)=>signals.push([group,signal]),graceMs:5,killMs:5,intervalMs:1})
  const token=registry.register({pid});registry.assertReady(token)
  try{
    const result=await cleanupOwnedResources({registry,token,temp})
    assert.equal(result.closed,false);assert.equal(result.groupConfirmedEmpty,false)
    assert.equal(result.temporaryDirectoryRetained,true);assert.equal(result.temporaryDirectory,temp)
    assert.match(result.error,/cleanup unconfirmed/);assert((await stat(temp)).isDirectory())
    assert(signals.some(([group,signal])=>group===-pid&&signal==='SIGTERM'))
    assert(signals.some(([group,signal])=>group===-pid&&signal==='SIGKILL'))
    assert(signals.every(([group])=>group===-pid))
  }finally{await rm(temp,{recursive:true,force:true})}
})

test('ESRCH alone is not confirmation when proc sees a group member',async()=>{
  const pid=40002
  const registry=createOwnedGroupRegistry({inspect:()=>({group:pid,startTime:'1'}),members:()=>[{pid,state:'S'}],kill:()=>{throw absent()},graceMs:2,killMs:2,intervalMs:1})
  const token=registry.register({pid})
  await assert.rejects(registry.stop(token),/cleanup unconfirmed/)
})

test('unreadable proc and changed leader identity fail closed',async()=>{
  const pid=40003;let reads=0;const signals=[]
  const registry=createOwnedGroupRegistry({inspect:()=>({group:pid,startTime:++reads===1?'old':'new'}),members:()=>[],kill:(group,signal)=>{signals.push([group,signal])},graceMs:1,killMs:1})
  const token=registry.register({pid})
  await assert.rejects(registry.stop(token),/identity changed/)
  assert.deepEqual(signals,[[-pid,0]])
  let observed=false;const noLeaderSignals=[]
  const noLeader=createOwnedGroupRegistry({inspect:()=>{if(observed)throw Object.assign(Error('gone'),{code:'ENOENT'});observed=true;return {group:pid,startTime:'old'}},members:()=>[],kill:(group,signal)=>noLeaderSignals.push([group,signal]),graceMs:1,killMs:1})
  await assert.rejects(noLeader.stop(noLeader.register({pid})),/identity unavailable/)
  assert.deepEqual(noLeaderSignals,[[-pid,0]])
  const inaccessible=createOwnedGroupRegistry({inspect:()=>({group:pid,startTime:'old'}),members:()=>{throw Error('proc unavailable')},kill:()=>{throw absent()}})
  await assert.rejects(inaccessible.stop(inaccessible.register({pid})),/proc unavailable/)
})
