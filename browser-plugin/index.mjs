import { startWorker } from './worker-client.mjs'
import { createBrowserRuntime } from './runtime.mjs'

export const inject = ['tools', 'agents']

/** Legacy offline-HTML experiment. Default off; unchanged by the fixture mode. */
export const OFFLINE_EXPERIMENT_ENV = 'DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT'
/** Explicit admin opt-in for the acceptance fixed-page mode. Default off. */
export const ACCEPTANCE_FIXTURE_ENV = 'DSH_FNOS_ACCEPTANCE_FIXTURE'

/**
 * Only exact `=1` values enable anything. The fixture mode wins when both are
 * set so a misconfigured acceptance instance can never fall back to the
 * arbitrary-HTML `open` action.
 */
export function selectExperimentMode(env = process.env) {
  if (env?.[ACCEPTANCE_FIXTURE_ENV] === '1') return 'acceptance-fixture'
  if (env?.[OFFLINE_EXPERIMENT_ENV] === '1') return 'offline-experiment'
  return 'disabled'
}

/**
 * Host packages are loaded only after an explicit opt-in, so a disabled plugin
 * never touches them and default tests do not require the running installation.
 */
async function loadHostDeps() {
  const [{ createScope }, { createMcpToolDefinition }] = await Promise.all([
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-mcp-client'),
  ])
  return { createScope, createMcpToolDefinition, startWorker }
}

/** Testable activation core; the mode comes from trusted host env, never from tool input. */
export async function activate(ctx, { env = process.env, load = loadHostDeps, runtimeFactory = createBrowserRuntime } = {}) {
  const mode = selectExperimentMode(env)
  if (mode === 'disabled') return undefined
  const deps = await load()
  const runtime = runtimeFactory(ctx, deps, { acceptanceFixture: mode === 'acceptance-fixture' })
  ctx.effect(() => () => runtime.dispose(), 'dsh-fnos-offline-browser.runtime')
  ctx.on('agent/created', ({ agent }) => runtime.attach(agent))
  for (const agent of ctx.agents.list()) await runtime.attach(agent)
  return runtime
}

/** Disabled experimental skeleton; do not install or enable in a user profile. */
export async function apply(ctx) {
  // Cordis treats a plugin's resolved value as an effect, so never return the runtime.
  await activate(ctx)
}
