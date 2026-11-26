import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ACCEPTANCE_ENABLED_FILE,
  ACCEPTANCE_UID_FILE,
  readBrowserAcceptanceOptIn,
} from '../src/browser-acceptance-optin.ts'

async function markerDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-browser-optin-'))
}

async function writeMarker(directory: string, name: string, content: string): Promise<void> {
  await writeFile(join(directory, name), content)
}

test('the switch is off when no marker exists', async () => {
  const directory = await markerDir()
  try {
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'not-configured' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the switch is enabled only for a valid uid', async () => {
  const directory = await markerDir()
  try {
    await writeMarker(directory, ACCEPTANCE_ENABLED_FILE, '1\n')
    await writeMarker(directory, ACCEPTANCE_UID_FILE, ' 1000 \n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: true, uid: '1000' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the switch fails closed on an invalid marker or uid', async () => {
  const directory = await markerDir()
  try {
    await writeMarker(directory, ACCEPTANCE_ENABLED_FILE, 'yes\n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'marker-invalid' })
    await writeMarker(directory, ACCEPTANCE_ENABLED_FILE, '1\n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'uid-missing' })
    await writeMarker(directory, ACCEPTANCE_UID_FILE, 'root\n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'uid-missing' })
    await writeMarker(directory, ACCEPTANCE_UID_FILE, '01000\n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'uid-missing' })
    await writeMarker(directory, ACCEPTANCE_UID_FILE, '0\n')
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'uid-missing' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('symlinked marker files never enable the switch', async () => {
  const directory = await markerDir()
  const outside = await markerDir()
  try {
    await writeMarker(outside, ACCEPTANCE_ENABLED_FILE, '1\n')
    await writeMarker(outside, ACCEPTANCE_UID_FILE, '1000\n')
    await symlink(join(outside, ACCEPTANCE_ENABLED_FILE), join(directory, ACCEPTANCE_ENABLED_FILE))
    await symlink(join(outside, ACCEPTANCE_UID_FILE), join(directory, ACCEPTANCE_UID_FILE))
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'not-configured' })
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a directory in place of a marker file never enables the switch', async () => {
  const directory = await markerDir()
  try {
    await mkdir(join(directory, ACCEPTANCE_ENABLED_FILE))
    assert.deepEqual(await readBrowserAcceptanceOptIn(directory, {}), { enabled: false, reason: 'not-configured' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the development override still requires a valid uid', async () => {
  const directory = await markerDir()
  try {
    assert.deepEqual(
      await readBrowserAcceptanceOptIn(directory, { DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_BROWSER_ACCEPTANCE_UID: '1000' }),
      { enabled: true, uid: '1000' },
    )
    assert.deepEqual(
      await readBrowserAcceptanceOptIn(directory, { DSH_FNOS_BROWSER_ACCEPTANCE: '1' }),
      { enabled: false, reason: 'env-uid-missing' },
    )
    assert.deepEqual(
      await readBrowserAcceptanceOptIn(directory, { DSH_FNOS_BROWSER_ACCEPTANCE: 'on' }),
      { enabled: false, reason: 'env-invalid' },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
