# dsh-tool-schema-compat

> A DeepSeek Harness plugin that normalizes the tool schemas sent to the model, so a single stray field stops breaking a whole request on strict function-calling providers (Gemini in particular).

English | [中文](README.zh.md)

## The problem

Strict providers accept only an OpenAPI-3.0-flavored subset of JSON Schema. Google Gemini's `functionDeclarations[].parameters` is the strictest common case and rejects the **entire request** (HTTP 400) when:

| Real error | Offending schema | Source |
| --- | --- | --- |
| `functionDeclaration ... schema didn't specify the schema type field` | `{ anyOf: [{type:'string',enum:[...]}, {type:'null'}] }` — no `type` | Playwright MCP `browser_emulate_media.colorScheme` (from `z.string().nullable()`) |
| `...properties[v_types].items: missing field` | `{ type: 'array' }` — no `items` | Lingshu MCP (`lingshu_cg`: 17 params, `lingshu_stg`: 2) |

Both are perfectly legal everywhere else, which is why the failure only appears once you route through Gemini.

## Why a Harness hook instead of an MCP proxy

An MCP proxy can only reach the servers it wraps. Built-in tools and tools registered by other plugins never cross an MCP transport, so a proxy cannot fix them. Normalizing at Harness assembly time fixes **every** tool at once.

## How it works

Each agent step assembles `PromptAssembly { sections, contexts, tools, variables }`; that `tools` array goes straight into the provider request. The plugin hooks the `system-prompt/assemble` waterfall and returns a rewritten assembly:

```js
ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
  const assembly = await next()   // let downstream (model selection) finish first
  return { ...assembly, tools: normalized }
}, { prepend: true })
```

Pure plugin, no core patching; registrations unwind with the plugin; the transform is pure, idempotent and deterministic, so it does not churn the request header or the prompt cache.

## Install

Append to `<DSH home>/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: tool-schema-compat
      name: '/absolute/path/to/dsh-tool-schema-compat/src/index.mjs'
      config:
        mode: match
        match: [gemini, google, vertex]
        logFile: '/absolute/path/to/.dsh/logs/tool-schema-compat.log'
```

Or install the package into the profile and mount it by name.

### Hot reload caveats (measured on DSH 44.0.0)

Config HMR re-mounts the plugin, but Node never re-evaluates an already-imported
file URL — edited code keeps running until you point `name:` at a **new path
and change the row `id`** (a `name` change alone does not reload), or restart.

## Config

`mode` (`match`|`always`|`off`), `match` (substrings), `unknownRoute` (`apply`|`skip`), `itemsFallback`, `nullable`, `dryRun`, `logFile`, `logLevel`. See [README.zh.md](README.zh.md) for the full table.

## Rules

Every node gets a `type`; every array gets `items`; `$ref`/`$defs` are inlined (cycle-safe); keywords strict providers reject are stripped; `required` is narrowed to real properties; exclusive bounds are folded in.

## Test

```sh
node --test test/normalize.test.mjs
```

13 tests, including one over the **82 real MCP tools** cached on this machine: violations before, zero after.

## License

MIT © 2026 ChenXu233
