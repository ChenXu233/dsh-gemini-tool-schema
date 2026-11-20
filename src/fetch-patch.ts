/**
 * Process-wide fetch shim that keeps Gemini tool calls replayable on
 * OpenAI-compatible relays.
 *
 * The alternative — rewriting the request inside a plugin hook — is impossible:
 * the agent loop freezes its `GenerateOptions` (and every message in it) before
 * dispatch, so no listener can change what the adapter sends. The one seam left
 * is the transport itself, which every OpenAI-compatible adapter reaches through
 * the global fetch.
 *
 * @module
 */

import {
  collectSignaturesFromJson,
  collectSignaturesFromSse,
  isChatCompletionsUrl,
  rewriteChatBody,
  type ChatBody,
  type SignatureMode,
} from './signature.ts'

/** Everything the shim needs from the plugin configuration. */
export interface FetchPatchOptions {
  mode: SignatureMode
  /** Whether a request URL is one this shim may rewrite. */
  matchesUrl(url: string): boolean
  /** Whether a request model id needs signature handling. */
  matchesModel(model: string): boolean
  /** Read one captured signature. */
  lookup(callId: string): string | undefined
  /** Record one captured signature. */
  remember(callId: string, signature: string): void
  /** Diagnostic sink; the shim never throws into the request path. */
  log?(line: string): void
}

/** A live shim. */
export interface FetchPatchHandle {
  /** Swap the configuration without re-wrapping fetch. */
  update(options: FetchPatchOptions): void
  /** Restore the ambient fetch (used by tests and by plugin disposal). */
  uninstall(): void
}

interface PatchState {
  current: FetchPatchOptions
  original: typeof globalThis.fetch
}

const PATCH_KEY = Symbol.for('dsh-gemini-tool-schema/fetch-patch')

/** The request URL of any fetch input shape. */
function urlOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null) {
    const url = (input as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return undefined
}

/** Error text that is safe to log. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rewrite one outgoing request body, when it is in scope. */
function rewriteRequest(init: RequestInit | undefined, url: string, config: FetchPatchOptions): RequestInit | undefined {
  if (!config.matchesUrl(url)) return init
  const body = typeof init?.body === 'string' ? init.body : undefined
  if (body === undefined) return init
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return init
  }
  if (typeof parsed !== 'object' || parsed === null) return init
  const chat = parsed as ChatBody
  if (typeof chat.model !== 'string' || !config.matchesModel(chat.model)) return init
  const result = rewriteChatBody(chat, { mode: config.mode, signatures: { get: config.lookup } })
  if (!result.changed) return init
  config.log?.(`[replay] model=${chat.model} attached=${result.attached} flattened=${result.flattened}`)
  return { ...init, body: JSON.stringify(result.body) }
}

/** Capture signatures from one response without disturbing the caller's stream. */
function capture(response: Response, url: string, config: FetchPatchOptions): void {
  if (!config.matchesUrl(url)) return
  const contentType = response.headers.get('content-type') ?? ''
  let clone: Response
  try {
    clone = response.clone()
  } catch {
    return
  }
  void (async () => {
    const text = await clone.text()
    const found = /event-stream/i.test(contentType)
      ? collectSignaturesFromSse(text)
      : (() => {
        try {
          return collectSignaturesFromJson(JSON.parse(text))
        } catch {
          return new Map<string, string>()
        }
      })()
    for (const [callId, signature] of found) config.remember(callId, signature)
    if (found.size > 0) config.log?.(`[signature] captured=${found.size}`)
  })().catch(() => {
    // A capture failure must never surface as a request failure.
  })
}

/**
 * Install the fetch shim, or update the one already installed.
 *
 * Installation is idempotent across plugin reloads: the shim keeps one state
 * object on `globalThis`, so a hot-reloaded plugin updates that state instead of
 * stacking a second wrapper on top of the first.
 *
 * @param options - initial configuration.
 * @returns a handle that can reconfigure or remove the shim.
 */
export function installFetchPatch(options: FetchPatchOptions): FetchPatchHandle {
  const holder = globalThis as unknown as { [key: symbol]: unknown }
  const existing = holder[PATCH_KEY] as PatchState | undefined
  if (existing !== undefined) {
    existing.current = options
    return {
      update: (next) => { existing.current = next },
      uninstall: () => {
        globalThis.fetch = existing.original
        delete holder[PATCH_KEY]
      },
    }
  }

  const state: PatchState = { current: options, original: globalThis.fetch }
  const shimmed = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const config = state.current
    let nextInit = init
    const url = urlOf(input)
    if (url !== undefined) {
      try {
        nextInit = rewriteRequest(init, url, config)
      } catch (error) {
        config.log?.(`[replay] rewrite failed: ${messageOf(error)}`)
      }
    }
    const response = await state.original(input, nextInit)
    if (url !== undefined) {
      try {
        capture(response, url, config)
      } catch (error) {
        config.log?.(`[signature] capture failed: ${messageOf(error)}`)
      }
    }
    return response
  }

  holder[PATCH_KEY] = state
  globalThis.fetch = shimmed as typeof globalThis.fetch
  return {
    update: (next) => { state.current = next },
    uninstall: () => {
      globalThis.fetch = state.original
      delete holder[PATCH_KEY]
    },
  }
}

/** Whether the shim is installed in this process. */
export function isFetchPatchInstalled(): boolean {
  const holder = globalThis as unknown as { [key: symbol]: unknown }
  return holder[PATCH_KEY] !== undefined
}

export { isChatCompletionsUrl }
