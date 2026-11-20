# dsh-gemini-tool-schema

> 把发给模型的工具 schema 归一化成 **Gemini function declaration 能接受的 OpenAPI 3.0 子集**。
> 一个 DeepSeek Harness 插件（TypeScript）。

[![npm version](https://img.shields.io/npm/v/dsh-gemini-tool-schema.svg)](https://www.npmjs.com/package/dsh-gemini-tool-schema)
[![license](https://img.shields.io/npm/l/dsh-gemini-tool-schema.svg)](LICENSE)
[![ci](https://github.com/ChenXu233/dsh-gemini-tool-schema/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenXu233/dsh-gemini-tool-schema/actions/workflows/ci.yml)

[English](README.md) | 中文

## 它解决什么

严格 provider 只吃 OpenAPI 3.0 风味的 JSON Schema **子集**。Gemini 的 `functionDeclarations[].parameters` 是其中最严的：遇到下面三种写法会**拒掉整个请求**（HTTP 400），哪怕这一轮根本不会调用那个工具。

| 真实报错 | 肇事 schema | 来源 |
| --- | --- | --- |
| `schema didn't specify the schema type field` | `{ anyOf: [{type:'string',…}, {type:'null'}] }` —— 节点没有 `type` | Playwright MCP `browser_emulate_media.colorScheme`（`z.string().nullable()`） |
| `properties[v_types].items: missing field` | `{ type: 'array' }` —— 数组没有 `items` | 灵枢 MCP `lingshu_cg` / `lingshu_stg`（19 个参数） |
| `properties[permission].enum[3]: cannot be empty` | `enum: [..., '']` 里含空串 | DSH 内置 `task_board_update.permission` |

这些写法在 OpenAI / Anthropic 系路由上完全合法 —— 所以问题只在切到 Gemini 系路由时暴露。

## 为什么做在 Harness 里

MCP 代理只能拦到它自己启动的 server；**DSH 内置工具、其他插件注册的工具根本不走 MCP 通道**。做在 Harness 的组装层，才是"一处修、全部生效"。

## 原理

DSH 每个 step 会组装 `PromptAssembly { sections, contexts, tools, variables }`，其中的 `tools` 直接进入 provider 请求。本插件挂 `system-prompt/assemble` waterfall：

```ts
ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
  const assembly = await next()          // 先让下游（含模型选择）跑完
  // 只对匹配到的 API 生效，改写每个 tool.parameters
  return { ...assembly, tools: normalized }
}, { prepend: true })
```

- 不改请求管线、不 patch 任何核心代码，纯插件；
- 注册即 effect，插件卸载时自动清理；
- 纯函数、**幂等且确定性** —— 反复归一化不会让工具头或 prompt 缓存抖动；
- 单个工具的归一化抛错只影响它自己，绝不连累整个请求。

## 工具调用回放修复（v0.4.0）

> 症状：多轮工具调用的第二步直接 400 —— `Function call is missing a thought_signature in functionCall parts`。

Gemini 推理模型给每个 `functionCall` 配一段加密的 `thoughtSignature`，下一轮必须原样带回，少了就整包拒收。原生 Google 传输会替我们带上；走 OpenAI 兼容的中转（new-api 类网关、部分 OpenRouter 路由）只有一个合法载体 `tool_calls[].extra_content.google.thought_signature`，而**不少中转会把它吞掉** —— 实测某些网关的流式和非流式响应里都根本没有这个字段。

插件做三件事：

1. **捕获**：只要中转把签名发回来（流式 SSE 或非流式 JSON），就按 tool-call id 存起来。
2. **回填**：下次请求遇到同一 call id，把 `extra_content.google.thought_signature` 补回 `tool_calls[]`。
3. **降级**：一个签名都拿不到时，把这次工具交换摊平成文本（assistant 叙述 + user 角色的结果），这是上游唯一还接受的形状。

实现落在 **transport 层**（包一层 `globalThis.fetch`），不是 hook：agent loop 在分发前把 `GenerateOptions` 和每条 message 都 `Object.freeze` 了，任何 `llm/stream` listener 都改不动历史，而 pi-ai 每次请求现建客户端、现取全局 fetch，正好留了这个缝。命中条件是 `*/chat/completions` + 模型名匹配 `signatures.models`，所以原生 `generateContent` 路由完全不受影响。

```yaml
- insert:
    - id: gemini-tool-schema
      name: dsh-gemini-tool-schema
      config:
        signatures:
          mode: auto
          store: ~/.dsh/gemini-tool-signatures.json
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `signatures.mode` | `auto` | `auto` 有签名就回填、没有就摊平；`flatten` 一律摊平；`off` 不动任何请求 |
| `signatures.models` | `['gemini','google','vertex']` | 模型名的**正则**列表，命中才处理 |
| `signatures.urls` | `[]` | 额外的 chat 端点正则（中转路径不标准时用） |
| `signatures.store` | 无（仅内存） | 签名 JSON 落盘路径，重启后仍能精确回放 |

**这不是治本。** 真正的修复在中转侧：让网关把 `extra_content.google.thought_signature` 原样透传出去，客户端才有东西可回填。插件只是让签名缺席时仍能跑通，代价是那一段历史从真实 `functionCall` 降级成文本。

## 安装

### 从源码（本地开发）

```sh
git clone https://github.com/ChenXu233/dsh-gemini-tool-schema.git
cd dsh-gemini-tool-schema
npm install && npm run build      # 产出 dist/
```

然后把下面这段追加到 `<DSH home>/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: gemini-tool-schema
      name: '/absolute/path/to/dsh-gemini-tool-schema/dist/index.js'
      config:
        mode: list
        apis: ['gemini', 'google', 'vertex']
        logFile: '/absolute/path/to/.dsh/logs/gemini-tool-schema.log'
```

### 从 npm

```sh
npm install dsh-gemini-tool-schema   # https://www.npmjs.com/package/dsh-gemini-tool-schema
```

装进 profile 后按包名挂载（`name: dsh-gemini-tool-schema`）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `list` | `all` 处理所有请求；`list` 只处理匹配的 API；`off` 关闭 |
| `apis` | `['gemini','google','vertex']` | **按正则解析**的 API 列表，见下 |
| `unknownApi` | `apply` | 读不到路由时：`apply` 照常处理，`skip` 跳过 |
| `itemsFallback` | `{type:'string'}` | 数组缺 `items` 时补的元素 schema |
| `nullable` | `true` | null 联合是否落成 `nullable: true` |
| `dryRun` | `false` | 只统计和 lint，实际发送原 schema |
| `logFile` | 无 | 每次组装追加一行诊断 |
| `logLevel` | `info` | `silent` / `info` / `debug`（debug 记录被跳过的 API 和工具名） |
| `dumpDir` | 无 | 命中的组装把完整工具集落盘，便于离线审计 |
| `dumpSchemas` | `true` | 转储是否包含完整 schema（false 只落工具名） |

### `apis`：全部 API 还是指定 API

匹配对象是 **`provider/model`** 拼成的字符串（例如 `gemini-lumiya/gemini-4-argon`）。每个条目都**按正则编译**（默认大小写不敏感），写错了也不会在加载时炸 —— 会退化成子串匹配。

```yaml
config:
  mode: list
  apis:
    - gemini                       # 子串 / 正则都行：匹配任何含 gemini 的路由
    - '^openrouter/'               # 锚定 provider 前缀
    - '/gemini-4-argon$/i'         # /pattern/flags 形式，完全自定义
    - '*'                          # 全部 API（等价于 mode: all）
```

想**全部 API** 生效就直接 `mode: all`（会忽略 `apis`）。

## 归一化规则

- **每个节点必须有 `type`**：`anyOf`/`oneOf` 折叠成单类型；含 null 分支时置 `nullable`（先分类再归一化，null 语义不会丢）；`type: ['array','null']` 展平；缺 `type` 时按形状推断。
- **数组必须有 `items`**：缺失时补 `itemsFallback`。
- **`enum` 不能有空项**：`''`、空数组、空对象会被丢弃；整条 enum 都为空就删掉它。`const` 折进 `enum` 时也走同一份过滤（`enum+const` 不会再漏回空串）。
- **`$ref`/`$defs` 内联**，循环引用安全终止。
- **剥离严格 provider 不接受的关键字**：`$schema`、`additionalProperties`、`if/then/else`、`not`、`prefixItems`、`title` 等；剩余键走**白名单**透传，未知关键字不会漏进请求。
- **`required` 只保留真实存在的属性**；`exclusiveMinimum/Maximum` 折算成 `minimum/maximum`。

## 开发

```sh
npm test        # Node ≥22.6 直接跑 TS（类型剥离），36 项测试
npm run build   # tsc → dist/
npm run check   # 只做类型检查
```

测试里有一项不是玩具数据：拿本机 MCP 连接器缓存里的**全部真实工具**跑一遍，归一化前有违规、归一化后 **0 违规**。

## 热更新注意（DSH 44.0.0 实测）

1. **配置改动**（`cordis.patch.yml`）会自动重挂载插件，几秒生效。
2. **代码改动不会自动生效**：Node 不会重新求值同一个文件 URL；而且只改 `name:` 路径也不触发，**必须改行 `id`** 才会被 loader 当成新条目重新 `import`。

所以本机开发时：构建到新路径（如 `dist-v2/`）并同时改 `id` 和 `name`；稳定部署则固定 `id`、改完代码重启一次 app。

## 与已有项目的关系

| 项目 | 形态 | 覆盖 |
| --- | --- | --- |
| [@luutuankiet/gemini-mcp](https://github.com/luutuankiet/gemini-mcp) | MCP 代理 | `$ref`/`$defs`/`anyOf`，**不补 `items`**；够不到 Harness 内置工具 |
| [aeewws/tool-schema-fixer](https://github.com/aeewws/tool-schema-fixer) | 离线 CLI | 需要人工改文件，不接运行时 |
| **本项目** | Harness 插件（hook） | 上述三类缺陷 + 内置/MCP/第三方插件的**所有**工具 |

## License

MIT © 2026 ChenXu233
