/**
 * Node stand-ins for the `@oh-my-pi/pi-utils` surface the omp Cursor transport
 * graph imports.
 *
 * omp ships TypeScript sources that import a Bun-oriented utility package; the
 * transport itself is Node-portable (`node:http2`, `node:crypto`, timers), so the
 * build swaps that package for this module. The surface is enumerable: esbuild
 * fails the build loudly on any named export this file does not provide, and
 * `omp-manifest.json` records both that surface (`shimSymbols`) and the names
 * the bundled graph reaches (`shimImports`) — so a `simplify:` member becoming
 * reachable shows up as a manifest diff instead of a silent degradation.
 *
 * Semantics are intentionally conservative rather than clever. The JSON
 * parser/streamer are omp's own implementations re-exported (not reimplemented),
 * because tool arguments are load-bearing; anything else marked `simplify:` is a
 * bounded stand-in (retry hints and logging, where the seam or the host owns the
 * policy) and is documented at its declaration.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  classifyJsonPrefix as realClassifyJsonPrefix,
  parseJsonWithRepair as realParseJsonWithRepair,
  parseStreamingJsonThrottled as realParseStreamingJsonThrottled,
} from '@oh-my-pi/pi-utils/json-parse'

/** Environment accessor omp reads as a record (`$env.KEY`). */
export const $env: Record<string, string | undefined> = new Proxy(
  {} as Record<string, string | undefined>,
  {
    get: (_target, key: string) => process.env[key],
    has: (_target, key: string) => key in process.env,
  },
) as Record<string, string | undefined>

/** First defined environment variable of `names`. */
export function $pickenv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

/** Boolean environment flag (`1` / `true`). */
export function $flag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true'
}

/** Run `fn` at most once and cache its first result. */
export function once<T extends (...args: any[]) => unknown>(fn: T): T {
  let done = false
  let result: unknown
  return ((...args: any[]) => {
    if (!done) {
      done = true
      result = fn(...args)
    }
    return result
  }) as unknown as T
}

/** Plain-object predicate. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** omp's per-agent state directory; unused by the cursor transport paths we build. */
export function getAgentDir(): string {
  return process.env.OMP_AGENT_DIR ?? process.cwd()
}

/** Structured logger; the plugin hands its own logger in once it mounts (Task 1). */
export const logger = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
}

/**
 * Level functions of omp's `@oh-my-pi/pi-utils/logger` subpath.
 *
 * Modules in this graph import that subpath as a namespace (`import * as
 * logger`), so the names must exist on *this module's* namespace; the root
 * `logger` object above is the other, object-shaped consumer. A namespace
 * member this shim does not export resolves to `undefined` and throws only on
 * the first debug call — which is why these are named explicitly.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
  logger.debug(message, context)
}

export function info(message: string, context?: Record<string, unknown>): void {
  logger.info(message, context)
}

export function warn(message: string, context?: Record<string, unknown>): void {
  logger.warn(message, context)
}

export function error(message: string, context?: Record<string, unknown>): void {
  logger.error(message, context)
}

/** HTTP status carried by a thrown fetch/HTTP2 error, when present. */
export function extractHttpStatusFromError(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

/**
 * Whether an error is worth retrying.
 *
 * `simplify:` omp applies provider-specific retry hints here; the DSH seam
 * owns retry policy for this route (`LlmAdapter.providerRetryPolicy`), so the
 * transport must not double-retry. Upgrade path: map `LlmFailure` fields in the
 * projection instead of teaching this shim a policy.
 */
export function isRetryableError(): boolean {
  return false
}

/** Whether a socket close message is the benign "unexpected close" case. */
export function isUnexpectedSocketCloseMessage(): boolean {
  return false
}

/** Provider retry hint decoded from an error; the seam carries it instead. */
export function extractRetryHint(): undefined {
  return undefined
}

/** Escape text for XML character data. */
export function escapeXmlText(text: string): string {
  return String(text).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] as string,
  )
}

/**
 * Parse JSON that may be truncated mid-stream.
 *
 * The real omp parser (tolerant lexer + relaxed tree builder) is re-exported
 * through a named binding rather than approximated: Cursor's `mcpArgs` frames
 * carry argument maps whose values this must decode, and a strict parse plus
 * `undefined` would turn an LLM-malformed argument into a silently missing tool
 * argument. The build lets this one import reach the installed
 * `@oh-my-pi/pi-utils` source (the shim itself is exempt from the package
 * substitution), so the semantics are omp's byte-for-byte and the drift gate
 * hashes the two sources that implement them.
 */
export const parseJsonWithRepair = realParseJsonWithRepair

/**
 * Throttled streaming parse used on Cursor's tool-argument hot path.
 *
 * The real implementation's geometric gate (re-parse only after the buffer
 * grows by `len / 32`, floored at 256 bytes) is what keeps a long argument
 * buffer O(N log N) instead of O(N²); the returned `parsedLen` is the cursor
 * the transport persists on the block.
 */
export const parseStreamingJsonThrottled = realParseStreamingJsonThrottled

/**
 * Classify a JSON prefix as complete / partial while streaming.
 *
 * The `complete` / `prefix` / `invalid` verdict decides whether a streamed
 * buffer can absorb the next argument chunk or is already unsalvageable.
 */
export const classifyJsonPrefix = realClassifyJsonPrefix

/** JSON serialization helper omp uses for cache keys and logging. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Bounded map with least-recently-used eviction (omp keeps conversation state in it).
 *
 * omp constructs it as `new LRUCache({ max })` and relies on the bound: its
 * per-conversation cache holds serialized history, so an unbounded map would
 * grow with every conversation a long-lived host ever served. Insertion order is
 * the recency order — `set` re-inserts, `get` refreshes — so the first key is
 * always the least recently used one.
 */
export class LRUCache<K, V> {
  readonly #entries = new Map<K, V>()
  readonly #max: number

  constructor(options: { max?: number } = {}) {
    // 0 means "no limit", as in omp's own cache (`positiveInteger(0)` = disabled).
    this.#max = options.max !== undefined && options.max > 0 ? options.max : Number.POSITIVE_INFINITY
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined
    const value = this.#entries.get(key) as V
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    if (this.#entries.size > this.#max) {
      this.#entries.delete(this.#entries.keys().next().value as K)
    }
    return this
  }

  delete(key: K): boolean {
    return this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  get size(): number {
    return this.#entries.size
  }
}

/** TLS-extra-CA fetch wrapper; DSH owns the fetch layer, so this is the identity. */
export function wrapFetchForExtraCa<T>(fetchImpl: T): T {
  return fetchImpl
}

/** omp log directory; this build writes no logs. */
export function getLogsDir(): string {
  return process.env.OMP_LOGS_DIR ?? process.cwd()
}

/** Whether the code runs under `bun test` (never, here). */
export function isBunTestRuntime(): boolean {
  return false
}

/** ENOENT predicate. */
export function isEnoent(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT'
}

/** Structured clone that stays JSON-shaped. */
export function structuredCloneJSON<T>(value: T): T {
  return structuredClone(value)
}

/** Truncate with an ellipsis marker. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Text sanitizer for provider-visible content. */
export function sanitizeText(text: string): string {
  return text
}
