import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, symlink, rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Explicit opt-in because it requires the running installation's exact packages.
test('isolated real Cordis loading and scoped registration with real Agents', {skip:process.env.DSH_FNOS_REAL_CORDIS_TEST !== '1', timeout:60000}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-cordis-test-'))
  const source = path.dirname(fileURLToPath(import.meta.url))
  const installedModules = '/vol1/@appcenter/dsh-fnos/harness/node_modules'
  try {
    const pluginDir = path.join(tmp, 'plugin')
    await mkdir(pluginDir)
    for (const name of ['index.mjs','runtime.mjs','worker-client.mjs','acceptance-model.mjs','package.json','cordis.patch.yml']) await copyFile(path.join(source,name), path.join(pluginDir,name))
    await symlink(installedModules, path.join(tmp, 'node_modules'), 'dir')
    const patch = await readFile(path.join(pluginDir,'cordis.patch.yml'), 'utf8')
    assert.match(patch, /disabled:\s*true/)
    const script = `
      import assert from 'node:assert/strict'
      import { Context } from '@deepseek-ai/cordis'
      import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
      import ToolsService from '@deepseek-ai/dsh-tools'
      import Sessions from '@deepseek-ai/dsh-session'
      import Projections from '@deepseek-ai/dsh-session-projection'
      import Agents from '@deepseek-ai/dsh-agent'
      import Llm from '@deepseek-ai/dsh-llm'
      import AgentLoop from '@deepseek-ai/dsh-agent-loop'
      import * as plugin from './plugin/index.mjs'
      const ctx = new Context()
      let fiber, a, b
      try {
        for (const [module, config] of [[SystemPrompt,{}],[ToolsService,{}],[Sessions,{}],[Projections,{}],[Agents,{}],[Llm,{}],[AgentLoop,{}]]) await ctx.plugin(module, config)
        // No persistence, model adapter, followup, or worker operation is mounted.
        assert.equal(ctx.get('sessionPersistence'), undefined)
        fiber = ctx.plugin(plugin)
        await fiber
        a = await ctx.agents.create({sessionId:'offline-scope-a'})
        b = await ctx.agents.create({sessionId:'offline-scope-b'})
        const name = 'browser_offline_prototype'
        const fixture = process.env.DSH_FNOS_ACCEPTANCE_FIXTURE === '1'
        const enabled = fixture || process.env.DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT === '1'
        assert.equal(ctx.tools.get(name), undefined)
        assert.equal(!!ctx.tools.get(name, a.agent), enabled)
        assert.equal(!!ctx.tools.get(name, b.agent), enabled)
        if (enabled) {
          const definition = ctx.tools.get(name, a.agent)
          if (fixture) {
            assert.deepEqual(definition.parameters.properties.action.enum, ['open_test_site'])
            assert.deepEqual(Object.keys(definition.parameters.properties), ['action'])
            assert.equal(definition.parameters.additionalProperties, false)
            assert.match(definition.description, /内置固定测试页/)
            // Forged arbitrary HTML/URL requests are rejected before any worker starts.
            await assert.rejects(definition.execute({action:'open', html:'<p>untrusted</p>'}, {agent:a.agent, signal:new AbortController().signal}), /仅允许内置测试页操作 open_test_site/)
            await assert.rejects(definition.execute({action:'open_test_site', html:'<p>untrusted</p>'}, {agent:a.agent, signal:new AbortController().signal}), /无效的操作参数/)
            await assert.rejects(definition.execute({action:'close'}, {agent:a.agent, signal:new AbortController().signal}), /仅允许内置测试页操作 open_test_site/)
            const model = await import('./plugin/acceptance-model.mjs')
            const events = []
            for await (const event of new model.OfflineAcceptanceAdapter().stream({
              provider:'acceptance-offline', model:'fixture-v1',
              messages:[{role:'user', content:[{type:'text', text:'open'}]}],
              tools:[{name:'browser_offline_prototype'}], signal:new AbortController().signal,
            })) events.push(event)
            const call = events.find(event => event.type === 'block-end' && event.block?.type === 'tool-call')
            assert(call, 'fixture model must emit a tool call')
            assert.equal(call.block.name, name)
            assert.deepEqual(JSON.parse(call.block.arguments), {action:'open_test_site'})
          } else {
            const result = await definition.execute({action:'close'}, {agent:a.agent, signal:new AbortController().signal})
            assert.equal(result.content[0].text, '{"closed":true}')
            await assert.rejects(definition.execute({action:'close'}, {agent:b.agent, signal:new AbortController().signal}), /Agent/)
          }
        }
        const agentA = a.agent, agentB = b.agent
        await a.dispose(); a = undefined
        assert.equal(ctx.agents.get('offline-scope-a'), undefined)
        assert.equal(ctx.tools.get(name, agentA), undefined)
        assert.equal(!!ctx.tools.get(name, agentB), enabled)
        await b.dispose(); b = undefined
        assert.equal(ctx.agents.get('offline-scope-b'), undefined)
        assert.equal(ctx.tools.get(name, agentB), undefined)
        await fiber.dispose(); fiber = undefined
        console.log('isolated Cordis check passed')
      } finally {
        await a?.dispose(); await b?.dispose(); await fiber?.dispose(); await ctx.fiber.dispose()
      }
    `
    const variants = [
      { label: 'disabled', env: {} },
      { label: 'offline', env: { DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT: '1' } },
      { label: 'fixture', env: { DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' } },
    ]
    for (const { label, env: variantEnv } of variants) {
      const env = { PATH:'/usr/bin:/bin', HOME:tmp, TMPDIR:tmp, LANG:'C.UTF-8', LD_LIBRARY_PATH:'/var/apps/dsh-fnos/target/runtime/lib', ...variantEnv }
      const result = await new Promise((resolve,reject) => {
        const child = spawn(process.execPath, ['--input-type=module','-e',script], {cwd:tmp,env,stdio:['ignore','pipe','pipe']})
        let stdout='', stderr=''; child.stdout.on('data',x=>stdout+=x); child.stderr.on('data',x=>stderr+=x)
        child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}))
      })
      assert.equal(result.code,0,`variant=${label}, signal=${result.signal}\n${result.stderr}`)
      assert.match(result.stdout,/isolated Cordis check passed/)
    }
  } finally { await rm(tmp,{recursive:true,force:true}) }
})
