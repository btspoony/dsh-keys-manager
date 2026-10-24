/**
 * Vendor usage endpoints, one probe per route id.
 *
 * Probes are deliberately lenient: private endpoints drift, fields come back
 * missing or under aliases, and a card must degrade to `absent`/`error`
 * instead of throwing. This release ships Claude, Codex, Z.AI, Kimi, MiniMax
 * and OpenCode Go; any other route id has no probe and resolves to `absent`,
 * never to a guessed endpoint. Nothing here writes cooldown or failure state.
 *
 * @module dsh-keys-manager/quota/providers
 */
import { readQuotaJson } from './fetch.js'
import type { QuotaFetch, QuotaRead } from './fetch.js'
import { fractionFromUsed, resetFrom } from './model.js'
import type { QuotaSnapshot, QuotaWindow, QuotaWindowId } from './model.js'

/** Everything a probe needs; the credential stays out of the cache. */
export interface QuotaProbeInput {
  token: string
  accountId?: string
  signal?: AbortSignal
  /** Injected for tests; the platform `fetch` in production. */
  fetch?: QuotaFetch
}

/** One provider's usage read, normalized to a snapshot. Never throws. */
export type QuotaProbe = (input: QuotaProbeInput) => Promise<QuotaSnapshot>

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_BETA_HEADER = 'oauth-2025-04-20'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages'
const MINIMAX_QUOTA_URL = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains'
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** A window longer than three days is the weekly pool; the short one is the session. */
const WEEK_SECONDS_THRESHOLD = 3 * 24 * 60 * 60

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Numbers arrive as numbers or numeric strings depending on the endpoint. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Build the snapshot from a classified read. An extraction returns either the
 * windows or a reason string; an empty result is a parse failure, never an
 * "ok" with zero windows.
 */
function snapshotFromRead(
  read: QuotaRead,
  extract: (body: Record<string, unknown>) => QuotaWindow[] | string,
): QuotaSnapshot {
  const fetchedAt = Date.now()
  if (!read.ok) return { status: read.status, fetchedAt, windows: [], reason: read.reason }
  const extracted = extract(read.body)
  if (typeof extracted === 'string') {
    return { status: 'error', fetchedAt, windows: [], reason: extracted }
  }
  if (extracted.length === 0) {
    return { status: 'error', fetchedAt, windows: [], reason: 'unrecognized usage payload' }
  }
  return { status: 'ok', fetchedAt, windows: extracted }
}

/**
 * Lenient reset-time read across aliases: ISO strings, numeric strings, epoch
 * seconds or epoch milliseconds (the fallback covers count-less payloads).
 */
function resetOf(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key]
    const direct = resetFrom(value)
    if (direct !== undefined) return direct
    const numeric = toNumber(value)
    if (numeric !== undefined) return resetFrom(numeric)
  }
  return undefined
}

/** Used fraction from a used/limit counter pair; `undefined` when unusable. */
function fractionFromCounts(used: number | undefined, limit: number | undefined): number | undefined {
  // A negative used count (remaining above the limit) is not "0% used": drop
  // the window instead of rendering a fake empty bar.
  if (used === undefined || limit === undefined || limit <= 0 || used < 0) return undefined
  return Math.min(1, used / limit)
}

/** A span under a day is the session window; longer spans are the weekly pool. */
const SESSION_MAX_MS = 24 * 60 * 60 * 1000

function windowIdForSpan(spanMs: number): QuotaWindowId {
  return spanMs < SESSION_MAX_MS ? 'session' : 'week'
}

/** Window span in milliseconds from a `duration` + unit pair (hours/days/weeks). */
function spanFromDuration(duration: number | undefined, unit: string): number | undefined {
  if (duration === undefined || unit.length === 0) return undefined
  const upper = unit.toUpperCase()
  if (upper.includes('MINUTE')) return duration * 60_000
  if (upper.includes('HOUR')) return duration * 3_600_000
  if (upper.includes('DAY')) return duration * 86_400_000
  if (upper.includes('WEEK')) return duration * 7 * 86_400_000
  return undefined
}

/** Keep the most-binding window per id: several model buckets share one plan quota. */
function tighterWindow(current: QuotaWindow | undefined, next: QuotaWindow): QuotaWindow {
  return current === undefined || next.usedFraction > current.usedFraction ? next : current
}

/** Claude OAuth plan usage: `five_hour` is the session, `seven_day` the week. */
export const claudeQuotaProbe: QuotaProbe = async ({ token, signal, fetch }) => {
  const read = await readQuotaJson(
    CLAUDE_USAGE_URL,
    { Authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_BETA_HEADER },
    { fetch, signal },
  )
  return snapshotFromRead(read, (body) => {
    const windows: QuotaWindow[] = []
    const add = (raw: unknown, id: QuotaWindowId): void => {
      const row = asRecord(raw)
      if (row === undefined) return
      // Anthropic reports USED percent, so the inversion lives in the normalizer.
      const usedPercent = toNumber(row.utilization)
      const usedFraction = usedPercent === undefined ? undefined : fractionFromUsed(usedPercent)
      const resetsAt = resetFrom(row.resets_at ?? row.reset_at ?? row.resetsAt ?? row.resetAt)
      if (usedFraction === undefined || resetsAt === undefined) return
      windows.push({ id, usedFraction, resetsAt })
    }
    add(body.five_hour, 'session')
    add(body.seven_day, 'week')
    return windows
  })
}

/** Codex / ChatGPT plan usage: primary and secondary windows, classified by duration. */
export const codexQuotaProbe: QuotaProbe = async ({ token, accountId, signal, fetch }) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (accountId !== undefined && accountId.length > 0) headers['chatgpt-account-id'] = accountId
  const read = await readQuotaJson(CODEX_USAGE_URL, headers, { fetch, signal })
  return snapshotFromRead(read, (body) => {
    const rateLimit = asRecord(body.rate_limit) ?? asRecord(body.rateLimit) ?? {}
    // Both slots can describe the same window (a 5h primary and a 5h
    // secondary), so collapse repeated ids and keep the tighter one.
    const windows = new Map<QuotaWindowId, QuotaWindow>()
    const add = (raw: unknown, fallback: QuotaWindowId): void => {
      const row = asRecord(raw)
      if (row === undefined) return
      const usedPercent = toNumber(row.used_percent ?? row.usedPercent)
      const usedFraction = usedPercent === undefined ? undefined : fractionFromUsed(usedPercent)
      const resetsAt =
        resetFrom(row.reset_at ?? row.resets_at ?? row.resetAt ?? row.resetsAt) ??
        resetAfterSeconds(toNumber(row.reset_after_seconds ?? row.resetAfterSeconds))
      if (usedFraction === undefined || resetsAt === undefined) return
      const seconds = toNumber(row.limit_window_seconds ?? row.limitWindowSeconds)
      const id: QuotaWindowId =
        seconds === undefined ? fallback : seconds >= WEEK_SECONDS_THRESHOLD ? 'week' : 'session'
      windows.set(id, tighterWindow(windows.get(id), { id, usedFraction, resetsAt }))
    }
    add(rateLimit.primary_window, 'session')
    add(rateLimit.secondary_window, 'week')
    return [...windows.values()]
  })
}

function resetAfterSeconds(seconds: number | undefined): number | undefined {
  return seconds === undefined || seconds <= 0 ? undefined : Date.now() + seconds * 1000
}

/**
 * Z.AI / Zhipu GLM coding-plan quota. The key is sent verbatim, with no
 * `Bearer` prefix, and `percentage` is USED percent. `unit` 3 = hours,
 * 4 = days, 5 = months, 6 = weeks; `TIME_LIMIT` buckets only map when their
 * unit says hours or weeks (the monthly MCP-call quota stays unmapped).
 */
export const zaiQuotaProbe: QuotaProbe = async ({ token, signal, fetch }) => {
  const read = await readQuotaJson(
    ZAI_QUOTA_URL,
    { Authorization: token, 'Content-Type': 'application/json' },
    { fetch, signal },
  )
  return snapshotFromRead(read, (body) => {
    if (body.success === false) return 'usage request rejected'
    const data = asRecord(body.data) ?? {}
    const limits = Array.isArray(data.limits) ? data.limits : []
    const windows = new Map<QuotaWindowId, QuotaWindow>()
    for (const raw of limits) {
      const row = asRecord(raw)
      if (row === undefined) continue
      const unit = toNumber(row.unit)
      const id: QuotaWindowId | undefined = unit === 3 ? 'session' : unit === 6 ? 'week' : undefined
      if (id === undefined) continue
      // `percentage` is a server-rounded integer; the counters are exact.
      // A present-but-invalid counter pair (negative spend) drops the window
      // instead of falling back to the rounded percentage — only a MISSING
      // field may fall back.
      const spent = toNumber(row.currentValue)
      const usedFraction = spent !== undefined
        ? fractionFromCounts(spent, toNumber(row.usage))
        : fractionFromUsed(toNumber(row.percentage) ?? Number.NaN)
      const resetsAt = resetOf(row, ['nextResetTime', 'next_reset_time'])
      if (usedFraction === undefined || resetsAt === undefined) continue
      windows.set(id, tighterWindow(windows.get(id), { id, usedFraction, resetsAt }))
    }
    return [...windows.values()]
  })
}

/**
 * Kimi Code quota: the aggregate `usage` object is the weekly window, each
 * `limits[]` row is classified by its `window.duration` + `time_unit`.
 * Numbers arrive as strings.
 */
export const kimiQuotaProbe: QuotaProbe = async ({ token, signal, fetch }) => {
  const read = await readQuotaJson(KIMI_USAGE_URL, { Authorization: `Bearer ${token}` }, { fetch, signal })
  return snapshotFromRead(read, (body) => {
    const windows = new Map<QuotaWindowId, QuotaWindow>()
    const add = (usedFraction: number | undefined, resetsAt: number | undefined, id: QuotaWindowId): void => {
      if (usedFraction === undefined || resetsAt === undefined) return
      windows.set(id, tighterWindow(windows.get(id), { id, usedFraction, resetsAt }))
    }
    const usage = asRecord(body.usage)
    if (usage !== undefined) {
      const limit = toNumber(usage.limit)
      const used =
        toNumber(usage.used) ??
        (toNumber(usage.remaining) !== undefined && limit !== undefined
          ? limit - (toNumber(usage.remaining) as number)
          : undefined)
      add(fractionFromCounts(used, limit), resetOf(usage, ['resetTime', 'reset_time']), 'week')
    }
    const limits = Array.isArray(body.limits) ? body.limits : []
    for (const raw of limits) {
      const row = asRecord(raw)
      if (row === undefined) continue
      const window = asRecord(row.window) ?? {}
      const detail = asRecord(row.detail) ?? row
      const spanMs = spanFromDuration(
        toNumber(window.duration),
        String(window.time_unit ?? window.timeUnit ?? ''),
      )
      if (spanMs === undefined) continue
      const limit = toNumber(detail.limit)
      const used =
        toNumber(detail.used) ??
        (toNumber(detail.remaining) !== undefined && limit !== undefined
          ? limit - (toNumber(detail.remaining) as number)
          : undefined)
      add(fractionFromCounts(used, limit), resetOf(detail, ['resetTime', 'reset_time']), windowIdForSpan(spanMs))
    }
    return [...windows.values()]
  })
}

/**
 * MiniMax coding-plan quota. The vendor answers HTTP 200 even for a rejected
 * credential, so `base_resp.status_code` is the real success signal. Plan-wide
 * buckets repeat the same two windows, so the most-binding row wins.
 */
export const minimaxQuotaProbe: QuotaProbe = async ({ token, signal, fetch }) => {
  const read = await readQuotaJson(MINIMAX_QUOTA_URL, { Authorization: `Bearer ${token}` }, { fetch, signal })
  return snapshotFromRead(read, (body) => {
    const baseResp = asRecord(body.base_resp)
    if (baseResp !== undefined && toNumber(baseResp.status_code) !== 0) {
      return `usage request rejected (${String(baseResp.status_code)})`
    }
    const rows = Array.isArray(body.model_remains) ? body.model_remains : []
    const windows = new Map<QuotaWindowId, QuotaWindow>()
    for (const raw of rows) {
      const row = asRecord(raw)
      if (row === undefined) continue
      const add = (
        id: QuotaWindowId,
        total: string,
        usage: string,
        remaining: string,
        endTime: string,
        remainsTime: string,
      ): void => {
        const limit = toNumber(row[total])
        const used = toNumber(row[usage])
        const left = toNumber(row[remaining])
        // The remaining-based fallback is for a MISSING usage counter only: a
        // present-but-negative count is corrupt data, and deriving 0% from it
        // would render a healthy bar for a payload we cannot interpret.
        const usedFraction = used !== undefined
          ? fractionFromCounts(used, limit)
          : left !== undefined && limit !== undefined && limit > 0 && left <= limit
            ? Math.min(1, 1 - left / limit)
            : undefined
        const resetsAt =
          resetOf(row, [endTime]) ?? resetAfterMs(toNumber(row[remainsTime]))
        if (usedFraction === undefined || resetsAt === undefined) return
        windows.set(id, tighterWindow(windows.get(id), { id, usedFraction, resetsAt }))
      }
      add(
        'session',
        'current_interval_total_count',
        'current_interval_usage_count',
        'current_interval_remaining_count',
        'end_time',
        'remains_time',
      )
      add(
        'week',
        'current_weekly_total_count',
        'current_weekly_usage_count',
        'current_weekly_remaining_count',
        'weekly_end_time',
        'weekly_remains_time',
      )
    }
    return [...windows.values()]
  })
}

/** Relative delays are reported in milliseconds; only positives are usable. */
function resetAfterMs(ms: number | undefined): number | undefined {
  return ms === undefined || ms <= 0 ? undefined : Date.now() + ms
}

/**
 * OpenCode Go quota. `percent` is USED percent, `resetsAt` an ISO stamp, and
 * `status: 'rate-limited'` outranks the percent. The monthly window anchors on
 * the subscription anniversary, so it is deliberately not mapped to `week`.
 */
export const opencodeGoQuotaProbe: QuotaProbe = async ({ token, signal, fetch }) => {
  const read = await readQuotaJson(OPENCODE_GO_USAGE_URL, { Authorization: `Bearer ${token}` }, { fetch, signal })
  return snapshotFromRead(read, (body) => {
    const usage = asRecord(body.usage) ?? {}
    const windows: QuotaWindow[] = []
    const add = (raw: unknown, id: QuotaWindowId): void => {
      const row = asRecord(raw)
      if (row === undefined) return
      const rateLimited = row.status === 'rate-limited'
      const usedFraction = rateLimited ? 1 : fractionFromUsed(toNumber(row.percent) ?? Number.NaN)
      const resetsAt = resetOf(row, ['resetsAt', 'resets_at'])
      if (usedFraction === undefined || resetsAt === undefined) return
      windows.push({ id, usedFraction, resetsAt })
    }
    add(usage.rolling, 'session')
    add(usage.weekly, 'week')
    return windows
  })
}

/**
 * Route id → probe. The ids are the variants this repo and the Host directory
 * actually use (OAuth catalog ids `anthropic`/`openai-codex`/`kimi-coding`, the
 * seed routes in `src/providers.ts`, the sign-in routes in `src/oauth`).
 * Unknown ids have no entry by design and resolve to `absent`.
 *
 * shortcut: the CN-region routes (`zai-coding-cn`, `minimax-code-cn`) reuse the
 * international endpoints, so a CN key reports `unauthorized`; add per-region
 * base URLs when a CN-hosted account must show quota.
 */
const QUOTA_PROBES: Readonly<Record<string, QuotaProbe>> = Object.freeze({
  claude: claudeQuotaProbe,
  anthropic: claudeQuotaProbe,
  codex: codexQuotaProbe,
  'openai-codex': codexQuotaProbe,
  zai: zaiQuotaProbe,
  'zai-coding-cn': zaiQuotaProbe,
  'zhipu-coding-plan': zaiQuotaProbe,
  kimi: kimiQuotaProbe,
  'kimi-code': kimiQuotaProbe,
  'kimi-coding': kimiQuotaProbe,
  minimax: minimaxQuotaProbe,
  'minimax-code': minimaxQuotaProbe,
  'minimax-code-cn': minimaxQuotaProbe,
  'opencode-go': opencodeGoQuotaProbe,
})

/** The probe for a route id, or `undefined` when the provider exposes no usage API. */
export function quotaProbe(provider: string): QuotaProbe | undefined {
  // Own-property check: a plain index would answer `constructor` with a
  // function and hand it back as if it were a probe.
  return Object.hasOwn(QUOTA_PROBES, provider) ? QUOTA_PROBES[provider] : undefined
}

/**
 * Probe one route id, degrading an unknown route to `absent` and a probe that
 * somehow throws to `error`, so callers never handle an exception.
 */
export async function resolveQuota(provider: string, input: QuotaProbeInput): Promise<QuotaSnapshot> {
  const probe = quotaProbe(provider)
  if (probe === undefined) {
    return { status: 'absent', fetchedAt: Date.now(), windows: [], reason: `no quota profile for ${provider}` }
  }
  try {
    return await probe(input)
  } catch (error) {
    return {
      status: 'error',
      fetchedAt: Date.now(),
      windows: [],
      reason: error instanceof Error ? error.message : 'quota probe failed',
    }
  }
}
