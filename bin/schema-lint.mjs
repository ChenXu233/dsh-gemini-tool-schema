#!/usr/bin/env node
/**
 * tool-schema-lint — report (and optionally fix) JSON Schemas that strict
 * function-calling providers reject.
 *
 * Usage:
 *   tool-schema-lint schema.json
 *   tool-schema-lint --fix schema.json
 *   cat schema.json | tool-schema-lint -
 */

import { readFileSync } from 'node:fs';
import { normalizeSchema, lintSchema } from '../src/normalize.mjs';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const target = args.find((arg) => !arg.startsWith('--'));

if (target === undefined) {
  console.error('usage: tool-schema-lint [--fix] <schema.json|->');
  process.exit(2);
}

const raw = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
let schema;
try {
  schema = JSON.parse(raw);
} catch (error) {
  console.error('invalid JSON: ' + error.message);
  process.exit(2);
}

// Accept a bare schema, a tool wrapper, or an MCP tools/list result.
const tools = Array.isArray(schema?.tools) ? schema.tools : [schema];

if (fix) {
  const fixed = tools.map((tool) => {
    if (tool?.inputSchema !== undefined) return { ...tool, inputSchema: normalizeSchema(tool.inputSchema) };
    if (tool?.parameters !== undefined) return { ...tool, parameters: normalizeSchema(tool.parameters) };
    return normalizeSchema(tool);
  });
  process.stdout.write(JSON.stringify(Array.isArray(schema?.tools) ? { ...schema, tools: fixed } : fixed[0], null, 2) + '\n');
  process.exit(0);
}

let findings = 0;
for (const tool of tools) {
  const schemaNode = tool?.inputSchema ?? tool?.parameters ?? tool;
  const name = typeof tool?.name === 'string' ? tool.name : '(schema)';
  for (const finding of lintSchema(schemaNode)) {
    findings += 1;
    console.log(name + finding);
  }
}
if (findings === 0) console.log('ok — no provider-strictness violations found');
process.exit(findings === 0 ? 0 : 1);
