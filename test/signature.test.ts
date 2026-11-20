import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectSignaturesFromJson,
  collectSignaturesFromSse,
  isChatCompletionsUrl,
  rewriteChatBody,
  textOf,
  type ChatBody,
  type SignatureLookup,
} from '../src/signature.ts'
import { SignatureStore, expandHome } from '../src/signature-store.ts'
import { installFetchPatch, isFetchPatchInstalled } from '../src/fetch-patch.ts'

const SIG = 'enc-thought-signature-value'

/** A lookup backed by a plain object. */
function lookup(entries: Record<string, string> = {}): SignatureLookup {
  return { get: (callId) => entries[callId] }
}

/** A two-message history that replays one tool call. */
function history(callId = 'call_1', signature?: string): ChatBody {
  const call = {
    id: callId,
    type: 'function',
    function: { name: 'echo', arguments: '{"text":"hi"}' },
    ...signature === undefined ? {} : { extra_content: { google: { thought_signature: signature } } },
  }
  return {
    model: 'gemini-4-neon',
    messages: [
      { role: 'user', content: 'call echo' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: callId, content: 'hi' },
    ],
  }
}

// ------------------------------------------------------------------ rewriting

test('a captured signature is attached on replay', () => {
  const result = rewriteChatBody(history(), { mode: 'auto', signatures: lookup({ call_1: SIG }) })
  assert.equal(result.changed, true)
  assert.equal(result.attached, 1)
  assert.equal(result.flattened, 0)
  const calls = result.body.messages?.[1]?.tool_calls
  assert.equal(calls?.[0]?.extra_content?.google?.thought_signature, SIG)
  assert.equal(result.body.messages?.[2]?.role, 'tool', 'signed exchanges keep their shape')
})

test('a signature the call already carries is never duplicated', () => {
  const body = history('call_1', 'already-there')
  const result = rewriteChatBody(body, { mode: 'auto', signatures: lookup({ call_1: SIG }) })
  assert.equal(result.body.messages?.[1]?.tool_calls?.[0]?.extra_content?.google?.thought_signature, SIG)
})

test('an unsignable exchange is flattened into text', () => {
  const result = rewriteChatBody(history(), { mode: 'auto', signatures: lookup() })
  assert.equal(result.flattened, 1)
  const [assistant, tool] = [result.body.messages?.[1], result.body.messages?.[2]]
  assert.equal(assistant?.role, 'assistant')
  assert.equal(assistant?.tool_calls, undefined)
  assert.match(String(assistant?.content), /\[tool call call_1\] echo\(\{"text":"hi"\}\)/)
  assert.equal(tool?.role, 'user')
  assert.equal(tool?.tool_call_id, undefined)
  assert.match(String(tool?.content), /\[tool result call_1\]\nhi/)
})

test('flatten mode ignores captured signatures', () => {
  const result = rewriteChatBody(history(), { mode: 'flatten', signatures: lookup({ call_1: SIG }) })
  assert.equal(result.attached, 0)
  assert.equal(result.flattened, 1)
})

test('off mode returns the body untouched', () => {
  const body = history()
  const result = rewriteChatBody(body, { mode: 'off', signatures: lookup({ call_1: SIG }) })
  assert.equal(result.body, body)
  assert.equal(result.changed, false)
})

test('a partly signed message is flattened as a whole', () => {
  const body: ChatBody = {
    messages: [
      { role: 'assistant', tool_calls: [
        { id: 'a', function: { name: 'one', arguments: '{}' } },
        { id: 'b', function: { name: 'two', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'A' },
      { role: 'tool', tool_call_id: 'b', content: 'B' },
    ],
  }
  const result = rewriteChatBody(body, { mode: 'auto', signatures: lookup({ a: SIG }) })
  assert.equal(result.attached, 0)
  assert.equal(result.flattened, 2)
  assert.equal(result.body.messages?.length, 2, 'both tool results fold into one user turn')
  assert.equal(result.body.messages?.[1]?.role, 'user')
  assert.match(String(result.body.messages?.[1]?.content), /\[tool result a\]\nA\n\n\[tool result b\]\nB/)
})

test('adjacent user text is folded into one turn', () => {
  const body: ChatBody = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'done' },
      { role: 'user', content: 'next please' },
    ],
  }
  const result = rewriteChatBody(body, { mode: 'auto', signatures: lookup() })
  assert.equal(result.body.messages?.length, 2)
  assert.equal(result.body.messages?.[1]?.role, 'user')
  assert.match(String(result.body.messages?.[1]?.content), /done\n\nnext please/)
})

test('a body without tool calls is left alone', () => {
  const body: ChatBody = { model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(rewriteChatBody(body, { mode: 'auto', signatures: lookup() }).changed, false)
})

test('textOf survives block content and empty values', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, 'b']), 'a\nb')
  assert.equal(textOf(null), '')
  assert.equal(textOf(42), '')
})

// ------------------------------------------------------------------- capture

test('signatures are read from a non-streaming response', () => {
  const found = collectSignaturesFromJson({
    choices: [{ message: { tool_calls: [{ id: 'call_9', extra_content: { google: { thought_signature: SIG } } }] } }],
  })
  assert.equal(found.get('call_9'), SIG)
})

test('signatures are read from stream deltas', () => {
  const found = collectSignaturesFromJson({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', extra_content: { google: { thought_signature: SIG } } }] } }],
  })
  assert.equal(found.get('call_9'), SIG)
})

test('a signature-less response yields nothing', () => {
  assert.equal(collectSignaturesFromJson({ choices: [{ message: { tool_calls: [{ id: 'x', function: {} }] } }] }).size, 0)
  assert.equal(collectSignaturesFromJson(null).size, 0)
})

test('SSE capture skips DONE and malformed frames', () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","extra_content":{"google":{"thought_signature":"' + SIG + '"}}}]}}]}',
    '',
    'data: {broken',
    'data: [DONE]',
  ].join('\n')
  const found = collectSignaturesFromSse(sse)
  assert.equal(found.size, 1)
  assert.equal(found.get('call_9'), SIG)
})

test('chat-completions URLs are recognised and others are not', () => {
  assert.equal(isChatCompletionsUrl('https://relay.example/v1/chat/completions'), true)
  assert.equal(isChatCompletionsUrl('https://relay.example/v1/chat/completions?x=1'), true)
  assert.equal(isChatCompletionsUrl('https://relay.example/v1beta/models/x:generateContent'), false)
})

// --------------------------------------------------------------------- store

test('the store persists signatures across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gts-sig-'))
  const path = join(dir, 'signatures.json')
  const first = new SignatureStore({ path })
  first.set('call_1', SIG)
  assert.equal(first.get('call_1'), SIG)
  const second = new SignatureStore({ path })
  assert.equal(second.get('call_1'), SIG)
  assert.equal(expandHome('~/x'), join(expandHome('~'), 'x'))
})

test('a corrupt store file degrades to an empty cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gts-bad-'))
  const path = join(dir, 'signatures.json')
  writeFileSync(path, 'not json')
  assert.equal(new SignatureStore({ path }).size, 0)
})

test('the store drops the oldest entries past its bound', () => {
  const store = new SignatureStore({ maxEntries: 2 })
  store.set('a', '1')
  store.set('b', '2')
  store.set('c', '3')
  assert.equal(store.size, 2)
  assert.equal(store.get('a'), undefined)
})

test('a store file holds plain JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gts-json-'))
  const path = join(dir, 'signatures.json')
  new SignatureStore({ path }).set('call_1', SIG)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).call_1, SIG)
})

// --------------------------------------------------------------- fetch shim

test('the shim rewrites an outgoing body and restores fetch afterwards', async () => {
  const original = globalThis.fetch
  const seen: string[] = []
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  globalThis.fetch = fake
  try {
    const handle = installFetchPatch({
      mode: 'auto',
      matchesUrl: isChatCompletionsUrl,
      matchesModel: (model) => /gemini/i.test(model),
      lookup: () => undefined,
      remember: () => {},
    })
    assert.equal(isFetchPatchInstalled(), true)
    const response = await globalThis.fetch('https://relay.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(history()),
    })
    assert.equal(response.status, 200)
    const sent = JSON.parse(seen[0] ?? '{}')
    assert.equal(sent.messages[1].tool_calls, undefined, 'the tool call must be flattened before it leaves')
    assert.match(String(sent.messages[1].content), /\[tool call call_1\]/)
    handle.uninstall()
    assert.equal(isFetchPatchInstalled(), false)
    assert.equal(globalThis.fetch, fake)
  } finally {
    globalThis.fetch = original
  }
})

test('the shim leaves foreign routes and non-chat endpoints alone', async () => {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(init?.body))
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  try {
    const handle = installFetchPatch({
      mode: 'auto',
      matchesUrl: isChatCompletionsUrl,
      matchesModel: (model) => /gemini/i.test(model),
      lookup: () => undefined,
      remember: () => {},
    })
    const untouched = JSON.stringify(history())
    await globalThis.fetch('https://relay.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1', messages: [{ role: 'user', content: 'x' }] }),
    })
    await globalThis.fetch('https://relay.example/v1beta/models/x:generateContent', { method: 'POST', body: untouched })
    assert.ok(seen.every((body) => !body.includes('[tool call')), 'no foreign body may be rewritten')
    handle.uninstall()
  } finally {
    globalThis.fetch = original
  }
})

test('captured signatures are remembered for the next replay', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ id: 'call_7', extra_content: { google: { thought_signature: SIG } } }] } }],
  }), { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch
  try {
    const remembered: Record<string, string> = {}
    const handle = installFetchPatch({
      mode: 'auto',
      matchesUrl: isChatCompletionsUrl,
      matchesModel: (model) => /gemini/i.test(model),
      lookup: (callId) => remembered[callId],
      remember: (callId, signature) => { remembered[callId] = signature },
    })
    await globalThis.fetch('https://relay.example/v1/chat/completions', { method: 'POST', body: '{"model":"gemini-4-neon"}' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(remembered.call_7, SIG)
    handle.uninstall()
  } finally {
    globalThis.fetch = original
  }
})
