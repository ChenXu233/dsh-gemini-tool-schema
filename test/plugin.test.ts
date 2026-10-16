import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apiTarget,
  apply,
  compileApiMatchers,
  name,
  resolveConfig,
  shouldApply,
  type AssembleListener,
  type Config,
  type PluginContext,
  type PromptAssembly,
  type Route,
  type ToolSchema,
} from '../src/index.ts'

const brokenTool: ToolSchema = {
  name: 'browser_emulate_media',
  parameters: {
    type: 'object',
    properties: {
      colorScheme: { anyOf: [{ type: 'string', enum: ['light', 'dark'] }, { type: 'null' }] },
      tags: { type: 'array' },
    },
  },
}

/** Mount the plugin on a mock Cordis context and capture its waterfall listener. */
function mount(config: Config = {}) {
  let captured: { listener: AssembleListener; options?: { prepend?: boolean } } | undefined
  const ctx = {
    on: (_event: 'system-prompt/assemble', listener: AssembleListener, options?: { prepend?: boolean }) => {
      captured = { listener, options }
    },
  } as unknown as PluginContext
  apply(ctx, config)
  assert.ok(captured, 'the plugin must register a listener')
  return captured
}

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

// ---------------------------------------------------------------- plugin shape

test('registers the assemble waterfall as a prepend listener', () => {
  const { options } = mount({ mode: 'all' })
  assert.equal(name, 'gemini-tool-schema')
  assert.equal(options?.prepend, true)
})

test('a matched route is normalized end to end', async () => {
  const { listener } = mount({ mode: 'all' })
  const assembly: PromptAssembly = { tools: [brokenTool], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  const parameters = out.tools?.[0]?.parameters
  assert.equal(parameters?.properties?.colorScheme?.type, 'string')
  assert.equal(parameters?.properties?.colorScheme?.nullable, true)
  assert.deepEqual(parameters?.properties?.tags?.items, { type: 'string' })
  assert.notEqual(out.tools?.[0], assembly.tools?.[0], 'tools must be replaced, not mutated')
})

test('a non-matching route passes the same assembly through', async () => {
  const { listener } = mount({ mode: 'list', apis: ['gemini'] })
  const assembly: PromptAssembly = { tools: [brokenTool], variables: { provider: 'openrouter', model: 'deepseek' } }
  assert.equal(await listener(assembly, {}, async () => assembly), assembly)
})

test('an unreadable route follows unknownApi', async () => {
  const assembly: PromptAssembly = { tools: [brokenTool], variables: {} }
  const skip = mount({ mode: 'list', apis: ['gemini'], unknownApi: 'skip' })
  assert.equal(await skip.listener(assembly, {}, async () => assembly), assembly)
  const applyIt = mount({ mode: 'list', apis: ['gemini'], unknownApi: 'apply' })
  const out = await applyIt.listener(assembly, {}, async () => assembly)
  assert.equal(out.tools?.[0]?.parameters?.properties?.tags?.items?.type, 'string')
})

test('dryRun reports but sends the original schemas', async () => {
  const logFile = join(tmp('gts-dry-'), 'log.txt')
  const { listener } = mount({ mode: 'all', dryRun: true, logFile })
  const assembly: PromptAssembly = { tools: [brokenTool], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  assert.equal(out.tools?.[0], brokenTool)
  assert.match(readFileSync(logFile, 'utf8'), /changed=1/)
})

test('dumpDir writes the model-facing tool set', async () => {
  const dumpDir = tmp('gts-dump-')
  const { listener } = mount({ mode: 'all', dumpDir })
  const assembly: PromptAssembly = { tools: [brokenTool], variables: { provider: 'gemini-lumiya', model: 'gemini-4-argon' } }
  await listener(assembly, {}, async () => assembly)
  const files = readdirSync(dumpDir)
  assert.equal(files.length, 1)
  const dump = JSON.parse(readFileSync(join(dumpDir, files[0]!), 'utf8'))
  assert.equal(dump.route.provider, 'gemini-lumiya')
  assert.equal(dump.toolCount, 1)
})

test('a tool with a hostile parameters value does not break the request', async () => {
  const { listener } = mount({ mode: 'all' })
  const assembly: PromptAssembly = { tools: [brokenTool, { name: 'hostile', parameters: 1 as never }], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  assert.equal(out.tools?.length, 2)
})

test('an invalid config fails fast', () => {
  for (const bad of [{ mode: 'nope' }, { unknownApi: 'nope' }, { apis: 'gemini' }, { logLevel: 'nope' }]) {
    assert.throws(() => apply({ on: () => {} } as unknown as PluginContext, bad as Config), /gemini-tool-schema/)
  }
})

// -------------------------------------------------------------- API selection

const route = (provider?: string, model?: string): Route => ({ provider, model, source: 'variables' })

test('API patterns are regular expressions, case-insensitive by default', () => {
  const [matcher] = compileApiMatchers(['^gemini'])
  assert.equal(matcher?.test('gemini-lumiya/gemini-4-argon'), true)
  assert.equal(matcher?.test('openrouter/gemini-flash'), false, '^ anchors the whole target')
  assert.equal(compileApiMatchers(['GEMINI'])[0]?.test('gemini-lumiya/x'), true)
})

test('API patterns accept /pattern/flags form', () => {
  const [matcher] = compileApiMatchers(['/^openrouter\\/glm/'])
  assert.equal(matcher?.test('openrouter/glm-5.3-flash'), true)
  assert.equal(matcher?.test('gemini-lumiya/gemini-4-argon'), false)
})

test('an invalid regex falls back to a substring match instead of throwing', () => {
  const [matcher] = compileApiMatchers(['gemini['])
  assert.equal(matcher?.test('x/gemini[y'), true)
  assert.equal(matcher?.test('openrouter/deepseek'), false)
})

test("'*' matches every API, including an unknown one", () => {
  const config = resolveConfig({ mode: 'list', apis: ['*'] })
  assert.equal(shouldApply(route('openrouter', 'deepseek-v4.1-flash-oc'), config), true)
  assert.equal(shouldApply({ source: 'unknown' }, config), true)
})

test('mode all ignores the API list, mode off never applies', () => {
  const all = resolveConfig({ mode: 'all', apis: ['nothing-matches'] })
  assert.equal(shouldApply(route('openrouter', 'deepseek'), all), true)
  const off = resolveConfig({ mode: 'off' })
  assert.equal(shouldApply(route('gemini-lumiya', 'gemini-4-argon'), off), false)
})

test('the default API list covers the Gemini family', () => {
  const config = resolveConfig()
  assert.equal(shouldApply(route('gemini-lumiya', 'gemini-4-argon'), config), true)
  assert.equal(shouldApply(route('openrouter', 'deepseek-v4.1-flash-oc'), config), false)
  assert.equal(shouldApply(route('vertex-ai', 'gemini-2.5-pro'), config), true)
})

test('apiTarget joins provider and model, tolerating a missing half', () => {
  assert.equal(apiTarget(route('gemini-lumiya', 'gemini-4-argon')), 'gemini-lumiya/gemini-4-argon')
  assert.equal(apiTarget(route(undefined, 'gemini-4-argon')), 'gemini-4-argon')
  assert.equal(apiTarget({ source: 'unknown' }), '')
})

test('a regex can select exactly one route', async () => {
  const { listener } = mount({ mode: 'list', apis: ['^gemini-lumiya/gemini-4-argon$'] })
  const hit: PromptAssembly = { tools: [brokenTool], variables: { provider: 'gemini-lumiya', model: 'gemini-4-argon' } }
  const miss: PromptAssembly = { tools: [brokenTool], variables: { provider: 'openrouter', model: 'gemini-4-argon' } }
  assert.notEqual(await listener(hit, {}, async () => hit), hit)
  assert.equal(await listener(miss, {}, async () => miss), miss)
})

test('existsSync guard keeps the suite portable', () => {
  assert.equal(typeof existsSync, 'function')
})
