/**
 * Tool JSON Schema normalization for strict function-calling providers.
 *
 * Many providers accept only an OpenAPI-3.0-flavored *subset* of JSON Schema.
 * Google Gemini's `functionDeclarations[].parameters` is the strictest common
 * case: it rejects the whole request (HTTP 400) when
 *
 *   - a schema node carries no `type` — for example the bare `anyOf` that
 *     `z.string().nullable()` produces, or
 *   - an array node carries no `items`, or
 *   - an `enum` contains an empty entry.
 *
 * The functions here are pure, dependency-free and deterministic: normalizing
 * twice yields a deep-equal result, so running them on every model request does
 * not churn the request header or the prompt cache.
 *
 * @module
 */

/** A JSON Schema node, as produced by MCP servers and tool authors. */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchema>
  required?: unknown[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  nullable?: boolean
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minProperties?: number
  maxProperties?: number
  default?: unknown
  $ref?: string
  $defs?: Record<string, JsonSchema>
  definitions?: Record<string, JsonSchema>
  /** Vendor extensions survive parsing but never reach the request. */
  [key: string]: unknown
}

/** Options for {@link normalizeSchema}. */
export interface NormalizeOptions {
  /**
   * Schema used for an array that omits `items`. Strict providers require a
   * concrete element type, and most bare arrays in the wild hold names or ids.
   * @default { type: 'string' }
   */
  itemsFallback?: JsonSchema
  /**
   * Emit `nullable: true` for null unions instead of dropping the nullability.
   * @default true
   */
  nullable?: boolean
  /** Recursion guard for pathological schemas. @default 64 */
  maxDepth?: number
}

/** The six type names every strict provider understands. */
const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

/** Preference order when a union has several non-null branches. */
const TYPE_PRIORITY = ['object', 'array', 'string', 'number', 'integer', 'boolean']

/**
 * Keywords a strict provider rejects, or that this module rewrites itself.
 * Anything not in {@link PASSTHROUGH_KEYS} is dropped from the output.
 */
const FORBIDDEN_KEYS = new Set([
  '$schema', '$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$comment', '$vocabulary',
  '$defs', 'definitions',
  'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'prefixItems', 'contains', 'minContains', 'maxContains',
  'propertyNames', 'patternProperties',
  'if', 'then', 'else', 'not',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'contentMediaType', 'contentEncoding', 'contentSchema',
  'multipleOf', 'examples', 'example', 'readOnly', 'writeOnly', 'deprecated',
  // Supported on paper, but older API versions rejected nested titles — and a
  // tool-calling schema gains nothing from them.
  'title',
])

/**
 * Scalar keywords that pass through untouched. An allow-list, not a deny-list:
 * one unknown keyword in a strict provider request rejects the whole request,
 * which is exactly the class of bug this module exists to remove.
 */
const PASSTHROUGH_KEYS = new Set([
  'minProperties', 'maxProperties', 'uniqueItems', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'format', 'default', 'minimum', 'maximum',
])

/** Deep clone that also detaches frozen input (prompt assemblies are frozen). */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = clone(item)
  return out as T
}

/** True for a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The JSON type name of a literal value, in schema vocabulary. */
function typeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'boolean'
    case 'number': return Number.isInteger(value) ? 'integer' : 'number'
    default: return 'object'
  }
}

/** Does this node describe only `null`? */
function isNullOnly(node: unknown): boolean {
  if (!isPlainObject(node)) return false
  if (node.type === 'null') return true
  if (Array.isArray(node.type) && node.type.length > 0 && node.type.every((t) => t === 'null')) return true
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => v === null)) return true
  return node.const === null && node.type === undefined
}

/** A strict provider rejects an empty enum entry; `''` is the common case. */
function isEmptyEnumEntry(value: unknown): boolean {
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/** Drop duplicate enum entries, keeping first-seen order. */
function dedupeEnum(values: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  for (const value of values) {
    if (!out.some((existing) => JSON.stringify(existing) === JSON.stringify(value))) out.push(clone(value))
  }
  return out
}

/** Union of two optional enum arrays, keeping first-seen order. */
function mergeEnums(a: unknown[] | undefined, b: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(a) && !Array.isArray(b)) return undefined
  return dedupeEnum([...(a ?? []), ...(b ?? [])])
}

/** The type a node declares, or one inferred from its shape. */
function effectiveType(node: unknown): string | undefined {
  if (!isPlainObject(node)) return undefined
  const declared = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type
  if (typeof declared === 'string' && KNOWN_TYPES.has(declared)) return declared
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const types = [...new Set(node.enum.filter((v) => v !== null).map(typeOfValue))]
    if (types.length === 1 && KNOWN_TYPES.has(types[0]!)) return types[0]
  }
  if (node.const !== undefined) {
    const type = typeOfValue(node.const)
    if (KNOWN_TYPES.has(type)) return type
  }
  if (isPlainObject(node.properties)) return 'object'
  if (Array.isArray(node.required)) return 'object'
  if (node.items !== undefined) return 'array'
  return undefined
}

/** Pick the branch that carries the most information for one type. */
function pickBranch(branches: readonly JsonSchema[]): JsonSchema {
  const rank = (node: JsonSchema): number => {
    const index = TYPE_PRIORITY.indexOf(effectiveType(node) ?? '')
    return index === -1 ? TYPE_PRIORITY.length : index
  }
  return [...branches].sort((a, b) => rank(a) - rank(b))[0] ?? {}
}

/** Collect `$defs`/`definitions` from the root so `$ref` can be inlined. */
function collectDefs(root: JsonSchema): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {}
  for (const key of ['$defs', 'definitions']) {
    const table = root[key]
    if (isPlainObject(table)) Object.assign(defs, table)
  }
  return defs
}

/** Resolve `#/$defs/Name` (or a JSON pointer under the root) against the defs. */
function resolveRef(ref: unknown, defs: Record<string, JsonSchema>): JsonSchema | undefined {
  if (typeof ref !== 'string') return undefined
  const named = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
  if (named) return defs[named[1]!]
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = { $defs: defs, definitions: defs }
  for (const raw of ref.slice(2).split('/')) {
    if (!isPlainObject(node)) return undefined
    node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return isPlainObject(node) ? (node as JsonSchema) : undefined
}

/** Later schema wins; `properties`, `required` and `enum` merge. */
function deepMerge(base: JsonSchema, patch: JsonSchema | undefined): JsonSchema {
  const out: JsonSchema = { ...clone(base) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'properties' && isPlainObject(value) && isPlainObject(out.properties)) {
      out.properties = { ...out.properties, ...clone(value) } as Record<string, JsonSchema>
      continue
    }
    if (key === 'required' && Array.isArray(value) && Array.isArray(out.required)) {
      out.required = [...new Set([...out.required, ...value])]
      continue
    }
    if (key === 'enum') {
      const merged = mergeEnums(out.enum, value as unknown[])
      if (merged !== undefined) out.enum = merged
      continue
    }
    if (value !== undefined) out[key] = clone(value)
  }
  return out
}

/** Copy a node without the combinators the caller handles. */
function withoutCombinators(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') continue
    out[key] = value
  }
  return out
}

interface Settings {
  itemsFallback: JsonSchema
  nullable: boolean
  maxDepth: number
}

/**
 * Rewrite a JSON Schema so every node declares a `type` and every array
 * declares `items`, without mutating the input.
 *
 * @param schema - the tool's parameter schema
 * @param options - see {@link NormalizeOptions}
 * @returns a new, strict-provider-safe schema
 */
export function normalizeSchema(schema: JsonSchema, options: NormalizeOptions = {}): JsonSchema {
  if (!isPlainObject(schema)) return schema
  const settings: Settings = {
    itemsFallback: isPlainObject(options.itemsFallback) ? clone(options.itemsFallback) : { type: 'string' },
    nullable: options.nullable !== false,
    maxDepth: Number.isInteger(options.maxDepth) && (options.maxDepth as number) > 0 ? (options.maxDepth as number) : 64,
  }
  return walk(schema, collectDefs(schema), settings, new Set<string>(), 0)
}

function walk(
  node: JsonSchema,
  defs: Record<string, JsonSchema>,
  settings: Settings,
  seen: Set<string>,
  depth: number,
): JsonSchema {
  if (!isPlainObject(node)) return node
  if (depth > settings.maxDepth) return { type: 'object', description: '(depth limit reached)' }

  // ---- 1. inline $ref (cycle-safe) ----------------------------------------
  if (typeof node.$ref === 'string') {
    const ref = node.$ref
    const rest: JsonSchema = { ...node }
    delete rest.$ref
    if (seen.has(ref)) {
      return Object.keys(rest).length > 0
        ? walk(rest, defs, settings, seen, depth + 1)
        : { type: 'object', description: '(circular reference)' }
    }
    const target = resolveRef(ref, defs)
    if (target === undefined) {
      return Object.keys(rest).length > 0 ? walk(rest, defs, settings, seen, depth + 1) : { type: 'string' }
    }
    seen.add(ref)
    const merged = walk({ ...clone(target), ...rest }, defs, settings, seen, depth + 1)
    seen.delete(ref)
    return merged
  }

  const source: JsonSchema = { ...node }

  // ---- 2. collapse combinators --------------------------------------------
  let nullable = false
  if (Array.isArray(source.allOf)) {
    const branches = source.allOf
    delete source.allOf
    const merged = branches
      .map((branch) => walk(branch, defs, settings, seen, depth + 1))
      .reduce<JsonSchema>((acc, branch) => deepMerge(acc, branch), {})
    Object.assign(source, deepMerge(merged, withoutCombinators(source)))
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = source[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    delete source[key]
    // Classify BEFORE normalizing: walking a `{ type: 'null' }` branch rewrites
    // it to `{ type: 'string', nullable: true }`, which would hide the null
    // marker and silently drop the union's nullability.
    const nullish = branches.filter((branch) => isNullOnly(branch))
    const nonNull = branches
      .filter((branch) => !isNullOnly(branch))
      .map((branch) => walk(branch, defs, settings, seen, depth + 1))
    if (nullish.length > 0) nullable = true
    if (nonNull.some((branch) => branch.nullable === true)) nullable = true
    if (nonNull.length === 0) {
      Object.assign(source, { type: 'string', description: source.description ?? '(nullable)' })
      continue
    }
    const types = [...new Set(nonNull.map((branch) => effectiveType(branch)).filter(Boolean))]
    const collapsed = types.length <= 1
      ? nonNull.reduce<JsonSchema>((acc, branch) => deepMerge(acc, branch), {})
      : pickBranch(nonNull)
    Object.assign(source, deepMerge(collapsed, withoutCombinators(source)))
  }

  // ---- 3. resolve `type`, and infer one when it is missing ------------------
  let declared: string | undefined
  const rawType = source.type
  if (Array.isArray(rawType)) {
    if (rawType.includes('null')) nullable = true
    declared = rawType.find((entry) => entry !== 'null' && KNOWN_TYPES.has(entry))
  } else if (typeof rawType === 'string') {
    declared = KNOWN_TYPES.has(rawType) ? rawType : undefined
    if (declared === undefined) {
      const lowered = rawType.toLowerCase()
      if (KNOWN_TYPES.has(lowered)) declared = lowered
      if (lowered === 'null') {
        declared = 'string'
        nullable = true
      }
    }
  }
  if (declared === undefined) declared = effectiveType(source)
  if (declared === undefined) declared = isPlainObject(source.properties) ? 'object' : 'string'

  // ---- 4. enum: drop nulls (they become `nullable`) and empty entries ------
  let enumValues: unknown[] | undefined
  if (Array.isArray(source.enum)) {
    if (source.enum.includes(null)) nullable = true
    const kept = dedupeEnum(source.enum.filter((value) => value !== null && !isEmptyEnumEntry(value)))
    if (kept.length > 0) enumValues = kept
  }
  if (source.const !== undefined) {
    // `const` folds into `enum` and must be filtered too: a schema carrying both
    // `enum: [..., '']` and `const: ''` reintroduced the empty entry the enum
    // pass had just removed (real case: task_board_update.permission).
    const constValues = (Array.isArray(source.const) ? source.const : [source.const])
      .filter((value) => value !== null && !isEmptyEnumEntry(value))
    if (source.const === null) nullable = true
    if (constValues.length > 0) enumValues = mergeEnums(enumValues, constValues)
  }
  if (enumValues !== undefined) {
    const enumTypes = [...new Set(enumValues.map(typeOfValue))]
    if (enumTypes.length === 1 && KNOWN_TYPES.has(enumTypes[0]!)) declared = enumTypes[0]
    else if (enumTypes.every((type) => type === 'integer' || type === 'number')) declared = 'number'
    else if (enumTypes.length > 1) declared = 'string'
  }
  if (source.nullable === true) nullable = true

  // ---- 5. rebuild in a canonical, stable key order ------------------------
  const out: JsonSchema = { type: declared }
  if (typeof source.description === 'string' && source.description.length > 0) out.description = source.description
  if (enumValues !== undefined) out.enum = enumValues
  if (typeof source.format === 'string' && source.format.length > 0) out.format = source.format

  if (declared === 'object') {
    const properties = isPlainObject(source.properties) ? source.properties : {}
    const next: Record<string, JsonSchema> = {}
    for (const [key, value] of Object.entries(properties)) {
      next[key] = isPlainObject(value) ? walk(value as JsonSchema, defs, settings, seen, depth + 1) : { type: 'string' }
    }
    // An empty `properties` map is itself rejected by some validators.
    if (Object.keys(next).length > 0) out.properties = next
    if (Array.isArray(source.required)) {
      const names = source.required.filter((name): name is string => typeof name === 'string' && name in next)
      if (names.length > 0) out.required = names
    }
  }
  if (declared === 'array') {
    out.items = source.items === undefined || !isPlainObject(source.items)
      ? clone(settings.itemsFallback)
      : walk(source.items as JsonSchema, defs, settings, seen, depth + 1)
  }

  // Exclusive bounds are unsupported; fold them into the inclusive form.
  for (const [from, to] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    const value = source[from]
    if (typeof value === 'number' && typeof source[to] !== 'number') {
      out[to] = declared === 'integer' ? value + 1 : value
    }
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems']) {
    if (source[key] !== undefined) out[key] = clone(source[key])
  }
  if (nullable && settings.nullable) out.nullable = true

  for (const [key, value] of Object.entries(source)) {
    if (key in out || value === undefined) continue
    if (FORBIDDEN_KEYS.has(key) || !PASSTHROUGH_KEYS.has(key)) continue
    out[key] = clone(value)
  }
  return out
}

/**
 * Report the strict-provider violations left in a schema.
 * Empty array means the schema is safe to send.
 */
export function lintSchema(schema: JsonSchema): string[] {
  const findings: string[] = []
  const visit = (node: unknown, path: string, depth: number): void => {
    if (!isPlainObject(node) || depth > 64) return
    const type = node.type
    if (typeof type !== 'string') findings.push(`${path}: missing type`)
    if (type === 'array' && node.items === undefined) findings.push(`${path}: array missing items`)
    if (Array.isArray(node.enum)) {
      if (node.enum.length === 0) findings.push(`${path}: empty enum`)
      node.enum.forEach((value, index) => {
        if (isEmptyEnumEntry(value)) findings.push(`${path}.enum[${index}]: cannot be empty`)
        else if (typeof type === 'string' && KNOWN_TYPES.has(type)) {
          const actual = typeOfValue(value)
          const compatible = type === 'number' && actual === 'integer'
          if (actual !== type && !compatible) findings.push(`${path}.enum[${index}]: ${actual} does not match type ${type}`)
        }
      })
    }
    if (node.properties !== undefined && !isPlainObject(node.properties)) findings.push(`${path}.properties: not an object`)
    if (typeof node.format === 'string' && node.format.length === 0) findings.push(`${path}.format: cannot be empty`)
    if (isPlainObject(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) visit(value, `${path}.properties.${key}`, depth + 1)
    }
    if (node.items !== undefined) visit(node.items, `${path}.items`, depth + 1)
  }
  visit(schema, '$', 0)
  return findings
}
