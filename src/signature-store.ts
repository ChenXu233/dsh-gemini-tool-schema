/**
 * Durable store for captured Gemini thought signatures.
 *
 * A signature identifies one tool call, so the key is the provider-issued call
 * id. Memory alone is enough for a single process; the file form lets a session
 * that outlives a restart still replay exact calls instead of falling back to
 * flattened text.
 *
 * @module
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Configuration for {@link SignatureStore}. */
export interface SignatureStoreOptions {
  /** JSON file to persist to; `undefined` keeps the store in memory only. */
  path?: string
  /** Oldest entries are dropped past this bound. @default 5000 */
  maxEntries?: number
}

/** Expand a leading `~` so a config path can be written portably. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Tool-call signature cache, optionally backed by a JSON file. */
export class SignatureStore {
  private readonly entries = new Map<string, string>()
  private readonly file?: string
  private readonly maxEntries: number

  constructor(options: SignatureStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 5000
    if (options.path !== undefined && options.path.length > 0) {
      this.file = expandHome(options.path)
      this.load()
    }
  }

  /** Number of cached signatures. */
  get size(): number {
    return this.entries.size
  }

  /** The bound path, when the store is durable. */
  get path(): string | undefined {
    return this.file
  }

  /**
   * @param callId - provider-issued tool-call id.
   * @returns the captured signature, or `undefined` when none was seen.
   */
  get(callId: string): string | undefined {
    return this.entries.get(callId)
  }

  /**
   * Record one signature; re-recording an id refreshes its recency.
   * @param callId - provider-issued tool-call id.
   * @param signature - the opaque signature value.
   */
  set(callId: string, signature: string): void {
    if (callId.length === 0 || signature.length === 0) return
    if (this.entries.has(callId)) this.entries.delete(callId)
    this.entries.set(callId, signature)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    this.save()
  }

  private load(): void {
    if (this.file === undefined) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      for (const [callId, signature] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof signature === 'string' && signature.length > 0) this.entries.set(callId, signature)
      }
    } catch {
      // A missing or corrupt cache is not an error: it only costs exact replay.
    }
  }

  private save(): void {
    if (this.file === undefined) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.entries)))
    } catch {
      // A full disk must never break a model request.
    }
  }
}
