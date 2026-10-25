/**
 * In-memory quota cache: TTL with jitter, single-flight per account, failure
 * backoff, and last-good retention.
 *
 * The Host owns one instance. Nothing is persisted and nothing is polled: a
 * read either serves a snapshot or performs at most one in-flight vendor call
 * per (provider, key). Failures are cached too, so a rate-limited endpoint is
 * not hammered on every card render; a last-good snapshot stays visible
 * (flagged `stale`) for up to 24 h before the failure state replaces it.
 * Quota state here never feeds selection, cooldown or failure escalation.
 *
 * @module dsh-keys-manager/quota/cache
 */
import type { QuotaSnapshot } from './model.js'

/** A snapshot as served to the UI: `stale` marks last-good data behind a failure. */
export interface QuotaSnapshotView extends QuotaSnapshot {
  stale?: boolean
}

/** Cache policy overrides; every field has a production default. */
export interface QuotaCacheOptions {
  /** Base freshness window; defaults to 300 s. */
  ttlMs?: number
  /** Symmetric jitter as a fraction of `ttlMs`; defaults to 0.25 (±25%). */
  jitterRatio?: number
  /** Retry delay after `error`/`absent`; defaults to 10 s. */
  failureBackoffMs?: number
  /** Retry delay after `unauthorized`; defaults to 60 s. */
  unauthorizedBackoffMs?: number
  /** How long a last-good snapshot may outlive a failure; defaults to 24 h. */
  staleMs?: number
  /** Injected clock for tests. */
  now?: () => number
  /** Injected randomness for jitter tests; `[0, 1]`. */
  random?: () => number
}

const DEFAULT_POLICY = {
  ttlMs: 300_000,
  jitterRatio: 0.25,
  failureBackoffMs: 10_000,
  unauthorizedBackoffMs: 60_000,
  staleMs: 24 * 60 * 60 * 1000,
} as const

interface CacheEntry {
  snapshot: QuotaSnapshotView
  /** No new vendor call before this time (freshness window or failure backoff). */
  nextAttemptAt: number
  lastGood?: QuotaSnapshot
}

/** Shared cache across all provider cards; safe for concurrent reads. */
export class QuotaCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<QuotaSnapshotView>>()
  private readonly ttlMs: number
  private readonly jitterRatio: number
  private readonly failureBackoffMs: number
  private readonly unauthorizedBackoffMs: number
  private readonly staleMs: number
  private readonly now: () => number
  private readonly random: () => number

  constructor(options: QuotaCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_POLICY.ttlMs
    this.jitterRatio = options.jitterRatio ?? DEFAULT_POLICY.jitterRatio
    this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_POLICY.failureBackoffMs
    this.unauthorizedBackoffMs = options.unauthorizedBackoffMs ?? DEFAULT_POLICY.unauthorizedBackoffMs
    this.staleMs = options.staleMs ?? DEFAULT_POLICY.staleMs
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /**
   * Serve one account's snapshot, loading it at most once per freshness or
   * backoff window. Concurrent reads of the same account share one load.
   */
  get(provider: string, keyId: string, load: () => Promise<QuotaSnapshot>): Promise<QuotaSnapshotView> {
    const key = `${provider}\u0000${keyId}`
    const now = this.now()
    const entry = this.entries.get(key)
    if (entry !== undefined && now < entry.nextAttemptAt) return Promise.resolve(entry.snapshot)
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending
    const promise = this.load(key, now, load).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async load(
    key: string,
    now: number,
    load: () => Promise<QuotaSnapshot>,
  ): Promise<QuotaSnapshotView> {
    const result = await this.settle(load, now)
    const previous = this.entries.get(key)
    // The cache owns the clock, so probe time and test time cannot diverge.
    const stamped: QuotaSnapshot = { ...result, fetchedAt: now }
    // Only transient outcomes keep the last-good numbers for display. A
    // deterministic fact about the credential (`unauthorized`, or the
    // host-synthesized `natively-managed`) must replace them: serving old
    // numbers there would hide a refusal or an expired credential for up to
    // `staleMs`, and no client-side retry could ever surface the truth.
    const transient = stamped.status === 'error' || stamped.status === 'absent'
    const lastGood =
      stamped.status === 'ok' ? stamped : transient ? previous?.lastGood : undefined
    const keepLastGood =
      transient && lastGood !== undefined && now - lastGood.fetchedAt <= this.staleMs
    const served: QuotaSnapshotView =
      keepLastGood && lastGood !== undefined ? { ...lastGood, stale: true } : { ...stamped, stale: false }
    this.entries.set(key, {
      snapshot: served,
      nextAttemptAt: now + this.retryDelay(stamped.status),
      lastGood,
    })
    return served
  }

  /**
   * The snapshot currently held for one account, without loading. The normal
   * state path uses this so a card render can never reach a vendor (D2).
   */
  peek(provider: string, keyId: string): QuotaSnapshotView | undefined {
    return this.entries.get(`${provider}\u0000${keyId}`)?.snapshot
  }

  private retryDelay(status: QuotaSnapshot['status']): number {
    if (status === 'ok') {
      const jitter = this.jitterRatio * (2 * this.random() - 1)
      return this.ttlMs * (1 + jitter)
    }
    return status === 'unauthorized' ? this.unauthorizedBackoffMs : this.failureBackoffMs
  }

  private async settle(load: () => Promise<QuotaSnapshot>, now: number): Promise<QuotaSnapshot> {
    try {
      return await load()
    } catch (error) {
      return {
        status: 'error',
        fetchedAt: now,
        windows: [],
        reason: error instanceof Error ? error.message : 'quota probe failed',
      }
    }
  }
}
