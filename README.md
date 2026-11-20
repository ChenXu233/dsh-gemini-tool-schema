# dsh-gemini-tool-schema

> Normalize the tool schemas sent to the model into the **strict OpenAPI 3.0 subset that Gemini's function declarations accept**. A TypeScript plugin for DeepSeek Harness.

[![npm version](https://img.shields.io/npm/v/dsh-gemini-tool-schema.svg)](https://www.npmjs.com/package/dsh-gemini-tool-schema)
[![license](https://img.shields.io/npm/l/dsh-gemini-tool-schema.svg)](LICENSE)
[![ci](https://github.com/ChenXu233/dsh-gemini-tool-schema/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenXu233/dsh-gemini-tool-schema/actions/workflows/ci.yml)

English | [中文](README.zh.md)

## The problem

Strict providers accept only a *subset* of JSON Schema. Google Gemini's `functionDeclarations[].parameters` rejects the **whole request** (HTTP 400) when:

| Real error | Offending schema | Source |
| --- | --- | --- |
| `schema didn't specify the schema type field` | `{ anyOf: [{type:'string',…}, {type:'null'}] }` — no `type` | Playwright MCP `browser_emulate_media.colorScheme` (`z.string().nullable()`) |
| `properties[v_types].items: missing field` | `{ type: 'array' }` — no `items` | Lingshu MCP `lingshu_cg` / `lingshu_stg` (19 params) |
| `properties[permission].enum[3]: cannot be empty` | `enum: [..., '']` | DSH built-in `task_board_update.permission` |

All three are legal elsewhere, which is why the failure only shows up on a Gemini-flavoured route.

## Why a Harness hook

An MCP proxy only reaches the servers it wraps. Built-in tools and tools registered by other plugins never cross an MCP transport, so normalizing at Harness assembly time is the only fix that covers **every** tool at once.

## Tool-call replay repair (v0.4.0)

> Symptom: the second step of any tool-using turn fails outright with `400 Function call is missing a thought_signature in functionCall parts`.

A Gemini reasoning model stamps every `functionCall` with an encrypted `thoughtSignature` and rejects the whole request when a replayed call lost it. Native Google transports carry it for you. On an OpenAI-compatible relay the single legal carrier is `tool_calls[].extra_content.google.thought_signature` — and **many relays drop it**, streaming and non-streaming alike.

The plugin therefore:

1. **captures** a signature whenever the relay does send one (SSE or JSON), keyed by tool-call id;
2. **re-attaches** it to `tool_calls[]` on the next request that replays that call id;
3. **degrades** when nothing was captured: the exchange is flattened into assistant text plus a user-role result, the one history shape such an upstream still accepts.

This lives in the **transport layer** (a shim around `globalThis.fetch`), not in a hook: the agent loop freezes `GenerateOptions` and every message in it before dispatch, so no `llm/stream` listener can rewrite history — but pi-ai builds its client per request and reads the global fetch then. Bodies are only touched when the URL is `*/chat/completions` and the model matches `signatures.models`, so a native `generateContent` route is never affected.

```yaml
- insert:
    - id: gemini-tool-schema
      name: dsh-gemini-tool-schema
      config:
        signatures:
          mode: auto
          store: ~/.dsh/gemini-tool-signatures.json
```

| Field | Default | Meaning |
| --- | --- | --- |
| `signatures.mode` | `auto` | `auto` attach captured signatures, flatten the rest · `flatten` always flatten · `off` leave requests alone |
| `signatures.models` | `['gemini','google','vertex']` | Model-name patterns, **compiled as regular expressions** |
| `signatures.urls` | `[]` | Extra chat-completions URL patterns for nonstandard relay paths |
| `signatures.store` | none (memory only) | JSON path so captured signatures survive a restart |

**This is not the root fix.** The real fix belongs in the relay: forward `extra_content.google.thought_signature` untouched so a client has something to replay. The plugin only keeps a signature-less relay working, at the cost of replaying that exchange as text instead of a real `functionCall`.

## Install

```sh
git clone https://github.com/ChenXu233/dsh-gemini-tool-schema.git
cd dsh-gemini-tool-schema && npm install && npm run build
```

Append to `<DSH home>/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: gemini-tool-schema
      name: '/absolute/path/to/dsh-gemini-tool-schema/dist/index.js'
      config:
        mode: list
        apis: ['gemini', 'google', 'vertex']
```

Or `npm install dsh-gemini-tool-schema` and mount it by package name.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `list` | `all` every request · `list` matching APIs only · `off` disabled |
| `apis` | `['gemini','google','vertex']` | API patterns, **compiled as regular expressions** |
| `unknownApi` | `apply` | When the route cannot be read: `apply` or `skip` |
| `itemsFallback` | `{type:'string'}` | Element schema for arrays that omit `items` |
| `nullable` | `true` | Emit `nullable: true` for null unions |
| `dryRun` | `false` | Report and lint, but send the original schemas |
| `logFile` / `logLevel` | none / `info` | One diagnostic line per assembly |
| `dumpDir` / `dumpSchemas` | none / `true` | Dump the model-facing tool set for offline auditing |

Patterns match against `provider/model` (e.g. `gemini-lumiya/gemini-4-argon`) and accept substring, regex, and `/pattern/flags` forms; an entry that does not compile degrades to a case-insensitive substring match. `'*'` matches everything, or set `mode: all`.

## Rules

Every node gets a `type`; every array gets `items`; `enum` entries are never empty (and `const` cannot reintroduce one); `$ref`/`$defs` are inlined cycle-safely; unsupported keywords are stripped and the remaining scalars pass an allow-list; `required` is narrowed to real properties.

## Development

```sh
npm test        # Node ≥22.6 runs the TS tests directly — 36 tests
npm run build   # tsc → dist/
```

## License

MIT © 2026 ChenXu233
