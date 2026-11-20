/**
 * Gemini thought-signature compatibility for OpenAI-compatible routes.
 *
 * Gemini reasoning models attach an encrypted `thoughtSignature` to every
 * `functionCall` they emit. On the next request the provider requires that
 * signature back; a missing one fails the whole call with HTTP 400
 * ("Function call is missing a thought_signature in functionCall parts").
 *
 * Native Gemini transports carry the signature for us. An OpenAI-compatible
 * relay only has one legal carrier for it — `tool_calls[].extra_content.google
 * .thought_signature` — and many relays (new-api style gateways, some
 * OpenRouter routes) drop it on the way out. Nothing can be replayed then, and
 * the only request shape the upstream still accepts is the tool exchange
 * flattened into ordinary text.
 *
 * This module is the pure half: parse signatures out of a response, and rewrite
 * a chat-completions body so a signature-less history keeps working.
 *
 * @module
 */

/** One tool call as an OpenAI-compatible chat body or response carries it. */
export interface ChatToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  /** OpenAI-compatible carrier for provider-specific metadata (Gemini uses `google`). */
  extra_content?: { google?: { thought_signature?: string } }
  [key: string]: unknown
}

/** One message as an OpenAI-compatible chat body carries it. */
export interface ChatMessage {
  role?: string
  content?: unknown
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

/** The subset of a chat-completions request body this module reads. */
export interface ChatBody {
  model?: string
  messages?: ChatMessage[]
  [key: string]: unknown
}

/** How a signature-less tool history is handled. */
export type SignatureMode = 'auto' | 'flatten' | 'off'

/** Read access to the signatures captured so far. */
export interface SignatureLookup {
  /** @param callId - provider-issued tool-call id.
   * @returns the captured signature, or `undefined` when none was seen. */
  get(callId: string): string | undefined
}

/** Options for {@link rewriteChatBody}. */
export interface RewriteOptions {
  mode: SignatureMode
  signatures: SignatureLookup
}

/** Outcome of one {@link rewriteChatBody} call. */
export interface RewriteResult {
  /** The body to send — the input itself when nothing changed. */
  body: ChatBody
  changed: boolean
  /** Tool calls that received a captured signature. */
  attached: number
  /** Tool calls flattened into text because no signature was available. */
  flattened: number
}

/** Whether a URL points at an OpenAI-compatible chat-completions endpoint. */
export function isChatCompletionsUrl(url: string): boolean {
  return /\/chat\/completions(?:\?|#|$)/.test(url)
}

/** Render message content as plain text, dropping block structure. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') parts.push(part)
      else if (typeof part === 'object' && part !== null) {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** The signature a tool call already carries, when the relay kept it. */
function signatureOf(call: ChatToolCall): string | undefined {
  const signature = call.extra_content?.google?.thought_signature
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined
}

/** Attach one signature using the OpenAI-compatible carrier. */
function withSignature(call: ChatToolCall, signature: string): ChatToolCall {
  return { ...call, extra_content: { ...call.extra_content, google: { ...call.extra_content?.google, thought_signature: signature } } }
}

/** Append a message, folding adjacent user text into one turn. */
function push(out: ChatMessage[], message: ChatMessage): void {
  const previous = out[out.length - 1]
  const bothText = typeof previous?.content === 'string' && previous.role === 'user' && message.role === 'user' && typeof message.content === 'string'
  if (bothText) {
    out[out.length - 1] = { ...previous, content: `${textOf(previous.content)}\n\n${textOf(message.content)}` }
    return
  }
  out.push(message)
}

/** Render one flattened tool exchange line. */
function callLine(call: ChatToolCall): string {
  const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : '?'
  const name = call.function?.name ?? '?'
  const args = typeof call.function?.arguments === 'string' && call.function.arguments.length > 0 ? call.function.arguments : '{}'
  return `[tool call ${id}] ${name}(${args})`
}

/**
 * Rewrite one chat-completions body for a signature-less tool history.
 *
 * `auto` attaches every captured signature it can and flattens any exchange it
 * cannot sign; `flatten` always flattens; `off` is a no-op. A flattened
 * exchange turns the assistant tool-call message into assistant text and each
 * answering tool message into a user-role result, which is the one replay shape
 * an upstream that lost the signature still accepts.
 *
 * @param body - the parsed request body.
 * @param options - mode plus the signature lookup.
 * @returns the rewritten body and what changed.
 */
export function rewriteChatBody(body: ChatBody, options: RewriteOptions): RewriteResult {
  const messages = body.messages
  const unchanged: RewriteResult = { body, changed: false, attached: 0, flattened: 0 }
  if (options.mode === 'off' || !Array.isArray(messages) || messages.length === 0) return unchanged

  const rewritten: ChatMessage[] = []
  const awaiting: string[] = []
  let attached = 0
  let flattened = 0

  const flatten = (message: ChatMessage, calls: ChatToolCall[]): void => {
    const lines: string[] = []
    for (const call of calls) {
      const id = typeof call.id === 'string' ? call.id : ''
      if (id.length > 0) awaiting.push(id)
      lines.push(callLine(call))
    }
    const text = [textOf(message.content).trim(), lines.join('\n')].filter((part) => part.length > 0).join('\n\n')
    flattened += calls.length
    push(rewritten, { role: 'assistant', content: text })
  }

  for (const message of messages) {
    const callId = message.tool_call_id
    if (message.role === 'tool' && typeof callId === 'string' && awaiting.includes(callId)) {
      const index = awaiting.indexOf(callId)
      awaiting.splice(index, 1)
      push(rewritten, { role: 'user', content: `[tool result ${callId}]\n${textOf(message.content)}` })
      continue
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined
    if (message.role !== 'assistant' || calls === undefined || calls.length === 0) {
      push(rewritten, message)
      continue
    }
    const signed = options.mode === 'flatten'
      ? []
      : calls.map((call) => (typeof call.id === 'string' ? options.signatures.get(call.id) : undefined))
    const everyCallSigned = options.mode !== 'flatten'
      && calls.length > 0
      && calls.every((call) => typeof call.id === 'string' && call.id.length > 0)
      && signed.length === calls.length
      && signed.every((signature): signature is string => typeof signature === 'string' && signature.length > 0)
    if (everyCallSigned) {
      const next = calls.map((call) => withSignature(call, options.signatures.get(call.id as string) as string))
      attached += calls.length
      push(rewritten, { ...message, tool_calls: next })
      continue
    }
    flatten(message, calls)
  }

  if (attached === 0 && flattened === 0) return unchanged
  return { body: { ...body, messages: rewritten }, changed: true, attached, flattened }
}

/** Read tool calls out of one response message or stream delta. */
function collectToolCalls(container: unknown, found: Map<string, string>): void {
  if (typeof container !== 'object' || container === null) return
  const calls = (container as { tool_calls?: unknown }).tool_calls
  if (!Array.isArray(calls)) return
  for (const call of calls as ChatToolCall[]) {
    const signature = signatureOf(call)
    if (typeof call.id === 'string' && call.id.length > 0 && signature !== undefined) found.set(call.id, signature)
  }
}

/**
 * Collect captured signatures from one decoded chat-completions response.
 *
 * Both the non-streaming `choices[].message` and the streaming
 * `choices[].delta` shapes are read, so the same parser serves either mode.
 *
 * @param payload - a parsed response body or one SSE data frame.
 * @returns tool-call id to signature, empty when the relay dropped them.
 */
export function collectSignaturesFromJson(payload: unknown): Map<string, string> {
  const found = new Map<string, string>()
  if (typeof payload !== 'object' || payload === null) return found
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return found
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    collectToolCalls((choice as { message?: unknown }).message, found)
    collectToolCalls((choice as { delta?: unknown }).delta, found)
  }
  return found
}

/**
 * Collect captured signatures from a complete SSE response body.
 * Malformed frames are skipped: one bad frame must never break a stream.
 *
 * @param text - the raw SSE body.
 * @returns tool-call id to signature, empty when the relay dropped them.
 */
export function collectSignaturesFromSse(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      for (const [id, signature] of collectSignaturesFromJson(JSON.parse(payload))) found.set(id, signature)
    } catch {
      // A truncated tail frame is normal when a stream is cut; keep the rest.
    }
  }
  return found
}
