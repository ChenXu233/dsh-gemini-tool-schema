# dsh-tool-schema-compat

> 在 DeepSeek Harness 里，把**发给模型的工具 schema** 统一归一化，让严格的 function-calling provider（尤其 Gemini）不再因为一个字段就整包 400。

[English](README.md) | 中文

## 它解决什么

严格 provider 只接受 OpenAPI 3.0 风味的 JSON Schema 子集。Gemini 的 `functionDeclarations[].parameters` 是其中最严的一个，遇到下面两种写法会**拒掉整个请求**（HTTP 400），哪怕这一轮根本不会调用那个工具：

| 真实报错 | 肇事 schema | 来源 |
| --- | --- | --- |
| `functionDeclaration ... schema didn't specify the schema type field` | `{ anyOf: [{type:'string',enum:[...]}, {type:'null'}] }`（节点没有 `type`） | Playwright MCP 的 `browser_emulate_media.colorScheme` 等 5 个字段，来自 `z.string().nullable()` |
| `...properties[v_types].items: missing field` | `{ type: 'array' }`（数组没有 `items`） | 灵枢（dsh-memory）的 `lingshu_cg` 17 个 + `lingshu_stg` 2 个数组参数 |

这两类写法在 OpenAI / Anthropic 系路由上完全合法 —— 所以问题只在切到 Gemini 系路由时暴露。

## 为什么做在 Harness 里，而不是 MCP 代理

MCP 代理只能拦到它自己启动的 server。**DSH 自带工具、其他插件注册的工具根本不走 MCP 通道**，一个都救不了。做在 Harness 的组装层，才是"一处修、全部生效"。

## 原理

DSH 在每个 step 会组装 `PromptAssembly { sections, contexts, tools, variables }`，其中的 `tools` **直接进入 provider 请求**。本插件挂 `system-prompt/assemble` waterfall：

```js
ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
  const assembly = await next()          // 先让下游（含模型选择）跑完
  // 只对匹配到的路由生效，改写每个 tool.parameters
  return { ...assembly, tools: normalized }
}, { prepend: true })
```

- 不改请求管线、不 patch 任何核心代码，纯插件；
- 注册即 effect，插件卸载时自动清理；
- 纯函数、**幂等且确定性** —— 反复归一化不会让工具头或 prompt 缓存抖动；
- 任何一条 tool 归一化抛错都只影响它自己，绝不连累整个请求。

## 安装

### 方式 A：源码路径（本机/开发）

把下面这段追加到 `<DSH home>/profiles/<profile>/cordis.patch.yml`（`dsh --profile web --dump-config` 可以打印本机实际启动的那棵树）：

```yaml
- insert:
    - id: tool-schema-compat
      name: '/absolute/path/to/dsh-tool-schema-compat/src/index.mjs'
      config:
        mode: match
        match: [gemini, google, vertex]
        logFile: '/absolute/path/to/.dsh/logs/tool-schema-compat.log'
```

### 方式 B：作为包安装

放进 profile 的 `node_modules`（或 `npm i`），然后按包名挂载：

```yaml
- insert:
    - id: tool-schema-compat
      name: dsh-tool-schema-compat
```

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `match` | `match` 只处理匹配路由；`always` 全部处理；`off` 关闭 |
| `match` | `[gemini, google, vertex]` | 大小写不敏感的子串，匹配 `provider` 和 `model` 拼成的字符串 |
| `unknownRoute` | `apply` | 路由读不出来时的行为：`apply` 照常处理，`skip` 跳过 |
| `itemsFallback` | `{type:'string'}` | 数组缺少 `items` 时补的元素 schema |
| `nullable` | `true` | null 联合是否落成 `nullable: true` |
| `dryRun` | `false` | 只统计和 lint，实际仍发送原 schema |
| `logFile` | 无 | 每次组装追加一行诊断 |
| `logLevel` | `info` | `silent` / `info` / `debug`（debug 会记录被跳过的路由和工具名） |
| `dumpDir` | 无 | 命中的组装把完整工具集落盘到该目录 |
| `dumpSchemas` | `true` | 转储是否包含完整 schema（false 只落工具名） |

## 归一化规则

- **每个节点必须有 `type`**：`anyOf`/`oneOf` 折叠成单类型（含 null 分支时置 `nullable`）、`type: ['array','null']` 展平、`enum` 去掉 null、`const` → `enum`、缺失时按形状推断。
- **数组必须有 `items`**：缺失时补 `itemsFallback`。
- **`$ref`/`$defs` 内联**，循环引用安全终止。
- **剥离严格 provider 不接受的关键字**：`$schema`、`additionalProperties`、`if/then/else`、`not`、`prefixItems` 等。
- **enum 里不能有空项**：`''`、空数组、空对象会被丢弃（Gemini 报 `enum[i]: cannot be empty`，例如 `permission?: "read-only" | ... | ""`）；整个 enum 都为空时直接删除该 enum。
- **`required` 只保留真实存在的属性**；`exclusiveMinimum/Maximum` 折算成 `minimum/maximum`；`title` 一并剥离。
- **全量转储（可选）**：`dumpDir` 打开后，每次命中的组装都会把模型实际看到的工具集落盘，方便离线审计还有没有漏网之鱼。

## 验证

```sh
node --test test/normalize.test.mjs
```

13 项测试，其中一项用的不是玩具数据：把本机 MCP 连接器缓存里的**全部 82 个真实工具**跑一遍 —— 归一化前有违规，归一化后 **0 违规**。

## 与已有项目的关系

| 项目 | 形态 | 覆盖 |
| --- | --- | --- |
| [@luutuankiet/gemini-mcp](https://github.com/luutuankiet/gemini-mcp) | MCP 代理 | `$ref`/`$defs`/`anyOf`，**不补 `items`**；够不到 Harness 内置工具 |
| [aeewws/tool-schema-fixer](https://github.com/aeewws/tool-schema-fixer) | 离线 CLI | 需要人工改文件，不接运行时 |
| **本项目** | Harness 插件（hook） | 上述两类缺陷 + 内置/MCP/第三方插件的**所有**工具 |

## API

```js
import { normalizeSchema, lintSchema } from 'dsh-tool-schema-compat/normalize'
```

## 环境

在 DeepSeek Harness 44.0.0 上实测。Hook 契约见官方手册的 `system-prompt/assemble`。

## License

MIT © 2026 ChenXu233
