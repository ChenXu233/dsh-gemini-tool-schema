import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { lintSchema, normalizeSchema, type JsonSchema } from '../src/normalize.ts'

/**
 * The exact schema that made Gemini reject every request on the
 * gemini-4-argon route: Playwright MCP's `browser_emulate_media`, whose
 * nullable enums come from `z.string().nullable()`.
 */
const playwrightEmulateMedia: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    colorScheme: {
      description: 'Emulates the prefers-color-scheme media feature',
      anyOf: [{ type: 'string', enum: ['light', 'dark'] }, { type: 'null' }],
    },
    reducedMotion: {
      description: 'Emulates the prefers-reduced-motion media feature',
      anyOf: [{ type: 'string', enum: ['reduce', 'no-preference'] }, { type: 'null' }],
    },
    forcedColors: {
      description: 'Emulates the forced-colors media feature',
      anyOf: [{ type: 'string', enum: ['active', 'none'] }, { type: 'null' }],
    },
    contrast: {
      description: 'Emulates the prefers-contrast media feature',
      anyOf: [{ type: 'string', enum: ['more', 'no-preference'] }, { type: 'null' }],
    },
    media: {
      description: 'Emulates the media type',
      anyOf: [{ type: 'string', enum: ['screen', 'print'] }, { type: 'null' }],
    },
  },
}

/**
 * The 17 array parameters of Lingshu's `lingshu_cg` that produced
 * "properties[...].items: missing field" — all built by `_p("array", ...)`.
 */
const LINGSHU_ARRAYS = [
  'depends_on', 'tags', 'non_applicable_conditions', 'questions', 'issues', 'patterns', 'skip_dirs',
  'roots', 'ids', 'relation_types', 'verdicts', 'clues', 'queries', 'entry_ids', 'v_types',
  'subjects', 'prefixes',
] as const
const lingshuCg: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(LINGSHU_ARRAYS.map((key) => [key, { description: key, type: 'array' }])),
}

test('playwright nullable enum gains a type and stays nullable', () => {
  const out = normalizeSchema(playwrightEmulateMedia)
  assert.equal(out.type, 'object')
  assert.deepEqual(out.properties?.colorScheme, {
    type: 'string',
    description: 'Emulates the prefers-color-scheme media feature',
    enum: ['light', 'dark'],
    nullable: true,
  })
  assert.equal(out.additionalProperties, undefined)
  assert.deepEqual(lintSchema(out), [])
})

test('the JSON-Schema "type array" form with null is flattened', () => {
  const out = normalizeSchema({ type: ['array', 'null'], items: { type: 'string' } })
  assert.equal(out.type, 'array')
  assert.equal(out.nullable, true)
  assert.deepEqual(out.items, { type: 'string' })
})

test('a bare array receives items instead of failing validation', () => {
  const out = normalizeSchema({ type: 'array', description: '不适用条件' })
  assert.equal(out.type, 'array')
  assert.deepEqual(out.items, { type: 'string' })
  assert.deepEqual(lintSchema(out), [])
})

test('every lingshu_cg array parameter becomes valid', () => {
  const before = lintSchema(lingshuCg)
  assert.equal(before.length, LINGSHU_ARRAYS.length, 'fixture must actually be broken')
  const out = normalizeSchema(lingshuCg)
  assert.deepEqual(lintSchema(out), [])
  for (const key of LINGSHU_ARRAYS) {
    assert.equal(out.properties?.[key]?.type, 'array')
    assert.deepEqual(out.properties?.[key]?.items, { type: 'string' })
  }
})

test('$ref against $defs is inlined and $defs disappears', () => {
  const out = normalizeSchema({
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: { Node: { type: 'object', properties: { id: { type: 'string' } } } },
  })
  assert.equal(out.$defs, undefined)
  assert.deepEqual(out.properties?.node, { type: 'object', properties: { id: { type: 'string' } } })
})

test('a circular $ref terminates', () => {
  const out = normalizeSchema({
    type: 'object',
    properties: { self: { $ref: '#/$defs/Node' } },
    $defs: { Node: { type: 'object', properties: { self: { $ref: '#/$defs/Node' } } } },
  })
  assert.deepEqual(lintSchema(out), [])
})

test('required entries that are not properties are dropped', () => {
  const out = normalizeSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost'] })
  assert.deepEqual(out.required, ['a'])
})

test('allOf merges, and a heterogeneous anyOf collapses to one type', () => {
  const merged = normalizeSchema({ allOf: [
    { type: 'object', properties: { a: { type: 'string' } } },
    { properties: { b: { type: 'number' } } },
  ] })
  assert.equal(merged.type, 'object')
  assert.deepEqual(Object.keys(merged.properties ?? {}).sort(), ['a', 'b'])
  assert.equal(normalizeSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] }).type, 'string')
})

test('enum null entries become nullable', () => {
  const out = normalizeSchema({ type: 'string', enum: ['a', null] })
  assert.deepEqual(out.enum, ['a'])
  assert.equal(out.nullable, true)
})

test('empty enum entries are dropped (enum[3]: cannot be empty)', () => {
  const out = normalizeSchema({
    type: 'object',
    properties: {
      permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access', ''] },
    },
  })
  assert.deepEqual(out.properties?.permission?.enum, ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual(lintSchema(out), [])
})

test('const cannot re-introduce a filtered empty enum entry (real task_board_update)', () => {
  const out = normalizeSchema({
    type: 'string',
    description: 'New permission preset; an empty string clears it back to the session default.',
    enum: ['read-only', 'workspace-write', 'danger-full-access', ''],
    const: '',
  })
  assert.deepEqual(out.enum, ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(out.const, undefined)
  assert.deepEqual(lintSchema(out), [])
})

test('a const that is only an empty string leaves no enum behind', () => {
  const out = normalizeSchema({ type: 'string', const: '' })
  assert.equal(out.enum, undefined)
  assert.deepEqual(lintSchema(out), [])
})

test('an enum made only of empty entries disappears entirely', () => {
  const out = normalizeSchema({ type: 'string', enum: ['', ''] })
  assert.equal(out.enum, undefined)
  assert.equal(out.type, 'string')
  assert.deepEqual(lintSchema(out), [])
})

test('title is stripped, numeric enums survive', () => {
  const out = normalizeSchema({ type: 'object', title: 'Root', properties: { level: { title: 'L', type: 'integer', enum: [1, 2, 3] } } })
  assert.equal(out.title, undefined)
  assert.equal(out.properties?.level?.title, undefined)
  assert.equal(out.properties?.level?.type, 'integer')
  assert.deepEqual(out.properties?.level?.enum, [1, 2, 3])
  assert.deepEqual(lintSchema(out), [])
})

test('normalization is idempotent and deterministic', () => {
  const once = normalizeSchema(playwrightEmulateMedia)
  assert.equal(JSON.stringify(normalizeSchema(once)), JSON.stringify(once))
  assert.equal(JSON.stringify(normalizeSchema(lingshuCg)), JSON.stringify(normalizeSchema(lingshuCg)))
})

test('the input schema is never mutated, even when deeply frozen', () => {
  const frozen = Object.freeze({ type: 'array' }) as JsonSchema
  const snapshot = JSON.stringify(frozen)
  const out = normalizeSchema(frozen)
  assert.equal(JSON.stringify(frozen), snapshot)
  assert.deepEqual(out.items, { type: 'string' })
  const nested: JsonSchema = { type: 'object', properties: { a: { type: 'array' } } }
  normalizeSchema(nested)
  assert.equal(nested.properties?.a?.items, undefined)
})

test('itemsFallback is configurable', () => {
  assert.deepEqual(normalizeSchema({ type: 'array' }, { itemsFallback: { type: 'object' } }).items, { type: 'object' })
})

test('nullable can be turned off', () => {
  const out = normalizeSchema({ type: ['string', 'null'] }, { nullable: false })
  assert.equal(out.nullable, undefined)
})

test('real MCP tool cache: every tool becomes strict-provider-valid', {
  skip: !existsSync('C:/Users/ChenXu233/.dsh/storages/mcp_connector.json'),
}, () => {
  const store = JSON.parse(readFileSync('C:/Users/ChenXu233/.dsh/storages/mcp_connector.json', 'utf8'))
  const catalog = store.tables.tool_catalog as Record<string, { tools?: Record<string, { inputSchema?: JsonSchema; parameters?: JsonSchema } & JsonSchema> }>
  let tools = 0
  let before = 0
  let after = 0
  for (const entry of Object.values(catalog)) {
    for (const tool of Object.values(entry.tools ?? {})) {
      const schema = tool.inputSchema ?? tool.parameters ?? tool
      if (schema === null || typeof schema !== 'object') continue
      tools += 1
      before += lintSchema(schema).length
      after += lintSchema(normalizeSchema(schema)).length
    }
  }
  assert.ok(tools > 50, 'expected the connector cache to hold the MCP tool set')
  if (before === 0) return
  assert.equal(after, 0, 'normalization must leave zero violations')
})
