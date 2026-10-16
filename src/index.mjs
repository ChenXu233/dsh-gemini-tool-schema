/**
 * dsh-tool-schema-compat — DeepSeek Harness plugin.
 *
 * Wraps the `system-prompt/assemble` waterfall: the returned
 * {@link PromptAssembly} is what the agent loop hands to the provider, so
 * rewriting `assembly.tools[].parameters` here normalizes **every** tool the
 * model sees — built-in tools, MCP tools, and tools registered by other
 * plugins alike.
 *
 * Why this lives in Harness and not in an MCP proxy: a proxy can only see the
 * servers it wraps. Tools contributed by other plugins, and the built-in
 * `dsh-tool-*` families, never pass through an MCP transport.
 *
 * @module dsh-tool-schema-compat
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSchema, lintSchema } from './normalize.mjs';

/** Plugin id shown by the loader. */
export const name = 'tool-schema-compat';

/** Default route match list: provider or model containing one of these. */
const DEFAULT_MATCH = ['gemini', 'google', 'vertex'];

/**
 * @typedef {object} Config
 * @property {'match'|'always'|'off'} [mode] `match` (default) applies only to matched routes
 * @property {string[]} [match] case-insensitive substrings tested against provider and model
 * @property {'apply'|'skip'} [unknownRoute] what to do when the route cannot be read (default `apply`)
 * @property {object} [itemsFallback] schema used for arrays that omit `items` (default `{type:'string'}`)
 * @property {boolean} [nullable] emit `nullable:true` for null-unions (default true)
 * @property {boolean} [dryRun] normalize for the report but send the original schemas
 * @property {string} [logFile] append one line per assembly to this file
 * @property {'silent'|'info'|'debug'} [logLevel] file verbosity (default `info`)
 */

/** Resolve and validate the plugin config. */
function resolveConfig(config) {
  const cfg = config ?? {};
  const mode = cfg.mode ?? 'match';
  if (!['match', 'always', 'off'].includes(mode)) {
    throw new Error(`tool-schema-compat: mode must be match|always|off, received ${JSON.stringify(mode)}`);
  }
  const unknownRoute = cfg.unknownRoute ?? 'apply';
  if (!['apply', 'skip'].includes(unknownRoute)) {
    throw new Error(`tool-schema-compat: unknownRoute must be apply|skip, received ${JSON.stringify(unknownRoute)}`);
  }
  const match = cfg.match === undefined ? DEFAULT_MATCH : cfg.match;
  if (!Array.isArray(match) || match.some((entry) => typeof entry !== 'string')) {
    throw new Error('tool-schema-compat: match must be an array of strings');
  }
  const logLevel = cfg.logLevel ?? 'info';
  if (!['silent', 'info', 'debug'].includes(logLevel)) {
    throw new Error(`tool-schema-compat: logLevel must be silent|info|debug, received ${JSON.stringify(logLevel)}`);
  }
  return {
    mode,
    match: match.map((entry) => entry.toLowerCase()),
    unknownRoute,
    itemsFallback: cfg.itemsFallback ?? { type: 'string' },
    nullable: cfg.nullable !== false,
    dryRun: cfg.dryRun === true,
    logFile: typeof cfg.logFile === 'string' && cfg.logFile.length > 0 ? cfg.logFile : undefined,
    logLevel,
    dumpDir: typeof cfg.dumpDir === 'string' && cfg.dumpDir.length > 0 ? cfg.dumpDir : undefined,
    dumpSchemas: cfg.dumpSchemas !== false,
  };
}

/** Read the active provider/model for this assembly, when the harness exposes it. */
function detectRoute(context, assembly) {
  const variables = assembly?.variables;
  if (variables !== undefined && (typeof variables.provider === 'string' || typeof variables.model === 'string')) {
    return { provider: variables.provider, model: variables.model, source: 'variables' };
  }
  try {
    const config = context?.agent?.session?.requestHeader?.()?.config;
    if (config !== undefined && typeof config === 'object') {
      return { provider: config.provider, model: config.model, source: 'requestHeader' };
    }
  } catch {
    /* a cold or disposed session has no request header; fall through */
  }
  return { provider: undefined, model: undefined, source: 'unknown' };
}

/** Whether this route should be normalized. */
function applies(route, cfg) {
  if (cfg.mode === 'off') return false;
  if (cfg.mode === 'always') return true;
  const haystack = [route.provider, route.model].filter((entry) => typeof entry === 'string').join('/').toLowerCase();
  if (haystack.length === 0) return cfg.unknownRoute === 'apply';
  return cfg.match.some((needle) => haystack.includes(needle));
}

/** Write the exact model-facing tool set to disk for offline auditing. */
function dumpAssembly(cfg, route, tools, stats) {
  try {
    mkdirSync(cfg.dumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(cfg.dumpDir, `assembly-${stamp}.json`);
    writeFileSync(file, JSON.stringify({
      route,
      toolCount: tools.length,
      changed: stats.changed,
      findings: stats.findings,
      tools: tools.map((tool) => cfg.dumpSchemas
        ? { name: tool?.name, parameters: tool?.parameters }
        : { name: tool?.name }),
    }, null, 1));
    writeLog(cfg, `[dump] ${file}`);
  } catch (error) {
    writeLog(cfg, `[dump] failed: ${error?.message ?? error}`);
  }
}

/** Compact rendering of the tool names in one assembly. */
function namesOf(tools) {
  const names = tools.map((tool) => tool?.name ?? '?');
  return names.length > 12 ? `${names.slice(0, 12).join(',')},+${names.length - 12}` : names.join(',');
}

/** Append one diagnostic line to the plugin log file, never throwing. */
function writeLog(cfg, line) {
  if (cfg.logFile === undefined || cfg.logLevel === 'silent') return;
  try {
    appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* a full disk or a bad path must never break a model request */
  }
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} [config]
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  console.log(`[tool-schema-compat] loaded v2 (mode=${cfg.mode}, match=${cfg.match.join(',') || '-'}, dryRun=${cfg.dryRun})`);
  writeLog(cfg, `[load:v2] mode=${cfg.mode} match=${cfg.match.join(',')} unknownRoute=${cfg.unknownRoute}`);

  // `prepend` runs this listener first so `next()` observes the finished
  // assembly — including route variables written by model selection.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (assembly === undefined || !Array.isArray(assembly.tools) || assembly.tools.length === 0) return assembly;
    const route = detectRoute(context, assembly);
    if (!applies(route, cfg)) {
      if (cfg.logLevel === 'debug') {
        writeLog(cfg, `[skip] route=${route.provider ?? '?'}/${route.model ?? '?'} (${route.source}) tools=${assembly.tools.length} names=${namesOf(assembly.tools)}`);
      }
      return assembly;
    }

    let changed = 0;
    const findings = [];
    const tools = assembly.tools.map((tool) => {
      if (tool === null || typeof tool !== 'object') return tool;
      const parameters = tool.parameters;
      if (parameters === null || typeof parameters !== 'object') return tool;
      let normalized;
      try {
        normalized = normalizeSchema(parameters, { itemsFallback: cfg.itemsFallback, nullable: cfg.nullable });
      } catch (error) {
        findings.push(`${tool.name}: normalize threw: ${error?.message ?? error}`);
        return tool;
      }
      if (JSON.stringify(normalized) !== JSON.stringify(parameters)) changed += 1;
      for (const finding of lintSchema(normalized)) {
        if (findings.length < 10) findings.push(`${tool.name}${finding}`);
      }
      return cfg.dryRun ? tool : { ...tool, parameters: normalized };
    });

    if (cfg.dumpDir !== undefined) dumpAssembly(cfg, route, tools, { changed, findings });
    const summary = `[assemble] route=${route.provider ?? '?'}/${route.model ?? '?'} (${route.source}) tools=${assembly.tools.length} changed=${changed} residual=${findings.length} names=${namesOf(assembly.tools)}`;
    writeLog(cfg, summary);
    if (findings.length > 0) writeLog(cfg, `[warn] ${findings.join(' | ')}`);
    return { ...assembly, tools };
  }, { prepend: true });
}

export { normalizeSchema, lintSchema } from './normalize.mjs';
