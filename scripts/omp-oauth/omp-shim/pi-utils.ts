/**
 * Node stand-ins for the `@oh-my-pi/pi-utils` surface the omp sign-in graph
 * imports.
 *
 * omp ships TypeScript sources that import a Bun-oriented utility package; the
 * two login flows themselves are Node-portable (`fetch`, timers, crypto). The
 * build swaps that package for this module, the same way the Cursor transport
 * bundle does (`packages/llm-omp/scripts/omp-shim/pi-utils.ts`), but the
 * surface is smaller: a sign-in needs env access, logging and three error
 * predicates, not the streaming JSON parser.
 *
 * Anything not provided here fails the build: esbuild reports a missing named
 * export, and `omp-manifest.json.shimImports` records which of these names the
 * graph actually reaches, so an omp bump that starts calling another one shows
 * up as a manifest diff.
 *
 * @module dsh-keys-manager/omp-oauth/omp-shim/pi-utils
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

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

/** Structured logger; the host renders attempt text, this only traces. */
export const logger = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
}

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

/** Plain-object predicate. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** ENOENT predicate. */
export function isEnoent(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT'
}

/** Whether the code runs under `bun test` (never, here). */
export function isBunTestRuntime(): boolean {
  return false
}

/** omp's HTTP inspector log directory; this build writes no inspector dumps. */
export function getLogsDir(): string {
  return process.env.OMP_LOGS_DIR ?? process.cwd()
}

/** HTTP status carried by a thrown fetch/HTTP2 error, when present. */
export function extractHttpStatusFromError(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

/** Escape text for XML character data. */
export function escapeXmlText(text: string): string {
  return String(text).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] as string,
  )
}

/** Truncate with an ellipsis marker. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Provider retry hint decoded from an error message.
 *
 * `simplify:` the retry hint only decorates error text our host renders
 * verbatim; DSH owns retry policy for the routes these credentials feed, so the
 * sign-in flows must not derive one. Upgrade path: re-export omp's real
 * implementation (it is pure string parsing) if a flow ever branches on it.
 */
export function extractRetryHint(): undefined {
  return undefined
}

/** Whether an error is worth retrying; the seam owns retry policy. */
export function isRetryableError(): boolean {
  return false
}

/** Whether a socket close message is the benign "unexpected close" case. */
export function isUnexpectedSocketCloseMessage(): boolean {
  return false
}
