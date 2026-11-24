import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readIdentity } from '../src/identity.ts'

test('reads the gateway identity from trusted headers', () => {
  assert.deepEqual(
    readIdentity({ 'x-trim-userid': '1000', 'x-trim-username': 'svcgv', 'x-trim-isadmin': 'true' }),
    { uid: '1000', username: 'svcgv', isAdmin: true },
  )
})

test('falls back to the development uid only when no header is present', () => {
  assert.equal(readIdentity({}, '1000')?.uid, '1000')
  assert.equal(readIdentity({ 'x-trim-userid': '1000' }, '2000')?.uid, '1000')
})

test('rejects malformed or missing identities', () => {
  assert.equal(readIdentity({}), undefined)
  assert.equal(readIdentity({ 'x-trim-userid': '0' }), undefined)
  assert.equal(readIdentity({ 'x-trim-userid': '../1000' }), undefined)
  assert.equal(readIdentity({ 'x-trim-userid': '1000abc' }), undefined)
  assert.equal(readIdentity({ 'x-trim-userid': ['1000', '2000'] })?.uid, '1000')
})

test('derives a display name and admin flag defensively', () => {
  const identity = readIdentity({ 'x-trim-userid': '1000' })
  assert.equal(identity?.username, 'user-1000')
  assert.equal(identity?.isAdmin, false)
})
