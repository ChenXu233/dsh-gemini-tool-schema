/**
 * Tool JSON Schema normalization for strict function-calling providers.
 *
 * Many providers accept only an OpenAPI-3.0-flavored subset of JSON Schema.
 * Google's Gemini `functionDeclarations[].parameters` is the strictest common
 * case and rejects a whole request (HTTP 400) when:
 *
 *   - a schema node carries no `type` (e.g. a bare `anyOf` produced by
 *     `z.string().nullable()`), or
 *   - an array node carries no `items`.
 *
 * Real-world offenders: Playwright MCP (`browser_emulate_media.colorScheme`)
 * and the Lingshu/cognitive-graph MCP server (`lingshu_cg`, `lingshu_stg`).
 *
 * This module is dependency-free, pure and deterministic: normalizing twice
 * yields a deep-equal result, so a per-step hook does not churn the request
 * header or the prompt cache.
 *
 * @module normalize
 */

/** Keys no strict provider accepts, or that this module rewrites itself. */
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
]);

/** Inferred-type preference when a union has several non-null branches. */
const TYPE_PRIORITY = ['object', 'array', 'string', 'number', 'integer', 'boolean'];

const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** @typedef {Record<string, any>} JsonSchema */

/** Deep clone that tolerates deep-frozen input (assemblies are frozen). */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clone(item);
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The JSON type name of a literal value, in schema vocabulary. */
function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(value) ? 'integer' : 'number';
    default: return 'object';
  }
}

/** Does this schema node describe only `null`? */
function isNullOnly(node) {
  if (!isPlainObject(node)) return false;
  if (node.type === 'null') return true;
  if (Array.isArray(node.type) && node.type.length > 0 && node.type.every((t) => t === 'null')) return true;
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => v === null)) return true;
  if (node.const === null && node.type === undefined) return true;
  return false;
}

/** Collect `$defs`/`definitions` from the root so `$ref` can be inlined. */
function collectDefs(root) {
  const defs = {};
  for (const key of ['$defs', 'definitions']) {
    if (isPlainObject(root?.[key])) Object.assign(defs, root[key]);
  }
  return defs;
}

/** Resolve `#/$defs/Name` (and `#/definitions/Name`) against the collected defs. */
function resolveRef(ref, defs) {
  if (typeof ref !== 'string') return undefined;
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (match) return defs[match[1]];
  if (ref.startsWith('#/')) {
    let node = { $defs: defs, definitions: defs };
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isPlainObject(node)) return undefined;
      node = node[key];
    }
    return node;
  }
  return undefined;
}

/** A strict provider rejects an empty enum entry; `''` is the common case. */
function isEmptyEnumEntry(value) {
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Drop duplicate enum entries, keeping first-seen order. */
function dedupeEnum(values) {
  const out = [];
  for (const value of values) {
    if (!out.some((existing) => JSON.stringify(existing) === JSON.stringify(value))) out.push(clone(value));
  }
  return out;
}

/** Union of two `enum` arrays, keeping first-seen order; undefined when neither has one. */
function mergeEnums(a, b) {
  if (!Array.isArray(a) && !Array.isArray(b)) return undefined;
  const out = [];
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!out.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) out.push(clone(item));
  }
  return out;
}

/** Pick the branch that carries the most information for a single `type`. */
function pickBranch(branches) {
  const ranked = [...branches].sort((a, b) => {
    const ai = TYPE_PRIORITY.indexOf(effectiveType(a));
    const bi = TYPE_PRIORITY.indexOf(effectiveType(b));
    return (ai === -1 ? TYPE_PRIORITY.length : ai) - (bi === -1 ? TYPE_PRIORITY.length : bi);
  });
  return ranked[0] ?? {};
}

/** The type a node declares, or a type inferred from its shape. */
function effectiveType(node) {
  if (!isPlainObject(node)) return undefined;
  const declared = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  if (KNOWN_TYPES.has(declared)) return declared;
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const types = [...new Set(node.enum.filter((v) => v !== null).map(typeOfValue))];
    if (types.length === 1 && KNOWN_TYPES.has(types[0])) return types[0];
  }
  if (node.const !== undefined) {
    const type = typeOfValue(node.const);
    if (KNOWN_TYPES.has(type)) return type;
  }
  if (isPlainObject(node.properties)) return 'object';
  if (Array.isArray(node.required)) return 'object';
  if (node.items !== undefined) return 'array';
  return undefined;
}

/**
 * Rewrite a JSON Schema so every node declares a `type` and every array
 * declares `items`, without mutating the input.
 *
 * @param {JsonSchema} schema
 * @param {object} [options]
 * @param {JsonSchema} [options.itemsFallback] schema used when an array omits `items`
 * @param {boolean} [options.nullable] emit `nullable: true` for null-unions (default true)
 * @param {number} [options.maxDepth] recursion guard (default 64)
 * @returns {JsonSchema} a new, normalized schema
 */
export function normalizeSchema(schema, options = {}) {
  const settings = {
    itemsFallback: isPlainObject(options.itemsFallback) ? clone(options.itemsFallback) : { type: 'string' },
    nullable: options.nullable !== false,
    maxDepth: Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : 64,
  };
  if (!isPlainObject(schema)) return schema;
  const defs = collectDefs(schema);
  return walk(schema, defs, settings, new Set(), 0);
}

function walk(node, defs, settings, seen, depth) {
  if (!isPlainObject(node)) return node;
  if (depth > settings.maxDepth) return { type: 'object', description: '(depth limit reached)' };

  // ---- 1. $ref resolution (inline, cycle-safe) -------------------------------
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    const rest = { ...node };
    delete rest.$ref;
    if (seen.has(ref)) {
      return Object.keys(rest).length > 0 ? walk(rest, defs, settings, seen, depth + 1) : { type: 'object', description: '(circular reference)' };
    }
    const target = resolveRef(ref, defs);
    if (target !== undefined && mergeEnums(rest, target) !== undefined) { /* keep types aligned below */ }
    if (target === undefined) {
      return Object.keys(rest).length > 0 ? walk(rest, defs, settings, seen, depth + 1) : { type: 'string' };
    }
    seen.add(ref);
    const merged = walk({ ...clone(target), ...rest }, defs, settings, seen, depth + 1);
    seen.delete(ref);
    return merged;
  }

  const source = { ...node };

  // ---- 2. combinators -------------------------------------------------------
  let nullable = false;
  const allOf = Array.isArray(source.allOf) ? source.allOf : undefined;
  if (allOf) {
    delete source.allOf;
    const merged = allOf.map((branch) => walk(branch, defs, settings, seen, depth + 1));
    const combined = merged.reduce((acc, branch) => deepMerge(acc, branch), {});
    Object.assign(source, deepMerge(combined, stripCombinators(source)));
  }
  for (const key of ['anyOf', 'oneOf']) {
    const branches = source[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    delete source[key];
    const resolved = branches.map((branch) => walk(branch, defs, settings, seen, depth + 1));
    const nullish = resolved.filter(isNullOnly);
    const nonNull = resolved.filter((branch) => !isNullOnly(branch));
    if (nullish.length > 0) nullable = true;
    if (nonNull.length === 0) {
      Object.assign(source, { type: 'string', description: source.description ?? '(nullable)' });
      continue;
    }
    const types = [...new Set(nonNull.map(effectiveType).filter(Boolean))];
    if (nonNull.length === 1 || types.length <= 1) {
      const merged = nonNull.reduce((acc, branch) => deepMerge(acc, branch), {});
      Object.assign(source, deepMerge(merged, stripCombinators(source)));
    } else {
      Object.assign(source, deepMerge(pickBranch(nonNull), stripCombinators(source)));
    }
  }

  // ---- 3. `type` as an array, and inference --------------------------------
  let declared = source.type;
  if (Array.isArray(declared)) {
    if (declared.includes('null')) nullable = true;
    const concrete = declared.find((entry) => entry !== 'null' && KNOWN_TYPES.has(entry));
    if (concrete === undefined) {
      declared = 'string';
    } else {
      declared = concrete;
    }
  }
  if (typeof declared === 'string' && !KNOWN_TYPES.has(declared)) {
    const lowered = declared.toLowerCase();
    declared = KNOWN_TYPES.has(lowered) ? lowered : undefined;
    if (declared === undefined && lowered === 'null') { declared = 'string'; nullable = true; }
  }
  if (declared === undefined) declared = effectiveType(source);
  if (declared === undefined) declared = isPlainObject(source.properties) ? 'object' : 'string';

  // `null`-typed enum entries are expressed as `nullable`, not as values, and
  // strict providers reject an empty entry outright (`enum[3]: cannot be empty`,
  // e.g. `permission?: "read-only" | "workspace-write" | "danger-full-access" | ""`).
  let enumValues;
  if (Array.isArray(source.enum)) {
    if (source.enum.includes(null)) nullable = true;
    enumValues = dedupeEnum(source.enum.filter((value) => value !== null && !isEmptyEnumEntry(value)));
    if (enumValues.length === 0) enumValues = undefined;
  }
  if (source.const !== undefined) {
    const constValues = Array.isArray(source.const) ? source.const : [source.const];
    enumValues = mergeEnums(enumValues, constValues);
    nullable = nullable || source.const === null;
  }
  if (enumValues !== undefined) {
    const enumTypes = [...new Set(enumValues.map(typeOfValue))];
    if (enumTypes.length === 1 && KNOWN_TYPES.has(enumTypes[0])) declared = enumTypes[0];
    else if (enumTypes.includes('integer') && enumTypes.every((t) => t === 'integer' || t === 'number')) declared = 'number';
    else if (enumTypes.length > 1) declared = 'string'; // heterogeneous enums are stringified by strict providers
  }

  // ---- 4. rebuild the node in a canonical, stable key order -----------------
  const out = { type: declared };
  if (typeof source.description === 'string' && source.description.length > 0) out.description = source.description;
  if (enumValues !== undefined) out.enum = enumValues;
  if (typeof source.format === 'string' && source.format.length > 0) out.format = source.format;
  if (declared === 'object') {
    const properties = isPlainObject(source.properties) ? source.properties : {};
    const next = {};
    for (const [key, value] of Object.entries(properties)) {
      next[key] = isPlainObject(value) ? walk(value, defs, settings, seen, depth + 1) : { type: 'string' };
    }
    // An empty `properties` map is itself rejected by some validators.
    if (Object.keys(next).length > 0) out.properties = next;
    if (Array.isArray(source.required)) {
      const names = source.required.filter((name) => typeof name === 'string' && Object.hasOwn(next, name));
      if (names.length > 0) out.required = names;
    }
  }
  if (declared === 'array') {
    out.items = source.items === undefined || !isPlainObject(source.items)
      ? clone(settings.itemsFallback)
      : walk(source.items, defs, settings, seen, depth + 1);
  }
  if (declared === 'array' && isPlainObject(settings.itemsFallback) && source.items === undefined) {
    // nothing further: fallback already assigned above
  }
  // Numeric bounds: strict providers drop the exclusive forms, so fold them in.
  for (const [from, to] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    const value = source[from];
    if (typeof value === 'number' && typeof source[to] !== 'number') out[to] = declared === 'integer' ? value + 1 : value;
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems']) {
    if (source[key] !== undefined) out[key] = clone(source[key]);
  }
  if (nullable && settings.nullable) out.nullable = true;

  // ---- 5. carry over any remaining provider-safe keys -----------------------
  for (const [key, value] of Object.entries(source)) {
    if (key in out || FORBIDDEN_KEYS.has(key)) continue;
    if (key === 'type' || key === 'properties' || key === 'required' || key === 'items' || key === 'enum') continue;
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') continue;
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') continue;
    if (value === undefined) continue;
    if (isPlainObject(value) || Array.isArray(value)) continue; // no unknown structural keywords
    out[key] = clone(value);
  }
  return out;
}

/** Copy a node's keys without the combinators handled by the caller. */
function stripCombinators(node) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') continue;
    out[key] = value;
  }
  return out;
}

/** Shallow merge where the later schema wins; `properties`/`required` merge. */
function deepMerge(base, patch) {
  const out = { ...clone(base) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'properties' && isPlainObject(value) && isPlainObject(out.properties)) {
      out.properties = { ...out.properties, ...clone(value) };
      continue;
    }
    if (key === 'required' && Array.isArray(value) && Array.isArray(out.required)) {
      out.required = [...new Set([...out.required, ...value])];
      continue;
    }
    if (key === 'enum') {
      const merged = mergeEnums(out.enum, value);
      if (merged !== undefined) out.enum = merged;
      continue;
    }
    if (value !== undefined) out[key] = clone(value);
  }
  return out;
}

/**
 * Report the provider-strictness violations left in a schema.
 * @param {JsonSchema} schema
 * @returns {string[]} human-readable findings, empty when clean
 */
export function lintSchema(schema) {
  const findings = [];
  const visit = (node, path, depth) => {
    if (!isPlainObject(node) || depth > 64) return;
    if (typeof node.type !== 'string') findings.push(path + ': missing type');
    if (node.type === 'array' && node.items === undefined) findings.push(path + ': array missing items');
    if (Array.isArray(node.enum)) {
      if (node.enum.length === 0) findings.push(path + ': empty enum');
      node.enum.forEach((value, index) => {
        if (isEmptyEnumEntry(value)) findings.push(path + '.enum[' + index + ']: cannot be empty');
        else if (typeof node.type === 'string' && KNOWN_TYPES.has(node.type) && typeOfValue(value) !== node.type) {
          const compatible = node.type === 'number' && typeOfValue(value) === 'integer';
          if (!compatible) findings.push(path + '.enum[' + index + ']: ' + typeOfValue(value) + ' does not match type ' + node.type);
        }
      });
    }
    if (node.properties !== undefined && !isPlainObject(node.properties)) findings.push(path + '.properties: not an object');
    if (typeof node.format === 'string' && node.format.length === 0) findings.push(path + '.format: cannot be empty');
    if (node.type === 'object' && Array.isArray(node.required) && isPlainObject(node.properties)) {
      for (const name of node.required) {
        if (!Object.hasOwn(node.properties, name)) findings.push(path + '.required: "' + name + '" is not a property');
      }
    }
    if (isPlainObject(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) visit(value, path + '.properties.' + key, depth + 1);
    }
    if (node.items !== undefined) visit(node.items, path + '.items', depth + 1);
  };
  visit(schema, '$', 0);
  return findings;
}

export { FORBIDDEN_KEYS };
