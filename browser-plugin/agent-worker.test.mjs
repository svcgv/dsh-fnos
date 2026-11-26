import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, symlink, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This is an explicit, machine-specific, offline experiment. Failure is not skipped or downgraded.
test('real Agents and isolated workers remain separate and clean up', {skip:process.env.DSH_FNOS_REAL_AGENT_WORKER_TEST !== '1', timeout:90000}, async () => {
  // Keep the private root short enough for the isolated launcher's Unix socket probe.
  const tmp = await mkdtemp(path.join('/tmp', 'daw-'))
  const source = path.dirname(fileURLToPath(import.meta.url))
  let safeToRemove = true
  try {
    const pluginDir = path.join(tmp,'plugin'), workerDir = path.join(tmp,'browser-worker'), workerTemp = path.join(tmp,'worker-tmp')
    await Promise.all([mkdir(pluginDir),mkdir(workerDir),mkdir(workerTemp)])
    for (const name of ['index.mjs','runtime.mjs','worker-client.mjs']) await copyFile(path.join(source,name), path.join(pluginDir,name))
    for (const name of ['worker.mjs','isolation.mjs','fixture-http.mjs','process-groups.mjs']) await copyFile(path.join(source,'../browser-worker',name), path.join(workerDir,name))
    await symlink('/vol1/@appcenter/dsh-fnos/harness/node_modules',path.join(tmp,'node_modules'),'dir')
    const script = `
      import assert from 'node:assert/strict'
      import path from 'node:path'
      import { readdir } from 'node:fs/promises'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      import { Context } from '@deepseek-ai/cordis'
      import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
      import Tools from '@deepseek-ai/dsh-tools'
      import Sessions from '@deepseek-ai/dsh-session'
      import Projections from '@deepseek-ai/dsh-session-projection'
      import Agents from '@deepseek-ai/dsh-agent'
      import Llm from '@deepseek-ai/dsh-llm'
      import AgentLoop from '@deepseek-ai/dsh-agent-loop'
      const ownTmp = path.join(process.cwd(),'worker-tmp')
      const workerPath = path.join(process.cwd(),'browser-worker','worker.mjs')
      const realSpawn = childProcess.spawn, children = []
      // Test-only instrumentation: identify exactly our fixed worker, provide a private
      // tmp root, and observe close. No model can supply these values.
      childProcess.spawn = (command,args,options) => {
        assert.equal(command,process.execPath)
        assert.deepEqual(args,[workerPath,'--experimental-filesystem-isolation'])
        const child = realSpawn(command,args,{...options,stdio:['pipe','pipe','pipe'],env:{...options.env,TMPDIR:ownTmp}})
        let stderr=''; child.stderr.on('data',chunk=>stderr+=chunk)
        const exited = new Promise((resolve,reject)=>{ child.once('error',reject); child.once('close',(code,signal)=>{if(code) console.error('test worker exit:',code,signal,stderr);resolve({code,signal})}) })
        children.push({child,exited})
        return child
      }
      syncBuiltinESMExports()
      const plugin = await import('./plugin/index.mjs')
      const ctx = new Context()
      let fiber, a, b
      try {
        for (const [p,c] of [[SystemPrompt,{}],[Tools,{}],[Sessions,{}],[Projections,{}],[Agents,{}],[Llm,{}],[AgentLoop,{}]]) await ctx.plugin(p,c)
        assert.equal(ctx.get('sessionPersistence'),undefined)
        fiber = ctx.plugin(plugin); await fiber
        a = await ctx.agents.create({sessionId:'e2e-a'})
        b = await ctx.agents.create({sessionId:'e2e-b'})
        const name='browser_offline_prototype', agentA=a.agent, agentB=b.agent
        const toolA=ctx.tools.get(name,agentA), toolB=ctx.tools.get(name,agentB)
        assert.ok(toolA);assert.ok(toolB);assert.equal(ctx.tools.get(name),undefined)
        const call=async (tool,agent,args)=>tool.execute(args,{agent,signal:new AbortController().signal})
        const data=result=>JSON.parse(result.content[0].text)
        assert.deepEqual(data(await call(toolA,agentA,{action:'open',html:'<button>alpha</button>'})),{offline:true})
        assert.equal(data(await call(toolA,agentA,{action:'snapshot'})).elements[0].text,'alpha')
        assert.deepEqual(data(await call(toolB,agentB,{action:'open',html:'<button>beta</button>'})),{offline:true})
        assert.equal(data(await call(toolB,agentB,{action:'snapshot'})).elements[0].text,'beta')
        assert.equal(children.length,2)
        assert.notEqual(children[0].child.pid,children[1].child.pid)
        assert.equal((await readdir(ownTmp)).filter(x=>x.startsWith('dsh-browser-worker-')).length,2)
        assert.equal(data(await call(toolA,agentA,{action:'snapshot'})).elements[0].text,'alpha')
        await assert.rejects(call(toolA,agentB,{action:'snapshot'}),/Agent/)
        await assert.rejects(call(toolB,agentA,{action:'snapshot'}),/Agent/)
        await a.dispose(); a=undefined
        const exitA=await children[0].exited; assert.equal(exitA.signal,null); assert.ok([0,1].includes(exitA.code))
        assert.equal(ctx.tools.get(name,agentA),undefined)
        assert.equal(data(await call(toolB,agentB,{action:'snapshot'})).elements[0].text,'beta')
        assert.equal((await readdir(ownTmp)).filter(x=>x.startsWith('dsh-browser-worker-')).length,1)
        await b.dispose(); b=undefined
        const exitB=await children[1].exited; assert.equal(exitB.signal,null); assert.ok([0,1].includes(exitB.code))
        assert.deepEqual(await readdir(ownTmp),[])
        await fiber.dispose();fiber=undefined
        console.log('two real Agents and isolated workers cleaned')
      } finally {
        const errors=[]
        for (const cleanup of [()=>a?.dispose(),()=>b?.dispose(),()=>fiber?.dispose(),()=>ctx.fiber.dispose()]) {
          try { await cleanup() } catch(error) { errors.push(error) }
        }
        childProcess.spawn=realSpawn;syncBuiltinESMExports()
        try {
          await Promise.all(children.map(({exited})=>exited))
          assert.deepEqual(await readdir(ownTmp),[])
          if (!errors.length) console.log('TEST_CLEANUP_CONFIRMED')
        } catch(error) { errors.push(error) }
        if(errors.length) throw new AggregateError(errors,'test cleanup failed')
      }
    `
    const env = { PATH:'/usr/bin:/bin', HOME:tmp, TMPDIR:tmp, LANG:'C.UTF-8', LD_LIBRARY_PATH:'/var/apps/dsh-fnos/target/runtime/lib', DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT:'1' }
    const result = await new Promise((resolve,reject)=>{
      // A fresh process group contains only this test harness and its direct
      // workers. Workers own separate Chromium groups and handle SIGTERM first.
      const child=spawn(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',script],{cwd:tmp,env,stdio:['ignore','pipe','pipe'],detached:true})
      let stdout='',stderr='',timedOut=false, escalation, lastResort
      child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
      const signalGroup=signal=>{try { process.kill(-child.pid,signal) } catch (error) { if(error.code!=='ESRCH') stderr+=`group signal failed: ${error.message}\\n` }}
      const deadline=setTimeout(()=>{
        timedOut=true; safeToRemove=false; signalGroup('SIGTERM')
        escalation=setTimeout(()=>{
          signalGroup('SIGKILL')
          lastResort=setTimeout(()=>{
            safeToRemove=false
            child.stdout.destroy();child.stderr.destroy();child.unref()
            reject(new Error(`test process did not close; browser cleanup unverified; preserved ${tmp}`))
          },2000)
        },17000)
      },60000)
      const clear=()=>{clearTimeout(deadline);clearTimeout(escalation);clearTimeout(lastResort)}
      child.once('error',error=>{clear();reject(error)})
      child.once('close',(code,signal)=>{clear();resolve({code,signal,stdout,stderr,timedOut})})
    })
    if (!result.stdout.includes('TEST_CLEANUP_CONFIRMED')) safeToRemove=false
    assert.equal(result.timedOut,false,`test timed out; browser cleanup unverified; preserved ${tmp}\n${result.stderr}`)
    assert.equal(result.code,0,`signal=${result.signal}\n${result.stderr}`)
    assert.match(result.stdout,/two real Agents and isolated workers cleaned/)
    assert.match(result.stdout,/TEST_CLEANUP_CONFIRMED/)
  } finally { if (safeToRemove) await rm(tmp,{recursive:true,force:true}) }
})
