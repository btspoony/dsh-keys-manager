/**
 * Vendor usage endpoints, one probe per route id.
 *
 * Probes are deliberately lenient: private endpoints drift, fields come back
 * missing or under aliases, and a card must degrade to `absent`/`error`
 * instead of throwing. This first release ships Claude and Codex; any other
 * route id has no probe and resolves to `absent`, never to a guessed
 * endpoint. Nothing here writes cooldown or failure state.
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

/** Build the snapshot from a classified read; an empty window list is a parse failure. */
function snapshotFromRead(
  read: QuotaRead,
  extract: (body: Record<string, unknown>) => QuotaWindow[],
): QuotaSnapshot {
  const fetchedAt = Date.now()
  if (!read.ok) return { status: read.status, fetchedAt, windows: [], reason: read.reason }
  const windows = extract(read.body)
  if (windows.length === 0) {
    return { status: 'error', fetchedAt, windows: [], reason: 'unrecognized usage payload' }
  }
  return { status: 'ok', fetchedAt, windows }
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
      const resetsAt = resetFrom(row.resets_at ?? row.resetsAt)
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
    const windows: QuotaWindow[] = []
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
      windows.push({ id, usedFraction, resetsAt })
    }
    add(rateLimit.primary_window, 'session')
    add(rateLimit.secondary_window, 'week')
    return windows
  })
}

function resetAfterSeconds(seconds: number | undefined): number | undefined {
  return seconds === undefined || seconds <= 0 ? undefined : Date.now() + seconds * 1000
}

/** Route id → probe. Unknown ids have no entry by design. */
const QUOTA_PROBES: Readonly<Record<string, QuotaProbe>> = Object.freeze({
  claude: claudeQuotaProbe,
  codex: codexQuotaProbe,
})

/** The probe for a route id, or `undefined` when the provider exposes no usage API. */
export function quotaProbe(provider: string): QuotaProbe | undefined {
  return QUOTA_PROBES[provider]
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
