/** Exact millisecond/minute conversions used by the policy form, the
 * transport model picker's wire shaping, and the quota strip's readouts. */
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

/** How long a snapshot serves before the strip asks for a new one (D4). */
export const QUOTA_TTL_MS = 300_000

/** Short window labels; technical abbreviations, identical in both locales. */
export const QUOTA_WINDOW_LABEL: Record<QuotaWindowId, string> = { session: '5h', week: 'W' }

const QUOTA_WINDOW_ORDER: readonly QuotaWindowId[] = ['session', 'week']

/** Whole percentage the card prints; clamped so a hostile fraction cannot print 140%. */
export function quotaPercent(fraction: number): number {
  return Math.min(100, Math.max(0, Math.round(fraction * 100)))
}

/** Bar tone of one window: exhausted, nearly exhausted, or normal. */
export function quotaTone(usedFraction: number): 'normal' | 'warn' | 'error' {
  if (usedFraction >= 1) return 'error'
  return usedFraction >= 0.9 ? 'warn' : 'normal'
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
 * True while any row still has no snapshot, or holds a usable one past its
 * TTL. Only `ok` snapshots age out: the host stamps `fetchedAt: 0` on
 * `absent`/`unauthorized`/`error` answers and caches them under its own
 * backoff, so treating those as stale would re-issue a refresh forever.
 */
export function quotaNeedsRefresh(quotas: ReadonlyArray<QuotaView | undefined>, now: number): boolean {
  return quotas.some(
    quota => quota === undefined || (quota.status === 'ok' && now - quota.fetchedAt > QUOTA_TTL_MS),
  )
}
