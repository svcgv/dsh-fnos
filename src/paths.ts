import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Validate a value that becomes a single path segment.
 * Rejects separators, traversal and control characters instead of sanitizing silently.
 */
export function safeSegment(value: string, label: string): string {
  if (!SEGMENT.test(value)) {
    throw new Error(`${label} must match ${SEGMENT.source}, received ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve `target` and require it to stay strictly below `root`. */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes ${JSON.stringify(root)}: ${JSON.stringify(target)}`)
  }
  return target
}

/** Create a directory tree; safe to call repeatedly. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}
