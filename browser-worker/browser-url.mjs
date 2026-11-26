import { isIP } from 'node:net'

const MAX_URL_BYTES = 2048

/** Validate a model-requested HTTP(S) URL before user approval. */
export function normalizeBrowserUrl(value) {
  if (typeof value !== 'string') throw new Error('访问地址无效')
  const text = value.trim()
  if (text === '' || Buffer.byteLength(text, 'utf8') > MAX_URL_BYTES || text.includes('\0')) {
    throw new Error('访问地址无效')
  }
  let url
  try { url = new URL(text) } catch { throw new Error('访问地址必须是完整的 HTTP 或 HTTPS URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('浏览器只允许访问 HTTP 或 HTTPS 地址')
  if (url.username !== '' || url.password !== '') throw new Error('访问地址不能包含用户名或密码')
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (hostname === '' || hostname === '0.0.0.0' || hostname === '[::]') throw new Error('访问地址无效')
  if (Buffer.byteLength(url.href, 'utf8') > MAX_URL_BYTES) throw new Error('访问地址过长')
  return url.href
}

function ipv4Parts(host) {
  return host.split('.').map(Number)
}

function ipv4Scope(host) {
  const [a, b] = ipv4Parts(host)
  if (a === 127) return 'local'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'lan'
  return 'public'
}

function ipv6Scope(host) {
  const text = host.toLowerCase()
  if (text === '::1') return 'local'
  if (text.startsWith('fc') || text.startsWith('fd') || text.startsWith('fe8') || text.startsWith('fe9') ||
      text.startsWith('fea') || text.startsWith('feb')) return 'lan'
  return 'public'
}

/** Classify an already validated URL for the permission copy shown to the user. */
export function browserTargetScope(value) {
  const url = new URL(normalizeBrowserUrl(value))
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local'
  const ip = isIP(host)
  if (ip === 4) return ipv4Scope(host)
  if (ip === 6) return ipv6Scope(host)
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'lan'
  return 'public'
}
