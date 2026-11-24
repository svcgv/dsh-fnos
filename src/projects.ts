import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, resolveInside, safeSegment } from './paths.ts'

/** A project owned by exactly one NAS user. */
export interface Project {
  readonly id: string
  readonly name: string
  readonly ownerUid: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Filesystem layout for one project's runtime state. */
export interface ProjectPaths {
  readonly root: string
  readonly workspace: string
  readonly dshHome: string
  readonly agentsHome: string
  readonly home: string
  readonly tmp: string
}

const PROJECT_ID = /^p[a-z0-9]{6,32}$/
const MAX_NAME_LENGTH = 64

/** Normalize and validate a user-supplied project name. */
export function normalizeProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('项目名称必须是字符串')
  const name = value.trim()
  if (name.length === 0) throw new Error('项目名称不能为空')
  if (name.length > MAX_NAME_LENGTH) throw new Error(`项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('项目名称不能包含控制字符')
  return name
}

interface StoreOptions {
  /** Per-user project data root (`TRIM_PKGHOME`). */
  readonly homeRoot: string
  /** Runtime data root used to quarantine deleted projects (`TRIM_PKGVAR`). */
  readonly varRoot: string
  readonly maxProjectsPerUser: number
}

/** Read-through project store. Ownership is always enforced on access. */
export class ProjectStore {
  readonly #homeRoot: string
  readonly #varRoot: string
  readonly #maxProjects: number

  constructor(options: StoreOptions) {
    this.#homeRoot = options.homeRoot
    this.#varRoot = options.varRoot
    this.#maxProjects = options.maxProjectsPerUser
  }

  /** Directory holding all projects of one user. */
  userRoot(uid: string): string {
    safeSegment(uid, 'uid')
    return resolveInside(this.#homeRoot, 'users', uid, 'projects')
  }

  paths(uid: string, id: string): ProjectPaths {
    const root = resolveInside(this.userRoot(uid), safeSegment(id, 'project id'))
    return {
      root,
      workspace: join(root, 'workspace'),
      dshHome: join(root, 'dsh-home'),
      agentsHome: join(root, 'agents-home'),
      home: join(root, 'home'),
      tmp: join(root, 'tmp'),
    }
  }

  async list(uid: string): Promise<Project[]> {
    const root = this.userRoot(uid)
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const projects: Project[] = []
    for (const entry of entries) {
      if (!PROJECT_ID.test(entry)) continue
      const project = await this.#read(uid, entry)
      if (project !== undefined) projects.push(project)
    }
    projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return projects
  }

  async get(uid: string, id: string): Promise<Project | undefined> {
    if (!PROJECT_ID.test(id)) return undefined
    return this.#read(uid, id)
  }

  async create(uid: string, rawName: unknown): Promise<Project> {
    const name = normalizeProjectName(rawName)
    const existing = await this.list(uid)
    if (existing.length >= this.#maxProjects) {
      throw new Error(`项目数量已达上限（${this.#maxProjects}）`)
    }

    const id = `p${Date.now().toString(36)}${randomUUID().slice(0, 8).replace(/-/g, '')}`
    const paths = this.paths(uid, id)
    await Promise.all([
      ensureDir(paths.workspace),
      ensureDir(paths.dshHome),
      ensureDir(paths.agentsHome),
      ensureDir(paths.home),
      ensureDir(paths.tmp),
    ])

    const now = new Date().toISOString()
    const project: Project = { id, name, ownerUid: uid, createdAt: now, updatedAt: now }
    await this.#write(paths.root, project)
    return project
  }

  /** Move a project out of the active set without destroying its data. */
  async remove(uid: string, id: string): Promise<boolean> {
    const project = await this.get(uid, id)
    if (project === undefined) return false
    const paths = this.paths(uid, id)
    const trashRoot = resolveInside(this.#varRoot, 'trash')
    await mkdir(trashRoot, { recursive: true })
    const target = join(trashRoot, `${uid}-${id}-${Date.now().toString(36)}`)
    await rename(paths.root, target)
    return true
  }

  /** Copy project state for backup or migration. */
  async exportTo(uid: string, id: string, destination: string): Promise<void> {
    const project = await this.get(uid, id)
    if (project === undefined) throw new Error('项目不存在')
    await cp(this.paths(uid, id).root, destination, { recursive: true, errorOnExist: false, force: true })
  }

  async #read(uid: string, id: string): Promise<Project | undefined> {
    const file = join(this.userRoot(uid), id, 'project.json')
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!isProject(parsed)) return undefined
      if (parsed.ownerUid !== uid || parsed.id !== id) return undefined
      return parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async #write(root: string, project: Project): Promise<void> {
    const file = join(root, 'project.json')
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(project, undefined, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
  }
}

function isProject(value: unknown): value is Project {
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

/** True when `path` is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
