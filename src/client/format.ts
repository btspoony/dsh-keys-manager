/** Exact millisecond/minute conversions used by the policy form, and the
 * transport model picker's wire shaping. */
import type { TransportModelsView } from './types'

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
  const warning = typeof record.warning === 'string' && record.warning.length > 0 ? record.warning : undefined
  return warning === undefined ? { catalog, models } : { catalog, models, warning }
}

/** Picker rows for every catalog model, preselecting the configured allow-list. */
export function modelPickerRows(view: TransportModelsView): Array<{ id: string; name: string; selected: boolean }> {
  const selected = new Set(view.models)
  return view.catalog.map(row => ({ id: row.id, name: row.name, selected: selected.has(row.id) }))
}
