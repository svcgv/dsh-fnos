import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveInside } from '../src/paths.ts'
import { WorkspaceStore } from '../src/workspaces.ts'

async function createStore(): Promise<{ store: WorkspaceStore; home: string; uidRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fnos-workspace-'))
  const home = join(root, 'home')
  const uidRoot = join(home, 'users', '1000')
  return { store: new WorkspaceStore({ homeRoot: home }), home, uidRoot }
}

async function writeLegacyProject(
  uidRoot: string,
  project: { id: string; name: string; createdAt: string },
): Promise<string> {
  const root = join(uidRoot, 'projects', project.id)
  await Promise.all([
    mkdir(join(root, 'workspace'), { recursive: true }),
    mkdir(join(root, 'dsh-home', 'storages'), { recursive: true }),
    mkdir(join(root, 'agents-home'), { recursive: true }),
    mkdir(join(root, 'home'), { recursive: true }),
    mkdir(join(root, 'tmp'), { recursive: true }),
  ])
  await writeFile(join(root, 'project.json'), `${JSON.stringify({
    id: project.id,
    name: project.name,
    ownerUid: '1000',
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
  }, undefined, 2)}\n`)
  return root
}

test('creates one empty workspace for a new user', async () => {
  const { store, uidRoot } = await createStore()
  const workspace = await store.ensure('1000')

  assert.equal(workspace.name, '默认工作区')
  assert.equal(workspace.ownerUid, '1000')
  const paths = store.paths('1000')
  for (const directory of [paths.workspace, paths.dshHome, paths.agentsHome, paths.home, paths.tmp]) {
    assert.equal((await stat(directory)).isDirectory(), true)
  }
  const marker = JSON.parse(await readFile(join(paths.root, 'instance.json'), 'utf8')) as Record<string, unknown>
  assert.equal(marker.version, 1)
  assert.equal(marker.ownerUid, '1000')
  assert.equal(marker.name, '默认工作区')
  assert.deepEqual(await readdir(join(uidRoot, 'harness', 'workspace')), [])
})

test('migrates the newest legacy project and preserves older projects', async () => {
  const { store, uidRoot } = await createStore()
  const older = await writeLegacyProject(uidRoot, {
    id: 'polder000001',
    name: 'older',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const newer = await writeLegacyProject(uidRoot, {
    id: 'pnewer000002',
    name: 'newer',
    createdAt: '2026-02-01T00:00:00.000Z',
  })
  const oldWorkspace = join(newer, 'workspace')
  const newWorkspace = join(uidRoot, 'harness', 'workspace')
  await writeFile(join(newer, 'workspace', 'README.md'), 'newest\n')
  await writeFile(join(older, 'workspace', 'old.txt'), 'older\n')
  const storage = join(newer, 'dsh-home', 'storages', 'workspace.json')
  await writeFile(storage, `${JSON.stringify({ path: oldWorkspace }, undefined, 2)}\n`)

  const workspace = await store.ensure('1000')

  assert.equal(workspace.name, 'newer')
  assert.deepEqual(workspace.migratedFrom, {
    projectId: 'pnewer000002',
    name: 'newer',
    createdAt: '2026-02-01T00:00:00.000Z',
  })
  assert.equal(await readFile(join(newWorkspace, 'README.md'), 'utf8'), 'newest\n')
  assert.equal(await readFile(join(older, 'workspace', 'old.txt'), 'utf8'), 'older\n')
  await assert.rejects(() => access(newer))

  const rewritten = JSON.parse(await readFile(join(uidRoot, 'harness', 'dsh-home', 'storages', 'workspace.json'), 'utf8')) as { path: string }
  assert.equal(rewritten.path, newWorkspace)
})

test('workspace preparation is idempotent and concurrency-safe', async () => {
  const { store, uidRoot } = await createStore()
  const legacy = await writeLegacyProject(uidRoot, {
    id: 'pconcurrent01',
    name: 'concurrent',
    createdAt: '2026-03-01T00:00:00.000Z',
  })
  await writeFile(join(legacy, 'workspace', 'one.txt'), 'one\n')

  const workspaces = await Promise.all(Array.from({ length: 20 }, () => store.ensure('1000')))
  assert.equal(new Set(workspaces.map((workspace) => workspace.createdAt)).size, 1)
  assert.equal(await readFile(join(uidRoot, 'harness', 'workspace', 'one.txt'), 'utf8'), 'one\n')
  await assert.rejects(() => access(join(uidRoot, '.workspace-migration.json')))

  const again = await store.ensure('1000')
  assert.equal(again.createdAt, workspaces[0]?.createdAt)
})

test('resumes migration after the project directory was moved', async () => {
  const { store, uidRoot } = await createStore()
  const legacy = await writeLegacyProject(uidRoot, {
    id: 'presume00001',
    name: 'resume',
    createdAt: '2026-04-01T00:00:00.000Z',
  })
  const userRoot = store.userRoot('1000')
  const target = join(userRoot, 'harness')
  await writeFile(join(userRoot, '.workspace-migration.json'), `${JSON.stringify({
    version: 1,
    ownerUid: '1000',
    projectId: 'presume00001',
    startedAt: '2026-04-01T00:00:00.000Z',
  })}\n`)
  await rename(legacy, target)

  const workspace = await store.ensure('1000')
  assert.equal(workspace.name, 'resume')
  assert.equal(workspace.migratedFrom?.projectId, 'presume00001')
  await assert.rejects(() => access(join(userRoot, '.workspace-migration.json')))
})

test('user roots cannot escape the application home', async () => {
  const { store } = await createStore()
  assert.throws(() => store.userRoot('../etc'), /uid/u)
  assert.throws(() => store.paths('../../etc'), /uid/u)
  assert.throws(() => resolveInside('/a/b', '../c'), /escapes/u)
})

test('two NAS users receive independent workspaces', async () => {
  const { store, home } = await createStore()
  const first = await store.ensure('1000')
  const second = await store.ensure('2000')

  assert.equal(first.name, second.name)
  assert.notEqual(store.paths('1000').root, store.paths('2000').root)
  assert.equal(store.paths('1000').root, join(home, 'users', '1000', 'harness'))
  assert.equal(store.paths('2000').root, join(home, 'users', '2000', 'harness'))
})
