/**
 * One HTTP read against a vendor usage endpoint, classified into quota status.
 *
 * Both probes share this function so 401/403, 404, timeout and parse failures
 * mean the same thing everywhere: `unauthorized`, `absent`, `error`. It never
 * throws — every failure mode becomes a `QuotaRead` — and the caller's abort
 * signal is combined with a hard timeout so a hung vendor cannot hold a card
 * render open.
 *
 * @module dsh-keys-manager/quota/fetch
 */
import type { QuotaStatus } from './model.js'

/** Injected for tests; the platform `fetch` in production. */
export type QuotaFetch = typeof fetch

/** A parsed 2xx body, or the classified reason the read produced nothing. */
export type QuotaRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: Exclude<QuotaStatus, 'ok'>; reason: string }

/** Per-call overrides; all optional so probes stay one-liners. */
export interface QuotaReadOptions {
  fetch?: QuotaFetch
  signal?: AbortSignal
  timeoutMs?: number
}

/** Hard cap on one vendor read. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** GET `url` and classify the response into a quota read. */
export async function readQuotaJson(
  url: string,
  headers: Record<string, string>,
  options: QuotaReadOptions = {},
): Promise<QuotaRead> {
  const { fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetchImpl(url, { headers, signal: combined })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 'unauthorized', reason: `http ${response.status}` }
    }
    if (response.status === 404) return { ok: false, status: 'absent', reason: 'http 404' }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: 'error', reason: `http ${response.status}` }
    }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, status: 'error', reason: 'non-object body' }
    }
    return { ok: true, body: body as Record<string, unknown> }
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, status: 'error', reason: 'aborted' }
    if (timeout.aborted) return { ok: false, status: 'error', reason: 'timeout' }
    return {
      ok: false,
      status: 'error',
      reason: error instanceof Error ? error.message : 'network error',
    }
  }
}
