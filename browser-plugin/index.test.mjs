import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTANCE_FIXTURE_ENV, OFFLINE_EXPERIMENT_ENV,
  activate, apply, selectExperimentMode,
} from './index.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

function createContext(agents = []) {
  const registrations = [], listeners = [], effects = []
  return {
    registrations, listeners, effects,
    tools: { register: definition => registrations.push(definition) },
    agents: { list: () => agents },
    on: (event, handler) => listeners.push({ event, handler }),
    effect: (factory, label) => effects.push({ factory, label }),
  }
}

function createRuntimeFactory() {
  const runtimes = []
  return {
    runtimes,
    factory: (ctx, deps, options) => {
      const runtime = {
        ctx, deps, options, attached: [], disposed: 0,
        async attach(agent) { this.attached.push(agent) },
        dispose() { this.disposed++ },
      }
      runtimes.push(runtime)
      return runtime
    },
  }
}

const fakeDeps = {
  createScope: () => 'scope', createMcpToolDefinition: () => 'definition', startWorker: () => 'worker',
}

test('default environment is disabled and never loads host packages or registers a tool', async () => {
  const ctx = createContext()
  const { runtimes, factory } = createRuntimeFactory()
  let loaded = 0
  const result = await activate(ctx, { env: {}, load: () => { loaded++; return fakeDeps }, runtimeFactory: factory })
  assert.equal(result, undefined)
  assert.equal(loaded, 0)
  assert.equal(runtimes.length, 0)
  assert.deepEqual(ctx.registrations, [])
  assert.deepEqual(ctx.listeners, [])
  assert.deepEqual(ctx.effects, [])

  const saved = { fixture: process.env[ACCEPTANCE_FIXTURE_ENV], offline: process.env[OFFLINE_EXPERIMENT_ENV] }
  delete process.env[ACCEPTANCE_FIXTURE_ENV]
  delete process.env[OFFLINE_EXPERIMENT_ENV]
  try {
    assert.equal(await apply(createContext()), undefined)
  } finally {
    if (saved.fixture === undefined) delete process.env[ACCEPTANCE_FIXTURE_ENV]
    else process.env[ACCEPTANCE_FIXTURE_ENV] = saved.fixture
    if (saved.offline === undefined) delete process.env[OFFLINE_EXPERIMENT_ENV]
    else process.env[OFFLINE_EXPERIMENT_ENV] = saved.offline
  }
})

test('mode selection accepts only exact =1 values and fixture wins over the legacy experiment', () => {
  assert.equal(selectExperimentMode({}), 'disabled')
  for (const value of ['0', 'true', 'yes', '']) {
    assert.equal(selectExperimentMode({ [OFFLINE_EXPERIMENT_ENV]: value }), 'disabled')
    assert.equal(selectExperimentMode({ [ACCEPTANCE_FIXTURE_ENV]: value }), 'disabled')
  }
  assert.equal(selectExperimentMode({ [OFFLINE_EXPERIMENT_ENV]: '1' }), 'offline-experiment')
  assert.equal(selectExperimentMode({ [ACCEPTANCE_FIXTURE_ENV]: '1' }), 'acceptance-fixture')
  assert.equal(selectExperimentMode({ [OFFLINE_EXPERIMENT_ENV]: '1', [ACCEPTANCE_FIXTURE_ENV]: '1' }), 'acceptance-fixture')
  assert.equal(selectExperimentMode(undefined), 'disabled')
})

test('legacy offline experiment keeps the existing activation wiring', async () => {
  const existing = { id: 'existing' }
  const ctx = createContext([existing])
  const { runtimes, factory } = createRuntimeFactory()
  const result = await activate(ctx, {
    env: { [OFFLINE_EXPERIMENT_ENV]: '1' },
    load: async () => fakeDeps,
    runtimeFactory: factory,
  })
  assert.equal(result, runtimes[0])
  assert.equal(runtimes[0].options.acceptanceFixture, false)
  assert.deepEqual(runtimes[0].deps, fakeDeps)
  assert.deepEqual(runtimes[0].attached, [existing])
  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'dsh-fnos-offline-browser.runtime')
  assert.equal(ctx.listeners.length, 1)
  assert.equal(ctx.listeners[0].event, 'agent/created')
  const fresh = { id: 'fresh' }
  await ctx.listeners[0].handler({ agent: fresh })
  assert.deepEqual(runtimes[0].attached, [existing, fresh])
  ctx.effects[0].factory()()
  assert.equal(runtimes[0].disposed, 1)
})

test('fixture variable alone activates the acceptance-fixture runtime without the legacy switch', async () => {
  const ctx = createContext()
  const { runtimes, factory } = createRuntimeFactory()
  await activate(ctx, {
    env: { [ACCEPTANCE_FIXTURE_ENV]: '1' },
    load: async () => fakeDeps,
    runtimeFactory: factory,
  })
  assert.equal(runtimes.length, 1)
  assert.equal(runtimes[0].options.acceptanceFixture, true)
})

test('both switches set still uses the fixture runtime (never arbitrary HTML)', async () => {
  const ctx = createContext()
  const { runtimes, factory } = createRuntimeFactory()
  await activate(ctx, {
    env: { [OFFLINE_EXPERIMENT_ENV]: '1', [ACCEPTANCE_FIXTURE_ENV]: '1' },
    load: async () => fakeDeps,
    runtimeFactory: factory,
  })
  assert.equal(runtimes.length, 1)
  assert.equal(runtimes[0].options.acceptanceFixture, true)
})

test('test seam runtime factory failure propagates and does not register tools', async () => {
  const ctx = createContext()
  await assert.rejects(activate(ctx, {
    env: { [ACCEPTANCE_FIXTURE_ENV]: '1' },
    load: async () => fakeDeps,
    runtimeFactory: () => { throw new Error('runtime factory failed') },
  }), /runtime factory failed/)
  assert.deepEqual(ctx.registrations, [])
})

test('acceptance patch enables only the fixed-fixture composition', async () => {
  const patch = await readFile(`${here}acceptance.patch.yml`, 'utf8')
  const expressions = [...patch.matchAll(/disabled: !!js "([^"]+)"/g)].map(match => match[1])
  assert.equal(expressions.length, 2)
  for (const expression of expressions) {
    const evaluate = env => new Function('process', `'use strict'; return (${expression})`)({ env })
    assert.equal(evaluate({}), true, 'default off')
    assert.equal(evaluate({ DSH_FNOS_BROWSER_ACCEPTANCE: '1' }), true, 'acceptance alone is not enough')
    assert.equal(evaluate({ DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT: '1' }), true, 'legacy switch alone is not enough')
    assert.equal(evaluate({ DSH_FNOS_ACCEPTANCE_FIXTURE: '1' }), true, 'fixture alone is not enough')
    assert.equal(evaluate({ DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT: '1' }), true, 'the legacy HTML acceptance composition is not enabled')
    assert.equal(evaluate({ DSH_FNOS_BROWSER_ACCEPTANCE: '1', DSH_FNOS_ACCEPTANCE_FIXTURE: '1' }), false, 'fixed-fixture composition')
  }
  assert.doesNotMatch(patch, /DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT/, 'acceptance harness must not accept the legacy HTML experiment')
  const cordisPatch = await readFile(`${here}cordis.patch.yml`, 'utf8')
  assert.match(cordisPatch, /disabled:\s*true/)
})

test('acceptance model only ever requests the fixed test site and confirms fixture results', async () => {
  const source = await readFile(`${here}acceptance-model.mjs`, 'utf8')
  assert.match(source, /DSH_FNOS_ACCEPTANCE_FIXTURE === '1'/)
  assert.match(source, /action:\s*'open_test_site'/)
  assert.match(source, /value\?\.fixture === true/)
  assert.doesNotMatch(source, /action:\s*'open'\s*,\s*html/)
})
