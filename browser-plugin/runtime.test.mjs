import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserRuntime } from './runtime.mjs'

function fixture(factory, options) {
  const agents = new Map(), scopes = [], workers = [], startOptions = []
  const ctx = { agents: { get: id => agents.get(id) } }
  function createScope(_ctx, agent) {
    const cleanups = [], tools = []
    let stopped = false
    const scope = { agent, tools, ctx: { effect: callback => cleanups.push(callback()), tools: { register: tool => tools.push(tool) } },
      async dispose() { if (stopped) return; stopped = true; for (const cleanup of cleanups) await cleanup() } }
    scopes.push(scope); return scope
  }
  const startWorker = (startOption) => { startOptions.push(startOption); const worker = factory ? factory() : { calls: [], stopped: 0, async request(op, fields) { this.calls.push({op,fields}); return {op} }, async stop() { this.stopped++ } }; workers.push(worker); return worker }
  const runtime = createBrowserRuntime(ctx, { createScope, createMcpToolDefinition: (_ctx, options) => options, startWorker }, options)
  function agent(id) { const result = { id, ctx: {} }; agents.set(id, result); runtime.attach(result); return result }
  const invoke = (agent, args, execAgent = agent, signal = new AbortController().signal) => scopes.find(s => s.agent === agent).tools[0].call(args, {agent: execAgent, signal})
  return { runtime, agent, invoke, scopes, workers, agents, startOptions }
}

test('Agent identity is mandatory, instances are per-Agent, and arguments cannot inject fields', async () => {
  const f = fixture(); const a = f.agent('a'), b = f.agent('b')
  await assert.rejects(f.invoke(a, {action:'open', html:'<p>x</p>'}, b), /Agent/)
  await assert.rejects(f.invoke(a, {action:'open', html:'<p>x</p>', op:'close'}), /参数/)
  await assert.rejects(f.invoke(a, {action:'open', html:'x', url:'http://example.com'}), /参数/)
  await f.invoke(a, {action:'open',html:'A'}); await f.invoke(b, {action:'open',html:'B'})
  assert.equal(f.workers.length, 2)
  assert.deepEqual(f.workers[0].calls, [{op:'open',fields:{html:'A'}}])
  assert.deepEqual(f.workers[1].calls, [{op:'open',fields:{html:'B'}}])
  f.agents.set('a', {id:'a'})
  await assert.rejects(f.invoke(a, {action:'snapshot'}), /Agent/)
  await f.runtime.dispose(); assert.equal(f.workers[0].stopped, 1); assert.equal(f.workers[1].stopped, 1)
})

test('one Agent serializes operations and separate Agents are independent', async () => {
  let finishFirst
  const f = fixture(() => ({ calls: [], async request(op) { this.calls.push(op); if (op === 'open') await new Promise(resolve => {finishFirst = resolve}); return {op} }, async stop() {} }))
  const a = f.agent('a'), b = f.agent('b')
  const first = f.invoke(a, {action:'open',html:'a'}); const second = f.invoke(a, {action:'snapshot'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.workers[0].calls, ['open'])
  await f.invoke(b, {action:'snapshot'}); assert.equal(f.workers.length, 2)
  finishFirst(); await Promise.all([first, second]); assert.deepEqual(f.workers[0].calls, ['open','snapshot'])
  await f.runtime.dispose()
})

test('cancellation retires the worker and queued operations do not reuse it', async () => {
  const f = fixture(() => ({ stopped: 0, request(_op,_fields,signal) { return new Promise((_,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})) }, async stop() { this.stopped++ } }))
  const a = f.agent('a'), cancel = new AbortController()
  const active = f.invoke(a, {action:'snapshot'}, a, cancel.signal)
  await new Promise(resolve => setImmediate(resolve)); cancel.abort(new Error('cancelled'))
  await assert.rejects(active, /cancelled/); assert.equal(f.workers[0].stopped, 1)
  await f.runtime.dispose(); assert.equal(f.workers[0].stopped, 1)
})

test('Agent scope disposal aborts and waits for in-flight worker cleanup', async () => {
  let started, cleaned = false
  const ready = new Promise(resolve => {started = resolve})
  const f = fixture(() => ({ request(_op,_fields,signal) { started(); return new Promise((_,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})) }, async stop() { await new Promise(resolve => setImmediate(resolve)); cleaned = true } }))
  const a = f.agent('a'); const active = f.invoke(a, {action:'snapshot'}); await ready
  const scopeClose = f.scopes[0].dispose(); await assert.rejects(active, /Agent/); await scopeClose; assert.equal(cleaned,true)
  await assert.rejects(f.invoke(a, {action:'snapshot'}), /Agent/); await f.runtime.dispose()
})

test('registration rollback retains asynchronous cleanup failures and isolates other Agents', async () => {
  const a = {id:'healthy',ctx:{}}, b = {id:'failing',ctx:{}}
  const agents = new Map([[a.id,a],[b.id,b]]), registered = new Map()
  let healthyCleaned = 0, failingDisposeCount = 0
  const cleanupFailure = new Error('scope cleanup rejected')
  const registrationFailure = new Error('registration rejected')
  const runtime = createBrowserRuntime({agents:{get:id=>agents.get(id)}}, {
    createScope(_ctx, agent) {
      let cleanup
      return {
        ctx:{ effect:fn=>{cleanup=fn()}, tools:{register:definition=>{
          if (agent===b) throw registrationFailure
          registered.set(agent,definition)
        }} },
        async dispose() {
          if (agent===b) { failingDisposeCount++; await Promise.resolve(); throw cleanupFailure }
          healthyCleaned++; await cleanup?.()
        },
      }
    },
    createMcpToolDefinition:(_ctx,options)=>options,
    startWorker:()=>{throw new Error('unexpected worker start')},
  })
  await runtime.attach(a)
  await assert.rejects(runtime.attach(b), error => {
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors,[registrationFailure,cleanupFailure])
    return true
  })
  const healthy = await registered.get(a).call({action:'close'},{agent:a,signal:new AbortController().signal})
  assert.deepEqual(healthy,{content:[{type:'text',text:'{"closed":true}'}]})
  const verify = error => { assert(error instanceof AggregateError); assert(error.errors.includes(cleanupFailure)); return true }
  await assert.rejects(runtime.dispose(),verify)
  await assert.rejects(runtime.dispose(),verify)
  assert.equal(failingDisposeCount,1)
  assert.equal(healthyCleaned,1)
})

test('provider disposal waits for an in-flight registration rollback', async () => {
  const agent={id:'race',ctx:{}}
  const registrationFailure=new Error('registration failed')
  const cleanupFailure=new Error('delayed cleanup failed')
  let finishCleanup, disposals=0
  const cleanup=new Promise(resolve=>{finishCleanup=resolve})
  const runtime=createBrowserRuntime({agents:{get:id=>id===agent.id?agent:undefined}}, {
    createScope(){ return {ctx:{effect:()=>{},tools:{register:()=>{throw registrationFailure}}}, dispose(){disposals++;return cleanup.then(()=>{throw cleanupFailure})}} },
    createMcpToolDefinition:(_ctx,options)=>options,
    startWorker:()=>{throw new Error('unexpected worker start')},
  })
  const attaching=runtime.attach(agent)
  const observedAttach=assert.rejects(attaching,error=>error instanceof AggregateError && error.errors.includes(cleanupFailure))
  let settled=false
  const disposing=runtime.dispose()
  const observedDispose=assert.rejects(disposing,error=>error instanceof AggregateError && error.errors.includes(cleanupFailure))
  void disposing.then(()=>{settled=true},()=>{settled=true})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(settled,false)
  finishCleanup()
  await Promise.all([observedAttach,observedDispose])
  assert.equal(disposals,1)
})

test('screenshots are projected as MCP image blocks and never as JSON text', async () => {
  const f = fixture(() => ({async request() {return {mime:'image/png',base64:'aGVsbG8='}}, async stop() {}}))
  const a = f.agent('a'); const result = await f.invoke(a, {action:'screenshot'})
  assert.deepEqual(result, {content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]})
  await f.runtime.dispose()
})

test('acceptance fixture mode exposes only an argument-free open_test_site action', async () => {
  const f = fixture(undefined, { acceptanceFixture: true })
  const a = f.agent('a')
  const [tool] = f.scopes[0].tools
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['open_test_site'])
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['action'])
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.match(tool.description, /内置固定测试页/)
  assert.match(tool.description, /不支持任意网站|URL/)
  const result = await f.invoke(a, {action:'open_test_site'})
  assert.deepEqual(result, {content:[{type:'text', text:'{"op":"open_test_site"}'}]})
  assert.equal(f.workers.length, 1)
  assert.deepEqual(f.startOptions, [{acceptanceFixture:true}])
  assert.deepEqual(f.workers[0].calls, [{op:'open_test_site', fields:{}}])
  await f.runtime.dispose()
})

test('acceptance fixture mode rejects forged open HTML, extra fields, and other actions', async () => {
  const f = fixture(undefined, { acceptanceFixture: true })
  const a = f.agent('a')
  for (const args of [
    {action:'open', html:'<p>untrusted</p>'},
    {action:'open'},
    {action:'open_test_site', html:'<p>untrusted</p>'},
    {action:'open_test_site', url:'http://example.com/'},
    {action:'open_test_site', generation:0},
    {action:'snapshot'},
    {action:'screenshot'},
    {action:'close'},
    {action:'open_test_site', extra:true},
    {op:'open_test_site'},
    null,
    ['open_test_site'],
  ]) {
    await assert.rejects(f.invoke(a, args), /仅允许内置测试页操作 open_test_site|无效的操作参数/)
  }
  assert.equal(f.workers.length, 0, 'rejected arguments must never start a worker')
  await assert.rejects(f.invoke(a, {action:'open_test_site'}, f.agent('b')), /Agent/)
  await f.runtime.dispose()
})

test('default mode keeps the existing offline-HTML actions and rejects open_test_site', async () => {
  const f = fixture()
  const a = f.agent('a')
  const [tool] = f.scopes[0].tools
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['open','snapshot','click','fill','screenshot','diagnostics','close'])
  assert(!tool.inputSchema.properties.action.enum.includes('open_test_site'))
  await assert.rejects(f.invoke(a, {action:'open_test_site'}), /无效的离线测试操作/)
  await f.invoke(a, {action:'open', html:'<p>trusted</p>'})
  assert.deepEqual(f.startOptions, [{acceptanceFixture:false}])
  assert.deepEqual(f.workers[0].calls, [{op:'open', fields:{html:'<p>trusted</p>'}}])
  await f.runtime.dispose()
})

test('confirmed close returns the exact worker contract and stops the worker once', async () => {
  const contract = {closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false}
  const f = fixture(() => ({ calls: [], stopped: 0, async request(op) { this.calls.push(op); return op === 'open' ? {offline:true} : {...contract} }, async stop() { this.stopped++ } }))
  const a = f.agent('a')
  await f.invoke(a, {action:'open', html:'<p>x</p>'})
  const result = await f.invoke(a, {action:'close'})
  assert.deepEqual(result, {content:[{type:'text', text: JSON.stringify(contract)}]})
  assert.deepEqual(f.workers[0].calls, ['open','close'])
  assert.equal(f.workers[0].stopped, 1, 'confirmed close must stop the worker exactly once')
  await f.runtime.dispose()
})

test('unconfirmed close is a failure that names the retained path and is never retried', async () => {
  const f = fixture(() => ({ calls: [], stopped: 0, async request(op) {
    this.calls.push(op)
    if (op === 'open') return {offline:true}
    return {closed:false,groupConfirmedEmpty:false,temporaryDirectoryRetained:true,temporaryDirectory:'/tmp/dsh-retained',error:'group cleanup unconfirmed'}
  }, async stop() { this.stopped++ } }))
  const a = f.agent('a')
  await f.invoke(a, {action:'open', html:'<p>x</p>'})
  await assert.rejects(f.invoke(a, {action:'close'}), error => {
    assert.match(error.message, /未确认关闭/)
    assert.match(error.message, /\/tmp\/dsh-retained/)
    assert.match(error.message, /进程组未确认清空/)
    assert.match(error.message, /group cleanup unconfirmed/)
    return true
  })
  assert.deepEqual(f.workers[0].calls, ['open','close'], 'close must not be retried')
  assert.equal(f.workers[0].stopped, 1)
  await f.runtime.dispose()
})

test('close treats a dropped worker reply as unconfirmed, never as success', async () => {
  const f = fixture(() => ({ stopped: 0, async request(op) { if (op === 'open') return {offline:true}; throw new Error('离线浏览器 worker 已退出') }, async stop() { this.stopped++ } }))
  const a = f.agent('a')
  await f.invoke(a, {action:'open', html:'<p>x</p>'})
  await assert.rejects(f.invoke(a, {action:'close'}), error => {
    assert.match(error.message, /未确认关闭/)
    assert.match(error.message, /保留路径：未知/)
    return true
  })
  assert.equal(f.workers[0].stopped, 1)
  await f.runtime.dispose()
})

test('close stays unconfirmed when the worker reported success but its stop failed', async () => {
  const f = fixture(() => ({ stopped: 0, async request(op) { return op === 'open' ? {offline:true} : {closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false} }, async stop() { this.stopped++; throw new Error('worker 未能及时清理') } }))
  const a = f.agent('a')
  await f.invoke(a, {action:'open', html:'<p>x</p>'})
  await assert.rejects(f.invoke(a, {action:'close'}), error => {
    assert.match(error.message, /未确认关闭/)
    assert.match(error.message, /停止确认失败/)
    assert.match(error.message, /worker 未能及时清理/)
    return true
  })
  assert.equal(f.workers[0].stopped, 1)
  await f.runtime.dispose()
})

test('close without a started worker reports a confirmed no-op instead of spawning one', async () => {
  const f = fixture()
  const a = f.agent('a')
  const result = await f.invoke(a, {action:'close'})
  assert.deepEqual(result, {content:[{type:'text', text:'{"closed":true}'}]})
  assert.equal(f.workers.length, 0)
  await f.runtime.dispose()
})
