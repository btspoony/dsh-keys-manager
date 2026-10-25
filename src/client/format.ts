/** Exact millisecond/minute conversions used by the policy form, the
 * transport model picker's wire shaping, and the quota readouts. */
import type { QuotaView, QuotaWindowId, QuotaWindowView, TransportModelsView } from './types'

export function cooldownMinutes(ms: number): number {
  return ms / 60_000
}

/** Convert a user-entered base cooldown to milliseconds without rounding. */
export function cooldownMs(minutes: number): number {
  return Math.max(0.5, minutes) * 60_000
}

/** Convert a user-entered recovery grace to minutes. */
export function graceMinutes(ms: number): number {
  return ms / 60_000
}

/** Convert a user-entered recovery grace to milliseconds without rounding. */
export function graceMs(minutes: number): number {
  return Math.max(0, minutes) * 60_000
}

/** Narrow the wire's model-picker payload; malformed or absent fields shape to empty. */
export function shapeTransportModels(value: unknown): TransportModelsView {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const catalog: TransportModelsView['catalog'] = []
  if (Array.isArray(record.catalog)) {
    for (const row of record.catalog) {
      if (row === null || typeof row !== 'object') continue
      const { id, name } = row as { id?: unknown; name?: unknown }
      if (typeof id === 'string' && id.length > 0 && typeof name === 'string') catalog.push({ id, name })
    }
  }
  const models = Array.isArray(record.models) ? record.models.filter((id): id is string => typeof id === 'string') : []
  // Only the fact crosses the wire; the picker resolves its own localized copy.
  return record.missingCatalog === true ? { catalog, models, missingCatalog: true } : { catalog, models }
}

/** Picker rows for every catalog model, preselecting the configured allow-list. */
export function modelPickerRows(view: TransportModelsView): Array<{ id: string; name: string; selected: boolean }> {
  const selected = new Set(view.models)
  return view.catalog.map(row => ({ id: row.id, name: row.name, selected: selected.has(row.id) }))
}

/**
 * How long an `ok` snapshot serves before the card asks for a new one (D4).
 * This is the server's MAXIMUM freshness (`ttlMs * (1 + jitterRatio)` =
 * 300 s × 1.25); asking earlier could be answered by a guaranteed cache hit.
 */
export const QUOTA_TTL_MS = 375_000

/**
 * How long a non-`ok` snapshot is trusted before the card retries it (D2).
 * Long enough not to hammer private endpoints, short enough that a token pi-ai
 * refreshed on model traffic shows up in the same session.
 */
export const QUOTA_RETRY_MS = 10 * 60 * 1000

/** Short window labels; technical abbreviations, identical in both locales. */
export const QUOTA_WINDOW_LABEL: Record<QuotaWindowId, string> = { session: '5h', week: 'W' }

const QUOTA_WINDOW_ORDER: readonly QuotaWindowId[] = ['session', 'week']

/** Whole percentage the card prints; clamped so a hostile fraction cannot print 140%. */
export function quotaPercent(fraction: number): number {
  return Math.min(100, Math.max(0, Math.round(fraction * 100)))
}

/** The windows a row can render, in session-then-week order. */
export function quotaWindows(quota: QuotaView | undefined): QuotaWindowView[] {
  if (quota === undefined || quota.status !== 'ok') return []
  return QUOTA_WINDOW_ORDER.map(id => quota.windows.find(window => window.id === id)).filter(
    (window): window is QuotaWindowView => window !== undefined,
  )
}

/**
 * The single window the collapsed card shows: the most-used one across the
 * provider's accounts, so the compact line is the tightest constraint.
 */
export function tightestQuotaWindow(quotas: ReadonlyArray<QuotaView | undefined>): QuotaWindowView | undefined {
  let tightest: QuotaWindowView | undefined
  for (const quota of quotas) {
    for (const window of quotaWindows(quota)) {
      if (tightest === undefined || window.usedFraction > tightest.usedFraction) tightest = window
    }
  }
  return tightest
}

/**
 * True while any row still has no snapshot, holds a usable one past its TTL, or
 * holds a non-`ok` one past the slower retry cadence.
 *
 * Every snapshot carries the host cache's `fetchedAt`, so a failed or
 * non-reporting state is retried every `QUOTA_RETRY_MS` instead of sticking
 * until the card remounts; the host's own per-row backoff still gates the
 * vendor call behind it.
 */
export function quotaNeedsRefresh(quotas: ReadonlyArray<QuotaView | undefined>, now: number): boolean {
  return quotas.some(quota => {
    if (quota === undefined) return true
    if (quota.status !== 'ok') return now - quota.fetchedAt > QUOTA_RETRY_MS
    // A stale last-good `ok` snapshot (kept by the host cache over a failed
    // probe) is display data, not a fact: re-check it on the slow cadence
    // instead of trusting it for the cache's 24 h retention.
    if (quota.stale === true) return now - quota.fetchedAt > QUOTA_RETRY_MS
    return now - quota.fetchedAt > QUOTA_TTL_MS
  })
}
