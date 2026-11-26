import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

// Internal test adapter: no sockets, credentials, external model or user-selected code.
// Merely loading this adapter does not make the surrounding Web profile safe.
const PROVIDER = 'acceptance-offline'
const MODEL = 'fixture-v1'
const TOOL = 'browser_offline_prototype'
const INTRO = '这是内置离线测试模型，不是真实模型。现在仅打开固定的内置离线页面。'
// Same explicit host switch as the plugin: fixture mode only opens the worker's
// fixed built-in page and never sends caller HTML.
function fixtureMode() { return process.env.DSH_FNOS_ACCEPTANCE_FIXTURE === '1' }

export class OfflineAcceptanceAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: '内置离线测试（非真实模型）' } }
  async listModels(provider) {
    if (provider !== PROVIDER) return []
    return [{ provider, id: MODEL, name: '内置离线测试模型（非真实模型）', inputModalities: ['text'] }]
  }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted()
    if (provider !== PROVIDER || model !== MODEL) throw new Error('未知的离线验收模型')
    return { provider, id: MODEL, name: '内置离线测试模型（非真实模型）', inputModalities: ['text'] }
  }
  async *stream(options) {
    options.signal?.throwIfAborted()
    if (options.provider !== PROVIDER || options.model !== MODEL) throw new Error('未知的离线验收模型')
    const messages = Array.isArray(options.messages) ? options.messages : []
    let lastUser = -1
    for (let i = 0; i < messages.length; i++) if (messages[i]?.role === 'user') lastUser = i
    let text
    if (options.purpose !== undefined || lastUser < 0) {
      text = '离线测试模型仅执行手动发起的内置验收，不处理其他任务。'
    } else {
      const history = messages.slice(lastUser + 1)
      const previousCall = history.flatMap(message => message?.role === 'assistant' && message.source?.provider === PROVIDER && Array.isArray(message.content) ? message.content : [])
        .find(block => block?.type === 'tool-call' && block.name === TOOL && typeof block.id === 'string' && block.id.startsWith('offline-fixture-'))
      if (previousCall) {
        const result = history.find(message => message?.role === 'tool' && message.toolCallId === previousCall.id)
        let success = false
        if (result && result.isError !== true && Array.isArray(result.content)) {
          for (const block of result.content) {
            if (block?.type !== 'text' || typeof block.text !== 'string') continue
            try {
              const value = JSON.parse(block.text)
              if (value?.fixture === true) success = true
            } catch { /* do not infer success from arbitrary output */ }
          }
        }
        text = success
          ? '内置验收固定页已打开；这不是访问真实网站，也不是智能模型推理。'
          : '无法确认内置离线页面已打开，请检查工具错误；没有访问真实网站。'
      } else if (!Array.isArray(options.tools) || !options.tools.some(tool => tool?.name === TOOL)) {
        text = '离线浏览器测试工具不可用；未执行页面操作。'
      } else {
        const textBlock = { type: 'text', text: INTRO }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: INTRO }
        yield { type: 'block-end', index: 0, block: textBlock }
        options.signal?.throwIfAborted()
        const id = `offline-fixture-${randomUUID()}`
        const args = JSON.stringify({ action: 'open_test_site' })
        const block = { type: 'tool-call', id, name: TOOL, arguments: args }
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id, name: TOOL, argumentsDelta: args }
        yield { type: 'block-end', index: 1, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
    }
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const inject = ['llm']
export function apply(ctx) {
  if (process.env.DSH_FNOS_BROWSER_ACCEPTANCE !== '1' || !fixtureMode()) return
  return ctx.llm.registerAdapter([PROVIDER], new OfflineAcceptanceAdapter())
}
