/**
 * Pure key-selection and cooldown policy for the Keys Manager.
 *
 * Nothing here touches Cordis, the filesystem, or a secret. The Host passes
 * plain provider records in and gets the same records back, which keeps the
 * round-robin, sticky-session, cooldown-escalation, and retry decisions
 * unit-testable without a running Harness.
 */
import type {
  KeyRecord,
  KeyStatus,
  ManagerSettings,
  ProviderRecord,
  ProviderStatus,
} from './domain.js'
import type { LlmFailureLike } from './host-types.js'

/** Defaults also exposed in the manager's policy card. */
export const DEFAULT_SETTINGS: ManagerSettings = {
  retryCount: 2,
  baseCooldownMs: 5 * 60 * 1000,
  recoveryGraceMs: 10 * 60 * 1000,
  maxCooldownMs: 7 * 24 * 60 * 60 * 1000,
  stickySession: true,
  autoSwitch: true,
}

const MIN_COOLDOWN_MS = 30 * 1000
const MAX_KEYS_PER_PROVIDER = 32
const MAX_ALIAS_LENGTH = 80
const MAX_KEY_LENGTH = 16 * 1024

/** Failure codes that describe the request or configuration, not the key. */
const NON_KEY_FAILURE_CODES = new Set<string>([
  'ABORTED',
  'CANCELLED',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE_REQUEST',
  'IMAGE_OFFLOAD_REQUIRED',
  'INVALID_PREPARED_CALL',
  'INVALID_REQUEST',
  'NO_ADAPTER',
  'REGISTRATION_DISPOSED',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_OPTION',
])

/** Normalize one persisted settings object. */
export function normalizeSettings(value: unknown): ManagerSettings {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    retryCount: clampInteger(source.retryCount, 1, 3, DEFAULT_SETTINGS.retryCount),
    baseCooldownMs: clampInteger(
      source.baseCooldownMs,
      MIN_COOLDOWN_MS,
      DEFAULT_SETTINGS.maxCooldownMs,
      DEFAULT_SETTINGS.baseCooldownMs,
    ),
    recoveryGraceMs: clampInteger(
      source.recoveryGraceMs,
      0,
      DEFAULT_SETTINGS.maxCooldownMs,
      DEFAULT_SETTINGS.recoveryGraceMs,
    ),
    maxCooldownMs: DEFAULT_SETTINGS.maxCooldownMs,
    stickySession: source.stickySession !== false,
    autoSwitch: source.autoSwitch !== false,
  }
}

/** Apply and validate a settings patch from the UI; throws on nonsense. */
export function patchSettings(current: ManagerSettings, patch: unknown): ManagerSettings {
  const source = patch !== null && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  if (source.retryCount !== undefined) {
    if (!Number.isInteger(source.retryCount) || (source.retryCount as number) < 1 || (source.retryCount as number) > 3) {
      throw new TypeError('retryCount must be an integer from 1 to 3')
    }
  }
  if (source.baseCooldownMs !== undefined) {
    if (!Number.isFinite(source.baseCooldownMs) || (source.baseCooldownMs as number) < MIN_COOLDOWN_MS) {
      throw new TypeError('baseCooldownMs must be at least 30 seconds')
    }
  }
  if (source.recoveryGraceMs !== undefined) {
    if (!Number.isFinite(source.recoveryGraceMs) || (source.recoveryGraceMs as number) < 0) {
      throw new TypeError('recoveryGraceMs must be zero or positive')
    }
  }
  return normalizeSettings({ ...current, ...source })
}

/** Clamp an untyped numeric setting. */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Whether a key may serve a request now. */
export function isSelectable(key: KeyRecord | undefined, now: number): key is KeyRecord {
  if (key === undefined) return false
  if (key.enabled === false || key.valueMissing === true) return false
  return !(Number(key.cooldownUntil) > now)
}

/** Pick the next healthy key for a provider in creation order, advancing the cursor. */
export function pickRoundRobin(provider: ProviderRecord, now: number, exclude?: ReadonlySet<string>): KeyRecord | undefined {
  const keys = Array.isArray(provider.keys) ? provider.keys : []
  if (keys.length === 0) return undefined
  const start = normalizeCursor(provider.cursor, keys.length)
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const key = keys[index]
    if (exclude?.has(key.id)) continue
    if (isSelectable(key, now)) {
      provider.cursor = (index + 1) % keys.length
      return key
    }
  }
  return undefined
}

/** Pick the next healthy key other than `excludeKeyId`, advancing the cursor. */
export function pickHealthyExcluding(provider: ProviderRecord, excludeKeyId: string, now: number): KeyRecord | undefined {
  const keys = Array.isArray(provider.keys) ? provider.keys : []
  if (keys.length === 0) return undefined
  const start = normalizeCursor(provider.cursor, keys.length)
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const key = keys[index]
    if (key.id === excludeKeyId) continue
    if (isSelectable(key, now)) {
      provider.cursor = (index + 1) % keys.length
      return key
    }
  }
  return undefined
}

/** Coerce a persisted cursor into range without mutating it. */
export function normalizeCursor(cursor: number, length: number): number {
  if (!Number.isInteger(cursor) || length <= 0) return 0
  return ((cursor % length) + length) % length
}

/** Result of marking one key failure. */
export interface CooldownResult {
  cooldownMs: number
  level: number
  cooldownUntil: number
}

/**
 * Record one failed key use and start (or extend) its cooldown.
 *
 * First failure: base cooldown. A failure while cooling, or within the
 * recovery grace window after the previous cooldown expired, doubles the
 * level. A long healthy gap resets the level, so an occasional failure does
 * not inherit ancient escalation. The result is always capped at seven days.
 */
export function applyFailureCooldown(
  key: KeyRecord,
  settings: ManagerSettings,
  now: number,
  failure: LlmFailureLike | undefined,
): CooldownResult {
  const normalized = normalizeSettings(settings)
  const previousLevel = Number.isInteger(key.failureLevel) ? key.failureLevel : 0
  const previousUntil = Number(key.cooldownUntil) || 0
  let level = 0
  if (previousUntil > 0) {
    if (now <= previousUntil) level = previousLevel + 1
    else if (now - previousUntil <= normalized.recoveryGraceMs) level = previousLevel + 1
    else level = 0
  }
  const providerDelay = Number(failure?.providerRetryAfterMs)
  const base = Math.max(MIN_COOLDOWN_MS, normalized.baseCooldownMs)
  const exponential = Math.min(normalized.maxCooldownMs, base * 2 ** Math.min(level, 30))
  const requested = Number.isFinite(providerDelay) && providerDelay > 0 ? Math.max(exponential, providerDelay) : exponential
  const cooldownMs = Math.max(1, Math.min(normalized.maxCooldownMs, requested))
  key.failureLevel = level
  key.cooldownUntil = now + cooldownMs
  key.lastFailureAt = now
  key.lastFailureCode = typeof failure?.code === 'string' ? failure.code : ''
  key.consecutiveFailures = (Number(key.consecutiveFailures) || 0) + 1
  key.totalFailures = (Number(key.totalFailures) || 0) + 1
  return { cooldownMs, level, cooldownUntil: key.cooldownUntil }
}

/**
 * Record one successful use: clear the failure streak, but keep the previous
 * cooldown timestamp/level until the recovery grace window has elapsed. A
 * failure shortly after recovery must still escalate.
 */
export function markKeySuccess(key: KeyRecord, now: number): void {
  key.lastUsedAt = now
  key.consecutiveFailures = 0
  key.lastFailureCode = ''
  key.totalUses = (Number(key.totalUses) || 0) + 1
}

/** Record that a request used a key, without changing health. */
export function markKeyUsed(key: KeyRecord, now: number): void {
  key.lastUsedAt = now
}

/** Status a key row renders. */
export function statusOfKey(key: KeyRecord | undefined, now: number): KeyStatus {
  if (key === undefined) return 'missing'
  if (key.enabled === false) return 'paused'
  if (key.valueMissing === true) return 'missing'
  if (Number(key.cooldownUntil) > now) return 'cooling'
  return 'active'
}

/** Status a provider row renders. */
export function statusOfProvider(keys: readonly KeyRecord[], now: number): ProviderStatus {
  if (keys.length === 0) return 'empty'
  const statuses = keys.map(key => statusOfKey(key, now))
  if (statuses.includes('active')) return 'active'
  if (statuses.includes('cooling')) return 'cooling'
  if (statuses.includes('paused')) return 'paused'
  return 'missing'
}

/** Whether a model-request failure should affect key health at all. */
export function shouldFailover(code: string | undefined): boolean {
  return typeof code === 'string' && code.length > 0 && !NON_KEY_FAILURE_CODES.has(code)
}

/** Failure code pi-ai raises for OAuth-specific problems (grant expired, refresh rejected, ...). */
export const OAUTH_FAILURE_CODE = 'oauth'

/** Credential-reference scope prefix under which OAuth grant payloads live. */
export const OAUTH_GRANT_SCOPE = 'keys-manager'

/** How one model-request failure affects pool health. */
export type FailureDisposition =
  /** OAuth-specific failure: failover-eligible and starts a cooldown. */
  | 'oauth'
  /** Ordinary key failure: failover-eligible and starts a cooldown (existing semantics). */
  | 'failover'
  /** Request/config-shaped failure: the candidate's health is untouched. */
  | 'ignore'

/**
 * Classify one model-request failure against the pool policy.
 *
 * pi-ai raises `ModelsError("oauth", ...)` when the OAuth grant itself is
 * the problem; that must cool the account down and fail over, while the
 * existing `NON_KEY_FAILURE_CODES` exclusions (e.g.
 * `CONTEXT_WINDOW_EXCEEDED`) stay excluded unchanged.
 */
export function classifyOAuthFailure(failure: LlmFailureLike | undefined): FailureDisposition {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  if (code === OAUTH_FAILURE_CODE) return 'oauth'
  return shouldFailover(code) ? 'failover' : 'ignore'
}

/** Whether a provider route supports OAuth account sign-in. */
export function isOAuthCapable(provider: { nativeAuth?: { env?: readonly string[]; oauth?: boolean } | null } | undefined): boolean {
  return provider?.nativeAuth?.oauth === true
}

/**
 * Build the plugin-scope credential reference that holds one account's
 * grant payload, e.g. `keys-manager/anthropic-3fa2c1`. The name part stays
 * within the lowercase-hyphen credential key charset: a stem whose first
 * character is a digit is prefixed with `p-` so the reference is always
 * acceptable to the credential store's key grammar.
 */
export function accountRef(provider: string, hash: string): string {
  const folded = provider.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const guarded = folded.length === 0 ? 'provider' : /^[0-9]/.test(folded) ? `p-${folded}` : folded
  const stem = guarded.slice(0, 40)
  const suffix = hash.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || '0'
  return `${OAUTH_GRANT_SCOPE}/${stem}-${suffix}`
}

/**
 * Rank one provider's candidates: OAuth accounts ahead of API keys, each
 * group keeping the provider's cursor-anchored ring order. Pure: the cursor
 * is not advanced.
 *
 * RESERVED for future per-account ordering — no production call site today.
 * Increment-1 arbitration is NOT this ranking: the live selection path is
 * projection presence + probe fail-skip over a kind-agnostic ring. The
 * round-robin pickers walk every candidate in array order regardless of
 * kind, and an OAuth row leaves that ring only when the account probe fails
 * on its non-credential-grammar ref (probeKey → failed, not missing).
 * Wiring this account-first ranking into the selection path is roadmap
 * work, deliberately out of increment-1 scope.
 */
export function cascadeOrder(provider: ProviderRecord, now: number): KeyRecord[] {
  const keys = Array.isArray(provider.keys) ? provider.keys : []
  if (keys.length === 0) return []
  const accounts: KeyRecord[] = []
  const apiKeys: KeyRecord[] = []
  const start = normalizeCursor(provider.cursor, keys.length)
  for (let offset = 0; offset < keys.length; offset += 1) {
    const key = keys[(start + offset) % keys.length]
    if (!isSelectable(key, now)) continue
    if (key.kind === 'oauth') accounts.push(key)
    else apiKeys.push(key)
  }
  return [...accounts, ...apiKeys]
}

/** Session/provider binding key. */
export function bindingKey(sessionId: string, provider: string): string {
  return `${sessionId}\u0000${provider}`
}

/** Validate a new key input before it reaches the credential store. */
export function validateKeyInput(alias: unknown, value: unknown): { alias: string; value: string } {
  const cleanAlias = typeof alias === 'string' ? alias.trim() : ''
  if (cleanAlias.length === 0) throw new TypeError('alias is required')
  if (cleanAlias.length > MAX_ALIAS_LENGTH) throw new TypeError(`alias must be at most ${MAX_ALIAS_LENGTH} characters`)
  if (typeof value !== 'string') throw new TypeError('key value is required')
  const cleanValue = value.trim()
  if (cleanValue.length === 0) throw new TypeError('key value is required')
  if (cleanValue.length > MAX_KEY_LENGTH) throw new TypeError('key value is too long')
  return { alias: cleanAlias, value: cleanValue }
}

/** Validate a rename/enable patch. */
export function validateKeyPatch(patch: unknown): { alias?: string; enabled?: boolean } {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch is required')
  const source = patch as Record<string, unknown>
  const result: { alias?: string; enabled?: boolean } = {}
  if (source.alias !== undefined) {
    const alias = typeof source.alias === 'string' ? source.alias.trim() : ''
    if (alias.length === 0) throw new TypeError('alias is required')
    if (alias.length > MAX_ALIAS_LENGTH) throw new TypeError(`alias must be at most ${MAX_ALIAS_LENGTH} characters`)
    result.alias = alias
  }
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    result.enabled = source.enabled
  }
  if (Object.keys(result).length === 0) throw new TypeError('patch has no supported fields')
  return result
}

/** Maximum keys per provider (also used by the Host). */
export const KEY_LIMIT = MAX_KEYS_PER_PROVIDER

/** Re-export the shared update type for callers that only import core. */
export type { ManagerSettings }
