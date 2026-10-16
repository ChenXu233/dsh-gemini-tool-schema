/**
 * dsh-gemini-tool-schema — a DeepSeek Harness plugin.
 *
 * Wraps the `system-prompt/assemble` waterfall. The assembly it returns is what
 * the agent loop hands to the provider, so rewriting `assembly.tools[].parameters`
 * here normalizes **every** tool the model sees — built-in tools, MCP tools and
 * tools registered by other plugins alike.
 *
 * Why this lives in Harness rather than in an MCP proxy: a proxy only sees the
 * servers it wraps, so built-in `dsh-tool-*` families and other plugins' tools
 * never pass through it.
 *
 * @module
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintSchema, normalizeSchema, type JsonSchema } from './normalize.ts'

/** Plugin id shown by the loader. */
export const name = 'gemini-tool-schema'

/** How the plugin decides which model routes to normalize. */
export type ApplyMode = 'all' | 'list' | 'off'

/** Plugin configuration, as written under the patch row's `config:`. */
export interface Config {
  /**
   * `all` — normalize every request; `list` — only routes matching
   * {@link Config.apis}; `off` — disabled.
   * @default 'list'
   */
  mode?: ApplyMode
  /**
   * API patterns, matched against `provider/model` (e.g.
   * `gemini-lumiya/gemini-4-argon`). Each entry is compiled as a regular
   * expression — `gemini`, `^openrouter/`, `/gpt-5\.\d/i` all work — and falls
   * back to a case-insensitive substring match when it is not a valid regex.
   * `'*'` matches everything.
   * @default ['gemini', 'google', 'vertex']
   */
  apis?: string[]
  /**
   * What to do when the route cannot be read from the harness.
   * `apply` is the safer default: a silent skip would look like the fix "not working".
   * @default 'apply'
   */
  unknownApi?: 'apply' | 'skip'
  /** Element schema for arrays that omit `items`. @default { type: 'string' } */
  itemsFallback?: JsonSchema
  /** Emit `nullable: true` for null unions. @default true */
  nullable?: boolean
  /** Report and lint, but send the original schemas. @default false */
  dryRun?: boolean
  /** Append one diagnostic line per assembly to this file. */
  logFile?: string
  /** `debug` also records skipped routes and the tool names involved. @default 'info' */
  logLevel?: 'silent' | 'info' | 'debug'
  /** Write the exact model-facing tool set here for offline auditing. */
  dumpDir?: string
  /** Include full schemas in the dump; `false` dumps names only. @default true */
  dumpSchemas?: boolean
}

/** The default API patterns: every Gemini-flavored route, by substring. */
const DEFAULT_APIS = ['gemini', 'google', 'vertex']

/** One compiled API pattern. */
export interface ApiMatcher {
  /** The pattern as written in the config. */
  readonly raw: string
  /** Whether this pattern matches a `provider/model` target. */
  test(target: string): boolean
}

/** A tool schema as the assembly carries it. */
export interface ToolSchema {
  name?: string
  description?: string
  parameters?: JsonSchema
  deferLoading?: boolean
  [key: string]: unknown
}

/** The assembled model input this plugin rewrites. */
export interface PromptAssembly {
  tools?: ToolSchema[]
  variables?: Record<string, string | undefined>
  [key: string]: unknown
}

/** The minimal agent shape used to read the active route. */
export interface AgentLike {
  session?: {
    requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
  }
}

/** Second argument of the assemble waterfall. */
export interface AssembleContext {
  agent?: AgentLike
  [key: string]: unknown
}

/** The `system-prompt/assemble` waterfall signature. */
export type AssembleListener = (
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

/** The subset of the Cordis context this plugin uses. */
export interface PluginContext {
  on(event: 'system-prompt/assemble', listener: AssembleListener, options?: { prepend?: boolean }): void
}

/** The active provider/model of one assembly. */
export interface Route {
  provider?: string
  model?: string
  /** Where the route came from, for diagnostics. */
  source: 'variables' | 'requestHeader' | 'unknown'
}

interface ResolvedConfig {
  mode: ApplyMode
  matchers: ApiMatcher[]
  unknownApi: 'apply' | 'skip'
  itemsFallback: JsonSchema
  nullable: boolean
  dryRun: boolean
  logFile?: string
  logLevel: 'silent' | 'info' | 'debug'
  dumpDir?: string
  dumpSchemas: boolean
}

/**
 * Compile API patterns into matchers.
 *
 * Every entry is treated as a regular expression (case-insensitive). Entries may
 * also be written in `/pattern/flags` form for full control, and an entry that
 * does not compile falls back to a case-insensitive substring match, so a typo
 * degrades instead of throwing at load time.
 */
export function compileApiMatchers(apis: readonly string[]): ApiMatcher[] {
  return apis.map((raw) => {
    const trimmed = raw.trim()
    if (trimmed === '' ) return { raw, test: () => false }
    if (trimmed === '*' || trimmed === '.*') return { raw, test: () => true }
    const delimited = /^\/(.+)\/([a-z]*)$/i.exec(trimmed)
    const source = delimited ? delimited[1]! : trimmed
    const flags = (delimited ? delimited[2]! : 'i').replace(/g/g, '')
    try {
      const pattern = new RegExp(source, flags)
      return { raw, test: (target: string) => pattern.test(target) }
    } catch {
      const needle = trimmed.toLowerCase()
      return { raw, test: (target: string) => target.toLowerCase().includes(needle) }
    }
  })
}

/** Validate and default a raw plugin config. Throws on a clearly wrong value. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const mode = config.mode ?? 'list'
  if (mode !== 'all' && mode !== 'list' && mode !== 'off') {
    throw new Error(`${name}: mode must be all|list|off, received ${JSON.stringify(mode)}`)
  }
  const unknownApi = config.unknownApi ?? 'apply'
  if (unknownApi !== 'apply' && unknownApi !== 'skip') {
    throw new Error(`${name}: unknownApi must be apply|skip, received ${JSON.stringify(unknownApi)}`)
  }
  const apis = config.apis ?? DEFAULT_APIS
  if (!Array.isArray(apis) || apis.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name}: apis must be an array of strings`)
  }
  const logLevel = config.logLevel ?? 'info'
  if (logLevel !== 'silent' && logLevel !== 'info' && logLevel !== 'debug') {
    throw new Error(`${name}: logLevel must be silent|info|debug, received ${JSON.stringify(logLevel)}`)
  }
  return {
    mode,
    matchers: compileApiMatchers(apis),
    unknownApi,
    itemsFallback: config.itemsFallback ?? { type: 'string' },
    nullable: config.nullable !== false,
    dryRun: config.dryRun === true,
    logFile: config.logFile,
    logLevel,
    dumpDir: config.dumpDir,
    dumpSchemas: config.dumpSchemas !== false,
  }
}

/** The `provider/model` string API patterns are matched against. */
export function apiTarget(route: Route): string {
  return [route.provider, route.model].filter((part): part is string => typeof part === 'string' && part.length > 0).join('/')
}

/** Whether this route should be normalized. */
export function shouldApply(route: Route, config: ResolvedConfig): boolean {
  if (config.mode === 'off') return false
  if (config.mode === 'all') return true
  const target = apiTarget(route)
  if (target.length === 0) return config.unknownApi === 'apply'
  return config.matchers.some((matcher) => matcher.test(target))
}

/** Read the active provider/model of this assembly, when the harness exposes it. */
function detectRoute(context: AssembleContext, assembly: PromptAssembly): Route {
  const variables = assembly.variables
  if (variables !== undefined && (typeof variables.provider === 'string' || typeof variables.model === 'string')) {
    return { provider: variables.provider, model: variables.model, source: 'variables' }
  }
  try {
    const config = context.agent?.session?.requestHeader?.()?.config
    if (config !== undefined) {
      return { provider: config.provider, model: config.model, source: 'requestHeader' }
    }
  } catch {
    // A cold or disposed session has no request header; fall through.
  }
  return { source: 'unknown' }
}

/** Append one diagnostic line, never throwing into the model request path. */
function writeLog(config: ResolvedConfig, line: string): void {
  if (config.logFile === undefined || config.logLevel === 'silent') return
  try {
    appendFileSync(config.logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A full disk or a bad path must never break a model request.
  }
}

/** Compact rendering of the tool names in one assembly. */
function namesOf(tools: readonly ToolSchema[]): string {
  const names = tools.map((tool) => tool.name ?? '?')
  return names.length > 12 ? `${names.slice(0, 12).join(',')},+${names.length - 12}` : names.join(',')
}

/** Write the exact model-facing tool set to disk, for offline auditing. */
function dumpAssembly(config: ResolvedConfig, route: Route, tools: readonly ToolSchema[], stats: { changed: number; findings: readonly string[] }): void {
  try {
    mkdirSync(config.dumpDir!, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(config.dumpDir!, `assembly-${stamp}.json`)
    writeFileSync(file, JSON.stringify({
      route,
      toolCount: tools.length,
      changed: stats.changed,
      findings: stats.findings,
      tools: tools.map((tool) => (config.dumpSchemas ? { name: tool.name, parameters: tool.parameters } : { name: tool.name })),
    }, null, 1))
    writeLog(config, `[dump] ${file}`)
  } catch (error) {
    writeLog(config, `[dump] failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Mount the plugin.
 * @param ctx - the plugin context
 * @param config - see {@link Config}
 */
export function apply(ctx: PluginContext, config?: Config): void {
  const resolved = resolveConfig(config)
  console.log(`[${name}] loaded (mode=${resolved.mode}, apis=${resolved.matchers.map((m) => m.raw).join(',') || '-'}, dryRun=${resolved.dryRun})`)
  writeLog(resolved, `[load] mode=${resolved.mode} apis=${resolved.matchers.map((m) => m.raw).join(',')} unknownApi=${resolved.unknownApi}`)

  // `prepend` runs this listener first so `next()` observes the finished
  // assembly, including the route variables written by model selection.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const tools = assembly?.tools
    if (!Array.isArray(tools) || tools.length === 0) return assembly

    const route = detectRoute(context, assembly)
    if (!shouldApply(route, resolved)) {
      if (resolved.logLevel === 'debug') {
        writeLog(resolved, `[skip] api=${apiTarget(route) || '?'} (${route.source}) tools=${tools.length} names=${namesOf(tools)}`)
      }
      return assembly
    }

    let changed = 0
    const findings: string[] = []
    const normalized = tools.map((tool): ToolSchema => {
      const parameters = tool?.parameters
      if (!parameters || typeof parameters !== 'object') return tool
      let next: JsonSchema
      try {
        next = normalizeSchema(parameters, { itemsFallback: resolved.itemsFallback, nullable: resolved.nullable })
      } catch (error) {
        findings.push(`${tool.name ?? '?'}: normalize threw: ${error instanceof Error ? error.message : String(error)}`)
        return tool
      }
      if (JSON.stringify(next) !== JSON.stringify(parameters)) changed += 1
      for (const finding of lintSchema(next)) {
        if (findings.length < 10) findings.push(`${tool.name ?? '?'}${finding}`)
      }
      return resolved.dryRun ? tool : { ...tool, parameters: next }
    })

    if (resolved.dumpDir !== undefined) dumpAssembly(resolved, route, normalized, { changed, findings })
    writeLog(resolved, `[assemble] api=${apiTarget(route) || '?'} (${route.source}) tools=${tools.length} changed=${changed} residual=${findings.length} names=${namesOf(normalized)}`)
    if (findings.length > 0) writeLog(resolved, `[warn] ${findings.join(' | ')}`)
    return { ...assembly, tools: normalized }
  }, { prepend: true })
}

export { lintSchema, normalizeSchema } from './normalize.ts'
export type { JsonSchema, NormalizeOptions } from './normalize.ts'
