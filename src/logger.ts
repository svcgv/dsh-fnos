/** Structured logger: one JSON object per line, safe for `cmd/main` log capture. */
export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function write(level: Level, base: Record<string, unknown>, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields })
  process.stdout.write(line + '\n')
}

/** Create a logger rooted at `base` fields. */
export function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (event, fields) => write('debug', base, event, fields),
    info: (event, fields) => write('info', base, event, fields),
    warn: (event, fields) => write('warn', base, event, fields),
    error: (event, fields) => write('error', base, event, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  }
}
