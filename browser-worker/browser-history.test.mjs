import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyTarget, historyAvailability } from './browser-history.mjs'

const history = { currentIndex: 1, entries: [
  { id: 1, url: 'about:blank' },
  { id: 2, url: 'https://example.org/path', title: 'current' },
  { id: 3, url: 'http://127.0.0.1:3000/', title: 'next' },
] }

test('history only permits explicit HTTP(S) destinations', () => {
  assert.deepEqual(historyAvailability(history), { canGoBack: false, canGoForward: true })
  assert.deepEqual(historyTarget(history, 'forward'), { id: 3, url: 'http://127.0.0.1:3000/', title: 'next' })
  assert.deepEqual(historyTarget(history, 'reload'), { id: 2, url: 'https://example.org/path', title: 'current' })
  assert.throws(() => historyTarget(history, 'back'))
  assert.throws(() => historyTarget(history, 'unexpected'))
  assert.throws(() => historyTarget({ currentIndex: 0, entries: [{ id: 1, url: 'https://user:password@example.org/' }] }, 'reload'))
  assert.throws(() => historyTarget({ currentIndex: 0, entries: [{ id: '1', url: 'https://example.org/' }] }, 'reload'))
  assert.throws(() => historyTarget({ currentIndex: -1, entries: [] }, 'forward'))
})
