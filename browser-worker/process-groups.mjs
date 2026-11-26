// Tracks only process groups directly spawned by this worker with detached:true.
// An empty registered group is NOT proof that setsid() descendants are gone.
import { readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'

function readStat(pid) {
  const data=readFileSync(`/proc/${pid}/stat`,'utf8')
  const end=data.lastIndexOf(') ')
  if(end<0 || !data.startsWith(`${pid} (`))throw Error(`invalid process stat: ${pid}`)
  const fields=data.slice(end+2).trim().split(/\s+/)
  if(fields.length<20 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[19]))throw Error(`invalid process stat: ${pid}`)
  return {state:fields[0],group:Number(fields[2]),startTime:fields[19]}
}
function vanished(error){return error?.code==='ENOENT'||error?.code==='ESRCH'}
function groupMembers(pgid) {
  const members=[]
  for(const name of readdirSync('/proc')) {
    if(!/^\d+$/.test(name))continue
    try {const stat=readStat(Number(name));if(stat.group===pgid)members.push({pid:Number(name),state:stat.state})}
    catch(error) {if(!vanished(error))throw new Error(`cannot inspect /proc/${name}/stat`,{cause:error})}
  }
  return members
}
function isGone(pgid,kill) {
  try {kill(-pgid,0);return false} catch(error) {if(error?.code==='ESRCH')return true;throw error}
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

// Optional hooks exist for deterministic unit tests, never from worker requests.
export function createOwnedGroupRegistry({kill=process.kill,inspect=readStat,members=groupMembers,graceMs=1000,killMs=2000,intervalMs=30}={}) {
  const registrations=new WeakMap()
  function register(child) {
    const pid=child?.pid
    if(!Number.isSafeInteger(pid)||pid<=1)throw Error('spawned group leader PID unavailable')
    // Node's detached:true establishes a new session and group before exec.
    const token=Object.freeze({})
    const entry={pid,pgid:pid,startTime:null,identityError:null}
    registrations.set(token,entry)
    try {
      const stat=inspect(pid)
      if(stat.group!==pid)throw Error('spawned leader is not its group leader')
      entry.startTime=stat.startTime
    } catch(error) {
      if(!vanished(error))entry.identityError=error
      // It may already have exited; verification will still require ESRCH/proc.
    }
    return token
  }
  function assertReady(token) {
    const entry=registrations.get(token)
    if(!entry)throw Error('unregistered process group')
    if(entry.identityError)throw Error('spawned group identity unverified',{cause:entry.identityError})
  }
  async function stop(token) {
    const entry=registrations.get(token)
    if(!entry)throw Error('unregistered process group')
    const {pid,pgid,startTime}=entry
    if(entry.identityError)throw Error('spawned group identity unverified',{cause:entry.identityError})
    async function empty() {
      if(!isGone(pgid,kill))return false
      return members(pgid).length===0
    }
    async function signal(name) {
      // If the group leader PID has been reused, refuse to signal that group.
      if(!startTime)throw Error('process group identity was not observed')
      let stat
      try {stat=inspect(pid)} catch(error) {throw new Error('process group leader identity unavailable',{cause:error})}
      if(stat.group!==pgid || stat.startTime!==startTime)throw Error('process group leader identity changed or unverified')
      try{kill(-pgid,name)}catch(error){if(!vanished(error))throw error}
    }
    async function wait(ms) {
      const deadline=Date.now()+ms
      do {if(await empty())return true;if(Date.now()>=deadline)return false;await delay(Math.min(intervalMs,Math.max(1,deadline-Date.now())))} while(true)
    }
    if(await empty())return {groupConfirmedEmpty:true,leaderPid:pid,pgid}
    await signal('SIGTERM')
    if(await wait(graceMs))return {groupConfirmedEmpty:true,leaderPid:pid,pgid}
    await signal('SIGKILL')
    if(await wait(killMs))return {groupConfirmedEmpty:true,leaderPid:pid,pgid}
    throw Error(`registered process group ${pgid} cleanup unconfirmed`)
  }
  return Object.freeze({register,assertReady,stop})
}

// Do not remove a profile unless every registered group and auxiliary resource
// was confirmed closed. The returned status is also the worker's close result.
export async function cleanupOwnedResources({registry,token,temp,dispose=[]}) {
  const errors=[]
  let groupConfirmedEmpty=!token
  if(token) {
    try {groupConfirmedEmpty=(await registry.stop(token)).groupConfirmedEmpty===true;if(!groupConfirmedEmpty)throw Error('registered process group cleanup unconfirmed')}
    catch(error){errors.push(error)}
  }
  for(const cleanup of dispose)try{await cleanup()}catch(error){errors.push(error)}
  let retained=!!temp
  if(temp && !errors.length) {
    try{await rm(temp,{recursive:true,force:true});retained=false}
    catch(error){errors.push(error);retained=null}
  }
  return {
    closed:errors.length===0,
    groupConfirmedEmpty,
    temporaryDirectoryRetained:retained,
    ...(retained!==false && temp ? {temporaryDirectory:temp} : {}),
    ...(errors.length ? {error:errors.map(error=>String(error.message||error)).join('; ')} : {})
  }
}
