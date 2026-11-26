import { lstat, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, resolveInside, safeSegment } from './paths.ts'

/** One fnOS user's persistent Harness workspace. */
export interface Workspace {
  readonly version: 1
  readonly ownerUid: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly migratedFrom?: {
    readonly projectId: string
    readonly name: string
    readonly createdAt: string
  }
}

/** Filesystem layout for one user's Harness instance. */
export interface WorkspacePaths {
  readonly root: string
  readonly workspace: string
  readonly dshHome: string
  readonly agentsHome: string
  readonly home: string
  readonly tmp: string
}

interface WorkspaceStoreOptions {
  /** Per-user application data root (`TRIM_PKGHOME`). */
  readonly homeRoot: string
}

interface LegacyProject {
  readonly id: string
  readonly name: string
  readonly ownerUid: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface MigrationJournal {
  readonly version: 1
  readonly ownerUid: string
  readonly projectId: string
  readonly startedAt: string
}

const LEGACY_PROJECT_ID = /^p[a-z0-9]{6,32}$/u
const INSTANCE_FILE = 'instance.json'
const MIGRATION_FILE = '.workspace-migration.json'
const REWRITE_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.txt'])
const REWRITE_DIRECTORIES = ['dsh-home', 'agents-home', 'home']

/** Error raised when a legacy project cannot be converted into the single workspace. */
export class WorkspacePreparationError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
    this.name = 'WorkspacePreparationError'
  }
}

/** Read-through store for one fixed Harness workspace per NAS user. */
export class WorkspaceStore {
  readonly #homeRoot: string
  readonly #resolving = new Map<string, Promise<Workspace>>()

  constructor(options: WorkspaceStoreOptions) {
    this.#homeRoot = options.homeRoot
  }

  /** Directory containing one user's application data. */
  userRoot(uid: string): string {
    safeSegment(uid, 'uid')
    return resolveInside(this.#homeRoot, 'users', uid)
  }

  paths(uid: string): WorkspacePaths {
    const root = join(this.userRoot(uid), 'harness')
    return {
      root,
      workspace: join(root, 'workspace'),
      dshHome: join(root, 'dsh-home'),
      agentsHome: join(root, 'agents-home'),
      home: join(root, 'home'),
      tmp: join(root, 'tmp'),
    }
  }

  /** Resolve, migrate, or create the user's single Harness workspace. */
  ensure(uid: string): Promise<Workspace> {
    safeSegment(uid, 'uid')
    const active = this.#resolving.get(uid)
    if (active !== undefined) return active
    const promise = this.#ensureUnlocked(uid).finally(() => this.#resolving.delete(uid))
    this.#resolving.set(uid, promise)
    return promise
  }

  /** Read the current instance marker without creating or migrating anything. */
  async read(uid: string): Promise<Workspace | undefined> {
    return this.#readInstance(uid)
  }

  async #ensureUnlocked(uid: string): Promise<Workspace> {
    const userRoot = this.userRoot(uid)
    await ensureDir(userRoot)
    const paths = this.paths(uid)

    const existing = await this.#readInstance(uid)
    if (existing !== undefined) {
      await this.#ensureLayout(paths)
      await rm(join(userRoot, MIGRATION_FILE), { force: true })
      return existing
    }

    const journal = await this.#readJournal(uid)
    if (journal !== undefined) return this.#finishMigration(uid, journal, paths)

    const legacy = await this.#latestLegacyProject(uid)
    if (legacy !== undefined) {
      const journalValue: MigrationJournal = {
        version: 1,
        ownerUid: uid,
        projectId: legacy.id,
        startedAt: new Date().toISOString(),
      }
      await this.#writeJsonAtomic(join(userRoot, MIGRATION_FILE), journalValue)
      return this.#finishMigration(uid, journalValue, paths, legacy)
    }

    const now = new Date().toISOString()
    await this.#ensureLayout(paths)
    const workspace: Workspace = {
      version: 1,
      ownerUid: uid,
      name: '默认工作区',
      createdAt: now,
      updatedAt: now,
    }
    await this.#writeJsonAtomic(join(paths.root, INSTANCE_FILE), workspace)
    return workspace
  }

  async #finishMigration(
    uid: string,
    journal: MigrationJournal,
    paths: WorkspacePaths,
    selected?: LegacyProject,
  ): Promise<Workspace> {
    const userRoot = this.userRoot(uid)
    const sourceRoot = resolveInside(userRoot, 'projects', safeSegment(journal.projectId, 'project id'))
    const sourceExists = await pathExists(sourceRoot)
    const targetExists = await pathExists(paths.root)
    const project = selected
      ?? (targetExists ? await this.#readProjectFile(join(paths.root, 'project.json'), uid, journal.projectId) : undefined)
      ?? (sourceExists ? await this.#readProjectFile(join(sourceRoot, 'project.json'), uid, journal.projectId) : undefined)
    if (project === undefined) {
      throw new WorkspacePreparationError(
        '旧工作区迁移失败',
        `legacy project ${journal.projectId} is missing or invalid`,
      )
    }
    if (sourceExists) {
      if (targetExists) {
        throw new WorkspacePreparationError(
          '旧工作区迁移失败',
          `both ${sourceRoot} and ${paths.root} exist`,
        )
      }
      await rename(sourceRoot, paths.root)
    } else if (!targetExists) {
      throw new WorkspacePreparationError(
        '旧工作区迁移失败',
        `neither ${sourceRoot} nor ${paths.root} exists`,
      )
    }

    await this.#rewriteAbsolutePaths(paths.root, sourceRoot, paths.root)
    await this.#ensureLayout(paths)
    const workspace: Workspace = {
      version: 1,
      ownerUid: uid,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: new Date().toISOString(),
      migratedFrom: {
        projectId: project.id,
        name: project.name,
        createdAt: project.createdAt,
      },
    }
    await this.#writeJsonAtomic(join(paths.root, INSTANCE_FILE), workspace)
    await rm(join(userRoot, MIGRATION_FILE), { force: true })
    return workspace
  }

  async #ensureLayout(paths: WorkspacePaths): Promise<void> {
    await Promise.all([
      ensureDir(paths.root),
      ensureDir(paths.workspace),
      ensureDir(paths.dshHome),
      ensureDir(paths.agentsHome),
      ensureDir(paths.home),
      ensureDir(paths.tmp),
    ])
    await ensureDefaultWorkspaceAlias(paths)
  }

  async #readInstance(uid: string): Promise<Workspace | undefined> {
    const file = join(this.paths(uid).root, INSTANCE_FILE)
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!isWorkspace(parsed) || parsed.ownerUid !== uid) return undefined
      return parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async #readJournal(uid: string): Promise<MigrationJournal | undefined> {
    const file = join(this.userRoot(uid), MIGRATION_FILE)
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!isMigrationJournal(parsed) || parsed.ownerUid !== uid) {
        throw new WorkspacePreparationError('旧工作区迁移日志无效', file)
      }
      return parsed
    } catch (error) {
      if (error instanceof WorkspacePreparationError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      if (error instanceof SyntaxError) {
        throw new WorkspacePreparationError('旧工作区迁移日志损坏', file)
      }
      throw error
    }
  }

  async #latestLegacyProject(uid: string): Promise<LegacyProject | undefined> {
    const projectsRoot = join(this.userRoot(uid), 'projects')
    let entries
    try {
      entries = await readdir(projectsRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }

    const projects: LegacyProject[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !LEGACY_PROJECT_ID.test(entry.name)) continue
      const project = await this.#readLegacyProject(uid, entry.name)
      if (project !== undefined) projects.push(project)
    }
    projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return projects[0]
  }

  async #readLegacyProject(uid: string, id: string): Promise<LegacyProject | undefined> {
    if (!LEGACY_PROJECT_ID.test(id)) return undefined
    const file = join(this.userRoot(uid), 'projects', id, 'project.json')
    return this.#readProjectFile(file, uid, id)
  }

  async #readProjectFile(file: string, uid: string, id: string): Promise<LegacyProject | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!isLegacyProject(parsed) || parsed.ownerUid !== uid || parsed.id !== id) return undefined
      return parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async #rewriteAbsolutePaths(root: string, oldRoot: string, newRoot: string): Promise<void> {
    for (const name of REWRITE_DIRECTORIES) {
      await rewriteTree(join(root, name), oldRoot, newRoot)
    }
  }

  async #writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  }
}

/**
 * Map Harness's standard first-use directory onto the fnOS fixed workspace.
 * Existing non-symlink directories are left untouched for compatibility; a
 * wrong symlink fails closed instead of registering an unexpected path.
 */
async function ensureDefaultWorkspaceAlias(paths: WorkspacePaths): Promise<void> {
  const parent = join(paths.root, 'deepseek-harness')
  const link = join(parent, 'default-workspace')
  await ensureDir(parent)
  let info
  try {
    info = await lstat(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await symlink(paths.workspace, link, 'dir')
    return
  }
  if (!info.isSymbolicLink()) return
  const [target, workspace] = await Promise.all([realpath(link), realpath(paths.workspace)])
  if (target !== workspace) {
    throw new Error(`default workspace alias points outside the fixed workspace: ${link}`)
  }
}

async function rewriteTree(directory: string, oldRoot: string, newRoot: string): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await rewriteTree(path, oldRoot, newRoot)
      continue
    }
    if (!entry.isFile()) continue
    const extension = path.slice(path.lastIndexOf('.'))
    if (!REWRITE_EXTENSIONS.has(extension)) continue

    const info = await lstat(path)
    const text = await readFile(path, 'utf8')
    if (!text.includes(oldRoot)) continue
    const tmp = `${path}.rewrite.tmp`
    await writeFile(tmp, text.split(oldRoot).join(newRoot), { mode: info.mode & 0o777 })
    await rename(tmp, path)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1
    && typeof record.ownerUid === 'string'
    && typeof record.projectId === 'string'
    && typeof record.startedAt === 'string'
  )
}

function isLegacyProject(value: unknown): value is LegacyProject {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.ownerUid === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
  )
}

function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1
    && typeof record.ownerUid === 'string'
    && typeof record.name === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
  )
}
