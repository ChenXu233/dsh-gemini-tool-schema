import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name } from '../src/index.mjs';

/** Mount the plugin on a mock cordis context and capture its listener. */
function mount(config) {
  const listeners = new Map();
  const ctx = { on: (event, handler, options) => { listeners.set(event, { handler, options }); } };
  apply(ctx, config);
  return { listeners, handler: listeners.get('system-prompt/assemble') };
}

const brokenTool = {
  name: 'browser_emulate_media',
  parameters: {
    type: 'object',
    properties: {
      colorScheme: { anyOf: [{ type: 'string', enum: ['light', 'dark'] }, { type: 'null' }] },
      tags: { type: 'array' },
    },
  },
};

test('plugin exports a name and registers the assemble waterfall as prepend', () => {
  const { handler } = mount({ mode: 'always' });
  assert.equal(name, 'tool-schema-compat');
  assert.equal(handler.options.prepend, true);
});

test('a matched route is normalized end to end', async () => {
  const { handler } = mount({ mode: 'always' });
  const assembly = { tools: [brokenTool], variables: {}, sections: [], contexts: [] };
  const out = await handler.handler(assembly, {}, async () => assembly);
  assert.equal(out.tools[0].parameters.properties.colorScheme.type, 'string');
  assert.equal(out.tools[0].parameters.properties.colorScheme.nullable, true);
  assert.deepEqual(out.tools[0].parameters.properties.tags.items, { type: 'string' });
  assert.notEqual(out.tools[0], assembly.tools[0], 'tools must be replaced, not mutated');
});

test('a non-matching route is left untouched', async () => {
  const { handler } = mount({ mode: 'match', match: ['gemini'] });
  const assembly = { tools: [brokenTool], variables: { provider: 'openrouter', model: 'deepseek' } };
  const out = await handler.handler(assembly, {}, async () => assembly);
  assert.equal(out, assembly, 'the same assembly object should pass through');
});

test('an unknown route follows unknownRoute', async () => {
  const skip = mount({ mode: 'match', match: ['gemini'], unknownRoute: 'skip' });
  const assembly = { tools: [brokenTool], variables: {} };
  assert.equal(await skip.handler.handler(assembly, {}, async () => assembly), assembly);
  const applyIt = mount({ mode: 'match', match: ['gemini'], unknownRoute: 'apply' });
  const out = await applyIt.handler.handler(assembly, {}, async () => assembly);
  assert.equal(out.tools[0].parameters.properties.tags.items.type, 'string');
});

test('dryRun reports but sends the original schemas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-'));
  const logFile = join(dir, 'log.txt');
  const { handler } = mount({ mode: 'always', dryRun: true, logFile });
  const assembly = { tools: [brokenTool], variables: {} };
  const out = await handler.handler(assembly, {}, async () => assembly);
  assert.equal(out.tools[0], brokenTool);
  assert.match(readFileSync(logFile, 'utf8'), /changed=1/);
});

test('dumpDir writes the model-facing tool set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-dump-'));
  const { handler } = mount({ mode: 'always', dumpDir: dir });
  const assembly = { tools: [brokenTool], variables: { provider: 'gemini-lumiya', model: 'gemini-4-argon' } };
  await handler.handler(assembly, {}, async () => assembly);
  assert.ok(existsSync(join(dir)));
});

test('a throwing tool does not break the request', async () => {
  const { handler } = mount({ mode: 'always' });
  const assembly = { tools: [brokenTool, { name: 'hostile', parameters: 1 }], variables: {} };
  const out = await handler.handler(assembly, {}, async () => assembly);
  assert.equal(out.tools.length, 2);
});

test('invalid config fails fast', () => {
  for (const bad of [{ mode: 'nope' }, { unknownRoute: 'nope' }, { match: 'gemini' }, { logLevel: 'nope' }]) {
    assert.throws(() => apply({ on: () => {} }, bad), /tool-schema-compat/);
  }
});
