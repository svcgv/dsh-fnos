import { normalizeBrowserUrl } from './browser-url.mjs'

/** Resolve a user-requested history action without allowing non-HTTP targets. */
export function historyTarget(history, direction) {
  if (!['back', 'forward', 'reload'].includes(direction) || !Number.isSafeInteger(history?.currentIndex) || !Array.isArray(history.entries)) throw new Error('浏览器导航请求无效')
  const offset = direction === 'back' ? -1 : direction === 'forward' ? 1 : 0
  const entry = history.entries[history.currentIndex + offset]
  if (!entry || !Number.isSafeInteger(entry.id)) throw new Error('没有可用的历史记录')
  return { id: entry.id, url: normalizeBrowserUrl(entry.url), title: typeof entry.title === 'string' ? entry.title : '' }
}

export function historyAvailability(history) {
  const available = direction => { try { historyTarget(history, direction); return true } catch { return false } }
  return { canGoBack: available('back'), canGoForward: available('forward') }
}
