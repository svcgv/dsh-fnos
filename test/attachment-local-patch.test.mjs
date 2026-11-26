import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  ATTACHMENT_LOCAL_PATCH_MARKER,
  attachmentLocalPatchFixture,
  patchAttachmentLocalFsync,
  verifyAttachmentLocalPatch,
} from '../scripts/attachment-local-patch.mjs'

async function payloadFixture(source) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-fnos-attachment-patch-'))
  const dsh = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  const attachment = join(directory, 'node_modules', '@deepseek-ai', 'dsh-attachment-local')
  await mkdir(dsh, { recursive: true })
  await mkdir(join(attachment, 'lib'), { recursive: true })
  await writeFile(join(dsh, 'bin.js'), 'export {}\n')
  await writeFile(join(attachment, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-attachment-local',
    type: 'module',
    exports: { './package.json': './package.json' },
  })}\n`)
  await writeFile(join(attachment, 'lib', 'index.js'), source)
  return { directory, bundle: join(attachment, 'lib', 'index.js') }
}

test('patches attachment-local to tolerate an unreadable durable ancestor', async () => {
  const fixture = await payloadFixture([
    "import { constants } from 'node:fs'",
    "import { open } from './open.mjs'",
    attachmentLocalPatchFixture.original,
    'export { syncDirectory }',
    '',
  ].join('\n'))
  await writeFile(join(fixture.directory, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'open.mjs'), [
    'export async function open(path) {',
    "  if (path === '/vol1') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })",
    "  if (path === '/broken') throw Object.assign(new Error('io failure'), { code: 'EIO' })",
    '  return { sync: async () => undefined, close: async () => undefined }',
    '}',
    '',
  ].join('\n'))

  try {
    const first = await patchAttachmentLocalFsync(fixture.directory)
    assert.equal(first.changed, true)
    const patched = await readFile(fixture.bundle, 'utf8')
    assert.match(patched, new RegExp(ATTACHMENT_LOCAL_PATCH_MARKER, 'u'))
    assert.match(patched, /EACCES/u)
    assert.match(patched, /EPERM/u)

    const second = await patchAttachmentLocalFsync(fixture.directory)
    assert.equal(second.changed, false)
    await verifyAttachmentLocalPatch(fixture.directory)

    const module = await import(`${pathToFileURL(fixture.bundle).href}?test=behaviour`)
    await assert.doesNotReject(() => module.syncDirectory('/vol1'))
    await assert.rejects(() => module.syncDirectory('/broken'), /io failure/u)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('fails loudly when a Harness upgrade changes the attachment-local bundle', async () => {
  const fixture = await payloadFixture('async function syncDirectory() { return "changed upstream" }\n')
  try {
    await assert.rejects(
      () => patchAttachmentLocalFsync(fixture.directory),
      /unsupported attachment-local bundle/u,
    )
    await assert.rejects(
      () => verifyAttachmentLocalPatch(fixture.directory),
      /missing the fnOS attachment-local fsync patch/u,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
