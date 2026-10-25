/**
 * Quota-domain types and the pure unit normalizers every probe shares.
 *
 * Vendors disagree on nearly every unit: Claude reports *used* utilization
 * and an ISO reset stamp, Codex reports used percent with epoch seconds or a
 * relative delay under aliased keys. Normalizing here keeps the probes thin
 * and keeps "used" vs "remaining" invertible in one tested place. Nothing in
 * this module touches the network, the clock, the filesystem, or key
 * selection state.
 *
 * @module dsh-keys-manager/quota/model
 */
import type { QuotaWindowId } from '../domain.js'


/**
 * Outcome class of one quota read. Only `ok` carries usable windows; probes
 * produce the first four, while `natively-managed` is host-only: the route is
 * served by a DSH-managed projection whose credential this process cannot read.
 */
export type QuotaStatus = 'ok' | 'absent' | 'unauthorized' | 'error' | 'natively-managed'

export type { QuotaWindowId }

/** One usage window of a managed account's plan. */
export interface QuotaWindow {
  id: QuotaWindowId
  /** Share of the window already consumed, `0`..`1`. */
  usedFraction: number
  /** Reset time as epoch milliseconds. */
  resetsAt: number
}

/** Normalized, cacheable result of one probe. */
export interface QuotaSnapshot {
  status: QuotaStatus
  /** Epoch milliseconds when the probe ran. */
  fetchedAt: number
  windows: QuotaWindow[]
  /** Diagnostic detail for non-`ok` states; never rendered verbatim. */
  reason?: string
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Used percentage (`0`..`100`, may exceed) → used fraction. A negative count
 * is not "0% used" — it is a vendor payload we cannot interpret, so it yields
 * `undefined` and the caller drops the window instead of printing a fake bar.
 * The upper clamp stays: over-100% still means exhausted.
 */
export function fractionFromUsed(usedPercent: number): number | undefined {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined
  return clampFraction(usedPercent / 100)
}

/**
 * Remaining percentage (`0`..`100`) → used fraction. Remaining above 100% is
 * equally uninterpretable and yields `undefined`.
 */
export function fractionFromRemaining(remainingPercent: number): number | undefined {
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) return undefined
  return clampFraction(1 - remainingPercent / 100)
}

/** Epoch seconds → epoch milliseconds. */
export function resetFromSeconds(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** Epoch milliseconds → epoch milliseconds (validated). */
export function resetFromMs(ms: number): number | undefined {
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** ISO-8601 string → epoch milliseconds; an unparseable string is `undefined`. */
export function resetFromIso(iso: string): number | undefined {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Lenient reset-time normalizer: epoch seconds, epoch milliseconds or an ISO
 * string, whichever alias the vendor returned.
 */
export function resetFrom(value: unknown): number | undefined {
  if (typeof value === 'number') {
    // Epoch milliseconds passed 1e12 in 2001; anything below that is seconds.
    return Math.abs(value) < 1e12 ? resetFromSeconds(value) : resetFromMs(value)
  }
  if (typeof value === 'string' && value.length > 0) return resetFromIso(value)
  return undefined
}
