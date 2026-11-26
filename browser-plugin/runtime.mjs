const ACTIONS = new Set(['open', 'snapshot', 'click', 'fill', 'screenshot', 'diagnostics', 'close'])
// Acceptance-fixture mode is a strict subset: one fixed built-in page and no
// page manipulation. It can never open caller-supplied HTML or a URL.
const FIXTURE_ACTIONS = new Set(['open_test_site'])
const FIXTURE_ALLOWED = Object.freeze({ open_test_site: Object.freeze([]) })
const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: '离线测试操作' },
    html: { type: 'string', description: '仅 open：可信测试 HTML，不得使用不可信内容' },
    generation: { type: 'integer', description: 'snapshot 返回的页面代次' },
    index: { type: 'integer', description: 'snapshot 返回的元素索引' },
    value: { type: 'string', description: '仅 fill：测试输入' },
  }, required: ['action'],
}
const fixtureSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...FIXTURE_ACTIONS], description: '仅内置测试页，不支持任意网站/URL' },
  }, required: ['action'],
}
const description = '仅在离线实验环境操作可信测试 HTML；不访问网站。快照和截图可能包含敏感数据。'
const fixtureDescription = '仅打开内置固定测试页（不接收参数）；不支持任意网站、URL 或 HTML，也不提供其他页面操作。'
function requestFields(args, acceptanceFixture) {
  const actions = acceptanceFixture ? FIXTURE_ACTIONS : ACTIONS
  if (!args || typeof args !== 'object' || Array.isArray(args) || !actions.has(args.action)) {
    throw new Error(acceptanceFixture ? '仅允许内置测试页操作 open_test_site' : '无效的离线测试操作')
  }
  const allowed = acceptanceFixture
    ? FIXTURE_ALLOWED[args.action]
    : { open: ['html'], snapshot: [], click: ['generation', 'index'], fill: ['generation', 'index', 'value'], screenshot: [], diagnostics: [], close: [] }[args.action]
  if (Object.keys(args).some(k => k !== 'action' && !allowed.includes(k))) throw new Error('无效的操作参数')
  if (args.action === 'open' && (typeof args.html !== 'string' || Buffer.byteLength(args.html) > 65536)) throw new Error('仅允许 64 KiB 以内的可信离线 HTML')
  if (['click', 'fill'].includes(args.action) && (!Number.isSafeInteger(args.generation) || args.generation < 0 || !Number.isSafeInteger(args.index) || args.index < 0 || args.index >= 100)) throw new Error('元素引用无效')
  if (args.action === 'fill' && (typeof args.value !== 'string' || args.value.length > 4096)) throw new Error('输入内容无效')
  return Object.fromEntries(allowed.filter(k => k in args).map(k => [k, args[k]]))
}

/**
 * A worker must explicitly confirm close; anything else (unconfirmed result,
 * interrupted output, forced stop) is surfaced as a failure with the retained
 * path when the worker reported one. Never retried into a success.
 */
function unconfirmedCloseError(result, requestError, stopError) {
  const details = []
  if (result && result.closed === true) {
    details.push('worker 已报告关闭成功，但停止确认失败')
  } else if (result) {
    details.push(result.error ? `worker 报告：${result.error}` : 'worker 未返回明确成功')
    if (result.groupConfirmedEmpty === false) details.push('进程组未确认清空')
    if (typeof result.temporaryDirectory === 'string' && result.temporaryDirectory) details.push(`保留路径：${result.temporaryDirectory}`)
    else if (result.temporaryDirectoryRetained === true) details.push('保留路径：worker 未返回')
    else if (result.temporaryDirectoryRetained === null) details.push('临时目录删除失败，目录状态不确定')
  } else {
    details.push(`worker 未返回关闭结果：${requestError?.message ?? '输出中断'}`)
    details.push('保留路径：未知')
  }
  if (stopError) details.push(`停止未确认：${stopError.message}`)
  return new Error(`浏览器未确认关闭：${details.join('；')}`)
}

/** Lifecycle owner accepts injected scope and worker implementations for tests. */
export function createBrowserRuntime(ctx, { createScope, createMcpToolDefinition, startWorker }, { acceptanceFixture = false } = {}) {
  if (typeof acceptanceFixture !== 'boolean') throw new Error('无效的验收固定页模式配置')
  const owners = new Map()
  // Preserve failed rollback evidence for later provider disposal.
  const cleanupErrors = []
  const pendingRollbacks = new Set()
  let disposed = false
  let disposal
  function isLive(agent) { return !!agent && ctx.agents.get(agent.id) === agent }
  async function detach(agent) {
    const owner = owners.get(agent)
    if (!owner) return
    if (owner.closing) return owner.closing
    owner.controller.abort(new Error('Agent 已关闭'))
    owner.closing = (async () => {
      await owner.tail.catch(() => {})
      try { if (owner.worker) await owner.worker.stop() }
      finally { owner.worker = null; if (owners.get(agent) === owner) owners.delete(agent) }
    })()
    return owner.closing
  }
  async function invoke(agent, args, exec) {
    const fields = requestFields(args, acceptanceFixture)
    const owner = owners.get(agent)
    if (disposed || !owner || !isLive(agent) || exec?.agent !== agent || !exec.signal) throw new Error('需要有效且匹配的 Agent 调用')
    const signal = AbortSignal.any([exec.signal, owner.controller.signal, AbortSignal.timeout(30_000)])
    const task = owner.tail.then(async () => {
      signal.throwIfAborted()
      if (disposed || !isLive(agent)) throw new Error('Agent 已关闭')
      if (!owner.worker && args.action === 'close') return { closed: true }
      if (!owner.worker) owner.worker = startWorker({ acceptanceFixture })
      const worker = owner.worker
      if (args.action === 'close') {
        // close has its own contract: only an explicit success plus a confirmed
        // stop counts. Never turn an unconfirmed cleanup into a success result.
        let result, requestError
        try { result = await worker.request('close', {}, signal) } catch (error) { requestError = error }
        let stopError
        try { await worker.stop() } catch (error) { stopError = error } finally { if (owner.worker === worker) owner.worker = null }
        if (result?.closed === true && !stopError) return result
        throw unconfirmedCloseError(result, requestError, stopError)
      }
      try {
        const result = await worker.request(args.action, fields, signal)
        signal.throwIfAborted()
        return result
      } catch (error) {
        // Any failed operation may have partially executed. Retire the whole worker.
        try { await worker.stop() } finally { if (owner.worker === worker) owner.worker = null }
        throw error
      }
    })
    owner.tail = task.then(() => {}, () => {})
    return task
  }
  async function attach(agent) {
    if (disposed || !isLive(agent) || owners.has(agent)) return
    const scope = createScope(agent.ctx, agent)
    const owner = { scope, controller: new AbortController(), worker: null, tail: Promise.resolve(), closing: null }
    owners.set(agent, owner)
    try {
      scope.ctx.effect(() => () => detach(agent), 'dsh-fnos-offline-browser.agent')
      scope.ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'browser_offline_prototype', rawName: 'browser_offline_prototype',
        description: acceptanceFixture ? fixtureDescription : description,
        inputSchema: acceptanceFixture ? fixtureSchema : schema,
        async call(args, exec) {
          const result = await invoke(agent, args, exec)
          if (args.action === 'screenshot') {
            if (result?.mime !== 'image/png' || typeof result.base64 !== 'string' || result.base64.length > 16 * 1024 * 1024) throw new Error('截图格式无效')
            return { content: [{ type: 'image', mimeType: 'image/png', data: result.base64 }] }
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        },
      }))
    } catch (error) {
      owner.controller.abort(new Error('Agent 注册失败'))
      const rollback = (async () => {
        try {
          await scope.dispose()
          return { failed: false }
        } catch (failure) {
          cleanupErrors.push(failure)
          return { failed: true, error: failure }
        } finally {
          if (owners.get(agent) === owner) owners.delete(agent)
        }
      })()
      pendingRollbacks.add(rollback)
      const result = await rollback
      pendingRollbacks.delete(rollback)
      if (result.failed) throw new AggregateError([error, result.error], 'Agent 注册失败且作用域清理失败')
      throw error
    }
  }
  async function dispose() {
    if (disposal) return disposal
    disposed = true
    disposal = (async () => {
      // A failing registration can be between detaching its owner and reporting
      // scope cleanup; do not let provider disposal declare success in that gap.
      await Promise.all([...pendingRollbacks])
      const entries = [...owners.entries()]
      const closed = await Promise.allSettled(entries.map(([agent]) => detach(agent)))
      const scopes = await Promise.allSettled(entries.map(([, owner]) => owner.scope.dispose()))
      const errors = [...cleanupErrors, ...[...closed, ...scopes].filter(x => x.status === 'rejected').map(x => x.reason)]
      if (errors.length) throw new AggregateError(errors, '离线浏览器清理失败')
    })()
    return disposal
  }
  return { attach, detach, dispose }
}
