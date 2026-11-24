import assert from 'node:assert/strict'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectStore, normalizeProjectName } from '../src/projects.ts'
import { resolveInside } from '../src/paths.ts'

async function createStore(): Promise<{ store: ProjectStore; home: string; varRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fnos-projects-'))
  const home = join(root, 'home')
  const varRoot = join(root, 'var')
  return { store: new ProjectStore({ homeRoot: home, varRoot, maxProjectsPerUser: 3 }), home, varRoot }
}

test('projects are scoped to their owner', async () => {
  const { store } = await createStore()
  const project = await store.create('1000', '博客重构')

  assert.equal(project.ownerUid, '1000')
  assert.equal((await store.list('1000')).length, 1)
  assert.equal((await store.list('2000')).length, 0)
  assert.equal(await store.get('2000', project.id), undefined)
  assert.equal((await store.get('1000', project.id))?.name, '博客重构')
})

test('project names are validated instead of silently rewritten', () => {
  assert.equal(normalizeProjectName('  项目 A  '), '项目 A')
  assert.throws(() => normalizeProjectName(''), /不能为空/u)
  assert.throws(() => normalizeProjectName('a'.repeat(65)), /64/u)
  assert.throws(() => normalizeProjectName('bad\u0000name'), /控制字符/u)
  assert.throws(() => normalizeProjectName(42), /字符串/u)
})

test('project ids cannot escape the user root', async () => {
  const { store } = await createStore()
  assert.equal(await store.get('1000', '../2000'), undefined)
  assert.throws(() => store.paths('1000', '../../etc'), /project id/u)
  assert.throws(() => resolveInside('/a/b', '../c'), /escapes/u)
})

test('removing a project quarantines its data instead of deleting it', async () => {
  const { store, varRoot } = await createStore()
  const project = await store.create('1000', 'demo')
  assert.equal(await store.remove('1000', project.id), true)
  assert.equal(await store.remove('1000', project.id), false)
  assert.equal((await store.list('1000')).length, 0)

  const trash = await readdir(join(varRoot, 'trash'))
  assert.equal(trash.length, 1)
  const quarantined = join(varRoot, 'trash', trash[0] ?? '')
  assert.equal((await stat(quarantined)).isDirectory(), true)
  assert.deepEqual(await readdir(join(quarantined, 'workspace')), [])
})

test('per-user project quota is enforced', async () => {
  const { store } = await createStore()
  await store.create('1000', 'one')
  await store.create('1000', 'two')
  await store.create('1000', 'three')
  await assert.rejects(() => store.create('1000', 'four'), /上限/u)
  await store.create('2000', 'other user is independent')
})
