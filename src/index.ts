/**
 * Keys Manager Host half.
 *
 * Responsibilities:
 * - Per-provider API-key CRUD, with key literals in the Harness credential
 *   store and secret-free metadata in `<DSH_HOME>/keys-manager/state.json`.
 * - Extend an existing provider's `apiKeyEnv` to a broker reference and
 *   answer that reference per request, so the original pi-ai / DeepSeek
 *   adapters keep working without patching their transports.
 * - Sticky per-session round-robin selection, bounded retry, key failover,
 *   and exponential cooldown recovery.
 * - Install searchable extra built-in providers as normal pi-ai routes.
 * - A small Typert Remote namespace that the Web settings page calls through
 *   `ctx.connection.rpc`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import {
  KEY_LIMIT,
  accountRef,
  applyFailureCooldown,
  bindingKey,
  classifyOAuthFailure,
  isSelectable,
  markKeySuccess,
  markKeyUsed,
  normalizeSettings,
  patchSettings,
  pickHealthyExcluding,
  pickRoundRobin,
  shouldFailover,
  statusOfKey,
  statusOfProvider,
  validateKeyInput,
  validateKeyPatch,
} from './core.js'
import type {
  AccountAttemptNotice,
  AccountAttemptPrompt,
  AccountAttemptView,
  ExtraProvider,
  KeyRecord,
  KeyTestResult,
  KeyView,
  ModelRecord,
  OAuthAccount,
  ProviderRecord,
  ProviderView,
  StateView,
  TransportAccountStatus,
  TransportAccountView,
} from './domain.js'
import type {
  AttemptState,
  AuthorizationFlowEntry,
  AuthorizationInteractionLike,
  CredentialHit,
  CredentialRecordLike,
  CredentialRecordsLike,
  CredentialsLike,
  DirectoryEntry,
  DiscoveredModel,
  GenerateOptionsLike,
  HostContext,
  KeySelection,
  LlmFailureLike,
  ProviderSupport,
  RequestErrorAction,
  AgentRequestPayload,
  RequestErrorPayload,
  SettingsDescriptorLike,
  SettingsLike,
  SettingsPathOp,
  StreamChunkLike,
  TransportGrantLike,
} from './host-types.js'
import { EXTRA_PROVIDER_MAP, EXTRA_PROVIDERS } from './providers.js'
import { KeysManagerStore, ensureStateFile, statePath } from './store.js'

export const name = 'keys-manager'
export const inject = ['llm', 'credentials', 'typert', 'authorization']
export const provide = ['keysManager']

const SERVICE = 'keysManager'
const NAMESPACE = 'keysManager'
const BROKER_PREFIX = 'KEYSMGR_'
const ORIGINAL = Symbol.for('cordis.original')
/**
 * The capability `close()`'s pre-close restoration writes under (PR review
 * round 36). A module-private token, not a boolean a caller can pass: no
 * cleanup, watchdog or late reconcile can hold it, so the restoration is the
 * only writer allowed while `shutdownRequested` is up.
 */
const PRE_CLOSE_RESTORE = Symbol('keys-manager.pre-close restore')
type RestoreCapability = typeof PRE_CLOSE_RESTORE
const MAX_SWITCHES = 6
const ATTEMPT_TTL_MS = 60 * 60 * 1000
/** A retry pin only lives for this long; an expired pin is treated as absent. */
const PIN_TTL_MS = 60_000
/**
 * An interactive sign-in that has not settled within this window is failed
 * and withdrawn: real flows finish in minutes, and a wedged attempt would
 * otherwise hold the provider's single authorization slot forever.
 */
const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000
/**
 * Same shape of bound the api-key attempt cache uses (pruneAttempts): the
 * settled-login cache is capped, evicting the oldest settled entries, so a
 * rapid begin/fail loop cannot accumulate unbounded views within the TTL.
 */
const MAX_LOGIN_ATTEMPTS = 128
/** Same display-name cap the api-key aliases use (core.ts MAX_ALIAS_LENGTH). */
const MAX_ALIAS = 80
/**
 * How long a pending projection-removal marker may absorb its deletion
 * echo. Bounded well above any realistic echo delay (the seam's own
 * watcher debounce dwarfs it): the old microtask sweep raced the echo
 * handler's awaited re-read and could clear the marker too early; the
 * race came from unbounded immediacy, not slow echoes.
 */
const INTENTIONAL_REMOVAL_TTL_MS = 5_000
/** The credential-record scope pi-ai stores its per-provider grants under (llm-pi-ai/src/auth.ts:29). */
export const OAUTH_GRANT_RECORD_SCOPE = 'llm-pi-ai'
/**
 * The credential-record scope the llm-omp transports package owns: one
 * `llm-omp-transports/<route>` grant per transport route (its
 * `CURSOR_CREDENTIAL_KEY` is `llm-omp-transports/cursor`). Keys Manager reads
 * those records to list/verify an account and deletes one on removal; it
 * never writes one and never projects one into `llm-pi-ai/<provider>`, so a
 * transport route keeps serving from its own adapter-owned credential.
 */
export const TRANSPORT_CREDENTIAL_SCOPE = 'llm-omp-transports'
/**
 * Upper bound on one stream's wait for projection-ownership hydration
 * (round-9 should-fix). Hydration reads one `readRecord` per OAuth provider
 * serially and the seam offers no timeout or cancellation, so a single
 * stalled read can keep that promise pending indefinitely. The wait is
 * therefore bounded: 500 ms is generous for a healthy local credential-store
 * read while keeping a stalled read from stalling the request (and every
 * managed provider behind it) for longer than half a second. The hydration
 * itself is never cancelled — a late result still lands through the
 * generation guard in {@link KeysManagerService.hydrateProjectionOwnership}.
 */
const HYDRATION_WAIT_MS = 500
/** Upper bound on one per-row connection test: a stalled provider must not hold the row busy forever. */
const KEY_TEST_TIMEOUT_MS = 20_000
/** The test timeout as user-visible copy; derived so the constant stays the single source of truth. */
const KEY_TEST_TIMEOUT_LABEL = `${KEY_TEST_TIMEOUT_MS / 1000}s`
/**
 * Hard bound on how long an ordinary request waits for an in-flight row test
 * (QC B3). The test's own request timeout covers only `ctx.llm.stream`; its
 * credential-store reads offer no timeout or cancellation, so without a bound
 * of its own one stalled seam read parks every ordinary request for the
 * provider indefinitely. The small margin keeps the wait from cutting short a
 * test whose provider call used its whole budget.
 */
const KEY_TEST_ISOLATION_WAIT_MS = KEY_TEST_TIMEOUT_MS + 5_000
/**
 * Hard bound on one abandoned test window's cleanup (QC fix wave 2). The
 * borrowed projection must be put back before ordinary traffic may resume on
 * the provider, but the cleanup runs through the same credential seam the
 * wedged test is parked in, so it cannot be trusted to return. Past this bound
 * the provider stays isolated and fenced instead of being released on an
 * unreconciled credential surface.
 */
const KEY_TEST_CLEANUP_DEADLINE_MS = 2_000
/**
 * Hard bound on the shutdown drain of the per-provider grant chains (PR review
 * round 29). A chain body carries the row test's own provider request, and an
 * adapter that ignores the abort signal keeps that request pending after the
 * watchdog already restored the borrowed credential, so the chain may never
 * settle. Past this bound the pending chain is abandoned: process teardown does
 * not need it, and shutdown must not hang on it.
 */
const GRANT_DRAIN_DEADLINE_MS = 2_000
/**
 * How many times one binding decision is re-derived after its write settled on
 * a serving source that has moved again (PR review round 32). The write itself
 * is asynchronous, so each settled profile can already describe a source a
 * newer classification replaced; a small bound chases that without letting a
 * genuinely flapping route spawn an unbounded write chain.
 */
const BINDING_CORRECTION_LIMIT = 3

/** The error-like `name` of an unknown thrown value, if it carries one. */
function errorNameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/**
 * Whether the 20 s test timeout caused the caught failure. The abort signal
 * is a whole-request fact, so an error that merely races the timer keeps its
 * own message (M1): only the timeout's own reason, or the abort the timeout
 * caused, maps to the timeout copy.
 */
function isTestTimeoutAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false
  if (error === signal.reason) return true
  if (errorNameOf(signal.reason) !== 'TimeoutError') return false
  return errorNameOf(error) === 'AbortError'
}

/**
 * Stable failure code for a harvest whose state flush rejected AND whose
 * credential-side rollback then failed to write.
 *
 * The state flush is the durability boundary `run` enforces, and the rollback
 * that follows it deletes/restores the credential records the rolled-back row
 * referenced. When those compensating writes fail too, the attempt's reason
 * starts with `<code>: ` and keeps the original flush error verbatim after it,
 * so an upstream caller can branch on {@link isFlushRollbackCompensationFailure}
 * instead of matching prose. A flush failure whose rollback completed keeps its
 * original error unchanged — this code is the only added spelling.
 */
export const FLUSH_ROLLBACK_COMPENSATION_FAILED = 'FLUSH_ROLLBACK_COMPENSATION_FAILED'

/** Whether an attempt error carries {@link FLUSH_ROLLBACK_COMPENSATION_FAILED}. */
export function isFlushRollbackCompensationFailure(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(`${FLUSH_ROLLBACK_COMPENSATION_FAILED}:`)
}

/** The pi-ai OAuth credential shape a grant record must carry (research: `OAuthCredential`). */
interface OAuthGrantPayload {
  type: 'oauth'
  refresh: string
  access: string
  expires?: number
  accountId?: string
  email?: string
  [key: string]: unknown
}

/** Whether an opaque grant payload is the OAuth credential pi-ai owns. */
function isOAuthGrantPayload(value: unknown): value is OAuthGrantPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return source.type === 'oauth'
    && typeof source.refresh === 'string' && source.refresh.length > 0
    && typeof source.access === 'string'
}

/** Internal attempt record; the controller and prompt resolvers stay host-side. */
interface LoginAttempt {
  id: string
  provider: string
  alias?: string
  /**
   * The pool row a re-authentication replaces (round-3 finding 6): the
   * harvest binds the committed grant to this validated row even when the
   * new payload matches nothing (rotated token, no identity metadata).
   * Host-side routing information; never surfaced on the attempt view.
   */
  targetAccountId?: string
  status: AccountAttemptView['status']
  notices: AccountAttemptNotice[]
  prompt?: AccountAttemptPrompt
  error?: string
  accountId?: string
  createdAt: number
  updatedAt: number
  settledAt?: number
  controller: AbortController
  /**
   * Resolves once the seam's attempt has settled AND this manager has acted on
   * the outcome, so a removal can await it before deleting the grant.
   */
  settled?: Promise<void>
  resolvePrompt?: (value: string) => void
  rejectPrompt?: (reason: Error) => void
}

/** The row fields a harvest replaces on a re-authentication. */
interface HarvestRowSnapshot {
  oauth: OAuthAccount | null
  valueMissing: boolean
  cooldownUntil: number
}

/** The in-memory row mutation a harvest performed, undone on flush failure. */
type HarvestRowUndo =
  | { kind: 'added'; id: string }
  | { kind: 'updated'; id: string; snapshot: HarvestRowSnapshot }

/**
 * Everything one harvest mutation wrote, kept so a later failure can
 * compensate exactly this login's writes. The row/owner facts exist for the
 * flush-failure rollback: `run` resolves the mutation but not necessarily its
 * durability, so a rejected `store.flush()` leaves an in-memory upsert on a
 * document that was never written.
 */
interface HarvestFacts {
  payload: OAuthGrantPayload
  grantRef: string
  wroteRef: boolean
  /** The plugin-scope record the write at `grantRef` overwrote (same-ref re-auth). */
  previousRef?: CredentialRecordLike
  /** The superseded generation the harvest deleted (restored on rollback). */
  superseded?: { ref: string; record: CredentialRecordLike }
  /** The in-memory row mutation, undone when the state flush rejects. */
  rowUndo?: HarvestRowUndo
  /** The projection owner before the harvest claimed it. */
  ownerUndo?: { had: boolean; owner?: string }
}

/** Copy a seam prompt into its serializable view (the AbortSignal stays out). */
function promptView(prompt: { kind?: string; message: string; placeholder?: string; options?: unknown }): AccountAttemptPrompt {
  const options = Array.isArray(prompt.options)
    ? prompt.options
      .filter((entry): entry is { id: string; label: string; description?: string } =>
        entry !== null && typeof entry === 'object'
        && typeof (entry as Record<string, unknown>).id === 'string'
        && typeof (entry as Record<string, unknown>).label === 'string')
    : undefined
  const kind = prompt.kind === 'secret' || prompt.kind === 'select' ? prompt.kind : 'text'
  return {
    kind,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    ...(options === undefined || options.length === 0 ? {} : { options }),
  }
}

/** Copy a seam notice into its serializable view. */
function noticeView(notice: { message: string; url?: string; code?: string }): AccountAttemptNotice {
  return {
    message: notice.message,
    ...(notice.url === undefined ? {} : { url: notice.url }),
    ...(notice.code === undefined ? {} : { code: notice.code }),
  }
}

/** Strip the host-side handles from one attempt. */
function attemptView(attempt: LoginAttempt): AccountAttemptView {
  return {
    id: attempt.id,
    provider: attempt.provider,
    ...(attempt.alias === undefined ? {} : { alias: attempt.alias }),
    status: attempt.status,
    notices: attempt.notices.map(notice => ({ ...notice })),
    ...(attempt.prompt === undefined ? {} : { prompt: { ...attempt.prompt, ...(attempt.prompt.options === undefined ? {} : { options: attempt.prompt.options.map(option => ({ ...option })) }) } }),
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    ...(attempt.accountId === undefined ? {} : { accountId: attempt.accountId }),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  }
}

/** One strict Remote endpoint descriptor. */
interface InvocationParameter {
  name: string
  wire: string
  source: 'json'
  codec: { mode: 'src-json' }
}

interface InvocationDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: InvocationParameter[]
  result: { mode: 'src-json' }
}

function endpoint(method: string, parameters: string[] = []): InvocationDescriptor {
  return {
    id: `dsh-keys-manager#${NAMESPACE}/${method}`,
    service: SERVICE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(field => ({
      name: field,
      wire: field,
      source: 'json',
      codec: { mode: 'src-json' },
    })),
    result: { mode: 'src-json' },
  }
}

const INVOCATIONS: InvocationDescriptor[] = [
  endpoint('getState'),
  endpoint('adoptProvider', ['provider']),
  endpoint('addKey', ['provider', 'alias', 'value']),
  endpoint('updateKey', ['provider', 'keyId', 'patch']),
  endpoint('deleteKey', ['provider', 'keyId']),
  endpoint('releaseProvider', ['provider']),
  endpoint('addExtraProvider', ['extraId', 'alias', 'value']),
  endpoint('setSettings', ['patch']),
  // OAuth account management (T2 service methods). The login dialog polls
  // accountAttempt for attempt-state transitions: the host forwards only a
  // fixed credentials-event allowlist to the browser, so the plugin has no
  // own event channel a client could subscribe to.
  // targetAccountId (round-3 finding 6): the row a re-authentication
  // replaces, so a metadata-poor rotation re-binds in place instead of
  // duplicating the account.
  endpoint('beginAccountLogin', ['provider', 'alias', 'targetAccountId']),
  endpoint('answerAccountPrompt', ['attemptId', 'value']),
  endpoint('accountAttempt', ['attemptId']),
  endpoint('listAccountAttempts'),
  endpoint('activateAccount', ['provider', 'accountId']),
  endpoint('removeAccount', ['provider', 'accountId']),
  // One minimal request per key/account row (observation-only: no health,
  // cursor or binding writes) so a user can tell a bad credential from a bad
  // route without waiting for a chat failure.
  endpoint('testKey', ['provider', 'keyId']),
  // Transport accounts (llm-omp-transports/<route>): managed beside the pi-ai
  // pool, never through it. The sign-in reuses the same attempt machinery and
  // is polled through `accountAttempt` above.
  endpoint('beginTransportLogin', ['provider']),
  endpoint('activateTransportAccount', ['provider']),
  endpoint('removeTransportAccount', ['provider']),
]

/** Read a nested value by path. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** A loose profile shape read from the settings view. */
interface ProfileShape {
  apiKeyEnv?: string
  api?: string
  baseURL?: string
  models?: unknown
  [key: string]: unknown
}

function asProfile(value: unknown): ProfileShape | undefined {
  return value !== null && typeof value === 'object' ? (value as ProfileShape) : undefined
}

/** Stable broker credential reference for one provider route. */
function brokerRefFor(provider: string): string {
  const stem = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 34)
  const hash = createHash('sha256').update(provider).digest('hex').slice(0, 6).toUpperCase()
  return `${BROKER_PREFIX}${stem || 'PROVIDER'}_${hash}`
}

/** Reference the Models page would have derived for a provider route. */
function derivedKeyRef(provider: string): string {
  const stem = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${stem || 'PROVIDER'}_API_KEY`
}

/** One fresh key credential reference beneath a provider broker. */
function newKeyRef(provider: string): string {
  return `${brokerRefFor(provider)}_K_${randomBytes(6).toString('hex').toUpperCase()}`
}

/** One fresh non-secret key id. */
function newKeyId(): string {
  return `k_${randomBytes(6).toString('hex')}`
}

/** Validate a credential-reference grammar. */
function isCredentialRefName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/** Normalize one model profile row for the pi-ai route. */
function normalizeModel(model: unknown): ModelRecord | undefined {
  if (model === null || typeof model !== 'object') return undefined
  const source = model as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0) return undefined
  const next: ModelRecord = { id: source.id }
  if (typeof source.name === 'string' && source.name.length > 0) next.name = source.name
  if (typeof source.contextWindow === 'number' && source.contextWindow > 0) next.contextWindow = Math.round(source.contextWindow)
  if (typeof source.maxTokens === 'number' && source.maxTokens > 0) next.maxTokens = Math.round(source.maxTokens)
  const input = Array.isArray(source.input)
    ? source.input
    : Array.isArray(source.inputModalities)
      ? source.inputModalities
      : []
  const modalities = input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  if (modalities.length > 0) next.input = [...new Set(modalities)]
  if (source.reasoningEfforts !== null && typeof source.reasoningEfforts === 'object') {
    next.reasoningEfforts = source.reasoningEfforts as Record<string, unknown>
  }
  if (source.compat !== null && typeof source.compat === 'object') {
    next.compat = source.compat as Record<string, unknown>
  }
  return next
}

/** Normalize an array of model rows, dropping unusable entries. */
function normalizeModels(raw: unknown): ModelRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeModel).filter((model): model is ModelRecord => model !== undefined)
}

/** Normalize one discovered model into the profile model shape. */
function discoveredModel(model: DiscoveredModel): ModelRecord | undefined {
  return normalizeModel({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: model.inputModalities,
  })
}

/** Credential-bearing header names the carrier must never persist as plain settings. */
const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'api-key', 'apikey', 'x-api-key'])

/** Carrier headers are non-secret metadata; a credential-bearing name is refused. */
function isCredentialHeader(header: string): boolean {
  const name = header.toLowerCase()
  return CREDENTIAL_HEADER_NAMES.has(name) || name.endsWith('-api-key')
}

/**
 * Resolve one extra provider's declared static request headers from the
 * environment. Every value must be non-blank and legal for Fetch; a missing or
 * unusable value refuses the add before any credential or settings write,
 * because a blank header would only surface later as an opaque
 * profile-resolution error.
 */
function resolveHeaderEnv(extra: ExtraProvider): Record<string, string> | undefined {
  if (extra.headerEnv === undefined) return undefined
  const headers: Record<string, string> = {}
  for (const [header, envName] of Object.entries(extra.headerEnv)) {
    if (isCredentialHeader(header)) {
      throw new Error(`${extra.id} declares the credential header ${header}; only non-secret metadata headers can be carried`)
    }
    const value = process.env[envName]?.trim()
    if (value === undefined || value.length === 0) {
      throw new Error(`${extra.id} requires the ${envName} environment variable (${header} header)`)
    }
    // The settings seam materializes the profile through Fetch, which rejects
    // names and values a header cannot carry; refuse them by name here.
    try {
      new Headers([[header, value]])
    } catch {
      throw new Error(`${extra.id} cannot carry the ${envName} value as the ${header} header: it is not a valid Fetch header value`)
    }
    headers[header] = value
  }
  return headers
}

/** Read a stored profile header map, keeping only the string values a header can carry. */
function staticHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (value === null || typeof value !== 'object') return headers
  for (const [header, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') headers[header] = entry
  }
  return headers
}

/** Stored header key matching a declared name; Fetch field names are case-insensitive. */
function storedHeaderKey(stored: Record<string, string>, header: string): string | undefined {
  const wanted = header.toLowerCase()
  for (const key of Object.keys(stored)) {
    if (key.toLowerCase() === wanted) return key
  }
  return undefined
}

/** Resolve the declared header values the environment currently supplies. */
function environmentHeaders(extra: ExtraProvider | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (extra?.headerEnv === undefined) return headers
  for (const [header, envName] of Object.entries(extra.headerEnv)) {
    const value = process.env[envName]?.trim()
    if (value !== undefined && value.length > 0) headers[header] = value
  }
  return headers
}

/** Declared headers the stored map does not carry yet; a stored value always wins. */
function missingHeaders(declared: Record<string, string> | undefined, stored: Record<string, string>): Record<string, string> {
  const missing: Record<string, string> = {}
  if (declared === undefined) return missing
  for (const [header, value] of Object.entries(declared)) {
    // A stored variant in any case counts as the same Fetch field, so no
    // second case variant is ever added.
    if (storedHeaderKey(stored, header) === undefined) missing[header] = value
  }
  return missing
}

/** Public, secret-free key row. */
function publicKey(key: KeyRecord, now: number, projectedAccountId?: string | null): KeyView {
  return {
    id: key.id,
    alias: key.alias,
    status: statusOfKey(key, now),
    enabled: key.enabled !== false,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    cooldownUntil: key.cooldownUntil,
    failureLevel: key.failureLevel,
    consecutiveFailures: key.consecutiveFailures,
    totalUses: key.totalUses,
    totalFailures: key.totalFailures,
    importedFrom: key.importedFrom ?? null,
    valueMissing: key.valueMissing === true,
    kind: key.kind ?? 'api-key',
    // Identity facts only; the grant reference stays host-side (T1 shapes).
    ...(key.kind === 'oauth' && key.oauth !== null
      ? {
          oauth: {
            provider: key.oauth.provider,
            ...(key.oauth.email === undefined ? {} : { email: key.oauth.email }),
            ...(key.oauth.accountId === undefined ? {} : { accountId: key.oauth.accountId }),
            ...(key.oauth.expiresAt === undefined ? {} : { expiresAt: key.oauth.expiresAt }),
          },
          // Step 6: surface which account row IS the live projection.
          ...(projectedAccountId !== undefined && projectedAccountId !== null && projectedAccountId === key.id
            ? { projected: true }
            : {}),
        }
      : {}),
  }
}

/**
 * The usable grant of one transport record, or undefined when the record is
 * absent or carries a payload this manager cannot read. The payload belongs
 * to the transports package, so every field is checked structurally.
 */
function transportGrantOf(record: CredentialRecordLike | undefined): TransportGrantLike | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const source = payload as Record<string, unknown>
  if (typeof source.access !== 'string' || source.access.length === 0) return undefined
  if (typeof source.expires !== 'number' || !Number.isFinite(source.expires)) return undefined
  return {
    access: source.access,
    expires: source.expires,
    ...(typeof source.refresh === 'string' && source.refresh.length > 0 ? { refresh: source.refresh } : {}),
    ...(typeof source.email === 'string' && source.email.length > 0 ? { email: source.email } : {}),
    ...(typeof source.accountId === 'string' && source.accountId.length > 0 ? { accountId: source.accountId } : {}),
  }
}

/**
 * One transport account row from its route flow and stored record.
 *
 * A transport route keeps exactly ONE grant record, and the route's adapter
 * resolves that record per request — so a usable grant IS the route's live
 * credential. There is no projection to select between: `active` only
 * restates that, and activation can never write a pi-ai record. The row
 * exists while signed out, so the UI can offer the sign-in that writes it.
 */
function transportAccountOf(flow: AuthorizationFlowEntry, record: CredentialRecordLike | undefined, now: number): TransportAccountView {
  const grant = transportGrantOf(record)
  const status: TransportAccountStatus = grant !== undefined
    ? grant.expires > now
      ? 'active'
      : grant.refresh === undefined ? 'needs-reauth' : 'expired'
    : record === undefined ? 'signed-out' : 'needs-reauth'
  return {
    id: flow.key.slice(TRANSPORT_CREDENTIAL_SCOPE.length + 1),
    scope: flow.key,
    displayName: flow.label,
    ...(grant?.email === undefined ? {} : { email: grant.email }),
    ...(grant?.accountId === undefined ? {} : { accountId: grant.accountId }),
    ...(grant?.expires === undefined ? {} : { expiresAt: grant.expires }),
    status,
    // Derived, never a second opinion: an expired or unreadable grant is not
    // the route's live credential.
    active: status === 'active',
  }
}

/**
 * The method id a transport flow begins with, or undefined when it has none.
 *
 * The transports package owns its flow's method id; this manager only reads
 * the scope prefix, so it must not assume the pi-ai `'oauth'` id.
 */
function transportMethodOf(flow: AuthorizationFlowEntry): string | undefined {
  return flow.methods[0]?.id
}

/** Env names that are a single API-key credential, not an OAuth/federation token. */
function isKeyishEnv(name: string): boolean {
  if (!/(?:API_KEY|_TOKEN)$/.test(name)) return false
  if (/OAUTH/.test(name)) return false
  if (/AUTH_TOKEN|FEDERATION|ORGANIZATION|IDENTITY_TOKEN_FILE|SERVICE_ACCOUNT|WORKSPACE_ID/.test(name)) return false
  return true
}

/**
 * DSH catalog routes that are explicitly outside the single-key pool. This
 * is a KEY-POOL verdict only (capabilityOf): an OAuth-capable route listed
 * here stays adoptable for account management. Keeping it as a named table
 * (rather than only deriving it from env names) makes a reviewed decision
 * visible and stable when a provider adds another auth path.
 */
const UNSUPPORTED_KEY_POOL_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  'amazon-bedrock': 'Uses an AWS credential chain (profile, IAM keys, container/IRSA tokens), not a single API key',
  'cloudflare-ai-gateway': 'Needs Cloudflare account and gateway IDs in addition to the API key',
  'cloudflare-workers-ai': 'Needs a Cloudflare account ID in addition to the API key',
  'openai-codex': 'Uses ChatGPT OAuth sign-in only; no API-key credential',
})

/**
 * Why an OAuth-capable catalog route cannot be managed as an account here.
 *
 * C6-2: `nativeAuth.oauth` is a catalog fact — the provider supports OAuth
 * upstream. Actually signing in needs a pi-ai flow registered with this
 * Harness build's authorization seam, which extension-backed routes may not
 * have (they are explicitly deferred from this increment). Offering "Add
 * account" without a flow would promise a sign-in that cannot start.
 */
const NO_OAUTH_FLOW_REASON = 'This provider has no OAuth sign-in flow registered in this Harness build'

/**
 * How one route can be managed, split by mode (MF1): the single-key pool
 * and OAuth account management are separate capabilities. A route may be
 * account-adoptable while carrying no key-pool credential at all
 * (`openai-codex`), and the reverse (amazon-bedrock, cloudflare) stays
 * key-unsupported without ever reaching the account path.
 */
interface CapabilitySplit {
  /** The route can join the single-key pool (Add key / addKey). */
  keys: boolean
  /** The route can be adopted for OAuth account management (Add account). */
  accounts: boolean
  /** Why the key pool does not apply, when a specific reason is known. */
  reason?: string
}

/**
 * Split one route's management capability by mode. The
 * {@link UNSUPPORTED_KEY_POOL_PROVIDERS} table keeps its meaning: it is a
 * verdict about API keys, so an OAuth-capable route listed there remains
 * adoptable for accounts while its key entry stays blocked.
 *
 * `oauthFlow` is the live answer from {@link KeysManagerService.oauthFlowAvailable}
 * — C6-2 requires an actually-beginable flow, not the catalog flag alone.
 */
function capabilityOf(entry: DirectoryEntry, profile: ProfileShape | undefined, oauthFlow: boolean): CapabilitySplit {
  if (entry.error !== undefined) return { keys: false, accounts: false, reason: entry.error }
  const accounts = entry.nativeAuth?.oauth === true && oauthFlow
  const unsupportedReason = UNSUPPORTED_KEY_POOL_PROVIDERS[entry.provider]
  if (unsupportedReason !== undefined) {
    // The table's reason describes the key verdict; when the only possible
    // capability (accounts) is unavailable too, the flow gap is the truthful
    // explanation a user needs.
    const reason = entry.nativeAuth?.oauth === true && !oauthFlow ? NO_OAUTH_FLOW_REASON : unsupportedReason
    return { keys: false, accounts, reason }
  }
  if (entry.provider === 'deepseek-official') return { keys: true, accounts }
  if (profile !== undefined && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) return { keys: true, accounts }
  const auth = entry.nativeAuth
  if (auth !== undefined) {
    // A dual-auth route (key env + OAuth, e.g. anthropic) keeps BOTH
    // capabilities; the oauth-only verdict below is for routes with no
    // key credential at all.
    if (auth.env.some(isKeyishEnv)) return { keys: true, accounts }
    if (auth.oauth) {
      return oauthFlow
        ? { keys: false, accounts: true, reason: 'This provider signs in with an OAuth account; no API key is used' }
        : { keys: false, accounts: false, reason: NO_OAUTH_FLOW_REASON }
    }
    if (auth.env.length > 0) return { keys: false, accounts: false, reason: 'This provider uses native cloud credentials, not one API key' }
    return { keys: false, accounts: false, reason: 'This provider declares no API-key authentication' }
  }
  return { keys: true, accounts }
}

/**
 * Whether the route can be adopted for OAuth account management (MF1).
 *
 * C6-2: `nativeAuth.oauth` alone is not enough. Account support requires a
 * flow the authorization seam can begin, resolved from the live flow list on
 * every call (see {@link KeysManagerService.oauthFlowAvailable}): the seam
 * may mount after this plugin, so availability is never cached at
 * construction. While the flow list is empty (seam not mounted yet) support
 * is false; the next state build re-evaluates once flows are enumerable.
 */
function accountSupportOf(entry: DirectoryEntry | undefined, oauthFlow: boolean): ProviderSupport {
  if (entry === undefined) return { supported: false, reason: 'This provider route is not registered' }
  if (entry.error !== undefined) return { supported: false, reason: entry.error }
  if (entry.nativeAuth?.oauth !== true) return { supported: false, reason: 'This provider offers no OAuth account sign-in' }
  if (!oauthFlow) return { supported: false, reason: NO_OAUTH_FLOW_REASON }
  return { supported: true }
}

/** Request-local credential context established by the stream listener. */
interface StreamAttempt {
  keyId: string | undefined
  usedManagedKey: boolean
  at: number
  sequence: number
  claimed: boolean
}

interface RequestScope {
  provider: string
  keyId: string | null
  keyValue: string | null
  /** Set only when the broker resolver actually answered with this key. */
  keyUsed: boolean
  /**
   * Set when a projected OAuth account owns this route (MF2): pi-ai's
   * per-request resolution serves the stored grant — not the broker key
   * selected above — so an oauth-coded failure attributes to the account
   * row instead of dying in the no-evidence delegation path.
   */
  oauthAccountId: string | null
  /**
   * Set only by {@link KeysManagerService.testKey}. A test scope pins the
   * credential under test itself, so the stream listener routes it straight
   * through: no key selection, no cursor or sticky binding, and no health
   * writes on any terminal chunk.
   */
  test: boolean
}

/**
 * One row test's borrowed-credential window (QC fix wave 2).
 *
 * An OAuth row test borrows the route's projection — and, on a broker-bound
 * profile, its credential binding — for the duration of one request. The
 * watchdog that abandons a wedged test must be able to put the route back
 * exactly as the test's own `finally` would, so the window records the borrow
 * facts as they become known instead of leaving them inside the abandoned
 * promise's scope.
 */
interface RowTestWindow {
  provider: string
  row: KeyRecord
  /** Whether this window releases the profile's broker reference. */
  borrowBinding: boolean
  /**
   * Set before the release is attempted: the attempt may land partially, so a
   * cleanup must re-sync the binding it touched.
   */
  releasedBinding: boolean
  /**
   * The projection borrow, recorded before the write lands so an abandoned
   * window can restore a borrow that landed after the watchdog looked.
   * {@link KeysManagerService.restoreProjection} decides by payload, so having
   * the facts early is safe whether or not the write landed.
   */
  facts?: {
    records: CredentialRecordsLike
    key: string
    previous: CredentialRecordLike | undefined
    borrowed: OAuthGrantPayload
  }
  /** The guarded test promise, for the identity-checked isolation release. */
  test?: Promise<KeyTestResult>
  /**
   * The borrow and binding mutations this window started, recorded before each
   * is awaited (QC fix wave 3, W-001). A cleanup may not judge the route from
   * a re-read while one of them is still in flight: a payload a writer has not
   * stored yet looks exactly like the pre-borrow payload, so the restore would
   * take its foreign branch and release the provider just before the borrow
   * lands. The promises are normalized to never reject — their own outcome
   * belongs to the code awaiting them.
   */
  mutations: Promise<void>[]
  /**
   * The abandonment fence: set by the watchdog before its first cleanup await.
   * Everything the test does afterwards observes it — it never starts a
   * borrow, its `finally` never restores from its own stale snapshot, and a
   * new test is refused until the window's cleanup completed.
   */
  cleaned: boolean
  /**
   * Set once the window's request is over (PR review round 21). A cleanup that
   * finishes before this may not release the provider: the adapter can still
   * refresh and rewrite the borrowed projection, so the settlement reconciles
   * that late write first.
   */
  settled: boolean
  /**
   * The cleanup completed while the request was still running and therefore
   * kept the provider isolated. Only the settlement releases such a window.
   */
  held: boolean
  /**
   * Set by the settlement that found a cleanup still holding the fence (PR
   * review round 28). That cleanup re-reads the late write and reconciles it
   * before it releases the provider; without the marker the release happened
   * with whatever the adapter wrote after the cleanup's own restore.
   */
  lateReconcileRequested: boolean
}

/** Original credential provider methods captured before wrapping. */
interface CredentialOriginals {
  resolve: CredentialsLike['resolve']
  describe: CredentialsLike['describe']
  set: CredentialsLike['set']
  unset: CredentialsLike['unset']
}

/** The broker wrappers installed on one credential provider instance. */
interface CredentialWrappers {
  resolve: CredentialsLike['resolve']
  describe: CredentialsLike['describe']
  set: CredentialsLike['set']
  unset: CredentialsLike['unset']
}

/** How the live provider profile relates to the managed broker reference. */
type BindingState = 'healthy' | 'mismatch' | 'unknown'

/**
 * How one adoption projection read resolved. `superseded` means a projection
 * event was reconciled while the read was outstanding: the reconciliation
 * queued behind it is authoritative, so this read classifies and binds nothing
 * and ownership stays unknown until that read answers.
 */
type AdoptionProjectionRead = 'known' | 'unknown' | 'superseded'

/** Settings snapshot with an explicit readability signal. */
interface SettingsSnapshot {
  writable: boolean
  namespaces: SettingsDescriptorLike[]
  readable: boolean
}

/** One credential probe result; `failed` is transient, `missing` is absent. */
interface KeyProbe {
  hit?: CredentialHit
  missing: boolean
  failed: boolean
}

/** Service keybinding consumed by the Typert Gateway. */
interface TypertRemoteBinding {
  service: KeysManagerService
  serviceKey: string
  namespace: string
}

/**
 * The account row whose grant payload matches one live projection payload:
 * the refresh digest names the row first; on a miss (rotated token) the
 * payload's identity metadata re-associates.
 *
 * The exact `accountId` lookup runs BEFORE the email fallback (round-8
 * finding I-000107): the fallback is only for rows that never carried an
 * accountId, and evaluating it in array order let an earlier email-only row
 * claim a payload that names a later row's accountId — corrupting both the
 * owner attribution and the cleanup target.
 */
function matchOwningAccount(provider: string, accounts: KeyRecord[], payload: OAuthGrantPayload): KeyRecord | undefined {
  const hash = createHash('sha256').update(payload.refresh).digest('hex').slice(0, 12)
  const projectedRef = accountRef(provider, hash)
  const byRef = accounts.find(candidate => candidate.oauth!.grantRef === projectedRef)
  if (byRef !== undefined) return byRef
  if (payload.accountId !== undefined) {
    const byAccountId = accounts.find(candidate => candidate.oauth!.accountId === payload.accountId)
    if (byAccountId !== undefined) return byAccountId
  }
  if (payload.email === undefined) return undefined
  return accounts.find(candidate =>
    candidate.oauth!.email === payload.email && candidate.oauth!.accountId === undefined)
}

/**
 * What one activation read before it entered the queue (plan
 * iter-pool-activate-queue, "Spike outcome"): the grant payload it will project,
 * its serialized form, and the projection the route served at that moment.
 *
 * The baseline is the compare half of the in-turn compare-and-write: the write
 * lands only while the live record still equals it, so a foreign writer that
 * replaced the projection between the read and the turn is left untouched and
 * the activation refuses. `absent` is a real baseline ("nothing served this
 * route"), not a wildcard.
 */
type ActivationBaseline =
  | { state: 'absent' }
  | { state: 'present'; kind: CredentialRecordLike['kind']; payload: string; record: CredentialRecordLike }

interface ActivationPreparation {
  grantRef: string
  payload: OAuthGrantPayload
  written: string
  baseline: ActivationBaseline
}

/** What the turn changed in memory, for the flush-failure compensation. */
interface ActivationUndo {
  valueMissing: boolean
  cooldownUntil: number
  generation: number
}

export class KeysManagerService {
  readonly ctx: HostContext
  readonly store: KeysManagerStore
  private readonly als = new AsyncLocalStorage<RequestScope>()
  private readonly attempts = new Map<string, AttemptState>()
  private readonly stepAttempts = new Map<string, AttemptState>()
  private readonly streamAttempts = new Map<string, StreamAttempt[]>()
  private readonly linkedAttempts = new WeakMap<object, StreamAttempt>()
  private readonly retryBindings = new Map<string, { keyId: string; at: number }>()
  private readonly requestSteps = new Map<string, { turn: number; step: number; at: number }>()
  private attemptSequence = 0
  private readonly switches = new Map<string, { count: number; at: number }>()
  private warnings: string[] = []
  settings: SettingsLike | undefined
  private rawCredentials: CredentialsLike | undefined
  private readonly credentialOriginals = new WeakMap<object, CredentialOriginals>()
  private readonly credentialWrappers = new WeakMap<object, CredentialWrappers>()
  private brokerOwners = new Map<string, string>()
  private readonly bindingCache = new Map<string, 'healthy' | 'mismatch'>()
  /**
   * Providers whose managed credentials are being removed right now. While a
   * provider is unmanaged only the unbind direction of
   * {@link syncBrokerBinding} may run: a demotion inside the deletion loop
   * (an `oauth` row iterated before a surviving `api-key` row) must never
   * re-point the released profile at the broker.
   */
  private readonly releasingProviders = new Set<string>()
  private lastBindingPruneAt = 0
  private readonly selectionQueues = new Map<string, Promise<unknown>>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  /** The one shutdown this manager runs; a later close() joins it (round 38). */
  private closePromise: Promise<void> | undefined
  /**
   * The pre-close restoration is running (PR review round 37). Only inside it
   * — set when {@link restoreBorrowedWindows} starts and cleared in its
   * `finally`, the cleanup deadline included — does the module-private
   * {@link PRE_CLOSE_RESTORE} capability let a write past shutdown. A
   * restoration that outlives its deadline resumes after this went down and
   * is refused like any other continuation.
   */
  private preCloseRestorePhase = false
  /**
   * Shutdown has begun (PR review round 34). Set on `close()`'s first line,
   * before the pre-close restoration runs, so a test arriving while that
   * restoration is putting the outstanding borrows back is refused instead of
   * starting a second window the restoration would not cover. Never cleared:
   * the instance is closing.
   */
  private shutdownRequested = false
  /**
   * Providers whose in-flight row test borrows the route's credential
   * surface (QC B4: an OAuth row test's projection, and the broker reference
   * it may temporarily release). While a provider is borrowed the binding
   * authority must not derive a real binding from the borrowed world: a
   * mutation landing inside the window (`addKey`, `deleteKey`, an account
   * removal) would otherwise persist an unbind decided about a state that is
   * not the route's. {@link syncBrokerBinding} consults this exactly like
   * {@link releasingProviders}; the test's own window-end sync passes
   * `borrow: true` so the restored state is written back in one step.
   */
  private readonly testBindingBorrows = new Set<string>()
  /**
   * Providers with a borrowing row test in flight, mapped to that test's own
   * promise. The promise is the isolation seam: an ordinary request for the
   * provider waits on it (bounded, see {@link settleProviderTest}) before
   * resolving a credential, and reports its own outcome if the test fails.
   * Only OAuth-row tests borrow (QC N7), so only they register here.
   */
  private readonly testsInFlight = new Map<string, Promise<KeyTestResult>>()
  /**
   * Every in-flight row test, by provider — the single-concurrent-test lock
   * for both row kinds. Separate from {@link testsInFlight} because an
   * api-key test borrows nothing and must not isolate ordinary requests.
   */
  private readonly testsActive = new Map<string, Promise<KeyTestResult>>()
  /**
   * Every row test window that has not been released yet, by provider (PR
   * review round 33). Shutdown restores each window's borrowed projection
   * before `closing` refuses the in-window cleanup, so the map outlives
   * {@link testsActive} for a window whose request never settles.
   */
  private readonly testWindows = new Map<string, RowTestWindow>()
  /**
   * Upper bound on one ordinary request's wait for an in-flight row test
   * (QC B3). Injectable so tests can exercise the bound quickly.
   */
  private isolationWaitMs = KEY_TEST_ISOLATION_WAIT_MS
  /**
   * Providers whose abandoned test window is still being cleaned up (QC fix
   * wave 2). The fence stays until a cleanup completed: a new test would
   * borrow a projection that is not back yet, and an ordinary request must not
   * be served by a borrowed grant or an unbound route.
   */
  private readonly cleaningTests = new Set<string>()
  /**
   * Nesting depth of an in-flight removal per provider (PR review round 12).
   * {@link settleTestBeforeRemoval} can only wait for a test that already
   * exists, so a test starting after that check would read the grant and the
   * projection and then re-project an account the removal deleted. {@link
   * testKey} refuses while this marker is up. A depth, because `deleteKey`
   * releases through `releaseLocked` inside its own removal.
   */
  private readonly removalsInProgress = new Map<string, number>()
  /**
   * Generation of the newest cleanup attempt per provider (PR review round 2).
   * An attempt that outlives its deadline keeps writing while a later attempt
   * for the same window starts. Only the newest generation may release
   * provider-wide state — the fence, the borrow marker, the in-flight maps —
   * so a superseded attempt can never clear isolation a newer window owns.
   */
  private readonly cleanupAttempts = new Map<string, number>()
  /**
   * The abandoned window currently fencing each provider (QC fix wave 3,
   * W-002), so a later test attempt can retry its cleanup. Without this the
   * fence could only ever clear from the abandoned promise's settlement, and a
   * promise that settled while the seam was still wedged left the provider
   * isolated forever.
   */
  private readonly abandonedWindows = new Map<string, RowTestWindow>()
  /** Hard bound on one abandoned window's cleanup. Injectable for tests. */
  private testCleanupDeadlineMs = KEY_TEST_CLEANUP_DEADLINE_MS
  /** Hard bound on the shutdown drain of the grant chains. Injectable for tests. */
  private grantDrainDeadlineMs = GRANT_DRAIN_DEADLINE_MS
  /** Providers whose isolation-deadline warning already fired (warn once). */
  private readonly isolationWaitWarned = new Set<string>()
  /** Interactive sign-in attempts, by attempt id. */
  private readonly loginAttempts = new Map<string, LoginAttempt>()
  /** The provider → attempt id index for the single-attempt rule. */
  private readonly loginsInFlight = new Map<string, string>()
  private loginSequence = 0
  /** The route → attempt id index for the single transport sign-in rule. */
  private readonly transportInFlight = new Map<string, string>()
  /**
   * Per-route removal epoch. A removal bumps it before withdrawing the live
   * attempt, so that attempt's settle path can tell the account is gone and
   * drop a grant its commit had already started writing.
   */
  private readonly transportRemovals = new Map<string, number>()
  /**
   * Transport-account rows, hydrated from the `llm-omp-transports/<route>`
   * records. Kept out of the pi-ai pool document on purpose: the rows are a
   * read-only projection of another package's records, rebuilt by
   * {@link refreshTransportAccounts} and rendered by `buildState`.
   */
  private transportRows: TransportAccountView[] = []
  /** Tail of the serialized transport read chain. */
  private transportRefresh: Promise<void> | undefined
  /** The account row whose grant payload currently IS the projection, per provider. */
  private readonly activeAccounts = new Map<string, string>()
  /**
   * Providers whose live projection EXISTS but no managed row owns it (PR
   * review round 3). `activeAccounts` alone cannot tell "no projection" from
   * "a projection this process does not manage": an orphan or foreign grant
   * (hydration found no matching row) still serves ahead of any broker
   * reference, so the route must not be treated as the key pool's. Set by
   * hydration and by the reconciler when a record is present but unattributed,
   * cleared when the record is deleted or becomes owned.
   */
  private readonly foreignProjections = new Set<string>()
  /**
   * Account rows committed to removal (C6-1/I1 removal-aware oracle), marked
   * by {@link removeOAuthGrant} before its first awaited delete. A multi-row
   * release deletes every row's credential first and the provider record
   * last, and it never splices its rows, so while it runs the provider record
   * and the row object both still look live even though the row's grant is
   * already gone. Object identity alone therefore cannot tell "still serving"
   * from "mid-removal"; this mark can. A successful removal leaves it set —
   * the row it names is either spliced out (removeAccount/deleteKey) or left
   * flagged `valueMissing` (release) — but a removal whose awaited steps
   * THROW must clear it: the row is then still live and still managed, and a
   * stale mark would silently skip its rotation sync until a restart. It
   * marks the live object, so a row object recreated under the same id is
   * unaffected.
   */
  private readonly retiringAccounts = new WeakSet<KeyRecord>()
  /**
   * Per-provider projection generation — the write counter for
   * {@link activeAccounts} claims (round-3 finding 3) and the attribution
   * identity of a projected grant (round-6 finding SF1). It is bumped exactly
   * when a grant becomes the provider's projection (a manager-side
   * re-projection or the seam's committed grant at the settlement broadcast),
   * never at a later bookkeeping step. A hydration result whose generation no
   * longer matches is discarded instead of overwriting a newer projection
   * with a stale read.
   */
  private readonly ownershipGenerations = new Map<string, number>()
  /**
   * Per-account-row projection generation in effect when the row's CURRENT
   * cooldown was earned (round-6 finding SF1). `applyFailureCooldown` stamps
   * it at failure time, so a harvest can tell the previous grant's window
   * from one the freshly projected grant earned while the harvest was still
   * queued. A row with no entry carries a window that predates any observed
   * attribution (one loaded from disk, for example); the next projection
   * treats it as the older generation's.
   */
  private readonly cooldownGenerations = new Map<string, number>()
  /**
   * Per-provider chain of pending grant reconciliations (round-9 finding
   * P1): two refresh echoes for the same route can arrive before the first
   * write-back settles, and the bodies run read → write → commit. Arrival
   * order is preserved so the older observation can never commit after the
   * newer one and leave the row on a stale generation.
   *
   * Round-8 finding I-000106: activation joins the same chain. The only
   * writer of `row.oauth.grantRef` is {@link reconcileGrantRecord}, which runs
   * outside the mutation queue, so activation's record read and its projection
   * write must be mutually exclusive with that writer — otherwise a rotation
   * landing between them leaves the projection on a generation the row no
   * longer names.
   */
  private readonly grantReconciliations = new Map<string, Promise<void>>()
  /**
   * Providers whose projection deletion this manager initiated, mapped to
   * the moment it was initiated. The `record-updated` echo of our own
   * demotion consumes the marker (one-shot) and stays silent while the
   * marker is inside its TTL window; past the window the marker is expired
   * and a removal warns as genuinely out-of-band again.
   */
  private readonly intentionalProjectionRemovals = new Map<string, number>()
  /**
   * In-flight projection demotions by provider (round-5 finding C1): the
   * oauth failure path cools the account and demotes asynchronously, and the
   * failover retry must not re-enter the stream while the projection still
   * resolves — pi-ai prefers the stored grant, so the key pool would never be
   * reached. The request-error listener awaits this entry before deciding.
   */
  private readonly projectionDemotions = new Map<string, Promise<void>>()
  /**
   * MF3 load-time hydration result (round-8 finding I-000108). The
   * constructor starts the ownership read, but a restarted process can serve
   * a stream before it settles. Until this provider's read lands,
   * {@link activeAccounts} may not know the owner, so `wrapStream` would
   * select and mutate a key (cursor, `lastUsedAt`, sticky binding) even though
   * pi-ai serves the persisted grant, and an OAuth failure would be classified
   * as externally authenticated instead of cooling the account.
   *
   * The promise never rejects (hydration catches and warns per provider), but
   * it can stay pending forever. Requests therefore never subscribe to it
   * (round-10 should-fix SF2: a per-call `then`/`await` would be retained on a
   * promise that never settles); they wait per provider through
   * {@link hydratedProviders} and {@link hydrationWaiters} instead.
   */
  private projectionHydration: Promise<void> = Promise.resolve()
  /**
   * Upper bound on one stream's wait for its provider's hydration read
   * (round-9 should-fix). The hydration read has no timeout of its own, so
   * without a bound one stalled `readRecord` would gate every managed stream.
   * Injectable so tests can exercise the bound quickly.
   */
  private hydrationWaitMs = HYDRATION_WAIT_MS
  /**
   * Providers whose hydration read has landed — owner found or not
   * (round-10 should-fix SF1). Hydration walks the providers serially and
   * writes each owner as it goes, so one stalled read must not make an
   * already-read provider look unknown: a provider whose own read landed is
   * ready immediately, and the bounded wait's "unknown" fallback is confined
   * to the requested provider's own unresolved read.
   */
  private readonly hydratedProviders = new Set<string>()
  /**
   * Providers whose hydration ownership read FAILED (PR review round 8). A
   * failed read knows nothing about the route, so it is not the "no projection"
   * answer a successful empty read is: treating it as one let the startup
   * repair read an empty owner/foreign map as proof that the pool serves and
   * bind the broker over a persisted OAuth projection it could not read.
   * Readiness therefore stays false for these providers and the repair skips
   * them; only a restart can retry the read.
   */
  private readonly ownershipReadFailures = new Set<string>()
  /**
   * One resolver set per provider still being waited on (round-10 should-fix
   * SF2). A wait registers exactly one entry here and removes it when the wait
   * ends — on timeout or on the late landing — so a read that never settles
   * cannot retain anything per request. {@link noteProviderHydrated} is the
   * only notification channel; the shared hydration promise is never
   * subscribed to.
   */
  private readonly hydrationWaiters = new Map<string, Set<() => void>>()
  /**
   * True once the load-time hydration read is over (round-10 SF1). From then
   * on no hydration read can land. It is NOT evidence that a given provider's
   * projection was read (PR review round 17): a provider adopted after the
   * snapshot was never in it, so readiness is decided per provider
   * ({@link projectionOwnershipKnown}) and adoption reads its own projection.
   */
  private hydrationSettled = false
  /**
   * Credential-store generation of the ownership hydration (PR review round
   * 27). A remounted credentials service starts a new pass while the previous
   * store's reads can still be in flight; their answers describe records the
   * new backend does not hold, so the epoch gates every write and settle of
   * the pass that started it.
   */
  private hydrationEpoch = 0
  /**
   * Whether a credential store was ever attached (PR review round 27). The
   * first attach is the startup mount and keeps its behaviour; every later one
   * replaces the credential backend, so the ownership classification loaded
   * from the previous one is stale and the read restarts from unknown.
   */
  private credentialsMounted = false
  /** Providers whose bounded-wait warning already fired (warn once). */
  private readonly hydrationWaitWarned = new Set<string>()
  /**
   * Requests each provider served without an attributed account (`I-000120`,
   * D8): the ownership read had not landed, or it had failed. Counted at the
   * one per-request serving site (`wrapStream`), never in the hydration pass —
   * a failed read serves no request, it only makes later requests unattributed.
   * Cleared only when a later read decides the route's attribution; process-
   * local, never persisted and never on the warnings channel.
   */
  private readonly unattributedRequests = new Map<string, number>()
  /** Channels whose lost-subscription warning already fired (warn once). */
  private readonly subscriptionLostWarnings = new Set<string>()
  /** Disposer for the `authorization/settled` subscription. */
  private settledDisposer: (() => void) | undefined
  /** Disposer for the `credentials/record-updated` subscription. */
  private recordUpdatedDisposer: (() => void) | undefined
  readonly typertRemote: TypertRemoteBinding

  constructor(ctx: HostContext, store: KeysManagerStore) {
    this.ctx = ctx
    this.store = store
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE, namespace: NAMESPACE })
    this.rebuildBrokerMap()
    this.projectionHydration = this.hydrateProjectionOwnership()
    // Startup self-heal: repair every managed provider whose persisted binding
    // the serving credential no longer justifies. The pass waits per provider
    // for its own ownership read (see {@link repairBrokerBindings}), so a
    // wedged OAuth read cannot starve an api-key-only route.
    void this.repairBrokerBindings().catch(error => {
      this.warn(`startup broker binding repair failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.settledDisposer = this.watchAuthorizationSettled()
    this.recordUpdatedDisposer = this.watchGrantRecordUpdated()
    this.refreshTransportAccountsIfIdle()
  }

  /**
   * MF3 load-time hydration: a projection outlives this process — pi-ai
   * wrote `llm-pi-ai/<provider>` during a previous run and it survived in
   * the credential store. Match each persisted payload back to an account
   * row (the exact rule the rotation reconciler applies, via
   * {@link matchOwningAccount}) so removeAccount / deleteManagedCredentials
   * demote the projection and `onGrantRecordUpdated` can mark valueMissing
   * after a restart. An orphan projection — no matching row, e.g. a foreign
   * or stale grant — is left untouched: the manager never adopts a grant it
   * does not own, and out-of-band updates keep surfacing the native-
   * management warning. A live record that is not a managed grant at all (a
   * native api-key, an unrecognized payload) is foreign for the same reason
   * (PR review round 4): it serves the route, so the startup repair must not
   * bind the broker over it.
   *
   * EVERY managed provider's projection is read (PR review round 13), not
   * only those with OAuth rows: a key-only pool can be overridden by a
   * native grant persisted for the same route, and a skipped read left the
   * startup repair free to bind the broker over it. The reads run
   * concurrently so one provider's stalled read cannot delay another
   * provider's own readiness (round 9).
   *
   * Returns its own completion (round-8 finding I-000108), and the returned
   * promise is already caught, so a failed hydration degrades to "no owner"
   * instead of wedging every request. Request attribution does not subscribe
   * to that promise (round-10 should-fix SF2 — it may stay pending forever);
   * each request waits on its own provider's landing instead.
   */
  private hydrateProjectionOwnership(): Promise<void> {
    const epoch = this.hydrationEpoch
    const records = this.credentialRecords()
    if (records === undefined) {
      // The credentials service can mount after this plugin (PR review round
      // 23): nothing was read, so ownership stays UNKNOWN. Settling here marked
      // every provider hydrated, and the startup repair read the empty
      // owner/foreign maps as "the key pool serves", binding the broker over a
      // persisted projection it never saw. attachCredentials re-runs this read
      // (and the repair) once the record half is reachable.
      this.warnSubscriptionLost('credentials record access')
      return Promise.resolve()
    }
    return (async () => {
      try {
        // allSettled, never all: under `all`, a rejection from any single
        // provider task settles this awaited pass at once, so the finally below
        // flips `hydrationSettled` while the other providers' reads are still
        // in flight and `awaitProjectionOwnership` calls them ready. No task
        // body can reject today (the read error is caught inside it), so this
        // is a structural guard — do not flip it back for style.
        await Promise.allSettled(Object.values(this.store.providers).map(async providerRecord => {
          const provider = providerRecord.provider
          const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
          try {
            const grantKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
            // Generation tag (round-3 finding 3): the read below is awaited, and
            // an activation or login landing while it is in flight must win —
            // the hydrated write only lands while the generation still matches.
            const generation = this.ownershipGenerations.get(provider) ?? 0
            let record: Awaited<ReturnType<typeof records.readRecord>>
            try {
              record = await records.readRecord(grantKey)
            } catch (error) {
              // PR review round 8: a failed read is not an absent projection.
              // Record it so readiness stays false and no repair binds the
              // broker over a grant this process could not see.
              // PR review round 23: unless a newer claim landed while this read
              // was in flight — a stale failure must not mark an established
              // owner unknown (same generation guard as the hydrated write).
              if (this.hydrationEpoch !== epoch || (this.ownershipGenerations.get(provider) ?? 0) !== generation) return
              this.ownershipReadFailures.add(provider)
              this.warn(`projection ownership hydration could not read ${grantKey}: ${error instanceof Error ? error.message : String(error)}`)
              return
            }
            // No record: nothing projects this route, so the pool may serve it.
            if (record === undefined) return
            // A live record this pool cannot interpret — a native api-key, an
            // unrecognized payload, or (for a key-only pool) any grant at all —
            // serves the route ahead of any broker reference exactly like an
            // unowned grant, so it is classified as foreign below (PR review
            // rounds 4 and 13).
            const owner = record.kind === 'grant' && isOAuthGrantPayload(record.payload)
              ? matchOwningAccount(provider, accounts, record.payload)
              : undefined
            // A newer activation/login claimed the owner while this read was in
            // flight: the stale read is discarded, never written over it. A
            // remount replaced the whole store: its classification is gone too.
            if (this.hydrationEpoch !== epoch || (this.ownershipGenerations.get(provider) ?? 0) !== generation) return
            // A concurrent removal may have dropped the row while this read was
            // in flight: never resurrect an owner entry for a row that is gone.
            if (owner !== undefined && providerRecord.keys.some(candidate => candidate.id === owner.id)) {
              this.activeAccounts.set(provider, owner.id)
              this.foreignProjections.delete(provider)
            } else {
              // Present but not a managed OAuth grant (PR review rounds 3–4):
              // the projection still serves, so the pool is not the route's
              // credential source and the startup repair must not bind it.
              this.foreignProjections.add(provider)
            }
          } finally {
            // This provider's own read is over (owner or not): its requests are
            // attributable now and must not wait behind another provider's
            // stalled read (round-10 should-fix SF1). A superseded pass does
            // not report readiness for a store it no longer describes.
            if (this.hydrationEpoch === epoch) {
              // A landed read decided this route's attribution; a failed one
              // decided nothing and never clears the count (I-000120).
              if (!this.ownershipReadFailures.has(provider)) this.unattributedRequests.delete(provider)
              this.noteProviderHydrated(provider)
            }
          }
        }))
      } finally {
        // The read is over (completed or abandoned): from now on no result can
        // land, so every provider is ready — including one whose OAuth rows
        // appear later, which this read could not have projected.
        if (this.hydrationEpoch === epoch) {
          this.hydrationSettled = true
          this.settleHydrationWaits()
        }
      }
    })().catch(error => {
      this.warn(`projection ownership hydration failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Drop every ownership fact loaded from a previous credential store (PR
   * review round 27). The classification is per backend: a record that existed
   * in the old store says nothing about the remounted one, and a route whose
   * old store held a managed projection would otherwise stay attributed to
   * that account and off its surviving key pool. The epoch bump discards a read
   * still in flight from the replaced store instead of letting its answer land
   * over the new one; ownership stays unknown until the new pass reads.
   */
  private invalidateProjectionOwnership(): void {
    this.hydrationEpoch += 1
    this.activeAccounts.clear()
    this.foreignProjections.clear()
    this.hydratedProviders.clear()
    this.ownershipReadFailures.clear()
    this.hydrationSettled = false
  }

  /**
   * Record that one provider's hydration read is over — owner or not (SF1) —
   * and wake the requests waiting on that provider alone (SF2).
   */
  private noteProviderHydrated(provider: string): void {
    this.hydratedProviders.add(provider)
    const waiters = this.hydrationWaiters.get(provider)
    if (waiters === undefined) return
    this.hydrationWaiters.delete(provider)
    for (const wake of [...waiters]) wake()
  }

  /**
   * An authoritative projection read answered for this provider, so a failed
   * startup hydration no longer leaves ownership unknown (PR review round 13:
   * the marker used to survive until a restart — no attribution, no key
   * selection, and row tests refused with "ownership is still loading"). The
   * binding re-derive is queued behind the reconciliation that proved the
   * read: its attribution decides the route's serving shape, and the startup
   * repair was skipped while that shape was unknown.
   */
  private noteProjectionReadSucceeded(provider: string): void {
    // This read decided the route's attribution, so a count of requests served
    // without one no longer describes it (I-000120).
    this.unattributedRequests.delete(provider)
    if (!this.ownershipReadFailures.delete(provider)) return
    this.noteProviderHydrated(provider)
    void this.scheduleGrantReconciliation(provider, () => this.syncBindingAfterProjectionChange(provider))
  }

  /** Release every provider's readiness wait when hydration cannot proceed. */
  private settleHydrationWaits(): void {
    for (const provider of Object.keys(this.store.providers)) this.noteProviderHydrated(provider)
  }

  /**
   * Wait for one provider's own hydration read to land, at most `ms`, and
   * report whether it landed.
   *
   * Registers exactly one waiter entry for this wait and removes it when the
   * wait ends either way (round-10 should-fix SF2): nothing is attached to the
   * shared hydration promise, so a read that never settles cannot retain one
   * reaction per request. A late landing still wakes the wait through
   * {@link noteProviderHydrated}, and the generation guard in
   * {@link hydrateProjectionOwnership} still decides whether its result lands
   * (I-000108).
   */
  private waitForProviderHydration(provider: string, ms: number): Promise<boolean> {
    // A failed read never becomes ready (PR review round 8): waiting cannot
    // produce an answer this process does not have.
    if (this.ownershipReadFailures.has(provider)) return Promise.resolve(false)
    if (this.hydrationSettled || this.hydratedProviders.has(provider)) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let waiters = this.hydrationWaiters.get(provider)
      if (waiters === undefined) {
        waiters = new Set<() => void>()
        this.hydrationWaiters.set(provider, waiters)
      }
      const live = waiters
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (landed: boolean): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        live.delete(onLanded)
        if (live.size === 0 && this.hydrationWaiters.get(provider) === live) this.hydrationWaiters.delete(provider)
        resolve(landed)
      }
      const onLanded = (): void => {
        // A failed read wakes the wait with "not known", never with a guess
        // about the projection (PR review round 8).
        wake(!this.ownershipReadFailures.has(provider))
      }
      timer = setTimeout(() => {
        wake(false)
      }, ms)
      // I-000116: a request waiting on hydration must not hold the process
      // open for the rest of the wait; every exit path still clears it.
      timer.unref?.()
      live.add(onLanded)
    })
  }

  /**
   * Live per-provider waiter entries. A documented internal counter for the
   * round-10 SF2 invariant: a wait that ended must leave no entry behind, so
   * this never grows with the number of timed-out requests.
   */
  private hydrationWaiterCount(): number {
    let total = 0
    for (const waiters of this.hydrationWaiters.values()) total += waiters.size
    return total
  }

  /**
   * Wait (bounded) until projection-ownership hydration can attribute this
   * request, and report whether it did.
   *
   * Readiness is decided PER PROVIDER (round-10 should-fix SF1): every managed
   * provider's own projection read lands independently (PR review round 13), so
   * a provider whose read has landed needs no wait and a stalled read for
   * another provider cannot delay this one.
   *
   * Returns false when the bound elapsed first. The caller then treats
   * attribution as unknown (no owner) and keeps key state untouched: a
   * projection may still be serving, and selecting/mutating a key here would
   * repeat the I-000108 corruption. The hydration promise is not cancelled,
   * so a late result still lands under the generation guard and later
   * requests are attributed normally.
   */
  private async awaitProjectionOwnership(providerId: string): Promise<boolean> {
    if (this.projectionOwnershipKnown(providerId)) return true
    const landed = await this.waitForProviderHydration(providerId, this.hydrationWaitMs)
    if (landed) return true
    if (!this.hydrationWaitWarned.has(providerId)) {
      this.hydrationWaitWarned.add(providerId)
      this.warn(this.ownershipReadFailures.has(providerId)
        ? `projection ownership for ${providerId} could not be read; requests proceed without an attributed account until a restart`
        : `projection ownership hydration did not settle within ${this.hydrationWaitMs}ms for ${providerId}; requests proceed without an attributed account until it does`)
    }
    return false
  }

  /**
   * Whether this provider's projection ownership can already be decided
   * without waiting (round-10 SF1, made the single readiness rule by PR review
   * round 3). Every managed provider's projection is read at hydration (a
   * key-only pool can be overridden by a persisted native grant, PR review
   * round 13), so the rule is the same for all of them: this provider's own
   * read landed, or a claim already owns it.
   *
   * The process-wide settled flag is deliberately NOT part of this rule (PR
   * review round 17): a provider adopted after the snapshot was never read by
   * it, so "hydration is over" says nothing about THAT route's projection.
   * Adoption reads it itself ({@link readAdoptionProjection}) and an extra
   * provider's profile is created by its own call, so every managed provider
   * still answers through its own marker.
   */
  private projectionOwnershipKnown(providerId: string): boolean {
    if (this.store.provider(providerId) === undefined) return true
    // A failed read is unknown even after the whole hydration settled: the
    // settled flag says no read can land, not that this one answered.
    if (this.ownershipReadFailures.has(providerId)) return false
    return this.hydratedProviders.has(providerId) || this.activeAccounts.has(providerId)
  }

  /**
   * Record that a newly committed grant became the provider's projection and
   * return that projection's generation (round-6 finding SF1).
   *
   * The bump happens at the moment the projection is observable — pi-ai's
   * committed grant at the settlement broadcast, or a manager-side
   * re-projection (activation, rotation reconcile, harvest claim) — so every
   * failure stamped afterwards belongs to that projection. It must never be
   * deferred to a later bookkeeping step: the harvest waits behind the
   * mutation queue and the projection read while the new grant already
   * serves, and a failure landing there must not be mistaken for the
   * previous grant's.
   */
  private noteProjectionCommitted(provider: string): number {
    const generation = (this.ownershipGenerations.get(provider) ?? 0) + 1
    this.ownershipGenerations.set(provider, generation)
    return generation
  }

  /**
   * Claim the projection owner for one account row, bumping the provider's
   * ownership generation so an in-flight hydration read of an older state
   * is discarded instead of overwriting the claim (round-3 finding 3).
   */
  private claimProjectionOwner(provider: string, accountId: string): void {
    this.activeAccounts.set(provider, accountId)
    this.foreignProjections.delete(provider)
    this.noteProjectionCommitted(provider)
    // The route has an owner now, so requests are attributed from here on.
    this.unattributedRequests.delete(provider)
  }

  /**
   * Log without ever echoing secret material. */
  warn(message: string): void {
    try {
      this.ctx.logger.warn(`keys-manager: ${message}`)
    } catch {
      // Logging must never break request handling.
    }
  }

  /** Rebuild the broker-reference → provider index. */
  private rebuildBrokerMap(): void {
    this.bindingCache.clear()
    this.brokerOwners = new Map()
    for (const provider of Object.values(this.store.providers)) {
      if (provider.brokerRef.length > 0) this.brokerOwners.set(provider.brokerRef, provider.provider)
    }
    for (const [key, pin] of this.retryBindings) {
      const providerId = key.split('\u0000')[1]
      const provider = providerId === undefined ? undefined : this.store.provider(providerId)
      if (provider === undefined || !provider.keys.some(candidate => candidate.id === pin.keyId)) {
        this.retryBindings.delete(key)
      }
    }
  }

  /** Serialize mutations, rejecting submissions that arrive during shutdown. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Keys Manager is shutting down'))
    const guarded = async (): Promise<T> => {
      if (this.store.readOnly) {
        throw new Error('The state file could not be read; refusing to write over it. Restart after fixing file access.')
      }
      const result = await operation()
      // A mutation is not successful until its state document is durable.
      await this.store.flush()
      return result
    }
    const next = this.queue.then(guarded, guarded)
    this.queue = next.catch(() => {})
    return next
  }

  /**
   * Periodically drop expired transient state: retry pins after `PIN_TTL_MS`,
   * the remaining attempt/step records after `ATTEMPT_TTL_MS`.
   */
  pruneTransient(now: number = Date.now()): void {
    this.pruneAttempts(now)
    this.pruneLoginAttempts(now)
  }

  /**
   * Whether a continuation that resumes from an await must stop writing
   * (PR review round 35). `shutdownRequested` is up for `close()`'s own
   * pre-close restoration, which writes by design: it alone carries the
   * module-private {@link PRE_CLOSE_RESTORE} capability (round 36), which is
   * honoured only while that phase is running (round 37). Both facts are read
   * here, at the caller's write decision, so a capability the phase left
   * behind cannot pass a check made earlier.
   */
  private persistenceRefused(capability?: RestoreCapability): boolean {
    if (!this.closing && !this.shutdownRequested) return false
    // PR review round 38: the capability is scoped to the one restoration pass
    // that runs before shutdown closes the store. Once `closing` is set the
    // pass is over for good, so a capability left over from a timed-out pass
    // (or handed to a repeated `close()`) cannot write again.
    return !(capability === PRE_CLOSE_RESTORE && this.preCloseRestorePhase && !this.closing)
  }

  /** Stop accepting mutations, drain the queue, then persist the final snapshot. */
  close(): Promise<void> {
    // PR review round 38: shutdown is single-entry. A second call (or a
    // concurrent one) joins the first instead of replaying the restoration,
    // which would otherwise write to a store the first call already closed.
    // Not `async`: callers share the identical promise, so a repeated close
    // cannot observe a second shutdown.
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce()
    this.closePromise = closing
    return closing
  }

  /** The body of the one shutdown this manager runs. */
  private async closeOnce(): Promise<void> {
    // PR review round 34: the entry marker goes up before the restoration, so
    // the window this function spends putting borrowed projections back cannot
    // accept a new test and a new borrow.
    this.shutdownRequested = true
    // PR review round 33: `closing` refuses the in-window cleanup, so every
    // outstanding borrow is put back first. A test whose request ignores the
    // abort otherwise leaves the tested account projected past unload.
    await this.restoreBorrowedWindows()
    this.closing = true
    this.settledDisposer?.()
    this.settledDisposer = undefined
    this.recordUpdatedDisposer?.()
    this.recordUpdatedDisposer = undefined
    for (const attempt of this.loginAttempts.values()) {
      attempt.controller.abort()
      this.dropPrompt(attempt, new Error('Keys Manager is shutting down'))
    }
    try {
      await this.queue
    } catch {
      // The mutation queue already reports failures to its caller.
    }
    // Round-9 P1: the per-provider reconciliation chains are independent of
    // the mutation queue, so drain them before the store closes — a queued
    // echo must not write a grant record into a manager that is shutting down.
    await this.drainGrantReconciliations()
    await this.store.close()
  }

  /**
   * Put every outstanding window's borrowed projection back before shutdown
   * closes the store (PR review round 33).
   *
   * `close()` sets `closing`, which refuses {@link cleanupTestWindow} — the one
   * identity-checked restoration — so a test whose request ignores the abort
   * used to leave the tested account projected and the binding it released
   * released, past unload and into the next startup. Each window's captured
   * facts are restored through the same compare-by-payload path as the late
   * reconcile, under one cleanup bound and the attempt fence (a superseded
   * attempt writes nothing), and a window that released the binding re-syncs it
   * against the restored serving source.
   *
   * The request itself is never waited for — an adapter can still rewrite the
   * projection after its restore — so a restoration that cannot finish in the
   * bound warns once and leaves the state to the next startup's hydration.
   */
  private async restoreBorrowedWindows(): Promise<void> {
    // PR review round 37: the capability is scoped to this phase. The flag goes
    // up before the first await and down however the phase ends — a restoration
    // the cleanup deadline abandoned is still parked, and it resumes with the
    // phase already over.
    this.preCloseRestorePhase = true
    try {
      for (const window of [...this.testWindows.values()]) {
        const facts = window.facts
        if (facts === undefined) continue
        const attempt = (this.cleanupAttempts.get(window.provider) ?? 0) + 1
        this.cleanupAttempts.set(window.provider, attempt)
        const stillCurrent = (): boolean => this.cleanupAttempts.get(window.provider) === attempt
        const failure = await this.withinCleanupDeadline(async () => {
          // QC fix wave 3 (W-001): a borrow or binding release still in flight
          // reads as the pre-borrow payload, so the restore would call the route
          // clean and let the write land afterwards.
          await this.awaitWindowMutations(window)
          // The window is still outstanding, so this is an in-window restore (not
          // the late one): the attempt fence is the only identity it needs. This
          // is also the one writer that holds the pre-close capability.
          const restored = await this.restoreProjection(
            facts.records,
            window.provider,
            window.row,
            facts.key,
            facts.previous,
            facts.borrowed,
            stillCurrent,
            false,
            PRE_CLOSE_RESTORE,
          )
          if (restored !== undefined) return restored
          if (!stillCurrent()) return 'a newer cleanup attempt took over this provider'
          if (!window.releasedBinding) return undefined
          // QC B4: the borrow released the profile's binding, so the restored
          // serving source must be written back to it.
          return await this.syncBrokerBinding(window.provider, { borrow: true })
            ? undefined
            : 'the route credential binding could not be restored'
        })
        if (failure !== undefined) {
          this.warn(`shutdown could not put the borrowed credential for ${window.provider} back (${failure}); the projection stays as the store holds it and the next startup's hydration restores it`)
        }
      }
    } finally {
      this.preCloseRestorePhase = false
    }
  }

  /**
   * Drain the grant chains under a hard bound (PR review round 29).
   *
   * The work is not cancelled — the credential seam offers no cancellation and
   * a wedged provider request may never settle — it is only stopped from
   * holding shutdown: the chain past the deadline is abandoned, and its late
   * write can only land in a store that is closing anyway.
   */
  private async drainGrantReconciliations(): Promise<void> {
    // The drain never rejects: a chain failure is that chain's own result.
    const drained = Promise.allSettled([...this.grantReconciliations.values()]).then(() => false)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), this.grantDrainDeadlineMs)
      timer.unref?.()
    })
    try {
      if (await Promise.race([drained, deadline])) {
        this.warn('shutdown stopped waiting for a grant reconciliation still held by a connection test request that never settled')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Push a user-facing warning that rides the next state response. */
  private pushWarning(message: string): void {
    this.warnings.push(message)
    if (this.warnings.length > 4) this.warnings.shift()
  }

  private takeWarnings(): string[] {
    const warnings = this.warnings
    this.warnings = []
    return warnings
  }

  /**
   * Report declared headers whose stored value no longer matches what the
   * environment supplies. The stored value is never replaced — the user may
   * have set it deliberately — but the divergence must be visible, because
   * otherwise the route keeps sending the stale value forever.
   */
  private warnHeaderDrift(extra: ExtraProvider, declared: Record<string, string> | undefined, stored: Record<string, string>): void {
    if (declared === undefined) return
    for (const [header, value] of Object.entries(declared)) {
      const storedKey = storedHeaderKey(stored, header)
      if (storedKey === undefined || stored[storedKey] === value) continue
      const envName = extra.headerEnv?.[header] ?? header
      this.pushWarning(`The stored ${storedKey} header on the ${extra.id} route differs from the value ${envName} now supplies; the stored value was kept.`)
    }
  }

  /** Current settings service, if the composition mounted one. */
  private settingsService(): SettingsLike | undefined {
    if (this.settings !== undefined) return this.settings
    return (this.ctx.get as (name: string) => unknown)('settings') as SettingsLike | undefined
  }

  /**
   * Mount the settings service — the host's `ctx.inject(['settings'])` seam.
   *
   * A mount that lands after construction retries the binding repair: the
   * startup pass could not read a profile yet and would otherwise leave the
   * route broken for the whole session.
   */
  attachSettings(settings: SettingsLike): void {
    this.settings = settings
    // The repair decides from projection ownership, which the constructor
    // hydrates asynchronously: a persisted projection read from an empty owner
    // map would make the route look key-pool-served and bind it to the broker
    // (PR review round 2). The pass therefore waits per provider for its own
    // read — never for the process-wide promise, which one wedged OAuth read
    // can hold forever (PR review round 3).
    void this.repairBrokerBindings().catch(error => {
      this.warn(`broker binding repair after the settings mount failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Unmount the settings service that a re-mount replaced. */
  detachSettings(settings: SettingsLike): void {
    if (this.settings === settings) this.settings = undefined
  }

  /** Current raw credential provider. */
  private credentialsRaw(): CredentialsLike | undefined {
    const current = (this.ctx.get as (name: string) => unknown)('credentials') as (CredentialsLike & Record<PropertyKey, unknown>) | undefined
    if (current === undefined) return undefined
    return (current[ORIGINAL] as CredentialsLike | undefined) ?? current
  }

  /**
   * The credential store's record half, reached through the raw provider:
   * the broker wrappers only ever replace the reference methods, so the
   * record methods of the mounted credential provider are always intact on
   * the raw instance. `llm-pi-ai` writes its grants through exactly these
   * methods, so the manager's activation projection must use them too.
   */
  private credentialRecords(): CredentialRecordsLike | undefined {
    const raw = this.credentialsRaw() as (CredentialsLike & Partial<CredentialRecordsLike>) | undefined
    if (raw === undefined) return undefined
    if (typeof raw.readRecord !== 'function' || typeof raw.modifyRecord !== 'function') return undefined
    return raw as CredentialRecordsLike
  }

  /**
   * Resolve the OAuth authorization flow one provider offers.
   *
   * The flow key format is pinned by `llm-pi-ai/login.ts:149-171` +
   * `auth.ts:29,36-38`: `recordKeyFor(providerId)` = `llm-pi-ai/<providerId>`,
   * with the oauth method offered first (`login.ts:40-47`). A provider with
   * no such flow (not OAuth-capable, or not installed) resolves to
   * undefined, which callers must treat as "sign-in unavailable".
   *
   * Availability is read from the live seam on every call, never cached:
   * the authorization service may mount after this plugin, so a route whose
   * flow is not enumerable yet stays account-unsupported until the flow list
   * exists (the client re-reads state after that ordering settles).
   */
  oauthFlowFor(provider: string): { key: string; method: string } | undefined {
    const flows = this.ctx.authorization?.list() ?? []
    const flow = flows.find(entry => entry.key === `llm-pi-ai/${provider}`)
    if (flow === undefined) return undefined
    if (!flow.methods.some(method => method.id === 'oauth')) return undefined
    return { key: flow.key, method: 'oauth' }
  }

  /**
   * C6-2: can this route's OAuth sign-in actually begin right now? Account
   * capability is gated on this instead of the catalog's `nativeAuth.oauth`
   * flag alone, so a route without a registered pi-ai flow never offers an
   * Add account that would fail. The check is lazy — see {@link oauthFlowFor}.
   */
  private oauthFlowAvailable(provider: string): boolean {
    return this.oauthFlowFor(provider) !== undefined
  }

  /**
   * Resolve one transport route's sign-in flow.
   *
   * The transports package registers `llm-omp-transports/<route>` itself, so
   * the live flow list is also this manager's inventory of transport routes:
   * a route with no registered flow is not a transport account surface, and a
   * route whose record exists but whose flow is gone is not listed at all
   * (there would be nothing to sign in with).
   *
   * The method id is the flow's own (`methods[0].id`), never a literal
   * `'oauth'`: the scope prefix is the whole cross-package contract, and the
   * transports package may name a method that is not OAuth. A flow with no
   * method cannot be begun and is not a sign-in surface.
   */
  private transportFlowFor(route: string): AuthorizationFlowEntry | undefined {
    return (this.ctx.authorization?.list() ?? [])
      .find(entry => entry.key === `${TRANSPORT_CREDENTIAL_SCOPE}/${route}` && transportMethodOf(entry) !== undefined)
  }

  /** Every registered transport flow, in seam order. */
  private transportFlows(): AuthorizationFlowEntry[] {
    return (this.ctx.authorization?.list() ?? [])
      .filter(entry => entry.key.startsWith(`${TRANSPORT_CREDENTIAL_SCOPE}/`) && transportMethodOf(entry) !== undefined)
  }

  /**
   * Warn once per channel: a lost subscription silently disables a whole
   * feature (harvest never runs; rotations never sync), so the degradation
   * must be observable instead of indistinguishable from success.
   */
  private warnSubscriptionLost(channel: string, error?: unknown): void {
    if (this.subscriptionLostWarnings.has(channel)) return
    this.subscriptionLostWarnings.add(channel)
    const detail = error === undefined ? '' : ` (${error instanceof Error ? error.message : String(error)})`
    this.warn(`the ${channel} subscription is unavailable${detail}; OAuth sign-in sync is degraded`)
  }

  /**
   * Subscribe to the seam's settled broadcast (authorization/src/index.ts:57,
   * :337-351). A settled attempt for a key this service is driving harvests
   * the committed grant; everything else is ignored — another surface's
   * sign-in is that surface's business, and the grant it leaves behind is
   * reconciled through `credentials/record-updated` instead.
   */
  private watchAuthorizationSettled(): (() => void) | undefined {
    const on = (this.ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => unknown) => () => void }).on
    if (typeof on !== 'function') {
      this.warnSubscriptionLost('authorization/settled')
      return undefined
    }
    try {
      return on.call(this.ctx, 'authorization/settled', (key: unknown, settlement: unknown) => {
        if (typeof key !== 'string') return
        this.onAuthorizationSettled(key, typeof settlement === 'string' ? settlement : '')
      })
    } catch (error) {
      this.warnSubscriptionLost('authorization/settled', error)
      return undefined
    }
  }

  /** One settled broadcast: finalize the matching attempt, harvest on success. */
  private onAuthorizationSettled(key: string, settlement: string): void {
    if (!key.startsWith(`${OAUTH_GRANT_RECORD_SCOPE}/`)) return
    const provider = key.slice(OAUTH_GRANT_RECORD_SCOPE.length + 1)
    const attemptId = this.loginsInFlight.get(provider)
    if (attemptId === undefined) return
    const attempt = this.loginAttempts.get(attemptId)
    if (attempt === undefined || attempt.settledAt !== undefined) return
    if (settlement === 'authorized') {
      // F2 provenance: capture the projection payload at the settlement
      // broadcast — the point where the seam reports THIS attempt's commit —
      // instead of reading whatever is live when the queued harvest finally
      // runs. The capture starts here, outside the mutation queue, so a
      // release parked ahead of the harvest cannot let a foreign writer
      // become this attempt's provenance.
      //
      // R6-SF1: the committed grant is already the provider's projection at
      // this broadcast, so this is also the generation boundary for cooldown
      // attribution. Everything the harvest does afterwards (queue and
      // projection-read waits included) runs against this generation.
      const projectionGeneration = this.noteProjectionCommitted(provider)
      void this.harvestLogin(attempt, this.captureSettledProjection(attempt), projectionGeneration)
      return
    }
    if (settlement === 'cancelled') this.finishLoginAttempt(attempt, 'cancelled')
    else this.failLoginAttempt(attempt, new Error(`the sign-in attempt failed (${settlement || 'unknown outcome'})`))
  }

  /**
   * The seam interaction one attempt hands to its flow.
   *
   * Shared by the pi-ai and transport sign-ins: both surfaces park notices and
   * prompts on the same {@link LoginAttempt} and are polled through
   * `accountAttempt`; only what happens after `authorized` differs.
   */
  private attemptInteraction(attempt: LoginAttempt): AuthorizationInteractionLike {
    return {
      notify: (notice: { message: string; url?: string; code?: string }): void => {
        attempt.notices.push(noticeView(notice))
        if (attempt.notices.length > 32) attempt.notices.shift()
        attempt.updatedAt = Date.now()
      },
      prompt: (prompt: { kind?: string; message: string; placeholder?: string; options?: unknown; signal?: AbortSignal }): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          if (attempt.settledAt !== undefined) {
            reject(new Error('This sign-in attempt has already ended'))
            return
          }
          if (prompt.signal?.aborted === true) {
            reject(new Error('The sign-in prompt was withdrawn'))
            return
          }
          attempt.status = 'prompt'
          attempt.updatedAt = Date.now()
          attempt.prompt = promptView(prompt)
          attempt.resolvePrompt = resolve
          attempt.rejectPrompt = reject
          // Cancellation propagates to the awaited prompt: a seam-side
          // withdrawal of this signal releases a flow parked here instead
          // of leaving it pending forever.
          prompt.signal?.addEventListener('abort', () => reject(new Error('The sign-in prompt was withdrawn')), { once: true })
        }),
    }
  }

  /**
   * Start one interactive OAuth sign-in. Returns immediately with the
   * attempt view; the attempt walks `pending → (prompt ⇄ pending) →
   * ready | failed | cancelled`, and every transition is observable through
   * {@link getAccountAttempt} / {@link listAccountAttempts}.
   */
  async beginAccountLogin(provider: string, alias?: string, targetAccountId?: string): Promise<AccountAttemptView> {
    if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('provider is required')
    const flow = this.oauthFlowFor(provider)
    if (flow === undefined) throw new Error(`Provider "${provider}" offers no OAuth sign-in flow`)
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) throw new Error(`Provider "${provider}" is not managed; adopt it before signing in`)
    // Validate the re-authentication target up front (round-3 finding 6):
    // the harvest binds the new grant to this row, so it must already name
    // a live OAuth account of this provider. It runs BEFORE the pending
    // resume (round-4 finding 3): a resume must never smuggle an older
    // attempt's target past the request's own validation, so an unknown or
    // foreign id is refused even while another sign-in is pending.
    let cleanTarget: string | undefined
    if (typeof targetAccountId === 'string' && targetAccountId.length > 0) {
      const target = providerRecord.keys.find(candidate => candidate.id === targetAccountId)
      if (target === undefined) throw new Error(`Account "${targetAccountId}" not found on ${provider}`)
      if (target.kind !== 'oauth' || target.oauth === null) throw new Error(`Key "${targetAccountId}" is not an OAuth account`)
      cleanTarget = targetAccountId
    }
    if (this.loginsInFlight.has(provider)) {
      // F3 (I-000082): a pending attempt IS the flow — reopening the dialog
      // resumes it (same id, same notices, same parked prompt) instead of
      // minting a competing second flow the seam's single-flight slot would
      // have to refuse. Terminal attempts never reach here: finishing an
      // attempt clears its provider slot, so the next begin starts fresh.
      const attemptId = this.loginsInFlight.get(provider)
      const inFlight = attemptId === undefined ? undefined : this.loginAttempts.get(attemptId)
      if (inFlight !== undefined && inFlight.settledAt === undefined) {
        // Round-4 finding 3: reuse is sound only when the resumed attempt
        // signs in the SAME target the caller asked for (or both name no
        // target). Silently resuming another row's flow would bind the new
        // grant to the older attempt's target.
        if (inFlight.targetAccountId === cleanTarget) return attemptView(inFlight)
        throw new Error(inFlight.targetAccountId === undefined
          ? `A sign-in for ${provider} is already pending without a target account; finish or cancel it before signing in to a specific account`
          : `A sign-in for ${provider} is already pending for a different account; finish or cancel it before signing in to ${cleanTarget ?? 'this provider'}`)
      }
      // Stale slot (should not happen — finishing always clears it): drop it
      // and start a fresh flow rather than wedging the provider.
      this.loginsInFlight.delete(provider)
    }
    const cleanAlias = typeof alias === 'string' ? alias.trim().slice(0, MAX_ALIAS) : undefined
    const now = Date.now()
    const attempt: LoginAttempt = {
      id: `la_${(++this.loginSequence).toString(36)}_${randomBytes(4).toString('hex')}`,
      provider,
      ...(cleanAlias !== undefined && cleanAlias.length > 0 ? { alias: cleanAlias } : {}),
      ...(cleanTarget !== undefined ? { targetAccountId: cleanTarget } : {}),
      status: 'pending',
      notices: [],
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
    }
    this.loginAttempts.set(attempt.id, attempt)
    this.capLoginAttempts()
    this.loginsInFlight.set(provider, attempt.id)
    const records = this.credentialRecords()
    if (records === undefined) {
      this.loginAttempts.delete(attempt.id)
      this.loginsInFlight.delete(provider)
      throw new Error('The credential store does not support records; OAuth sign-in is unavailable')
    }
    const interaction = this.attemptInteraction(attempt)
    const beginPromise = this.ctx.authorization!.begin({
      key: flow.key,
      method: flow.method,
      interaction,
      signal: attempt.controller.signal,
    })
    void beginPromise.then(
      outcome => {
        // The settled broadcast always lands first (the seam fires it in the
        // attempt's finally, authorization/src/index.ts:316-322). An
        // authorized outcome therefore means harvestLogin owns the terminal
        // transition (SF1): publishing ready the moment begin resolves would
        // close the dialog with "Signed in." while the grant capture is
        // still in flight — or failing. A cancelled outcome still finalizes
        // attempts that no settlement reached.
        if (outcome.status !== 'authorized') this.finishLoginAttempt(attempt, 'cancelled')
      },
      error => {
        this.failLoginAttempt(attempt, error)
      },
    )
    return attemptView(attempt)
  }

  /** Resolve the attempt's parked prompt with the human's answer. */
  async answerAccountPrompt(attemptId: string, value: string): Promise<void> {
    const attempt = this.loginAttempts.get(attemptId)
    if (attempt === undefined) throw new Error('Unknown sign-in attempt')
    if (attempt.settledAt !== undefined) throw new Error('This sign-in attempt has already ended')
    if (attempt.status !== 'prompt' || attempt.resolvePrompt === undefined) throw new Error('This attempt has no pending prompt')
    if (typeof value !== 'string') throw new TypeError('An answer value is required')
    const resolve = attempt.resolvePrompt
    this.dropPrompt(attempt)
    resolve(value)
  }

  /** One attempt's serializable view, or undefined when unknown. */
  getAccountAttempt(attemptId: string): AccountAttemptView | undefined {
    const attempt = this.loginAttempts.get(attemptId)
    return attempt === undefined ? undefined : attemptView(attempt)
  }

  /** Remote: poll one attempt's serializable state (T3 dialog channel). */
  accountAttempt(attemptId: string): AccountAttemptView | undefined {
    return this.getAccountAttempt(attemptId)
  }

  /** Every attempt, newest first, for T3 surfaces. */
  listAccountAttempts(): AccountAttemptView[] {
    return [...this.loginAttempts.values()].sort((a, b) => b.createdAt - a.createdAt).map(attemptView)
  }

  /**
   * Re-read every `llm-omp-transports/<route>` grant into
   * {@link transportRows}.
   *
   * Every caller gets a pass appended after the one already in flight, so an
   * awaiting caller observes a read that started after its own write (a
   * removal, a sign-in commit). Poll-only callers use
   * {@link refreshTransportAccountsIfIdle} instead, so a slow store cannot
   * accumulate one pass per page tick. A failed read leaves that route's
   * previous row alone instead of claiming the account disappeared; the next
   * pass retries.
   */
  refreshTransportAccounts(): Promise<void> {
    const previous = this.transportRefresh ?? Promise.resolve()
    const pass = previous.then(() => this.readTransportAccounts(), () => this.readTransportAccounts())
    const tail = pass.then(() => undefined, () => undefined)
    this.transportRefresh = tail
    void tail.then(() => {
      if (this.transportRefresh === tail) this.transportRefresh = undefined
    })
    return pass
  }

  /** Poll hint: start a pass only when none is in flight. */
  private refreshTransportAccountsIfIdle(): void {
    if (this.transportRefresh === undefined) void this.refreshTransportAccounts()
  }

  /** One read pass over every registered transport route. */
  private async readTransportAccounts(): Promise<void> {
    try {
      const flows = this.transportFlows()
      if (flows.length === 0) {
        this.transportRows = []
        return
      }
      const records = this.credentialRecords()
      const now = Date.now()
      const rows: TransportAccountView[] = []
      for (const flow of flows) {
        let record: CredentialRecordLike | undefined
        if (records !== undefined) {
          try {
            record = await records.readRecord(flow.key)
          } catch (error) {
            const previous = this.transportRows.find(row => row.scope === flow.key)
            if (previous !== undefined) rows.push(previous)
            this.warn(`transport account ${flow.key} could not be read: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
        }
        rows.push(transportAccountOf(flow, record, now))
      }
      this.transportRows = rows
    } catch (error) {
      // Fire-and-forget callers (getState, the record watcher) must never see
      // a rejection; the previous rows stay until the next pass.
      this.warn(`transport account refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Remote: start one transport sign-in.
   *
   * The flow lives on the transports package's own key
   * (`llm-omp-transports/<route>`), so the grant it commits stays that route's
   * credential: nothing here harvests it into a pool row or a `llm-pi-ai`
   * projection. The attempt is otherwise the same record the pi-ai dialog
   * polls through `accountAttempt`, so the client reuses that dialog; an
   * authorized outcome is terminal here (the flow has already committed).
   */
  async beginTransportLogin(route: string): Promise<AccountAttemptView> {
    if (typeof route !== 'string' || route.length === 0) throw new TypeError('provider is required')
    const flow = this.transportFlowFor(route)
    if (flow === undefined) throw new Error(`Provider "${route}" offers no transport sign-in flow`)
    const pendingId = this.transportInFlight.get(route)
    if (pendingId !== undefined) {
      const pendingAttempt = this.loginAttempts.get(pendingId)
      if (pendingAttempt !== undefined && pendingAttempt.settledAt === undefined) return attemptView(pendingAttempt)
      this.transportInFlight.delete(route)
    }
    const now = Date.now()
    const attempt: LoginAttempt = {
      id: `la_${(++this.loginSequence).toString(36)}_${randomBytes(4).toString('hex')}`,
      provider: route,
      status: 'pending',
      notices: [],
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
    }
    this.loginAttempts.set(attempt.id, attempt)
    this.capLoginAttempts()
    this.transportInFlight.set(route, attempt.id)
    const generation = this.transportGenerationOf(route)
    // `transportFlowFor` already proved the seam is mounted and the flow has a
    // method; the method id is the flow's own, not the pi-ai `'oauth'` literal.
    const settled = this.ctx.authorization!.begin({
      key: flow.key,
      method: transportMethodOf(flow)!,
      interaction: this.attemptInteraction(attempt),
      signal: attempt.controller.signal,
    }).then(
      async outcome => {
        // A removal during the attempt bumped the route's epoch: the account
        // is gone, so a grant this flow wrote while being withdrawn must not
        // recreate it. The seam refuses a commit after the abort, but a commit
        // that had already started can still land.
        if (this.transportGenerationOf(route) !== generation) {
          await this.dropRemovedTransportGrant(flow.key)
          this.finishLoginAttempt(attempt, 'cancelled')
          return
        }
        if (outcome.status === 'authorized') {
          this.finishLoginAttempt(attempt, 'ready')
          void this.refreshTransportAccounts()
          return
        }
        this.finishLoginAttempt(attempt, 'cancelled')
      },
      error => this.failLoginAttempt(attempt, error),
    )
    // A removal awaits this, so it deletes the grant only after the withdrawn
    // attempt (and any late write it drops) is done. The route keeps its
    // pending entry until the seam's `begin` resolves: an earlier settle
    // (prune, release, cancel) must not hide a commit that is still in flight.
    attempt.settled = settled.then(() => undefined, () => undefined).finally(() => {
      if (this.transportInFlight.get(route) === attempt.id) this.transportInFlight.delete(route)
    })
    return attemptView(attempt)
  }

  /**
   * Remote: confirm one transport route's stored grant.
   *
   * A transport route has exactly one grant record and its adapter resolves
   * that record per request, so the stored grant already IS the route's live
   * credential. Activation is therefore a state-level re-read: it writes
   * nothing (in particular no `llm-pi-ai/<route>` projection, which the
   * transport route never consults) and reports the current status so the UI
   * can tell "active" from "expired" or "sign in again".
   */
  async activateTransportAccount(route: string): Promise<StateView> {
    if (this.transportFlowFor(route) === undefined) throw new Error(`Provider "${route}" offers no transport account`)
    await this.refreshTransportAccounts()
    return this.buildState()
  }

  /**
   * Remote: drop one transport route's grant record.
   *
   * The record is the whole account — the transports package re-creates none —
   * so deleting it leaves the route signed out until the next sign-in. A live
   * sign-in is withdrawn first: left running, its commit would recreate the
   * grant this removal just deleted. No manager state is written, hence no
   * `run` queue and no state flush.
   */
  async removeTransportAccount(route: string): Promise<StateView> {
    const flow = this.transportFlowFor(route)
    if (flow === undefined) throw new Error(`Provider "${route}" offers no transport account`)
    const records = this.credentialRecords()
    if (records === undefined) throw new Error('The credential store does not support records')
    const pendingId = this.transportInFlight.get(route)
    const pending = pendingId === undefined ? undefined : this.loginAttempts.get(pendingId)
    // Key on the seam promise, not `settledAt`: the prune timeout, a provider
    // release and a cancel settle the attempt record while `begin` is still
    // pending (the seam refuses a withdraw during a commit). The epoch bump
    // and the await must cover that window, or a late `authorized` recreates
    // the grant this removal deleted.
    if (pending !== undefined && pending.settled !== undefined) {
      // Bump the epoch before the abort: the attempt's settle path reads it to
      // know this removal owns the record, and this await covers that path.
      this.transportRemovals.set(route, this.transportGenerationOf(route) + 1)
      pending.controller.abort()
      await pending.settled
    }
    await records.deleteRecord(flow.key)
    await this.refreshTransportAccounts()
    return this.buildState()
  }

  /** The route's removal epoch; absent means never removed. */
  private transportGenerationOf(route: string): number {
    return this.transportRemovals.get(route) ?? 0
  }

  /**
   * Drop a grant a withdrawn sign-in wrote after its account was removed.
   *
   * The seam refuses a commit once the attempt's signal aborts, but a commit
   * that had already started can still land. The account was deleted, so that
   * write is deleted too instead of being reported as a signed-in route.
   */
  private async dropRemovedTransportGrant(key: string): Promise<void> {
    const records = this.credentialRecords()
    if (records === undefined) return
    try {
      await records.deleteRecord(key)
    } catch (error) {
      this.warn(`transport account ${key} could not be dropped after its removal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Detach the parked prompt. With a reason the flow's awaited promise is
   * rejected too — a parked prompt dropped un-rejected would leave the
   * seam's flow (and the provider's single-flight slot) wedged until its
   * own timeout, so every attempt-ending path passes one.
   */
  private dropPrompt(attempt: LoginAttempt, reason?: Error): void {
    const reject = attempt.rejectPrompt
    attempt.resolvePrompt = undefined
    attempt.rejectPrompt = undefined
    attempt.prompt = undefined
    if (attempt.status === 'prompt') attempt.status = 'pending'
    attempt.updatedAt = Date.now()
    if (reject !== undefined && reason !== undefined) reject(reason)
  }

  /** Finalize an attempt with a terminal status exactly once. */
  private finishLoginAttempt(attempt: LoginAttempt, status: 'ready' | 'cancelled' | 'failed', error?: unknown): void {
    if (attempt.settledAt !== undefined) return
    attempt.settledAt = Date.now()
    attempt.status = status
    if (error !== undefined) {
      attempt.error = error instanceof Error ? error.message : String(error)
    }
    this.dropPrompt(attempt, new Error(
      status === 'failed'
        ? attempt.error ?? 'The sign-in attempt failed'
        : 'The sign-in attempt was cancelled',
    ))
    if (this.loginsInFlight.get(attempt.provider) === attempt.id) this.loginsInFlight.delete(attempt.provider)
    attempt.controller.abort()
    attempt.updatedAt = attempt.settledAt
  }

  /** Finalize an attempt as failed with the given reason. */
  private failLoginAttempt(attempt: LoginAttempt, error: unknown): void {
    this.finishLoginAttempt(attempt, 'failed', error)
  }

  /**
   * Turn a committed sign-in into pool state: persist the grant pi-ai wrote
   * to `llm-pi-ai/<provider>` according to the settlement-time capture,
   * under the plugin-scope account ref, and upsert the `kind: 'oauth'` row.
   * Any failure fails the attempt loudly — a login whose grant could not be
   * captured must not look like success.
   *
   * `committed` is the F2 provenance promise started by
   * {@link captureSettledProjection}: the projection payload observed at the
   * settlement broadcast, never a later live read. The harvest persists
   * exactly that payload and compensation may only revert exactly that
   * payload, so a foreign grant cannot become this attempt's authority just
   * because it landed before the queued mutation ran.
   *
   * `projectionGeneration` is the generation {@link noteProjectionCommitted}
   * recorded at that same broadcast (R6-SF1): it names the projection whose
   * failures own a cooldown, so the stale-window reset below clears only a
   * window attributed to an OLDER projection.
   *
   * A harvest that finds the attempt already settled writes neither the
   * plugin-scope copy nor a row, but the projection the seam committed for
   * this attempt is still demoted (ownership-checked, I-000122): a
   * failed/cancelled login must not keep serving through the route.
   */
  private async harvestLogin(
    attempt: LoginAttempt,
    committed: Promise<OAuthGrantPayload | undefined>,
    projectionGeneration: number,
  ): Promise<void> {
    // A revoke (provider release) may have finalized this attempt before
    // the seam's authorized settlement arrives: never resurrect rows for a
    // settled login (round-2 review, step 4).
    if (attempt.settledAt !== undefined) return
    // Records this login's grant identity for the failure-path
    // compensation below: `wroteRef` says the plugin-scope copy exists, and
    // the projection is reverted only while it still carries exactly this
    // login's committed payload. The row/owner facts are only needed when
    // the state flush rejects after the mutation resolved.
    let harvest: HarvestFacts | undefined
    try {
      await this.run(async () => {
        const records = this.credentialRecords()
        if (records === undefined) throw new Error('The credential store does not support records')
        const grantKey = `${OAUTH_GRANT_RECORD_SCOPE}/${attempt.provider}`
        const payload = await committed
        if (payload === undefined) {
          throw new Error(`No pi-ai OAuth credential was committed to ${grantKey}`)
        }
        // The refresh token is the stable per-grant secret; its digest —
        // never the token — names the account's plugin-scope record.
        const hash = createHash('sha256').update(payload.refresh).digest('hex').slice(0, 12)
        const grantRef = accountRef(attempt.provider, hash)
        // Capture the compensation facts BEFORE the managed-state check
        // (round-3 finding 2): release may win the race — it settles this
        // attempt and removes the provider while the harvest mutation is
        // queued behind it — and when the check below throws, the
        // compensation must still hold this login's payload so the pi-ai
        // projection it already committed can be reverted.
        const facts: HarvestFacts = { payload, grantRef, wroteRef: false }
        harvest = facts
        // Managed state and key capacity are checked BEFORE the
        // plugin-scope write (round-2 review, step 4): a login whose row
        // cannot exist must not strand the persisted grant.
        const providerRecord = this.store.provider(attempt.provider)
        if (providerRecord === undefined) throw new Error(`Provider "${attempt.provider}" is no longer managed`)
        // Round-9 finding I-000110: reuse the ordered ownership matcher the
        // rotation reconciler and hydration apply. The previous single `find`
        // ORing grantRef / accountId / email evaluated the email fallback in
        // ARRAY order, so an earlier email-only row adopted a later account's
        // grant when both carried the same address; the harvest then deleted
        // that earlier row's prior record as "superseded" — another account's
        // credential. Ref first, then the exact accountId, then the guarded
        // email fallback.
        const oauthRows = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
        const existing = matchOwningAccount(attempt.provider, oauthRows, payload)
          // Re-authentication target binding (round-3 finding 6): when the
          // payload matches nothing — a rotated token with no identity
          // metadata — the validated target row from beginAccountLogin
          // receives the grant instead of minting a duplicate row.
          ?? (attempt.targetAccountId !== undefined
            ? providerRecord.keys.find(candidate =>
                candidate.id === attempt.targetAccountId && candidate.kind === 'oauth' && candidate.oauth !== null)
            : undefined)
        if (existing === undefined && providerRecord.keys.length >= KEY_LIMIT) {
          throw new Error(`A provider may have at most ${KEY_LIMIT} keys`)
        }
        // Snapshot the record this write is about to overwrite (same-ref
        // re-authentication): a rejected state flush rolls the write back,
        // and the restored row must keep the payload it referenced.
        if (existing !== undefined && existing.oauth !== null && existing.oauth.grantRef === grantRef) {
          facts.previousRef = await records.readRecord(grantRef)
        }
        // R5-SF3: the cooldown reset below clears only the window the OLD
        // grant earned. The seam broadcasts the committed grant as soon as
        // pi-ai writes it, so the freshly committed grant can already be
        // serving requests while this write is awaited; a failure landing in
        // that window belongs to the new generation and must keep cooling.
        //
        // R6-SF1: the boundary is the projection generation, not the instant
        // this plugin-copy write starts. That instant sits too late — the
        // harvest also waited behind the mutation queue and the projection
        // read, and a failure of the already-projected grant landing there
        // used to look older than the write. Attribution is stamped onto the
        // row's window at failure time instead: only a window belonging to a
        // generation older than the one projected here is the previous
        // grant's. Timestamps play no part, so a same-millisecond recovery no
        // longer stalls.
        //
        // Codex P2 (PR #17): the settled guard at the top of this method
        // cannot see a settlement that lands AFTER this callback was queued
        // but BEFORE it runs. A release queued ahead does exactly that — the
        // settlement broadcast arrives while the release body is still
        // parked, so the pre-queue check passes — and when the release then
        // fails its own preflight (unreadable settings) the provider stays
        // managed, so this callback still runs against it. The attempt the
        // user sees is failed while the harvest would write the grant and
        // the account row. Revalidate settlement immediately before the
        // first credential write: a settled attempt must never grow a grant
        // copy or a row.
        //
        // I-000122: aborting the write is not enough. The seam committed
        // THIS attempt's grant as the provider's `llm-pi-ai` projection at
        // the settlement broadcast, so returning here would leave the route
        // serving a grant whose login failed/cancelled. Compensate that
        // projection through the same ownership-checked path the failure
        // handler uses: only this attempt's captured payload is deleted and
        // a foreign or newer live grant is never touched. The release
        // already published the terminal it owns.
        if (attempt.settledAt !== undefined) {
          await this.compensateFailedHarvest(attempt, harvest)
          return
        }
        await records.modifyRecord(grantRef, () => Promise.resolve({ kind: 'grant', payload: structuredClone(payload) }))
        facts.wroteRef = true
        const now = Date.now()
        // The id of the row this mutation appends, when it appends one.
        let addedId: string | undefined
        if (existing !== undefined) {
          // Replacing the credential removes the superseded plugin-scope
          // record: a changed refresh token hashes to a new ref, and the
          // old payload (old refresh token included) must not strand as a
          // secret-bearing orphan. Cleanup is best-effort — the fresh grant
          // is already persisted, so a locked store must not fail an
          // otherwise successful login; the warning keeps it observable.
          if (existing.oauth !== null && existing.oauth.grantRef !== grantRef) {
            try {
              // Snapshot before deleting: a rejected state flush restores
              // this record, because the rolled-back row still references
              // it. Refusing the delete when the read fails keeps the
              // superseded record reversible instead of dangling.
              const superseded = await records.readRecord(existing.oauth.grantRef)
              if (superseded !== undefined) facts.superseded = { ref: existing.oauth.grantRef, record: superseded }
              await records.deleteRecord(existing.oauth.grantRef)
            } catch (error) {
              this.warn(`cleanup of the superseded grant record failed for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          // Snapshot the fields this upsert replaces, so a flush rejection
          // can restore the row exactly as it was before the harvest.
          facts.rowUndo = {
            kind: 'updated',
            id: existing.id,
            snapshot: {
              oauth: existing.oauth === null ? null : structuredClone(existing.oauth),
              valueMissing: existing.valueMissing,
              cooldownUntil: existing.cooldownUntil,
            },
          }
          existing.oauth = {
            ...existing.oauth,
            provider: attempt.provider,
            grantRef,
            ...(payload.email === undefined ? {} : { email: payload.email }),
            ...(payload.accountId === undefined ? {} : { accountId: payload.accountId }),
            ...(typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? { expiresAt: payload.expires } : {}),
          }
          // A successful re-authentication recovers the account (round-3
          // finding 5): the missing flag a demotion set must go, or the now
          // live projection keeps rendering as missing and stays out of the
          // healthy counts. Same reset activateAccount applies.
          existing.valueMissing = false
          // Round-5 finding C3: a demoted-and-cooling row kept its stale
          // cooldown timer, so the freshly projected grant still rendered as
          // cooling and stayed out of the healthy counts until that timer
          // expired. The window ends with the new grant.
          // Round-5 finding M2: clearing the window also resets escalation.
          // `applyFailureCooldown` derives the next level only from the
          // previous `cooldownUntil` (core.ts:168-174), so a zeroed window
          // starts the next failure at level 0 / the base cooldown; the
          // recovery grace window does not apply to a zeroed cooldown. The
          // leftover `failureLevel`/`consecutiveFailures` fields do not
          // escalate anything.
          // Round-5 finding SF3: only a cooldown the OLD grant earned may be
          // cleared. R6-SF1: attribution is the projection generation stamped
          // on the window at failure time, not a timestamp taken here — a
          // failure of the freshly projected grant landing while this harvest
          // waited (queue, projection read) keeps its window, and an older
          // window clears even when its stamp shares this millisecond.
          const earnedGeneration = this.cooldownGenerations.get(existing.id)
          if (earnedGeneration === undefined || earnedGeneration < projectionGeneration) {
            existing.cooldownUntil = 0
            this.cooldownGenerations.delete(existing.id)
          }
        } else {
          const rowId = newKeyId()
          addedId = rowId
          // Record the appended row before the push resolves, so the
          // failure handler can remove exactly this row.
          facts.rowUndo = { kind: 'added', id: rowId }
          providerRecord.keys.push({
            id: rowId,
            alias: attempt.alias ?? payload.email ?? providerRecord.displayName,
            // Deliberately not a credential-ref-grammar name: account rows
            // carry no broker-resolvable literal, and an unparseable ref keeps
            // the api-key probe paths (probeKey/findVerifiedAlternate) from
            // misreading the grant as a missing API key.
            ref: grantRef,
            kind: 'oauth',
            enabled: true,
            createdAt: now,
            lastUsedAt: 0,
            cooldownUntil: 0,
            lastFailureAt: 0,
            lastFailureCode: '',
            failureLevel: 0,
            consecutiveFailures: 0,
            totalUses: 0,
            totalFailures: 0,
            valueMissing: false,
            importedFrom: null,
            oauth: {
              provider: attempt.provider,
              grantRef,
              ...(payload.email === undefined ? {} : { email: payload.email }),
              ...(payload.accountId === undefined ? {} : { accountId: payload.accountId }),
              ...(typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? { expiresAt: payload.expires } : {}),
            },
          })
        }
        this.store.touch()
        attempt.accountId = existing !== undefined ? existing.id : addedId
        // Remember who owned the projection before this harvest claims it:
        // a flush rejection restores that entry instead of leaving the
        // rolled-back row as the live owner.
        facts.ownerUndo = this.activeAccounts.has(attempt.provider)
          ? { had: true, owner: this.activeAccounts.get(attempt.provider) }
          : { had: false }
        // The grant pi-ai just committed IS the projection; the fresh row
        // owns it until activation or fallback says otherwise.
        if (attempt.accountId !== undefined) this.claimProjectionOwner(attempt.provider, attempt.accountId)
        // The committed grant now serves this route, so any broker reference
        // carried over from the key pool must go.
        await this.syncBrokerBinding(attempt.provider)
        // No terminal here: `run` flushes the state document after this
        // callback resolves, and the ready terminal publishes below — only
        // once persistence has actually resolved (round-2 review, step 3).
      })
      this.finishLoginAttempt(attempt, 'ready')
    } catch (error) {
      // A rejected state flush lands here AFTER the mutation resolved, so
      // `attempt.accountId` is already set even though `run` never made the
      // document durable. Undo the in-memory upsert synchronously — before
      // any queued mutation or retry can serialize a row whose grant the
      // credential rollback then deletes — and roll the credential writes
      // back. Only a failure BEFORE the upsert takes the pre-existing
      // compensation path.
      const upserted = attempt.accountId !== undefined
      if (upserted) this.undoHarvestRow(attempt, harvest)
      // Whether THIS failure handler settles the attempt (a release may have
      // finalized it first): only an attempt this handler failed may have its
      // reason enriched with the rollback code below.
      const settledHere = attempt.settledAt === undefined
      this.failLoginAttempt(attempt, error)
      this.warn(`oauth sign-in harvest failed for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
      // Round-2 review step 4: a harvest whose row was never created is
      // compensated by deleting both written records — the plugin-scope
      // grant copy (when its write resolved), and the llm-pi-ai projection
      // only while it still carries THIS login's payload. A harvest that
      // DID create its row is rolled back the same way, plus the credential
      // writes its restored row depends on, because the rejected flush
      // left that upsert undurable.
      if (upserted) {
        const rollback = await this.compensateFailedFlush(attempt, harvest)
        // A rollback that could not write leaves a credential surface the
        // rolled-back row no longer owns. Tag the terminal reason with the
        // stable code (keeping the original flush cause after it) so an
        // upstream caller can branch instead of matching prose.
        if (rollback.failed && settledHere) {
          const cause = attempt.error ?? 'the state flush failed'
          attempt.error = `${FLUSH_ROLLBACK_COMPENSATION_FAILED}: ${cause} (credential rollback incomplete: ${rollback.failures.join('; ')})`
          attempt.updatedAt = Date.now()
          this.warn(`${FLUSH_ROLLBACK_COMPENSATION_FAILED} for ${attempt.provider}: the state flush failed and the credential rollback could not be completed`)
        }
      } else {
        await this.compensateFailedHarvest(attempt, harvest)
      }
      // The rollback restored the rows and the owner map, so the binding must
      // follow whatever serves the route now: this attempt's projection is
      // gone, and the surviving pool must serve again (Codex P2).
      await this.syncBindingAfterProjectionChange(attempt.provider)
    }
  }

  /**
   * Capture this attempt's committed projection payload (F2 provenance).
   *
   * The seam reports `authorized` only after the flow's commit is observed
   * and still present, so a read STARTED at that broadcast observes the
   * record this attempt wrote. The read is deliberately not queued on
   * `run`: a release parked ahead of the harvest must not delay provenance
   * long enough for a foreign writer to become this attempt's authority.
   *
   * The seam offers no writer identity or record version, so this capture is
   * the closest provenance the manager can obtain: `undefined` means the
   * committed payload is unknown, and compensation then refuses to touch the
   * projection instead of guessing. See I-000090 for the seam capability
   * (compare-and-delete / versioned records) that would make it exact.
   */
  private captureSettledProjection(attempt: LoginAttempt): Promise<OAuthGrantPayload | undefined> {
    const records = this.credentialRecords()
    if (records === undefined) return Promise.resolve(undefined)
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${attempt.provider}`
    return records.readRecord(projectionKey).then(
      record => record !== undefined && record.kind === 'grant' && isOAuthGrantPayload(record.payload)
        ? structuredClone(record.payload)
        : undefined,
      error => {
        this.warn(`could not capture the committed grant for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      },
    )
  }

  /**
   * Undo the in-memory half of a harvest whose state document was never made
   * durable (a rejected `store.flush()` after the mutation resolved).
   *
   * Runs synchronously from the failure handler so no queued mutation,
   * debounced write, or retry can observe — or persist — the rolled-back row
   * between the rejected flush and this undo. The credential rollback that
   * follows ({@link compensateFailedFlush}) deletes the grant the row
   * referenced, so leaving the upsert in memory would make the next
   * successful flush point at a deleted record.
   */
  private undoHarvestRow(attempt: LoginAttempt, harvest: HarvestFacts | undefined): void {
    attempt.accountId = undefined
    const providerRecord = this.store.provider(attempt.provider)
    if (providerRecord !== undefined && harvest?.rowUndo !== undefined) {
      const undo = harvest.rowUndo
      if (undo.kind === 'added') {
        const index = providerRecord.keys.findIndex(candidate => candidate.id === undo.id)
        // Remove exactly the appended row: identity, never position.
        if (index >= 0) providerRecord.keys.splice(index, 1)
      } else {
        const row = providerRecord.keys.find(candidate => candidate.id === undo.id)
        if (row !== undefined) {
          row.oauth = undo.snapshot.oauth
          row.valueMissing = undo.snapshot.valueMissing
          row.cooldownUntil = undo.snapshot.cooldownUntil
        }
      }
    }
    if (harvest?.ownerUndo !== undefined) {
      if (harvest.ownerUndo.had && harvest.ownerUndo.owner !== undefined) {
        this.activeAccounts.set(attempt.provider, harvest.ownerUndo.owner)
      } else {
        this.activeAccounts.delete(attempt.provider)
      }
      // Same generation guard the claim bumped: a hydration read started
      // before/during the harvest must not re-apply the claim just undone.
      this.ownershipGenerations.set(attempt.provider, (this.ownershipGenerations.get(attempt.provider) ?? 0) + 1)
    }
    this.store.touch()
  }

  /**
   * Undo the credential writes of a harvest whose state flush rejected.
   *
   * Differs from {@link compensateFailedHarvest} in one respect: the row
   * upsert already happened, so the plugin-scope record cannot simply be
   * deleted. A same-ref re-authentication overwrote the record the restored
   * row references, and a changed-ref re-authentication deleted the
   * superseded generation before the flush failed — both are reverted here,
   * each write guarded by the exact payload this login committed so a
   * foreign writer's record is never clobbered. The `llm-pi-ai` projection is
   * then demoted exactly like any failed harvest (ownership-checked, never a
   * foreign grant), so no committed credential outlives the rolled-back row
   * without a pool owner.
   *
   * Resolves with the write failures the rollback hit, if any: a refusal to
   * touch the surface when provenance is unknown is a deliberate skip, not a
   * failure, but a rejected compensating write means the credential surface
   * may still hold records the rolled-back row no longer owns. The caller
   * tags the attempt with {@link FLUSH_ROLLBACK_COMPENSATION_FAILED} so that
   * state is distinguishable from a clean rollback (each failure is also
   * warned about here, message by message).
   */
  private async compensateFailedFlush(
    attempt: LoginAttempt,
    harvest: HarvestFacts | undefined,
  ): Promise<{ failed: boolean; failures: string[] }> {
    const failures: string[] = []
    const recordFailure = (prefix: string, error: unknown): void => {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${prefix}: ${detail}`)
      this.warn(`${prefix}: ${detail}`)
    }
    const records = this.credentialRecords()
    if (records === undefined) return { failed: false, failures }
    if (harvest === undefined) {
      this.warn(`flush-failure compensation refused for ${attempt.provider}: this attempt's committed grant payload is unknown, so the credential surface was left untouched`)
      return { failed: false, failures }
    }
    const provenance = JSON.stringify(harvest.payload)
    const stillThisPayload = (record: CredentialRecordLike | undefined): boolean =>
      record !== undefined && record.kind === 'grant'
      && isOAuthGrantPayload(record.payload) && JSON.stringify(record.payload) === provenance
    try {
      if (harvest.previousRef !== undefined) {
        const previous = harvest.previousRef
        // Restore the overwritten same-ref record only while the live record
        // still holds this harvest's payload; the replacement runs inside
        // the seam's per-key lock.
        await records.modifyRecord(harvest.grantRef, async current =>
          stillThisPayload(current) ? structuredClone(previous) : undefined)
      } else if (harvest.wroteRef) {
        let owns = false
        await records.modifyRecord(harvest.grantRef, async current => {
          owns = stillThisPayload(current)
          return undefined
        })
        if (owns) await records.deleteRecord(harvest.grantRef)
      }
    } catch (error) {
      recordFailure(`flush-failure compensation could not restore ${harvest.grantRef} for ${attempt.provider}`, error)
    }
    if (harvest.superseded !== undefined) {
      const superseded = harvest.superseded
      try {
        // Write the superseded generation back only while its ref is still
        // free: a native writer that reused the ref owns the record now.
        await records.modifyRecord(superseded.ref, async current =>
          current === undefined ? structuredClone(superseded.record) : undefined)
      } catch (error) {
        recordFailure(`flush-failure compensation could not restore ${superseded.ref} for ${attempt.provider}`, error)
      }
    }
    const projection = await this.revertHarvestProjection(attempt, harvest)
    if (!projection.ok) failures.push(projection.failure)
    return { failed: failures.length > 0, failures }
  }

  /**
   * Roll a failed harvest back to a clean credential surface: the
   * plugin-scope grant copy is deleted when it was written; the
   * `llm-pi-ai` projection is deleted only while it still carries EXACTLY
   * this login's settlement-time committed payload, so compensation can
   * never delete a grant another account owns.
   *
   * Provenance unknown (the settlement-time capture found no usable record)
   * refuses both deletions with a warning: without the committed payload
   * there is no proof of ownership, and deleting "whatever is live" is the
   * round-4 defect (I-000083).
   */
  private async compensateFailedHarvest(attempt: LoginAttempt, harvest: HarvestFacts | undefined): Promise<void> {
    const records = this.credentialRecords()
    if (records === undefined) return
    if (harvest === undefined) {
      this.warn(`harvest compensation refused for ${attempt.provider}: this attempt's committed grant payload is unknown, so the projection was left untouched`)
      return
    }
    if (harvest.wroteRef) {
      try {
        await records.deleteRecord(harvest.grantRef)
      } catch (error) {
        this.warn(`harvest compensation could not delete ${harvest.grantRef}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.revertHarvestProjection(attempt, harvest)
  }

  /**
   * Delete the `llm-pi-ai` projection only while it still carries exactly
   * this login's settlement-time committed payload. Shared by the
   * failed-harvest compensation and the flush-failure rollback.
   *
   * Resolves `ok: false` only when the compare/delete writes themselves
   * rejected; an ownership mismatch is the guard doing its job (the live
   * record belongs to someone else) and counts as a clean skip.
   *
   * Every manager-initiated projection deletion registers the one-shot
   * {@link intentionalProjectionRemovals} marker before the delete, exactly
   * as {@link decideAndDeleteProjection} does (I-000125). Unmarked, the
   * removal's own `credentials/record-updated` echo reconciles as an
   * external deletion: the route's previously active managed account is
   * flagged `valueMissing`, its owner claim is dropped and a misleading
   * "removed outside Keys Manager" warning is pushed — even though that
   * row and its plugin-scope grant are untouched.
   *
   * The marker only silences that echo; the route's state is corrected
   * explicitly. The removal leaves the route with no stored projection, so the
   * provider's owner claim — whatever it named before this attempt's grant
   * replaced the record — is untruthful: {@link oauthOwnerFor} keeps naming a
   * row pi-ai no longer resolves, `wrapStream` skips key-pool selection, oauth
   * failures are attributed to that row, and the client keeps "Set active"
   * disabled — the account cannot be re-activated. The claim is therefore
   * invalidated (I-000125), and ONLY the claim: the surviving row keeps its
   * `grantRef` and its `valueMissing: false`, so it stays managed and
   * re-activatable while the route falls back to its API-key pool.
   *
   * The marker is armed only while the provider is still managed: a released
   * provider has no echo consumer, and a marker nothing consumes would stay
   * armed for its whole TTL and mask a genuine out-of-band removal.
   */
  private async revertHarvestProjection(
    attempt: LoginAttempt,
    harvest: HarvestFacts,
  ): Promise<{ ok: true } | { ok: false; failure: string }> {
    const records = this.credentialRecords()
    if (records === undefined) return { ok: true }
    try {
      const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${attempt.provider}`
      // Same atomic decide-and-delete as the demotion path (round-3
      // finding 1): the compare runs inside `modifyRecord`'s per-key lock
      // against the FULL settlement-time payload (not merely its refresh
      // token), so a native writer that replaced the projection — even by a
      // payload that reused our refresh token — is never matched, and the
      // delete runs only on a locked-in exact match (no delete-inside-modify
      // primitive exists on the seam; see decideAndDeleteProjection and
      // I-000090).
      const provenance = JSON.stringify(harvest.payload)
      let owns = false
      let decidedAgainst: string | undefined
      await records.modifyRecord(projectionKey, async current => {
        owns = current !== undefined && current.kind === 'grant'
          && isOAuthGrantPayload(current.payload) && JSON.stringify(current.payload) === provenance
        // F2 pre-delete re-read snapshot, identical to the demotion path.
        if (owns && current !== undefined) decidedAgainst = provenance
        return undefined
      })
      if (owns && await this.projectionStillMatches(records, projectionKey, decidedAgainst)) {
        // The claim this removal makes untruthful, captured before the awaited
        // delete. A newer activation or login claiming the route while the
        // delete is in flight wins: its generation moves, and its claim names
        // whatever that writer actually put in place.
        const ownerBeforeRemoval = this.activeAccounts.get(attempt.provider)
        const generation = this.ownershipGenerations.get(attempt.provider) ?? 0
        // Mark BEFORE the delete, same one-shot bookkeeping the demotion
        // path uses: the deletion's echo handler reads this marker across
        // its own awaited record re-read, so the removal stays silent for
        // this manager's own demotion instead of demoting the active
        // account.
        const markedAt = Date.now()
        // Only arm the marker where an echo can reach its consumer: the
        // dispatcher drops record-updates for an unmanaged provider, and a
        // marker nothing consumes would mask a genuine out-of-band removal for
        // its whole TTL.
        const providerManaged = this.store.provider(attempt.provider) !== undefined
        if (providerManaged) this.intentionalProjectionRemovals.set(attempt.provider, markedAt)
        try {
          await records.deleteRecord(projectionKey)
        } catch (error) {
          // A delete that threw removed nothing, so no own-removal echo is
          // coming. Revoke this call's marker before the failure leaves this
          // method — left in place it would consume a genuine out-of-band
          // removal as the manager's own for the whole TTL, hiding the
          // warning, the missing mark, and the stale owner cleanup. The
          // identity check keeps a newer marker untouched.
          if (providerManaged && this.intentionalProjectionRemovals.get(attempt.provider) === markedAt) {
            this.intentionalProjectionRemovals.delete(attempt.provider)
          }
          throw error
        }
        // The removal succeeded: the projection the rows were claimed against
        // is gone, so the provider's owner claim must go with it. The row is
        // deliberately left untouched — same `grantRef`, still `valueMissing:
        // false` — because it is still managed and its grant is still live;
        // re-activating it re-projects the route.
        if (ownerBeforeRemoval !== undefined
          && (this.ownershipGenerations.get(attempt.provider) ?? 0) === generation) {
          this.activeAccounts.delete(attempt.provider)
          this.store.touch()
        }
        // The projection the pool was hidden behind is gone, so the route
        // falls back to whatever still serves it: rebind its pool here rather
        // than leaving the profile unbound for pi-ai to bypass the broker
        // (PR review round 2 must-fix).
        await this.syncBindingAfterProjectionChange(attempt.provider)
      } else if (!owns) {
        this.warn(`harvest compensation kept the projection for ${attempt.provider}: the live grant no longer matches this attempt's committed payload`)
      }
      return { ok: true }
    } catch (error) {
      const failure = `harvest compensation could not revert the projection for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`
      this.warn(failure)
      return { ok: false, failure }
    }
  }

  /** Expire wedged sign-ins and drop long-settled attempt records. */
  private pruneLoginAttempts(now: number): void {
    for (const [id, attempt] of this.loginAttempts) {
      if (attempt.settledAt === undefined) {
        if (now - attempt.updatedAt <= LOGIN_ATTEMPT_TTL_MS) continue
        attempt.controller.abort()
        this.failLoginAttempt(attempt, new Error('The sign-in attempt timed out'))
        continue
      }
      if (now - attempt.settledAt > ATTEMPT_TTL_MS) this.loginAttempts.delete(id)
    }
  }

  /** Keep the attempt cache bounded: evict the oldest settled entries first. */
  private capLoginAttempts(): void {
    while (this.loginAttempts.size > MAX_LOGIN_ATTEMPTS) {
      let oldestId: string | undefined
      let oldestSettledAt = Number.POSITIVE_INFINITY
      for (const [id, attempt] of this.loginAttempts) {
        // In-flight attempts are never eviction candidates.
        if (attempt.settledAt === undefined) continue
        if (attempt.settledAt < oldestSettledAt) {
          oldestSettledAt = attempt.settledAt
          oldestId = id
        }
      }
      if (oldestId === undefined) break
      this.loginAttempts.delete(oldestId)
    }
  }

  /**
   * Subscribe to the credential seam's post-commit record broadcast
   * (credentials/src/index.ts:271-277; the event carries the key only, so
   * the handler re-reads the record for its payload).
   */
  private watchGrantRecordUpdated(): (() => void) | undefined {
    const on = (this.ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => unknown) => () => void }).on
    if (typeof on !== 'function') {
      this.warnSubscriptionLost('credentials/record-updated')
      return undefined
    }
    try {
      return on.call(this.ctx, 'credentials/record-updated', (key: unknown) => {
        if (typeof key === 'string') this.onGrantRecordUpdated(key)
      })
    } catch (error) {
      this.warnSubscriptionLost('credentials/record-updated', error)
      return undefined
    }
  }

  /**
   * Reconcile one `llm-pi-ai/<provider>` record change with the pool.
   *
   * The manager writes this record only through {@link activateAccount}
   * (D1); pi-ai rewrites it on every lazy refresh and owns every login. A
   * change whose payload belongs to the active account is a rotation and
   * syncs back into the owning row; anything else the manager did not write
   * is native management of the route and surfaces as a warning instead of
   * being adopted silently.
   *
   * C6-1: reconciliation writes a plugin-scope record for the rotated
   * generation and then mutates the owning row. removeAccount /
   * releaseProvider mutate the same row but cannot be serialized against
   * that write — the credential seam offers only a per-record lock
   * (`modifyRecord`), never a transaction across the record write and the
   * pool row. So {@link reconcileGrantRecord} revalidates the row immediately
   * before AND after the awaited write and compensates by deleting the record
   * it just wrote. An orphan record must never outlive a removed account.
   *
   * Round-9 finding P1: two echoes for the same provider can
   * arrive before the first reconciliation commits. Their write-backs then
   * race and an out-of-order completion could move the row back onto an
   * older generation, stranding the newer record outside manager state. The
   * bodies are therefore chained per provider: one observation's
   * read → write → commit window is never interleaved with another's, and
   * {@link reconcileGrantRecord} additionally re-checks that its generation
   * is still current before committing.
   */
  private onGrantRecordUpdated(key: string): void {
    // A transport route's record is another package's credential: a write or
    // removal there (its adapter re-authenticating, or a sign-in on another
    // surface) only re-reads the account list. It must never reach the pi-ai
    // reconciliation path below, which would look for a pool row that does not
    // exist and warn about native management of a route this manager does not
    // own.
    if (key.startsWith(`${TRANSPORT_CREDENTIAL_SCOPE}/`)) {
      void this.refreshTransportAccounts()
      return
    }
    if (!key.startsWith(`${OAUTH_GRANT_RECORD_SCOPE}/`)) return
    const provider = key.slice(OAUTH_GRANT_RECORD_SCOPE.length + 1)
    if (this.store.provider(provider) === undefined) return
    // Fire-and-forget: the seam event is synchronous and carries no
    // completion channel, so failures are logged like any async work. The
    // body is appended to the provider's chain, preserving arrival order
    // (round-9 P1); the chain itself never rejects, so a failed
    // reconciliation does not stop the next echo.
    const next = this.scheduleGrantReconciliation(provider, () => this.reconcileGrantRecord(provider, key))
    void next.catch(error => {
      this.warn(`grant reconciliation failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Append one body to the provider's per-route grant chain and return it.
   *
   * The chain is the single serialization point for every operation that can
   * repoint `row.oauth.grantRef` or reproject the route: the echo reconciler
   * (round-9 P1 ordering) and, since round-8 finding I-000106, activation.
   * The stored tail never rejects, so one failed body cannot stop the chain;
   * callers that must observe the failure await the returned promise (the
   * fire-and-forget echo caller attaches its own catch).
   */
  private scheduleGrantReconciliation<T>(provider: string, body: () => Promise<T>): Promise<T> {
    const previous = this.grantReconciliations.get(provider) ?? Promise.resolve()
    const next = previous.then(body, body)
    const tail = next.then(() => undefined, () => undefined)
    this.grantReconciliations.set(provider, tail)
    void tail.then(() => {
      if (this.grantReconciliations.get(provider) === tail) this.grantReconciliations.delete(provider)
    })
    return next
  }

  /**
   * The body of {@link onGrantRecordUpdated}. Pool state is read live, and
   * every awaited step around the write is guarded by revalidation: a
   * removal is allowed to complete while the write is in flight.
   */
  private async reconcileGrantRecord(provider: string, key: string): Promise<void> {
    // PR review round 30: the shutdown drain abandons a chain that has not
    // settled, and this body resumes after `close()`. Its whole result is a
    // credential write-back plus a binding sync, so persistence is refused
    // once shutdown started.
    if (this.closing) return
    // PR review round 32: a remount replaces the credential backend while this
    // body awaits its read, and the answer then describes records the new store
    // does not hold. The epoch gates every decision below — owner, foreign
    // marker, readiness and the binding sync — exactly like the hydration pass.
    const epoch = this.hydrationEpoch
    const records = this.credentialRecords()
    if (records === undefined) return
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return
    const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
    const activeId = this.activeAccounts.get(provider)
    const active = activeId === undefined
      ? undefined
      : accounts.find(candidate => candidate.id === activeId)
    // F1 (I-000081): the owner claim below must not overwrite a claim an
    // activation or login lands while this awaited re-read is in flight —
    // the same generation guard load-time hydration applies.
    const generation = this.ownershipGenerations.get(provider) ?? 0
    const record = await records.readRecord(key)
    if (this.hydrationEpoch !== epoch) return
    // PR review round 35: shutdown abandons this chain, so the body resumes
    // here after `close()`. The read may finish; the writes below may not.
    if (this.persistenceRefused()) return
    // PR review round 13: this read is authoritative for the provider's
    // projection, so it answers what a failed startup hydration could not —
    // ownership stops being unknown and the binding repair it skipped runs.
    this.noteProjectionReadSucceeded(provider)
    if (record === undefined) {
      // PR review round 31: a harvest outside this chain can commit and claim
      // a newer projection while this read is in flight, so the absence above
      // can already be superseded. The newer claim owns the route and settled
      // the binding itself: this stale removal decides nothing — no owner
      // delete, no rebind — it only consumes its own one-shot removal marker.
      if ((this.ownershipGenerations.get(provider) ?? 0) !== generation) {
        this.intentionalProjectionRemovals.delete(provider)
        return
      }
      // The projection is gone, so nothing foreign serves this route any more
      // (PR review round 3).
      this.foreignProjections.delete(provider)
      // This manager's own demotion marked the removal just before
      // deleting; while the marker is inside its TTL window the echo is
      // ours — consume the one-shot marker and stay silent. An expired
      // marker no longer masks anything (and is dropped for hygiene).
      const markedAt = this.intentionalProjectionRemovals.get(provider)
      if (markedAt !== undefined && Date.now() - markedAt <= INTENTIONAL_REMOVAL_TTL_MS) {
        this.intentionalProjectionRemovals.delete(provider)
        // The manager's own removal left no projection: converge the binding
        // with the state the removal created, so the surviving pool serves
        // through the broker instead of pi-ai's bare credential (PR review
        // round 2).
        await this.syncBindingAfterProjectionChange(provider)
        return
      }
      if (markedAt !== undefined) this.intentionalProjectionRemovals.delete(provider)
      if (active !== undefined) {
        // Not our deletion: someone removed the projection, so the route
        // silently serves the key pool while the account row looks
        // healthy. Mark, warn, and drop the stale owner entry (round-2
        // review, step 1): nothing owns the projection anymore.
        active.valueMissing = true
        this.activeAccounts.delete(provider)
        this.store.touch()
        this.pushWarning(`The ${provider} OAuth grant was removed outside Keys Manager; the route now resolves through its API-key pool.`)
      }
      // The row is demoted (or was never the owner) and nothing projects the
      // route, so the binding must name the key pool now — an unbound profile
      // here read as a mismatch. This runs for EVERY confirmed deletion, not
      // only an owned one (PR review round 3): a native writer can replace the
      // managed projection first and delete it later, leaving the pool to
      // serve an unbound profile.
      await this.syncBindingAfterProjectionChange(provider)
      return
    }
    // I-000125 marker hygiene: the removal branch above is the marker's ONLY
    // consumer, so nothing may return before it. A provider that holds no
    // OAuth row cannot be demoted (nothing to mark and nobody to warn), but
    // its own removal echo still lands here — returning first would leave the
    // marker armed for its whole TTL and mask a genuine out-of-band removal of
    // the projection that serves a row added inside that window.
    // PR review round 19 (I-000182): the classification below runs for a
    // key-only provider too. An early return on `accounts.length === 0` left
    // the foreign marker unset while the native api-key / unrecognized record
    // still served the route ahead of the broker, so the queued binding repair
    // treated the pool as the serving source and bound/kept the broker
    // reference over it. With no OAuth row the unowned-grant branch below
    // classifies a valid grant the same way.
    if (record.kind === 'api-key') {
      // Native api-key management took the route over: the manager no
      // longer owns any projection here.
      this.activeAccounts.delete(provider)
      // A live record Keys Manager does not own still serves ahead of the
      // broker reference, so the pool is not the route's source (round 3).
      this.foreignProjections.add(provider)
      // A pending hydration read of the previous owner is now stale: the
      // route serves a record this pool does not own (round 40).
      this.noteProjectionCommitted(provider)
      this.pushWarning(`The ${provider} route now holds a natively managed API-key credential; the Keys Manager account pool is not serving it.`)
      // pi-ai resolves the broker reference before this record, so a route
      // left bound would keep serving the pool (PR review round 4).
      await this.syncBindingAfterProjectionChange(provider)
      return
    }
    if (!isOAuthGrantPayload(record.payload)) {
      // An unrecognized payload is not ours to interpret: drop the stale
      // owner entry so failure attribution and demotion never fire on it.
      this.activeAccounts.delete(provider)
      this.foreignProjections.add(provider)
      this.noteProjectionCommitted(provider)
      this.pushWarning(`The ${provider} OAuth record holds an unrecognized payload; Keys Manager left it untouched.`)
      await this.syncBindingAfterProjectionChange(provider)
      return
    }
    const payload = record.payload
    const hash = createHash('sha256').update(payload.refresh).digest('hex').slice(0, 12)
    const rotatedRef = accountRef(provider, hash)
    // Owner resolution runs through the shared matcher (refresh digest
    // first, then identity metadata) — the same rule load-time hydration
    // applies, so a restarted process and the live reconciler agree.
    const owner = matchOwningAccount(provider, accounts, payload)
    if (owner === undefined) {
      // A foreign account's grant serves the route: no pool row owns the
      // projection, so the previous owner entry must not survive it — and the
      // live record keeps the pool from claiming the route (round 3).
      this.activeAccounts.delete(provider)
      this.foreignProjections.add(provider)
      this.noteProjectionCommitted(provider)
      this.pushWarning(`An OAuth account for ${provider} is managed natively outside Keys Manager and is not part of the account pool.`)
      await this.syncBindingAfterProjectionChange(provider)
      return
    }
    // C6-1 pre-write revalidation: removeAccount / releaseProvider run on
    // the mutation queue and delete the row (and its grant record) while
    // this reconciliation is still resolving its owner. Writing the rotated
    // generation for an account removed in that window would recreate a
    // secret-bearing record nothing owns, so the write is skipped entirely.
    // R7-SF3: this proof is adoption-oriented, so a merely demoted row
    // (`valueMissing`) still qualifies — a projection that reappears for it
    // is re-adopted below. Only a removal in progress is refused.
    if (!this.accountRowIsManaged(provider, owner)) return
    // F1 (I-000081): the matched grant IS the live projection, so this row
    // owns it from now on — even when no in-process login or activation
    // ran (the post-restart echo-rotation case: a hydrated row, no owner
    // entry). Claiming here is what makes request attribution
    // (oauthOwnerFor), cooling, and demotion act on the serving account.
    // The guard above keeps unrecognized and foreign payloads on the
    // warn-and-clear path; ownership is never adopted for them. A newer
    // activation/login that claimed while the read was in flight wins:
    // the stale echo claim is discarded exactly like a stale hydration
    // read (the rotation sync below still runs, but a commit that a newer
    // claim has superseded is rejected — round-9 P1).
    let claimedGeneration: number | undefined
    if ((this.ownershipGenerations.get(provider) ?? 0) === generation) {
      this.claimProjectionOwner(provider, owner.id)
      claimedGeneration = this.ownershipGenerations.get(provider)
      // R7-SF3: the live projection proves this row's identity again, so a
      // demoted row is re-adopted — restore its owner claim (above) and end
      // the demoted state. `valueMissing` means "not serving but still
      // managed", not "removal in progress": a native sign-in or pi-ai
      // write that re-projects the grant recovers the account without a
      // manual re-activation. The flag is persisted with the rest of the
      // state document.
      if (owner.valueMissing === true) {
        owner.valueMissing = false
        // R14-SF3: a demotion is earned by a failure, so the row usually
        // still carries the cooldown `markFailure` wrote. Re-adoption is the
        // same manual-recovery equivalence `activateAccount` and re-auth
        // implement: the live projection is serving again, so the old
        // window ends with it — otherwise the resurrected row renders
        // "cooling" and stays out of the healthy counts until the timer
        // expires. Only this proven-adoption branch clears; a row whose
        // projection did not reappear keeps its window.
        owner.cooldownUntil = 0
        this.store.touch()
      }
    }
    // Rotation sync: the rotated payload is authoritative (the plan's
    // single-writer contract — "sync them back to the owning plugin-scope
    // record on record-updated"), so write it back to the row's grant
    // record instead of trusting that refresh tokens never rotate. The
    // plugin-scope record is written FIRST; the row's grantRef commits
    // only after that write resolves, so a failed write leaves the row
    // pointing at the old, still-present record and Remove keeps working
    // against the live grant (round-2 review, step 5). This write cannot
    // re-enter this handler: it is keys-manager/-scope, and the handler
    // above only reconciles llm-pi-ai/-scope keys.
    const previousRef = owner.oauth!.grantRef
    await records.modifyRecord(rotatedRef, () =>
      Promise.resolve({ kind: 'grant', payload: structuredClone(payload) }))
    // PR review round 32: the write above landed in the store this body started
    // on; a remount since then makes every following decision (the owner
    // cleanup, the generation commit) describe the replaced backend.
    if (this.hydrationEpoch !== epoch) return
    // PR review round 35: the write above is the last one this body may start
    // once shutdown began; the compensation and commit below are refused here.
    if (this.persistenceRefused()) return
    // C6-1 post-write revalidation: a removal that landed while the write
    // was in flight already deleted its own record, so the generation just
    // written must be compensated or it outlives the account. The removed
    // row object is detached, so the mutation below would be invisible
    // anyway; it is skipped, and a stale owner claim is withdrawn.
    if (!this.accountRowStillCurrent(provider, owner)) {
      if (this.activeAccounts.get(provider) === owner.id) this.activeAccounts.delete(provider)
      try {
        await records.deleteRecord(rotatedRef)
      } catch (error) {
        this.warn(`cancelled rotation record cleanup failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    // Round-9 P1 commit guard: the awaited write gave a newer echo, an
    // activation, or a login time to supersede the generation this body
    // observed. Committing then would point the row back at an older
    // generation and leave the newer generation's record outside manager
    // state, so the superseded write-back is removed instead. Only a
    // distinct record is deleted: in the same-ref case the write landed on
    // the row's own current record and must stay.
    const stillCurrent = await this.rotationStillCurrent(records, provider, key, rotatedRef, claimedGeneration)
    // PR review round 32: the staleness probe is an await; the store may have
    // been replaced under it.
    if (this.hydrationEpoch !== epoch) return
    // PR review round 35: the probe is another await; a shutdown that started
    // under it refuses the discard/compensation below.
    if (this.persistenceRefused()) return
    if (!stillCurrent) {
      if (rotatedRef !== previousRef) {
        // R5-MF1: the staleness probe is awaited, and a settled harvest can
        // adopt this very generation into a live row while it is in flight
        // (same account, same committed refresh token). Removing the record
        // then would delete the row's own grant — keep anything a live row
        // still serves.
        await this.discardRotationRecord(records, provider, rotatedRef, 'cleanup of the superseded rotation record failed for')
      }
      return
    }
    // R5-SF1: the staleness probe above is itself awaited, so the post-write
    // revalidation is already stale by the time the commit runs. A removal
    // that completes inside that probe is only visible through the
    // removal-aware check, so it runs again immediately before the commit:
    // committing would write grantRef onto a detached row and leave the record
    // just written orphaned. Compensation mirrors the post-write branch.
    if (!this.accountRowStillCurrent(provider, owner)) {
      if (this.activeAccounts.get(provider) === owner.id) this.activeAccounts.delete(provider)
      if (rotatedRef !== previousRef) {
        await this.discardRotationRecord(records, provider, rotatedRef, 'cancelled rotation record cleanup failed for')
      }
      return
    }
    // SF2: once the new payload persists, the commit repoints the row at it
    // and deletes the superseded generation's plugin-scope record (harvest
    // parity). A rotated refresh token must not strand its secret-bearing
    // record outside manager state; cleanup is best-effort with a warning,
    // exactly like the harvest-time cleanup. QC N1: the ref scheme, identity
    // merge and cleanup are the one write-back owned by
    // {@link commitGrantGeneration}, shared with the connection test.
    // PR review round 35: the commit is this body's persisted state write; a
    // shutdown that began under any of the awaits above refuses it.
    if (this.persistenceRefused()) return
    await this.commitGrantGeneration(provider, owner, payload, rotatedRef)
    // PR review round 44: the projection now serves this managed account again,
    // so a profile that still names the broker would make pi-ai resolve the
    // pool first and fail with MISSING_CREDENTIAL. Converge the binding with the
    // serving source, exactly like activation and harvest do — off the grant
    // chain, which this body runs on (a settings write inside it would re-enter).
    void this.syncBindingAfterProjectionChange(provider)
  }

  /**
   * C6-1 revalidation: the row captured before an awaited credential write
   * must still be the provider's live row — same object identity, still an
   * OAuth account. A remove/release landing in between detaches the row
   * object; object identity is what tells "this account is still there"
   * apart from "some same-id row was recreated".
   *
   * C6-1/I1: a removal that is still IN PROGRESS is not visible through
   * identity alone. A multi-row release deletes each row's grant first and
   * the provider record last, and it never splices its rows, so after row X's
   * grant is deleted the provider record and row X both still look live while
   * the release awaits later rows. Syncing a rotation into that window would
   * commit `grantRef = rotatedRef` on a row nothing will serve, and the
   * release's final provider deletion leaves that record orphaned. The
   * removal-aware check is {@link retiringAccounts}, set before the removal's
   * first awaited delete.
   *
   * R7-SF3: `valueMissing` is NOT a removal signal — it only says the row is
   * currently not serving. A demoted row is still managed, and a projection
   * that reappears for it must be re-adopted (the caller proves the
   * projection belongs to this row before claiming it). This guard therefore
   * keeps the credential-write semantics strict: writing to a demoted row is
   * pointless until the adoption path has cleared the flag.
   */
  private accountRowStillCurrent(provider: string, owner: KeyRecord): boolean {
    if (owner.valueMissing === true) return false
    return this.accountRowIsManaged(provider, owner)
  }

  /**
   * R7-SF3 adoption proof: the row is live and still managed, whether or not
   * it is currently serving. "Retiring" (removal in progress) refuses
   * everything; "demoted" (`valueMissing`) refuses nothing here — the caller
   * has already proven that the live projection belongs to this exact row
   * ({@link matchOwningAccount}) and that no newer projection superseded the
   * observation (generation guard).
   */
  private accountRowIsManaged(provider: string, owner: KeyRecord): boolean {
    if (this.retiringAccounts.has(owner)) return false
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return false
    if (owner.kind !== 'oauth' || owner.oauth === null) return false
    return providerRecord.keys.some(candidate => candidate === owner)
  }

  /**
   * Round-5 review (R5-MF1): whether a live account row of `provider` still
   * names `ref` as its grant. The settled harvest can adopt the generation a
   * reconciliation just wrote while that reconciliation is still awaiting its
   * staleness probe — the row's `grantRef` then IS the record the cleanup
   * would delete, so deleting it destroys the account's own live grant.
   * A row already marked for removal does not count: its removal deletes the
   * refs it names, so keeping the record would strand it instead.
   */
  private grantRefServed(provider: string, ref: string): boolean {
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return false
    return providerRecord.keys.some(candidate =>
      candidate.kind === 'oauth'
      && candidate.oauth !== null
      && candidate.oauth.grantRef === ref
      && !this.retiringAccounts.has(candidate))
  }

  /**
   * Delete a rotation record a reconciliation wrote but must not keep, unless
   * a live row already serves it (R5-MF1). Cleanup is best-effort with a
   * warning, exactly like the harvest-time superseded-record cleanup.
   */
  private async discardRotationRecord(
    records: CredentialRecordsLike,
    provider: string,
    ref: string,
    failure: string,
  ): Promise<void> {
    if (this.grantRefServed(provider, ref)) return
    try {
      await records.deleteRecord(ref)
    } catch (error) {
      this.warn(`${failure} ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Round-9 P1 revalidation: the generation a reconciliation observed is
   * still the one the route holds, and the ownership claim this body made (if
   * any) is still the newest. Two independent writes can supersede it while
   * the plugin-scope write-back is in flight: pi-ai refreshing again (the
   * projection's refresh digest — the ref's identity — moves on) and an
   * activation or login claiming the projection (the ownership generation
   * moves). Committing the older ref in either case would move the row
   * backwards and strand the newer record outside manager state.
   *
   * A failed re-read cannot prove staleness, so it must not block the sync:
   * the commit then proceeds exactly as it did before this guard existed.
   */
  private async rotationStillCurrent(
    records: CredentialRecordsLike,
    provider: string,
    key: string,
    rotatedRef: string,
    claimedGeneration: number | undefined,
  ): Promise<boolean> {
    if (claimedGeneration !== undefined
      && (this.ownershipGenerations.get(provider) ?? 0) !== claimedGeneration) return false
    try {
      const current = await records.readRecord(key)
      if (current === undefined || current.kind !== 'grant' || !isOAuthGrantPayload(current.payload)) return false
      const hash = createHash('sha256').update(current.payload.refresh).digest('hex').slice(0, 12)
      return accountRef(provider, hash) === rotatedRef
    } catch (error) {
      this.warn(`rotation staleness check could not re-read ${key}: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  /**
   * Make one account's grant payload the route's stored credential
   * (D1 activation projection).
   *
   * Plan iter-pool-activate-queue, "Spike outcome" — the contract this method
   * implements. The slow half (read the row's grant, validate it, capture what
   * the route serves now) runs outside the mutation queue, so a slow credential
   * store does not delay unrelated mutations. The mutation queue turn owns every
   * write:
   *
   * 1. admission checks in queue order, which produce this method's error
   *    surface (`Provider "…" is not managed`, `Account "…" not found on …`,
   *    `Key "…" is not an OAuth account`, `The credential store does not support
   *    records`) — plus a re-check that the row still names the generation the
   *    read used;
   * 2. the projection write as a compare-and-write under the seam's per-key
   *    lock (credentials/src/index.ts:236-250): it lands only while the live
   *    record still equals the captured baseline, "both absent" included. A
   *    rotation, a removal or any foreign writer that replaced the projection
   *    meanwhile makes the compare fail, so this call refuses with the retryable
   *    `could not be projected` message and leaves the newer projection
   *    untouched — there is nothing to delete, because nothing was written;
   * 3. the owner claim, the row writes and the returned `buildState`.
   *
   * There is deliberately no shutdown check after the write: `close()` awaits
   * this queue before it closes the store, so a turn that started in time always
   * finishes (measured in the spike that produced this contract). A check there
   * is what used to leave an orphan projection behind.
   *
   * The one write the turn cannot make durable by itself is a rejected state
   * flush; see {@link compensateActivationFlush} for that compensation.
   */
  async activateAccount(provider: string, accountId: string): Promise<StateView> {
    const records = this.credentialRecords()
    // Locator only: it keeps the row's grantRef reachable for the read below.
    // The turn re-reads the store and decides; this lookup decides nothing.
    const located = this.store.provider(provider)?.keys.find(candidate => candidate.id === accountId)
    // The refusals `run` applies (1683, 1685-1687) are hoisted ahead of the
    // credential read: a refused call should not pay for it at all. They are
    // not the guarantee — the turn's own admission checks are.
    if (this.closing) throw new Error('Keys Manager is shutting down')
    if (this.store.readOnly) {
      throw new Error('The state file could not be read; refusing to write over it. Restart after fixing file access.')
    }
    // The slow half, outside the queue: read the grant this activation would
    // project and capture what the route serves now as the compare baseline.
    // Nothing here decides — admission order belongs to the turn.
    const prepared = located !== undefined
      && located.kind === 'oauth'
      && located.oauth !== null
      && records !== undefined
      ? await this.prepareActivation(provider, located, records)
      : undefined
    let undo: ActivationUndo | undefined
    try {
      const view = await this.run(async () => {
        const providerRecord = this.store.provider(provider)
        if (providerRecord === undefined) throw new Error(`Provider "${provider}" is not managed`)
        const row = providerRecord.keys.find(candidate => candidate.id === accountId)
        if (row === undefined) throw new Error(`Account "${accountId}" not found on ${provider}`)
        if (row.kind !== 'oauth' || row.oauth === null) throw new Error(`Key "${accountId}" is not an OAuth account`)
        if (records === undefined || prepared === undefined) {
          throw new Error('The credential store does not support records')
        }
        // A remount replaced the credential backend while the read ran; the
        // payload came from records this manager no longer serves.
        //
        // The row must still name the generation this activation read. A
        // rotation echo or a removal + re-add that repointed it meanwhile
        // belongs to a different grant, and projecting the old payload would
        // either overwrite a newer generation or report a success the row does
        // not serve. Refusing keeps the record untouched; the caller retries.
        if (this.credentialRecords() !== records || row.oauth.grantRef !== prepared.grantRef) {
          throw new Error(`The grant payload for "${accountId}" on ${provider} could not be projected; activate the account again`)
        }
        // The projection write is a compare-and-write under the seam's per-key
        // lock: it lands only while the route still serves the baseline read
        // above. A removal or a foreign writer that got there first makes the
        // compare fail, and this activation refuses without touching the
        // record — there is nothing to compensate afterwards.
        const written = await this.compareAndWriteProjection(records, provider, prepared)
        if (written === undefined) {
          throw new Error(`The grant payload for "${accountId}" on ${provider} could not be projected; activate the account again`)
        }
        // No post-write shutdown check: `close()` awaits this queue before it
        // closes the store (`1758-1762`), so a run that starts in time always
        // finishes before the store goes away. Refusing here after the write
        // is what used to manufacture an orphan.
        undo = { valueMissing: row.valueMissing, cooldownUntil: row.cooldownUntil, generation: 0 }
        this.claimProjectionOwner(provider, row.id)
        undo.generation = this.ownershipGenerations.get(provider) ?? 0
        row.valueMissing = false
        // Round-5 finding M1: manual recovery ends the cooling window too, the
        // same reset a successful re-authentication applies. A demoted account
        // is re-activated while its stale cooldown still sits on the row, which
        // would render the freshly projected grant as cooling and keep it out
        // of the healthy counts until the timer expires. Clearing the window
        // also resets escalation: `applyFailureCooldown` derives the next level
        // from `cooldownUntil` only (core.ts:168-174).
        row.cooldownUntil = 0
        this.store.touch()
        // Remote methods hand back the refreshed state view (addKey/deleteKey
        // precedent), so the client updates its snapshot in one round trip.
        return this.buildState()
      })
      // The re-activated grant is the serving credential again, so a broker
      // reference left by the key pool must go (see syncBrokerBinding). A
      // settings refusal does not roll back the committed projection.
      await this.syncBrokerBinding(provider)
      return view
    } catch (error) {
      // A rejected flush lands here AFTER the turn resolved its work: `run`
      // does not roll the mutation back (`1789-1800`), so the row is still
      // cleared in memory and the projection still serves the route. Undo both
      // once, by identity. Failures before the write leave `undo` unset.
      //
      // Residual (I-000090 territory): `undo` is assigned only once the write
      // resolved, so a `modifyRecord` that applies its mutation and THEN
      // rejects refuses with the raw seam error and keeps the projection. What
      // compensation could run is undecidable from this repo — the seam would
      // have to promise it never commits then rejects — so this shape is left
      // as the seam reports it rather than guessed at.
      if (undo !== undefined) await this.compensateActivationFlush(provider, accountId, prepared!, undo, records!)
      throw error
    }
  }

  /**
   * The slow half of an activation, outside the queue: read the row's grant
   * generation, validate it, and capture the projection the route serves now.
   */
  private async prepareActivation(
    provider: string,
    row: KeyRecord,
    records: CredentialRecordsLike,
  ): Promise<ActivationPreparation> {
    const grantRef = row.oauth!.grantRef
    const stored = await records.readRecord(grantRef)
    if (stored === undefined || stored.kind !== 'grant' || !isOAuthGrantPayload(stored.payload)) {
      throw new Error(`The grant payload at ${grantRef} is missing or unusable; sign in to this account again`)
    }
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    const live = await records.readRecord(projectionKey)
    const payload = structuredClone(stored.payload)
    return {
      grantRef,
      payload,
      written: JSON.stringify(payload),
      baseline: live === undefined
        ? { state: 'absent' }
        : { state: 'present', kind: live.kind, payload: JSON.stringify(live.payload), record: structuredClone(live) },
    }
  }

  /** Whether the projection still holds the value this activation read. */
  private matchesActivationBaseline(
    current: CredentialRecordLike | undefined,
    baseline: ActivationBaseline,
  ): boolean {
    if (baseline.state === 'absent') return current === undefined
    return current !== undefined
      && current.kind === baseline.kind
      && JSON.stringify(current.payload) === baseline.payload
  }

  /**
   * Write the projection only while the route still serves the baseline. The
   * seam's `modifyRecord` mutate body runs under the per-key lock, so this is
   * the one atomic primitive the activation has (I-000090: `deleteRecord` has
   * no expected-payload form). Returns the payload written, or `undefined` when
   * the compare failed and nothing was touched.
   */
  private async compareAndWriteProjection(
    records: CredentialRecordsLike,
    provider: string,
    prepared: ActivationPreparation,
  ): Promise<string | undefined> {
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    let landed = false
    await records.modifyRecord(projectionKey, async current => {
      if (!this.matchesActivationBaseline(current, prepared.baseline)) return undefined
      landed = true
      // Only this write supersedes a pending own-removal marker: a projection
      // is about to serve again, so a removal echo still in flight cannot
      // describe the live record. A refused compare must leave the marker
      // armed for the removal it belongs to — clearing it there would let that
      // removal's echo read as an out-of-band deletion (a spurious "removed
      // outside Keys Manager" warning and a `valueMissing` row).
      this.intentionalProjectionRemovals.delete(provider)
      return { kind: 'grant', payload: prepared.payload }
    })
    return landed ? prepared.written : undefined
  }

  /**
   * Undo one activation whose state flush was rejected: the row this turn
   * cleared in memory, the owner claim it took, and the projection it wrote
   * (back to the captured baseline).
   *
   * The baseline decides the mechanism. A present baseline is restored with the
   * same compare-and-write the projection used; only an absent baseline has to
   * remove a record, and only while that record is still this activation's own
   * payload. A foreign writer's record is never deleted.
   */
  private async compensateActivationFlush(
    provider: string,
    accountId: string,
    prepared: ActivationPreparation,
    undo: ActivationUndo,
    records: CredentialRecordsLike,
  ): Promise<void> {
    const row = this.store.provider(provider)?.keys.find(candidate => candidate.id === accountId)
    if (row !== undefined) {
      row.valueMissing = undo.valueMissing
      row.cooldownUntil = undo.cooldownUntil
      this.store.touch()
    }
    if (this.ownershipGenerations.get(provider) === undo.generation
      && this.activeAccounts.get(provider) === accountId) {
      this.activeAccounts.delete(provider)
    }
    if (prepared.baseline.state === 'absent') {
      await this.deleteActivationProjection(records, provider, prepared.written)
    } else {
      await this.restoreActivationProjection(records, provider, prepared)
    }
  }

  /** Put the projection back to the present baseline, if it is still ours. */
  private async restoreActivationProjection(
    records: CredentialRecordsLike,
    provider: string,
    prepared: ActivationPreparation,
  ): Promise<void> {
    const baseline = prepared.baseline
    if (baseline.state !== 'present') return
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    try {
      await records.modifyRecord(projectionKey, async current => {
        if (current === undefined
          || current.kind !== 'grant'
          || JSON.stringify(current.payload) !== prepared.written) return undefined
        return { kind: baseline.kind, payload: baseline.record.payload }
      })
    } catch (error) {
      this.warn(`activation projection restore failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The delete authority's proof for an activation's own projection, as an
   * explicit three-valued answer (QC R2): only `matches` may authorize touching
   * the record. `unknown` is a store failure — a closed seam, an unreadable
   * record — and proves nothing, so it is never permission.
   */
  private async activationProjectionProof(
    records: CredentialRecordsLike,
    provider: string,
    written: string,
  ): Promise<'matches' | 'differs' | 'unknown'> {
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    try {
      return await this.projectionStillMatches(records, projectionKey, written) ? 'matches' : 'differs'
    } catch (error) {
      this.warn(`activation projection proof failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      return 'unknown'
    }
  }

  /**
   * Delete one projection an activation just proved it still owns, through the
   * same guarded shape the demotion path uses (MF2): the intentional-removal
   * marker is armed before the delete, so the deletion's own echo is read as
   * ours instead of as an out-of-band removal.
   */
  private async deleteActivationProjection(
    records: CredentialRecordsLike,
    provider: string,
    written: string,
  ): Promise<void> {
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    // F2: the identity read and the delete cannot be atomic here — the seam has
    // no compare-and-delete, `deleteRecord(key)` takes no expected payload
    // (host-types.ts:142, tracked as I-000090). This read immediately before the
    // delete narrows the window to the seam call itself; a writer that replaces
    // the record inside it still loses its grant, and that residual needs the
    // seam CAS, not another read here. Anything but a proven match is left
    // alone.
    if (await this.activationProjectionProof(records, provider, written) !== 'matches') return
    const markedAt = Date.now()
    this.intentionalProjectionRemovals.set(provider, markedAt)
    try {
      await records.deleteRecord(projectionKey)
    } catch (error) {
      // A delete that threw removed nothing, so no own-removal echo is coming:
      // revoke this call's marker or it would mask a genuine one for the TTL.
      if (this.intentionalProjectionRemovals.get(provider) === markedAt) {
        this.intentionalProjectionRemovals.delete(provider)
      }
      this.warn(`cancelled activation projection cleanup failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Remote: send one minimal request with the selected key or account row.
   *
   * Observation-only by construction: the request runs under a test-only
   * request scope, so the broker answers with the pinned credential and the
   * stream listener skips selection and every health/binding write. An OAuth
   * row's grant is projected only for the duration of the request; the
   * projection (and the in-memory owner) that served the route before is
   * restored even when the request fails, so a test never changes which
   * account the route is on.
   *
   * Every expected refusal is a structured `{ ok: false, error }` result
   * (M2): the inline row line is the only failure surface, so a refusal must
   * not also raise the page-level banner a thrown RPC error produces.
   */
  async testKey(provider: string, keyId: string): Promise<KeyTestResult> {
    // PR review round 34: shutdown marks its entry before it restores the
    // outstanding borrows, and that restoration is not in this test's window —
    // so a test arriving now would borrow during it and outlive it.
    if (this.shutdownRequested) return this.shutdownEntryResult()
    // PR review round 12: a removal holds the provider from its entry, before
    // its first await, so a test cannot start in the window this check would
    // otherwise miss — read the grant and the projection while the removal is
    // deleting them, then re-project the removed account.
    if (this.removalsInProgress.has(provider)) {
      return {
        ok: false,
        latencyMs: 0,
        error: `Provider "${provider}" is being removed; run the connection test again once the removal finishes.`,
      }
    }
    const record = this.store.provider(provider)
    if (record === undefined) return { ok: false, latencyMs: 0, error: `Provider "${provider}" is not managed` }
    const row = record.keys.find(candidate => candidate.id === keyId)
    if (row === undefined) return { ok: false, latencyMs: 0, error: `Key "${keyId}" not found on ${provider}` }
    // QC fix wave 2: an abandoned window owns this provider until its cleanup
    // completed. Refused before the running-test check below, because the
    // abandoned test keeps that entry on purpose: the route's projection is
    // still unreconciled, so a second test would borrow it twice.
    if (this.cleaningTests.has(provider)) {
      // QC fix wave 3 (W-002): the fence must be able to clear itself, so this
      // attempt first runs one bounded cleanup of the abandoned window instead
      // of refusing on it forever. A failed attempt still refuses; a successful
      // one releases the isolation and the requested test proceeds.
      if (!await this.recoverAbandonedWindow(provider)) {
        return { ok: false, latencyMs: 0, error: 'A previous test is still being cleaned up' }
      }
    }
    // PR review round 15: the recovery above awaits the abandoned window's
    // cleanup, and that cleanup is what lifts the fence a removal's own
    // precheck reads. A removal beginning inside that await therefore passes
    // its precheck (no fence, no registered test), parks in its credential
    // deletion, and this attempt would register, read the still-present grant
    // and re-project the account the removal is deleting. The entry check
    // cannot cover the await, so the markers are read again here.
    if (this.removalsInProgress.has(provider) || this.retiringAccounts.has(row)) {
      return {
        ok: false,
        latencyMs: 0,
        error: `Provider "${provider}" is being removed; run the connection test again once the removal finishes.`,
      }
    }
    // Concurrent tests would race the projection save/restore; one at a time
    // per provider is enough for a per-row action and keeps the restore exact
    // (QC N7: the lock covers both row kinds, the isolation guard only the
    // kind that actually borrows).
    if (this.testsActive.has(provider)) {
      return { ok: false, latencyMs: 0, error: 'A test for this provider is already running' }
    }
    // Everything that awaits — the ownership readiness wait (QC B6) and the
    // request — belongs to the guarded promise, so a second call cannot slip
    // past the lock during the wait.
    const window: RowTestWindow = {
      provider,
      row,
      borrowBinding: false,
      releasedBinding: false,
      mutations: [],
      cleaned: false,
      settled: false,
      held: false,
      lateReconcileRequested: false,
    }
    // PR review round 21: the request is over when the guarded promise settles,
    // and that is what a held cleanup waits for. The marker is registered before
    // any settlement listener (the abandon retry), so that retry observes a
    // settled window instead of re-holding it forever.
    const test = this.runRowTest(record, row, window).finally(() => {
      window.settled = true
    })
    window.test = test
    this.testsActive.set(provider, test)
    // PR review round 33: registered with the lock, because shutdown restores
    // this window's borrow even when the test promise never settles.
    this.testWindows.set(provider, window)
    // The guard holds the whole test as a promise, not just a membership
    // flag: `streamListener` awaits it so no ordinary request is served by —
    // or attributed to — the grant an OAuth row test has borrowed. An api-key
    // test borrows nothing, so it never isolates ordinary traffic (QC N7).
    if (row.kind === 'oauth') this.testsInFlight.set(provider, test)
    // QC B3 + QC fix wave 2: this watchdog, not only the finally below, ends a
    // test wedged in an untimed seam call — and it ends the window the way the
    // test itself would, because releasing the provider without putting the
    // borrowed projection and binding back hands ordinary traffic the tested
    // account's credential.
    const watchdog = setTimeout(() => {
      this.abandonTestWindow(window)
    }, this.isolationWaitMs)
    watchdog.unref?.()
    try {
      return await test
    } finally {
      clearTimeout(watchdog)
      if (this.testsActive.get(provider) === test) this.testsActive.delete(provider)
      if (this.testWindows.get(provider)?.test === test) this.testWindows.delete(provider)
      // PR review MF1: a window whose cleanup could not put the route back
      // (normal path or watchdog) keeps its isolation entry until a recovery
      // attempt succeeds, so ordinary traffic is never served by the borrowed
      // grant while the fence is up.
      if (this.testsInFlight.get(provider) === test && !this.cleaningTests.has(provider)) this.testsInFlight.delete(provider)
    }
  }

  /**
   * Take over a test window that did not settle within the isolation deadline
   * (QC fix wave 2) or whose own cleanup could not restore the route (PR
   * review MF1).
   *
   * The fence is set synchronously, before the first cleanup await: the wedged
   * test may resume at any await from here, and it must observe the
   * abandonment before it starts a borrow or restores from its own stale
   * snapshot. The provider keeps its isolation entry until the cleanup
   * completed — see {@link settleAbandonedWindow}.
   */
  private abandonTestWindow(window: RowTestWindow, origin: 'deadline' | 'cleanup' = 'deadline'): void {
    // One cleanup owner per window: the watchdog and the normal path can both
    // observe the same failure, and a second owner would put two cleanups on
    // one route.
    if (window.cleaned) return
    window.cleaned = true
    this.cleaningTests.add(window.provider)
    this.abandonedWindows.set(window.provider, window)
    void this.settleAbandonedWindow(window, origin)
  }

  /**
   * Clean up one abandoned window and release its provider only on success.
   *
   * A cleanup that cannot finish needs the same untimed seam the wedged test is
   * parked in, so it fails exactly like the test did. Releasing the provider
   * then would serve ordinary traffic from the borrowed grant (or, on a
   * broker-bound profile, from a route whose binding was released and never
   * restored), so the isolation entry and the fence both stay. Two events can
   * retry the cleanup: the abandoned promise's settlement, and the next test
   * attempt ({@link recoverAbandonedWindow}, QC fix wave 3 W-002) — a promise
   * that settles while the seam is still wedged must not be the only path.
   */
  private async settleAbandonedWindow(window: RowTestWindow, origin: 'deadline' | 'cleanup'): Promise<void> {
    const failure = await this.attemptAbandonedCleanup(window)
    const cause = origin === 'deadline'
      ? `did not settle within ${this.isolationWaitMs}ms`
      : 'could not be cleaned up when it finished'
    if (failure === undefined && !window.held) {
      this.warn(`connection test for ${window.provider} ${cause}; its borrowed credential was put back and the provider slot is released`)
      return
    }
    if (failure === undefined) {
      // PR review round 21: the route is back, but the request that borrowed it
      // is still running and can refresh and rewrite that projection. The
      // provider stays isolated until the settlement reconciles the late write
      // and releases it.
      this.warn(`connection test for ${window.provider} ${cause}; its borrowed credential was put back, but its request has not settled, so the provider stays isolated until it does`)
    } else {
      this.warn(`connection test for ${window.provider} ${cause} and its cleanup did not complete (${failure}); the provider stays isolated`)
    }
    const pending = window.test
    if (pending === undefined) return
    const retry = (): void => { void this.retryAbandonedWindow(window) }
    void pending.then(retry, retry)
  }

  /** One later cleanup attempt for an abandoned window, once the seam answers again. */
  private async retryAbandonedWindow(window: RowTestWindow): Promise<void> {
    if (!this.cleaningTests.has(window.provider)) return
    if (this.abandonedWindows.get(window.provider) !== window) return
    await this.recoverAbandonedWindow(window.provider, 'settled')
  }

  /**
   * One bounded cleanup attempt for a fenced provider (QC fix wave 3, W-002).
   *
   * Returns whether the provider is servable again. The caller's attempt is
   * what makes the fence self-clearing: `testKey` calls this before refusing,
   * so isolation no longer depends on the abandoned promise settling after the
   * seam recovered. A failed attempt keeps the fence and warns exactly once.
   */
  private async recoverAbandonedWindow(provider: string, origin: 'settled' | 'next-attempt' = 'next-attempt'): Promise<boolean> {
    const window = this.abandonedWindows.get(provider)
    if (window === undefined) return !this.cleaningTests.has(provider)
    const failure = await this.attemptAbandonedCleanup(window)
    if (failure === undefined && !window.held) {
      this.warn(origin === 'settled'
        ? `the abandoned connection test for ${provider} settled; its borrowed credential was put back and the provider slot is released`
        : `the abandoned connection test for ${provider} was cleaned up on the next attempt; its borrowed credential was put back and the provider slot is released`)
      return true
    }
    if (failure === undefined) {
      // PR review round 21: the cleanup put the route back, but the request it
      // borrowed it for is still running and can rewrite the projection, so the
      // provider is not servable yet.
      this.warn(`the abandoned connection test for ${provider} was cleaned up, but its request has not settled; the provider stays isolated until it does`)
      return false
    }
    this.warn(`the abandoned connection test for ${provider} is still fenced (${failure}); the provider stays isolated`)
    return false
  }

  /**
   * Run the window's cleanup under its hard deadline and drop the provider's
   * isolation only when it completed. Returns the reason it could not finish.
   *
   * PR review round 21: the request that borrowed the route is not part of the
   * cleanup, so a cleanup can finish while that request is still able to
   * refresh and rewrite the borrowed projection. Such a window is held
   * ({@link RowTestWindow.held}) — the fence and the isolation entries stay —
   * and only its settlement reconciles the late write and releases it.
   */
  private async attemptAbandonedCleanup(window: RowTestWindow): Promise<string | undefined> {
    const provider = window.provider
    const attempt = (this.cleanupAttempts.get(provider) ?? 0) + 1
    this.cleanupAttempts.set(provider, attempt)
    const stillCurrent = (): boolean => this.cleanupAttempts.get(provider) === attempt
    this.cleaningTests.add(provider)
    const failure = await this.withinCleanupDeadline(() => this.cleanupTestWindow(window, stillCurrent))
    if (failure !== undefined) return failure
    // The work outlived its deadline and a newer attempt took the provider
    // over: its writes may finish (they were decided against the live store),
    // but it may not release state that attempt now owns.
    if (!stillCurrent()) return 'a newer cleanup attempt took over this provider'
    if (!window.settled && window.facts !== undefined) {
      // PR review round 21: the route is back, but the request that borrowed
      // this projection is still running and can refresh and rewrite it. Hold
      // the isolation (the fence and the entries above stay) until that
      // settlement reconciles the late write and releases the provider.
      window.held = true
      return undefined
    }
    // PR review round 28: the request settled while this cleanup ran, so its
    // settlement could not reconcile the late write itself — a running cleanup
    // reads as the route's owner. Reconcile that write here, before the release
    // hands the route back: a failure keeps the fence for the next attempt.
    if (window.lateReconcileRequested) {
      window.lateReconcileRequested = false
      const late = await this.withinCleanupDeadline(() => this.reconcileLateWindowProjection(window, true, stillCurrent))
      if (!stillCurrent()) return 'a newer cleanup attempt took over this provider'
      if (late !== undefined) return late
    }
    this.releaseAbandonedWindow(window)
    return undefined
  }

  /** Drop every isolation entry this window still owns, identity-checked. */
  private releaseAbandonedWindow(window: RowTestWindow): void {
    if (this.testsActive.get(window.provider) === window.test) this.testsActive.delete(window.provider)
    if (this.testsInFlight.get(window.provider) === window.test) this.testsInFlight.delete(window.provider)
    if (this.abandonedWindows.get(window.provider) === window) this.abandonedWindows.delete(window.provider)
    // PR review round 33: a released window is no longer outstanding, so
    // shutdown does not restore over the newer window's borrow.
    if (this.testWindows.get(window.provider) === window) this.testWindows.delete(window.provider)
    window.held = false
    this.cleaningTests.delete(window.provider)
  }

  /**
   * Put the route back the way the window found it: the mutations this window
   * started, then the projection (compare-by-payload and rotation-aware, so
   * nothing a writer stored meanwhile is overwritten), then the binding — the
   * original finally's order, because the binding decision reads the restored
   * owner map — then the borrow marker. Returns the reason the cleanup could
   * not complete.
   *
   * `stillCurrent` is passed by abandoned-window attempts only: a superseded
   * attempt that outlived its deadline may finish its writes, but the
   * provider-wide borrow marker belongs to the newest attempt (PR review
   * round 2) — deleting it would let ordinary traffic reach a newer window's
   * borrowed projection.
   */
  private async cleanupTestWindow(window: RowTestWindow, stillCurrent?: () => boolean): Promise<string | undefined> {
    // PR review round 30: the watchdog can abandon this window during or after
    // shutdown. Every step below writes (credential record, binding, state), so
    // the cleanup is refused instead of landing after `close()`; the process is
    // going away, which leaves the borrowed projection as the store holds it.
    if (this.closing) return 'Keys Manager is shutting down; the test cleanup was skipped'
    // QC fix wave 3 (W-001): a re-read cannot tell the pre-borrow payload from
    // a write that has not landed yet, so the cleanup first waits for the
    // borrow/binding mutations this window started. Past the caller's deadline
    // an unsettled mutation is a failed cleanup, not a clean route.
    await this.awaitWindowMutations(window)
    // PR review round 35: the wait above is an await, and shutdown's own
    // restoration owns every outstanding window from its entry — this cleanup
    // must not write after it.
    if (this.persistenceRefused()) return 'Keys Manager is shutting down; the test cleanup was skipped'
    const facts = window.facts
    if (facts !== undefined) {
      // PR review round 28: a restore that starts now reads the state the
      // route carries at this moment, so it also covers a settlement that
      // asked for a late reconcile before it began; only a settlement landing
      // while this restore runs still needs the cleanup to re-read afterwards.
      window.lateReconcileRequested = false
      const restored = await this.restoreProjection(facts.records, window.provider, window.row, facts.key, facts.previous, facts.borrowed, stillCurrent)
      if (restored !== undefined) return restored
    }
    // PR review round 3: a superseded attempt may not persist a binding
    // decision derived from a world a newer window now owns.
    if (stillCurrent !== undefined && !stillCurrent()) return 'a newer cleanup attempt took over this provider'
    // PR review round 35: the restore above awaited; a shutdown that started
    // under it refuses the binding write below.
    if (this.persistenceRefused()) return 'Keys Manager is shutting down; the test cleanup was skipped'
    // QC B4: one sync at window end, after the owner map and the projection
    // are back, so the persisted binding matches the state the route actually
    // restored to.
    // QC fix wave 3 (S-003): unconditionally, because a binding decision the
    // borrow made {@link syncBrokerBinding} skip (an `addKey` inside the
    // window) is only observed here. It stays a no-op when nothing changed and
    // never overwrites a value Keys Manager did not write; only a window that
    // actually released the binding reports a refused write as a failure.
    const rebound = await this.syncBrokerBinding(window.provider, { borrow: true })
    if (!rebound && window.releasedBinding) {
      return 'The route credential binding could not be restored after the test; repair it in Models before relying on this route.'
    }
    if (stillCurrent === undefined || stillCurrent()) this.testBindingBorrows.delete(window.provider)
    return undefined
  }

  /**
   * Reconcile the projection once an abandoned window's request finally
   * settles (PR review round 13).
   *
   * The watchdog's cleanup can complete before the wedged request resumes: an
   * adapter that ignored the abort then refreshes and rewrites the borrowed
   * grant, and the abandoned window used to skip cleanup on settlement — so
   * the tested account stayed projected over the restored one and served
   * ordinary traffic. The shared compare-by-payload restore is idempotent and
   * only touches a projection this test left (the borrowed grant or a
   * rotation of the tested row): a foreign payload survives, and a newer
   * generation is written back to the tested row before the pre-test
   * projection is restored.
   *
   * Returns the failure, so a caller that releases the provider afterwards (PR
   * review round 21) can keep the fence instead. `ownsFence` is passed by the
   * settlement of a held window and by the cleanup that releases a window whose
   * settlement it deferred (PR review round 28): both already own the
   * provider's fence, which the default guards would read as a competing
   * cleanup and skip.
   */
  private async reconcileLateWindowProjection(
    window: RowTestWindow,
    ownsFence = false,
    stillCurrent?: () => boolean,
  ): Promise<string | undefined> {
    const facts = window.facts
    if (facts === undefined) return undefined
    const provider = window.provider
    if (!ownsFence) {
      // A cleanup that is still running — or one that gave up and left the
      // provider fenced — owns the route: its own attempt reads the late state
      // and reconciles it, and this late promise must not race it. PR review
      // round 28: that attempt only knows about the late write through this
      // marker, set synchronously with `window.settled` in the caller, so a
      // cleanup that observes a settled window also observes this request.
      if (this.cleaningTests.has(provider)) {
        if (this.abandonedWindows.get(provider) === window) window.lateReconcileRequested = true
        return undefined
      }
      const active = this.testsActive.get(provider)
      if (active !== undefined && active !== window.test) return undefined
    }
    // PR review round 32: the phase runs under its own deadline, so the attempt
    // that started it can already be superseded when it resumes — the restore
    // and the binding sync are both gated on that attempt identity, not merely
    // checked by the caller afterwards.
    const failure = await this.restoreProjection(facts.records, provider, window.row, facts.key, facts.previous, facts.borrowed, stillCurrent, true)
    if (failure !== undefined) {
      this.warn(`the late projection write of the abandoned connection test for ${provider} could not be reconciled: ${failure}`)
      return failure
    }
    if (stillCurrent !== undefined && !stillCurrent()) return undefined
    await this.syncBindingAfterProjectionChange(provider)
    return undefined
  }

  /**
   * Record one in-flight window mutation before it is awaited (QC fix wave 3,
   * W-001). The normalized promise never rejects: the mutation's own outcome
   * belongs to the code awaiting it, while the cleanup only needs to know when
   * the write is over.
   */
  private recordWindowMutation(window: RowTestWindow, mutation: Promise<unknown>): void {
    window.mutations.push(mutation.then(() => undefined, () => undefined))
  }

  /**
   * Await every mutation this window recorded, including one the continuation
   * of an earlier mutation records (a borrow that settles right before its
   * binding release starts). The microtask hop after each settling round lets
   * that continuation run before the cleanup judges the route clean. A
   * mutation the seam never answers is bounded by the caller's deadline, not
   * here.
   */
  private async awaitWindowMutations(window: RowTestWindow): Promise<void> {
    let awaited = 0
    for (;;) {
      while (awaited < window.mutations.length) {
        await window.mutations[awaited]
        awaited += 1
      }
      await Promise.resolve()
      if (awaited >= window.mutations.length) return
    }
  }

  /**
   * Run one cleanup under its hard deadline. The work is not cancelled — the
   * credential seam offers no cancellation — it is only stopped from holding
   * the provider past the bound; a late result is ignored.
   */
  private async withinCleanupDeadline(work: () => Promise<string | undefined>): Promise<string | undefined> {
    // The bound never rejects: a seam failure is a cleanup result, not a
    // control-flow error.
    const running = work().then(
      failure => failure,
      (error: unknown) => `the credential store refused the cleanup: ${error instanceof Error ? error.message : String(error)}`,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<string>(resolve => {
      timer = setTimeout(() => resolve('the credential store did not answer before the cleanup deadline'), this.testCleanupDeadlineMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([running, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Decide the route's serving shape and run one row test. Separate from
   * {@link testKey} so the concurrency lock is registered before the first
   * await.
   */
  private async runRowTest(record: ProviderRecord, row: KeyRecord, window: RowTestWindow): Promise<KeyTestResult> {
    const provider = record.provider
    // QC B6: the serving source is decided from projection ownership, which a
    // restarted process hydrates asynchronously. Until that read lands the
    // shape is unknown, so the honest answer is a refusal with no request
    // rather than a test attributed to the wrong credential.
    if (!await this.awaitProjectionOwnership(provider)) {
      return { ok: false, latencyMs: 0, error: 'Account ownership is still loading; try again in a moment' }
    }
    const route = this.testRouteProfile(record)
    if ('error' in route) return { ok: false, latencyMs: 0, error: route.error }
    const profile = route.profile
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    // QC B1: derive the route's serving shape once, from the profile value
    // read at entry, and only test a row whose credential this shape carries.
    // pi-ai resolves a named `apiKeyEnv` override before its stored grant, so
    // `bound` decides that the broker (key pool) authenticates the request and
    // `projected` that the account's grant does.
    const bound = apiKeyEnv === record.brokerRef
    const projected = this.oauthOwnerFor(provider) !== null
    const foreignReference = apiKeyEnv !== undefined && !bound
    if (foreignReference) {
      return {
        ok: false,
        latencyMs: 0,
        error: `This route is served by the credential reference "${apiKeyEnv}" set in the provider settings, which Keys Manager does not manage. Repair the binding in Models, then test again.`,
      }
    }
    // C1: a route served by a projected OAuth account resolves that account's
    // stored grant, never the API-key pool. `syncBrokerBinding` unsets the
    // profile's broker reference while a projection exists, so the adapter has
    // no `apiKey` override to hand pi-ai and the test scope's pinned literal is
    // never consulted: an api-key row test here would report a pass for a key
    // the request did not carry. Refuse with the serving source instead of
    // borrowing (or deleting) the projection — a diagnostic action must not
    // rewrite the route's credential binding. `oauthOwnerFor` is the read-only
    // ownership oracle; a stale map entry resolves to null and does not refuse.
    if (row.kind === 'api-key' && projected) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'This route is currently served by its OAuth account; the API key pool is not in use. Deactivate the account or let the projection fall back, then test again.',
      }
    }
    if (row.kind === 'api-key' && !bound) {
      // No `apiKeyEnv` override means pi-ai reads its own stored credential:
      // the pinned literal never reaches the request, so a pass would be
      // reported for a key this route did not carry.
      return {
        ok: false,
        latencyMs: 0,
        error: 'This route is not served by its API-key pool (the provider profile holds no Keys Manager binding). Re-add a key or repair the binding in Models, then test again.',
      }
    }
    const model = normalizeModels(profile.models)[0]?.id
    if (model === undefined) return { ok: false, latencyMs: 0, error: 'No model is configured for this provider' }
    // QC B1: a broker-bound profile hides the borrowed projection from pi-ai,
    // so the binding is released for the test window through the one authority
    // and restored at window end (see runOAuthRowTest).
    const borrowBinding = row.kind === 'oauth' && bound
    if (row.kind !== 'oauth') return await this.runApiKeyRowTest(provider, row, model, window)
    // The window records what this test borrows, so the watchdog can put the
    // route back exactly as the test's own finally would (QC fix wave 2).
    window.borrowBinding = borrowBinding
    return await this.runOAuthRowTest(provider, row, model, window)
  }

  /**
   * The live provider profile one test must reason about, read once at entry
   * (QC B1/N6), or the reason it cannot be used. An unreadable settings
   * snapshot and a missing profile are distinct causes, so the row never
   * claims a model is missing when the settings service is merely absent.
   */
  private testRouteProfile(record: ProviderRecord): { profile: ProfileShape } | { error: string } {
    const descriptor = this.describeSettings()
    if (!descriptor.readable) {
      return { error: 'The provider settings could not be read, so the test cannot tell which credential serves this route. Try again in a moment.' }
    }
    const namespace = this.namespace(descriptor, record.settingsNs)
    if (namespace === undefined) {
      return { error: `The settings namespace "${record.settingsNs}" is not mounted; configure this provider in Models and test again.` }
    }
    const profile = asProfile(getPath(namespace.value, record.settingsPath))
    if (profile === undefined) {
      return { error: 'This provider has no settings profile yet; configure a model for it and test again.' }
    }
    return { profile }
  }

  /** One request pinned to the row's API-key literal. */
  private async runApiKeyRowTest(provider: string, row: KeyRecord, model: string, window: RowTestWindow): Promise<KeyTestResult> {
    const probe = await this.probeKey(row.ref)
    // PR review round 10 (I-000179): the probe is an untimed seam call, so the
    // window can be abandoned — and a release, refused or not, can have
    // removed the row — while the test is parked here. Re-assert both right
    // before the send: a late probe result must not send a deleted literal.
    if (window.cleaned) return this.abandonedTestResult()
    const live = this.store.provider(provider)
    if (live === undefined || !live.keys.some(candidate => candidate.id === row.id)) {
      return { ok: false, latencyMs: 0, error: `Key "${row.id}" was removed from ${provider} before its test could send` }
    }
    if (probe.hit === undefined) {
      return {
        ok: false,
        latencyMs: 0,
        error: probe.failed ? `Could not read credential ${row.ref}` : 'The stored credential is missing',
      }
    }
    // PR review round 40: a native OAuth sign-in (or a demotion) can change the
    // route's serving source while the probe is parked. Sending now would test a
    // key the request does not carry, so refuse instead of reporting a false pass.
    if (this.oauthOwnerFor(provider) !== null || this.foreignProjections.has(provider)) {
      return {
        ok: false,
        latencyMs: 0,
        error: `The ${provider} route is now served by another credential source; run the test again once it settles.`,
      }
    }
    return await this.runTestRequest(provider, model, {
      provider,
      keyId: row.id,
      keyValue: probe.hit.value,
      keyUsed: false,
      oauthAccountId: null,
      test: true,
    })
  }

  /** One request with the row's grant temporarily projected as the route's credential. */
  private async runOAuthRowTest(
    provider: string,
    row: KeyRecord,
    model: string,
    window: RowTestWindow,
  ): Promise<KeyTestResult> {
    const grant = row.oauth
    if (grant === null) return { ok: false, latencyMs: 0, error: `Key "${row.id}" is not an OAuth account` }
    const records = this.credentialRecords()
    if (records === undefined) return { ok: false, latencyMs: 0, error: 'The credential store does not support records' }
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    let result: KeyTestResult = { ok: false, latencyMs: 0, error: 'The test did not run' }
    // The projection write, the request and the restore share the provider's
    // grant chain, so a rotation echo cannot observe or overwrite the
    // temporary projection between them.
    await this.scheduleGrantReconciliation(provider, async () => {
      const stored = await records.readRecord(grant.grantRef)
      if (window.cleaned) {
        // QC fix wave 2: the watchdog abandoned this window while the read was
        // in flight. Starting (or resuming) the borrow now would land it after
        // the cleanup that already ran, so the test stops here.
        result = this.abandonedTestResult()
        return
      }
      if (stored === undefined || stored.kind !== 'grant' || !isOAuthGrantPayload(stored.payload)) {
        result = {
          ok: false,
          latencyMs: 0,
          error: `The grant payload at ${grant.grantRef} is missing or unusable; sign in to this account again`,
        }
        return
      }
      const borrowed = structuredClone(stored.payload)
      const captured = await records.readRecord(projectionKey)
      // PR review round 14: the snapshot and its comparison key are frozen
      // here. The seam hands back a live record, so a writer mutating that
      // stored object in place would otherwise change `previous` along with
      // the updater's `current` and make the borrow look unchanged.
      const previous = captured === undefined ? undefined : structuredClone(captured)
      const previousKey = previous === undefined ? undefined : JSON.stringify(previous)
      if (window.cleaned) {
        result = this.abandonedTestResult()
        return
      }
      if (this.shutdownRequested) {
        // PR review round 30: shutdown abandons the chain parked here, so the
        // borrow write below must not land after `close()`. Round 34: the
        // marker is up from shutdown's entry, so the pre-close restoration is
        // covered too — it does not borrow, and this test must not either.
        result = this.shutdownEntryResult()
        return
      }
      // PR review round 12: both reads above are awaits, so a removal can have
      // deleted the provider or this row while they were in flight (a test that
      // registered and one that did not are covered: the marker refuses the
      // latter, this re-check the former). Never write the borrow — and never
      // re-project the removed account's grant — on that state.
      // PR review round 15: the existence check alone still holds while a
      // removal is deleting credentials (the row is spliced only after its
      // grant delete), so the row's retirement mark is part of the assertion.
      // The provider-wide marker is deliberately not read here: a removal that
      // began while this test is registered waits for it in
      // {@link settleTestBeforeRemoval} and is the designed handshake, while
      // the row mark is only set by a removal that already passed that check.
      const live = this.store.provider(provider)
      const removing = this.retiringAccounts.has(row)
      if (removing || live === undefined || !live.keys.some(candidate => candidate.id === row.id)) {
        result = removing
          ? { ok: false, latencyMs: 0, error: `Provider "${provider}" is being removed; the test did not borrow its credential` }
          : { ok: false, latencyMs: 0, error: `Key "${row.id}" was removed from ${provider} before its test could borrow it` }
        return
      }
      // QC fix wave 2: record the borrow before the write, so an abandoned
      // window can restore a borrow whose write lands after the watchdog
      // looked. The restore decides by payload, so the facts are safe to hold
      // whether or not the write landed.
      window.facts = { records, key: projectionKey, previous, borrowed }
      // QC B4 + PR review round 8: the borrow marker is registered BEFORE the
      // write is awaited. A mutation landing while the write is still in
      // flight would otherwise derive a binding from the pre-borrow world — on
      // an unbound route it binds the broker over the projection this test is
      // about to borrow, and the window (whose `borrowBinding` was decided at
      // entry) never releases it.
      this.testBindingBorrows.add(provider)
      // QC fix wave 3 (W-001): the write is recorded before it is awaited, so
      // a cleanup that runs while it is still in flight waits for it instead
      // of re-reading the pre-borrow payload and calling the route clean.
      // PR review round 13: the pre-borrow read is awaited, so a native or
      // manager sign-in can commit a newer projection before this write runs.
      // The write is therefore a compare-and-swap against the record it
      // captured: borrowing over that sign-in — and restoring the stale
      // `previous` at window end — would drop it for good.
      let borrowRefused = false
      const borrowWrite = records.modifyRecord(projectionKey, current => {
        const unchanged = previous === undefined
          ? current === undefined
          : current !== undefined && JSON.stringify(current) === previousKey
        if (!unchanged) {
          borrowRefused = true
          return Promise.resolve(undefined)
        }
        return Promise.resolve({ kind: 'grant', payload: structuredClone(borrowed) })
      })
      this.recordWindowMutation(window, borrowWrite)
      try {
        await borrowWrite
      } catch (error) {
        // Nothing was borrowed, so the fence goes back — unless an abandoned
        // window's cleanup owns it (it removes the marker when it completes).
        if (!window.cleaned) this.testBindingBorrows.delete(provider)
        result = {
          ok: false,
          latencyMs: 0,
          error: `The grant could not be projected for the test: ${error instanceof Error ? error.message : String(error)}`,
        }
        return
      }
      if (this.shutdownRequested) {
        // PR review round 30: the borrow write settled after shutdown started,
        // so no binding release, request or restore may follow it. Round 34:
        // shutdown's entry marker makes that true during the pre-close
        // restoration as well, which waits this write out and puts it back.
        result = this.shutdownTestResult()
        return
      }
      if (borrowRefused) {
        // The projection belongs to a newer writer, so this window borrowed
        // nothing and has nothing to restore. An abandoned window's cleanup
        // owns the fence and the marker.
        if (!window.cleaned) {
          window.facts = undefined
          this.testBindingBorrows.delete(provider)
          result = {
            ok: false,
            latencyMs: 0,
            error: `The credential projection for ${provider} changed while the test was starting; the test did not borrow it. Run the test again.`,
          }
          return
        }
        result = this.abandonedTestResult()
        return
      }
      if (window.cleaned) {
        // QC fix wave 2: the window was conceded while this write was in
        // flight, so the watchdog's cleanup may have read the projection
        // before it landed. Undo the borrow through the same compare-by-payload
        // restore (not the stale snapshot) and keep the fence if that fails.
        // QC fix wave 3 (W-002): only while this window still owns the fence.
        // A cleanup that completed on a later test attempt already restored
        // this write; running again now would put a projection back out from
        // under that newer window.
        if (this.abandonedWindows.get(provider) === window) await this.attemptAbandonedCleanup(window)
        result = this.abandonedTestResult()
        return
      }
      // QC fix wave 3 (W-002): the owner claim sits after the fence check — an
      // abandoned window's repair already reconciled the owner from the
      // restored payload, and claiming it again would name a row the cleanup
      // no longer serves. QC B4: the borrow marker that hides this window's
      // credential surface from the binding authority is already set, before
      // the borrow write (PR review round 8); the window-end sync below writes
      // the restored state.
      this.claimProjectionOwner(provider, row.id)
      let restoreFailure: string | undefined
      try {
        if (window.borrowBinding) {
          // QC B1: a broker-bound profile hands pi-ai the broker reference, so
          // the projection would be inert for the request. Release it for the
          // window through the single binding authority (a failed release
          // refuses the test instead of borrowing a second writer).
          // QC fix wave 2: the attempt is recorded before it is awaited — it
          // may land partially, and a cleanup must re-sync what it touched.
          // QC fix wave 3 (W-001): it is also recorded as an in-flight window
          // mutation, so a cleanup does not sync a route whose release is
          // still on its way to the profile.
          window.releasedBinding = true
          const release = this.syncBrokerBinding(provider, { borrow: true })
          this.recordWindowMutation(window, release)
          const released = await release
          if (window.cleaned) {
            // The abandonment landed while this release was in flight, so the
            // watchdog's re-sync may have run before the release did and left
            // the profile unbound. Re-sync now that the release is complete —
            // unless a later attempt already cleaned this window up (W-002).
            if (this.abandonedWindows.get(provider) === window) await this.attemptAbandonedCleanup(window)
            result = this.abandonedTestResult()
            return
          }
          if (!released) {
            restoreFailure = 'The route is served by its API-key pool and its credential binding could not be released for the test; the account was not tested.'
          }
        }
        if (restoreFailure === undefined) {
          result = await this.runTestRequest(provider, model, {
            provider,
            keyId: null,
            keyValue: null,
            keyUsed: false,
            oauthAccountId: row.id,
            test: true,
          })
        }
      } finally {
        // PR review round 21: the request is over. A cleanup that completed
        // while it was still running held the provider's isolation for exactly
        // this point, so the late write is reconciled before that isolation is
        // released; a failed reconcile keeps the fence (the existing
        // borrow-could-not-be-undone path).
        window.settled = true
        if (this.closing) {
          // PR review round 30: the shutdown drain abandoned this chain; the
          // restore and the binding sync below are persistence, and the store
          // is closed already. Nothing is written, so the borrowed projection
          // stays as the credential store holds it.
          restoreFailure ??= this.shutdownTestResult().error
        } else if (window.cleaned) {
          // QC fix wave 2: this window was abandoned and its cleanup already
          // ran (or is running) under the watchdog. Restoring from this
          // promise's own pre-test snapshot now would race whatever state the
          // route carries by then, so the late settlement writes nothing and
          // reports the failure its own result cannot claim.
          restoreFailure = this.abandonedTestResult().error
          // PR review round 13: the abandoned request may itself have
          // refreshed and rewritten the borrowed projection after that
          // cleanup ran. Reconcile that late write against what the window
          // found before the route counts as handed back.
          const late = await this.reconcileLateWindowProjection(window, window.held)
          if (window.held && late === undefined && this.abandonedWindows.get(provider) === window) {
            this.releaseAbandonedWindow(window)
          }
        } else {
          const restored = await this.cleanupTestWindow(window)
          if (restoreFailure === undefined) restoreFailure = restored
          // PR review MF1: a cleanup that failed on the normal path must enter
          // the same fenced recovery the watchdog uses. Reporting the failure
          // alone would strand the borrow marker (every later
          // `syncBrokerBinding` returns early) and let the borrowed grant keep
          // serving ordinary requests. `window.cleaned` guards the case where
          // the watchdog took the window over while this cleanup ran — that
          // owner is already retrying.
          if (restored !== undefined && !window.cleaned) this.abandonTestWindow(window, 'cleanup')
        }
      }
      if (restoreFailure !== undefined) {
        result = { ok: false, latencyMs: result.latencyMs, error: restoreFailure }
      }
    })
    return result
  }

  /** The refusal an abandoned test reports instead of a stale success. */
  private abandonedTestResult(): KeyTestResult {
    return {
      ok: false,
      latencyMs: 0,
      error: `The connection test was abandoned after ${this.isolationWaitMs}ms and its borrowed credential was cleaned up; run the test again.`,
    }
  }

  /** The refusal a chain reports when shutdown refuses its persistence. */
  private shutdownTestResult(): KeyTestResult {
    return {
      ok: false,
      latencyMs: 0,
      error: 'Keys Manager is shutting down; the connection test did not finish and its cleanup was skipped.',
    }
  }

  /** The refusal a test reports when it arrives after shutdown began (round 34). */
  private shutdownEntryResult(): KeyTestResult {
    return {
      ok: false,
      latencyMs: 0,
      error: 'Keys Manager is shutting down; the connection test was refused before it borrowed a credential.',
    }
  }

  /**
   * Mark one provider as being removed for the whole removal body (PR review
   * round 12). The marker is up before the body's first await — the removal's
   * own test wait included — so {@link testKey} can refuse a test that would
   * otherwise start inside the removal. Nesting is a depth because a
   * last-key `deleteKey` releases through `releaseLocked`.
   */
  private async withRemovalInProgress<T>(provider: string, work: () => Promise<T>): Promise<T> {
    const depth = this.removalsInProgress.get(provider) ?? 0
    this.removalsInProgress.set(provider, depth + 1)
    try {
      return await work()
    } finally {
      if (depth === 0) this.removalsInProgress.delete(provider)
      else this.removalsInProgress.set(provider, depth)
    }
  }

  /**
   * Hold a row/account removal until the provider's running row test settles
   * (PR review round 9, R8-2).
   *
   * `testKey` captures its row, its credential and the route's serving shape
   * before the first await, so a removal landing inside that window can delete
   * the credential the test is about to send. For a borrowed OAuth account the
   * removal is worse than a stale read: it compares its decision against the
   * test's temporary projection, deletes it and demotes every row, and the
   * test's own restore then writes the removed account's grant back. The
   * removal therefore waits for the window instead of racing it. The wait is
   * bounded by {@link isolationWaitMs} — a test wedged in an untimed seam call
   * must not park the removal forever — and a provider whose abandoned window
   * still owns the route's records refuses the removal outright. A wait that
   * hits its own bound refuses too (PR review round 10, I-000179): proceeding
   * would delete the credential the parked test is about to send. The user can
   * retry once the abandoned window has been cleaned up.
   */
  private async settleTestBeforeRemoval(provider: string): Promise<void> {
    const refusal = `A previous connection test for ${provider} is still being cleaned up; try again in a moment.`
    if (this.cleaningTests.has(provider)) throw new Error(refusal)
    const pending = this.testsActive.get(provider)
    if (pending === undefined) return
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.isolationWaitMs)
      timer.unref?.()
    })
    try {
      await Promise.race([pending.then(() => { settled = true }, () => { settled = true }), bound])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (this.cleaningTests.has(provider)) throw new Error(refusal)
    if (!settled) {
      throw new Error(
        `A connection test for ${provider} did not settle within ${this.isolationWaitMs}ms, so the removal was refused rather than delete a credential its request may still carry; try again in a moment.`,
      )
    }
  }

  /**
   * Put the projection back as it was before the test borrowed it, without
   * losing or overwriting anything that changed meanwhile.
   *
   * `late` marks the abandoned window's settlement, after the watchdog's
   * cleanup already released the provider: a removal no longer waits for this
   * test, so the pre-test projection's owning row may be gone by the time this
   * runs and must not be projected again (PR review round 19).
   *
   * The decision is compare-by-payload against the borrowed grant: only a
   * live record that still carries it — or a refresh-rotated version of it
   * that {@link matchOwningAccount} attributes to the tested row — is
   * replaced. A rotation is reconciled into the tested row first (the same
   * plugin-scope write-back {@link reconcileGrantRecord} performs), because
   * the provider may already have consumed the superseded refresh token. A
   * foreign or newer payload (another account, a native writer) is left
   * untouched, and a record removed during the window stays removed. In every
   * branch the owner map ends consistent with what the store actually holds.
   *
   * Returns a failure message when the restore or the rotation write-back
   * did not land, so the caller reports `{ ok: false }` instead of a false
   * pass.
   */
  private async restoreProjection(
    records: CredentialRecordsLike,
    provider: string,
    row: KeyRecord,
    key: string,
    previous: CredentialRecordLike | undefined,
    borrowed: OAuthGrantPayload,
    stillCurrent?: () => boolean,
    late?: boolean,
    capability?: RestoreCapability,
  ): Promise<string | undefined> {
    let live: CredentialRecordLike | undefined
    try {
      live = await records.readRecord(key)
    } catch (error) {
      const message = `The credential projection at ${key} could not be re-read after the test: ${error instanceof Error ? error.message : String(error)}`
      this.pushWarning(message)
      return message
    }
    // PR review round 3: a cleanup that outlived its deadline can be
    // superseded by a newer window that borrowed the SAME account meanwhile,
    // so the compare by payload below still matches a state this attempt no
    // longer owns. `stillCurrent` is that attempt identity; only an abandoned
    // attempt has one. Every write decision — the projection, the owner map
    // and the binding sync — is gated on it.
    const superseded = (): boolean => stillCurrent !== undefined && !stillCurrent()
    const takeover = 'a newer cleanup attempt took over this provider'
    // PR review round 36: the re-read above is an await a cleanup can park in
    // across `close()`, so every write decision refuses persistence from the
    // moment shutdown starts — unless the caller is the pre-close restoration,
    // which is the only holder of that capability.
    const shutdown = 'Keys Manager is shutting down; the test cleanup was skipped'
    if (this.persistenceRefused(capability)) return shutdown
    // PR review round 8: the fence is checked in each branch that writes the
    // owner map, instead of once before every branch. The pre-branch check ran
    // after the only await, so it pre-empted the branch fences below and made
    // them untestable; every write is still guarded, at the write itself.
    const liveGrant = live !== undefined && live.kind === 'grant' && isOAuthGrantPayload(live.payload)
      ? live.payload
      : undefined
    const previousGrant = previous !== undefined && previous.kind === 'grant' && isOAuthGrantPayload(previous.payload)
      ? previous.payload
      : undefined
    const carriesBorrowed = liveGrant !== undefined && JSON.stringify(liveGrant) === JSON.stringify(borrowed)
    // R2-1: the pre-test projection was deleted while this test ran. That
    // removal came from a writer outside the provider's grant chain — the
    // manager's own projection release, or a native sign-out — so the
    // pre-test payload is not this test's to put back: resurrecting it would
    // restore a credential its owner just stopped serving. The record stays
    // absent and the owner map follows the (empty) live store. The
    // `previous === undefined` case is different — that projection was this
    // test's own write — and is deleted below.
    if (live === undefined && previous !== undefined) {
      // PR review round 7: the re-read above is an await, so the attempt fence
      // is re-checked at this write instead of inherited from an earlier site.
      if (superseded()) return takeover
      this.reconcileProjectionOwner(provider, undefined)
      return undefined
    }
    const rows = this.store.provider(provider)?.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null) ?? []
    const previousOwner = previousGrant === undefined ? undefined : matchOwningAccount(provider, rows, previousGrant)
    if (live !== undefined && !carriesBorrowed) {
      const rotationOwner = liveGrant === undefined ? undefined : matchOwningAccount(provider, rows, liveGrant)
      if (rotationOwner?.id === row.id && this.accountRowIsManaged(provider, row)) {
        // PR review round 8: this branch's write-back starts an awaited write,
        // so it checks the attempt fence where it is about to write.
        if (superseded()) return takeover
        if (this.persistenceRefused(capability)) return shutdown
        try {
          await this.writeBackRotation(provider, row, liveGrant!, capability, stillCurrent)
        } catch (error) {
          // PR review round 38: the helper throws when this attempt was
          // superseded mid-write or shutdown started; neither may claim the
          // route, and nothing may be written on their behalf.
          if (superseded()) return takeover
          if (this.persistenceRefused(capability)) return shutdown
          // The live projection is the only copy of the rotated payload:
          // overwriting it with the pre-test payload would strand the account
          // on a consumed refresh token, so it stays and owns the route —
          // unless this attempt is superseded, and the route is no longer its
          // to claim (PR review round 6).
          if (superseded()) return takeover
          this.claimProjectionOwner(provider, row.id)
          const message = `The rotated grant for ${provider} could not be written back after the test: ${error instanceof Error ? error.message : String(error)}`
          this.pushWarning(message)
          return message
        }
      } else {
        // A foreign or newer payload — another account, a native writer, an
        // unrecognized record — is not this test's to restore. Only the owner
        // map follows what is actually stored, and only while this attempt
        // still owns the provider (PR review round 7: fenced at the write).
        if (superseded()) return takeover
        this.reconcileProjectionOwner(provider, live)
        return undefined
      }
    }
    // PR review round 6: the rotation write-back is an await. A cleanup that
    // outlived its deadline can resume after a newer window borrowed another
    // account, so the owner map it would reconcile belongs to that window's
    // world now: finish the write, skip the owner write, report the takeover.
    if (superseded()) return takeover
    // QC B2: the pre-test projection already belonged to the tested row, so
    // the live payload (the borrowed grant, or a rotation just written back
    // above) IS that row's current grant. Writing `previous` back would revert
    // it: its echo re-matches the same row, moves `grantRef` to the superseded
    // generation and deletes the rotated record — leaving the account on a
    // consumed refresh token.
    //
    // PR review round 28: ownership alone cannot decide that, because the
    // captured `previous` is a *different generation* of the same account
    // whenever a re-authentication projected a newer payload before the borrow
    // (the borrow's compare-and-swap then replaced it with the older stored
    // grant). Keeping the borrowed payload there strands the route on the
    // stale generation, and the next echo adopts it and deletes the newer one.
    // Only the payload identity decides: identical payloads are the pre-test
    // projection itself, and a different one that the store still carries as
    // the borrow is the newer generation this restore puts back.
    const staleBorrow = previousGrant !== undefined && JSON.stringify(previousGrant) !== JSON.stringify(borrowed)
    if (previousOwner?.id === row.id && !(carriesBorrowed && staleBorrow)) {
      this.reconcileProjectionOwner(provider, live)
      return undefined
    }
    // PR review round 19 (I-000179 late restore): only a late restore can find
    // its pre-test projection's owner gone — the watchdog's cleanup released
    // the provider, so a removal no longer waited for this test and `rows` no
    // longer matches that payload, leaving nothing else to reject the write.
    // Restoring it would serve a deleted account's credential. An in-window
    // restore is protected by settleTestBeforeRemoval and keeps restoring a
    // pre-test projection no pool row owns (a foreign grant it borrowed over).
    if (late === true && (previousOwner === undefined || !this.accountRowIsManaged(provider, previousOwner))) {
      if (superseded()) return takeover
      this.reconcileProjectionOwner(provider, live)
      const message = `The credential projection at ${key} was not restored after the test: the account whose grant it carried is no longer managed. The route keeps whichever credential those records hold now.`
      this.pushWarning(message)
      return message
    }
    // The record this restore left in place: the tail reconciles the owner map
    // against the live record, never against the payload it hoped to restore
    // (PR review round 8 — the store may hold a present non-grant record).
    let left: CredentialRecordLike | undefined
    try {
      if (previous === undefined) {
        // PR review MF2: the projection was this test's own write, so the
        // route goes back to having none — but only while the record still
        // carries what this test left (the borrowed grant, or a rotation of
        // the tested row). The decision runs inside the seam's per-key lock
        // and the removal is preceded by {@link projectionStillMatches}, so a
        // native writer's grant landing after the re-read above survives as
        // that writer's projection instead of being deleted as a leftover.
        let decidedAgainst: string | undefined = undefined
        await records.modifyRecord(key, async current => {
          // A superseded attempt, or a cleanup the shutdown overtook, leaves
          // the record exactly as it found it.
          if (superseded() || this.persistenceRefused(capability)) return undefined
          if (current === undefined) return undefined
          const currentGrant = current.kind === 'grant' && isOAuthGrantPayload(current.payload)
            ? current.payload
            : undefined
          const testLeft = currentGrant !== undefined && (
            JSON.stringify(currentGrant) === JSON.stringify(borrowed)
            || matchOwningAccount(provider, rows, currentGrant)?.id === row.id)
          if (testLeft) decidedAgainst = JSON.stringify(current.payload)
          return undefined
        })
        if (superseded()) return takeover
        if (this.persistenceRefused(capability)) return shutdown
        if (decidedAgainst === undefined || !await this.projectionStillMatches(records, key, decidedAgainst)) {
          const liveAfter = await records.readRecord(key)
          // PR review round 6: this reconcile follows an awaited re-read; a
          // superseded attempt may not repoint the owner from a world a newer
          // window now owns.
          if (superseded()) return takeover
          // PR review round 35: the re-read is the cleanup's last await before
          // it would write; a shutdown that began under it stops the restore.
          if (this.persistenceRefused(capability)) return shutdown
          this.reconcileProjectionOwner(provider, liveAfter)
          // Already gone: the route has no projection, which is the state the
          // test found. Anything else is a grant this test may not remove —
          // it stays and owns the route, and the test reports that its own
          // borrow could not be undone.
          if (liveAfter === undefined) return undefined
          const message = `The credential projection at ${key} changed during the test and was left in place; the route serves whichever credential those records hold now.`
          this.pushWarning(message)
          return message
        }
        // The projection this test borrowed may already be a newer window's.
        if (superseded()) return takeover
        if (this.persistenceRefused(capability)) return shutdown
        await records.deleteRecord(key)
      } else {
        // QC N2: the compare travels with the write, so a foreign payload
        // stored between the re-read above and this write is never
        // overwritten. Only a record that still carries what this test left
        // (the borrowed grant, or a rotation of the tested row) is replaced.
        const snapshot = structuredClone(previous)
        left = await records.modifyRecord(key, current => {
          // A superseded attempt, or a cleanup the shutdown overtook, leaves
          // the record exactly as it found it.
          if (superseded() || this.persistenceRefused(capability)) return Promise.resolve(current)
          const currentGrant = current !== undefined && current.kind === 'grant' && isOAuthGrantPayload(current.payload)
            ? current.payload
            : undefined
          const testLeft = currentGrant !== undefined && (
            JSON.stringify(currentGrant) === JSON.stringify(borrowed)
            || matchOwningAccount(provider, rows, currentGrant)?.id === row.id)
          return Promise.resolve(testLeft ? snapshot : current)
        })
        if (superseded()) return takeover
        if (this.persistenceRefused(capability)) return shutdown
      }
    } catch (error) {
      // The store still holds what the re-read saw: keep the owner map on
      // that record rather than claiming the pre-test account (I2).
      if (!superseded()) this.reconcileProjectionOwner(provider, live)
      const message = `The credential projection at ${key} could not be restored after the test: ${error instanceof Error ? error.message : String(error)}`
      this.pushWarning(message)
      return message
    }
    if (superseded()) return takeover
    this.reconcileProjectionOwner(provider, left)
    return undefined
  }

  /**
   * Point the owner map at the OAuth row the stored record identifies.
   *
   * The argument is the live record, not its grant payload (PR review round 8):
   * a payload-only signature cannot tell a removed projection from a PRESENT
   * record this pool cannot interpret (a native api-key, an unrecognized
   * payload), so a surviving native record reached this method as `undefined`,
   * cleared the foreign marker, and `keyPoolServes` then let the window-end
   * sync bind the broker over it. Only an absent record is a confirmed removal
   * (I-000167); a present record no row owns keeps the route foreign (round 3).
   */
  private reconcileProjectionOwner(provider: string, live: CredentialRecordLike | undefined): void {
    if (live === undefined) {
      this.activeAccounts.delete(provider)
      // A confirmed absence: the foreign marker must clear with the owner, or
      // `keyPoolServes` keeps the surviving pool unbound forever (I-000167).
      this.foreignProjections.delete(provider)
      return
    }
    const rows = this.store.provider(provider)?.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null) ?? []
    const owner = live.kind === 'grant' && isOAuthGrantPayload(live.payload)
      ? matchOwningAccount(provider, rows, live.payload)
      : undefined
    if (owner !== undefined) {
      this.claimProjectionOwner(provider, owner.id)
      return
    }
    this.activeAccounts.delete(provider)
    // Present but not a managed grant: a native api-key or an unowned grant
    // still serves the route ahead of any broker reference.
    this.foreignProjections.add(provider)
  }

  /**
   * Persist one authoritative rotated grant payload for a row: write the
   * plugin-scope record for the rotated generation, then hand the commit to
   * {@link commitGrantGeneration} — the same tail {@link reconcileGrantRecord}
   * performs. The caller runs inside the provider's grant chain and owns the
   * decision, including the echo-specific generation guards, so only the
   * write-back semantics live here.
   */
  private async writeBackRotation(
    provider: string,
    row: KeyRecord,
    payload: OAuthGrantPayload,
    capability?: RestoreCapability,
    stillCurrent?: () => boolean,
  ): Promise<void> {
    const records = this.credentialRecords()
    if (records === undefined) throw new Error('The credential store does not support records')
    if (row.oauth === null) throw new Error(`Key "${row.id}" is not an OAuth account`)
    // PR review round 38: this helper's three steps are separated by awaits, so
    // both gates are read again at each of them. A superseded attempt may not
    // write the rotated record, and shutdown refuses the persistence outright
    // rather than only at the commit below.
    if (this.persistenceRefused(capability) || (stillCurrent !== undefined && !stillCurrent())) {
      throw new Error('Keys Manager is shutting down or the test cleanup was superseded')
    }
    const hash = createHash('sha256').update(payload.refresh).digest('hex').slice(0, 12)
    const rotatedRef = accountRef(provider, hash)
    // PR review round 39: the seam may park this call before it invokes the
    // updater, so the gates are read inside the updater itself — a write
    // decided before shutdown/supersession must not land after them.
    let written = false
    await records.modifyRecord(rotatedRef, async () => {
      if (this.persistenceRefused(capability) || (stillCurrent !== undefined && !stillCurrent())) return undefined
      written = true
      return { kind: 'grant', payload: structuredClone(payload) }
    })
    if (!written) throw new Error('Keys Manager is shutting down or the test cleanup was superseded')
    // PR review round 35: the write above is an await, and the commit below is
    // the persisted state write that follows it. Round 36: only the restore
    // holding the pre-close capability may continue past shutdown entry.
    if (this.persistenceRefused(capability) || (stillCurrent !== undefined && !stillCurrent())) {
      throw new Error('Keys Manager is shutting down or the test cleanup was superseded')
    }
    await this.commitGrantGeneration(provider, row, payload, rotatedRef, stillCurrent, capability)
  }

  /**
   * The single owner of `row.oauth.grantRef` semantics (QC N1): point the row
   * at the record holding its rotated generation, merge the refresh-derived
   * identity fields, and remove the superseded record. Both the echo
   * reconciler and the connection test's rotation write-back commit through
   * here, so the ref scheme, the identity merge and the cleanup policy have
   * exactly one implementation.
   *
   * The record write stays with the caller: the reconciler must revalidate the
   * row between that write and this commit (C6-1), so only the tail is shared.
   */
  private async commitGrantGeneration(
    provider: string,
    owner: KeyRecord,
    payload: OAuthGrantPayload,
    rotatedRef: string,
    guard?: () => boolean,
    capability?: RestoreCapability,
  ): Promise<void> {
    // PR review round 38: the rotation write that precedes this call is an
    // await. An attempt superseded meanwhile must not repoint the row or delete
    // the record it would find here — that record may be a newer window's
    // already-committed generation — and shutdown must refuse both writes even
    // when it began after the caller's own check.
    if (this.persistenceRefused(capability) || (guard !== undefined && !guard())) return
    const current = owner.oauth
    if (current === null) return
    const previousRef = current.grantRef
    owner.oauth = {
      ...current,
      ...(previousRef === rotatedRef ? {} : { grantRef: rotatedRef }),
      ...(payload.email === undefined ? {} : { email: payload.email }),
      ...(payload.accountId === undefined ? {} : { accountId: payload.accountId }),
      ...(typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? { expiresAt: payload.expires } : {}),
    }
    if (previousRef !== rotatedRef) {
      // The row repoint above is synchronous, but the delete is a second write:
      // re-read both gates immediately before it so a shutdown or a takeover
      // that landed in between cannot remove a record this attempt never owned.
      if (this.persistenceRefused(capability) || (guard !== undefined && !guard())) {
        this.store.touch()
        return
      }
      const records = this.credentialRecords()
      try {
        if (records === undefined) throw new Error('The credential store does not support records')
        await records.deleteRecord(previousRef)
      } catch (error) {
        this.warn(`cleanup of the superseded grant record failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.store.touch()
  }

  /**
   * Send the minimal request under the given scope and map its terminal
   * chunk. A thrown error or the 20-second abort is reported, never swallowed.
   */
  private async runTestRequest(provider: string, model: string, scope: RequestScope): Promise<KeyTestResult> {
    const started = Date.now()
    const signal = AbortSignal.timeout(KEY_TEST_TIMEOUT_MS)
    try {
      const outcome = await this.als.run(scope, async () => {
        const stream = this.ctx.llm.stream({
          provider,
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 1,
          signal,
        })
        for await (const chunk of stream) {
          if (chunk.type !== 'finish') continue
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            const failure = chunk.reason?.failure
            return { ok: false, error: failure?.message ?? failure?.code ?? 'The provider reported a failure' }
          }
          // PR review SF3 + round 8: only a real completion is a pass. The ping
          // asks for one token, so `length` is the expected completion; a
          // finish chunk with NO reason, `aborted`, or any kind this broker
          // does not know means the provider did not answer, so reporting a
          // pass would claim a credential it never served.
          if (kind === 'stop' || kind === 'length' || kind === 'toolUse') {
            // PR review round 42: a successful ping only proves the route
            // answered. An api-key row test must also prove the pinned literal
            // was the credential that served it — a takeover during the stream
            // would otherwise be reported as this key's success.
            if (scope.keyId !== null && scope.oauthAccountId === null && scope.keyUsed !== true) {
              return { ok: false, error: `The ${provider} route was served by another credential source; the selected key was not used.` }
            }
            return { ok: true }
          }
          if (kind === undefined) return { ok: false, error: 'The provider returned no completion reason' }
          return { ok: false, error: kind === 'aborted' ? 'The request was aborted' : `The request ended with "${kind}"` }
        }
        return { ok: false, error: 'The provider returned no result' }
      })
      return { ...outcome, latencyMs: Date.now() - started }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: isTestTimeoutAbort(error, signal) ? `Timed out after ${KEY_TEST_TIMEOUT_LABEL}` : error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Demote the cascade to the key pool by deleting the projection record:
   * pi-ai's per-request resolution prefers the stored credential and only
   * falls through to the broker `apiKeyEnv` when none is stored
   * (research, resolve.js:26-55).
   *
   * Recovery is deliberately manual: the cooled account stays demoted until
   * the user re-activates it or signs in again. An automatic re-activation
   * on cooldown expiry would replay the failing grant every request; the
   * user (who can see whether the account recovered upstream) is the
   * arbiter. `fallbackToKeys` marks every account row value-missing so the
   * live arbitration — projection presence plus probe fail-skip over a
   * kind-agnostic cursor ring — keeps serving only real candidates.
   *
   * `accountId` names the row whose failure triggers this demotion (R7-MF).
   * It is resolved when the queued body runs, so the demotion deletes only a
   * projection that still belongs to THAT row: activating another account
   * while the failing request is in flight must not lose the new account's
   * healthy projection.
   *
   * R14-M3: the targetless form (omitted `accountId`) is TEST-ONLY. It
   * resolves the provider's active account when the queued body runs — the
   * same execution-time race R7-MF removed from the failure path — so it is
   * kept only because the tests drive the demotion without a failure event.
   * Production callers must name the row; the failure path always passes
   * `key.id`.
   */
  fallbackToKeys(provider: string, accountId?: string): Promise<void> {
    return this.run(() => this.fallbackToKeysUnqueued(provider, accountId))
  }

  /**
   * Atomic decide-and-delete of the `llm-pi-ai/<provider>` projection for one
   * row (round-3 finding 1): the payload compare runs INSIDE the credential
   * seam's per-key lock — `modifyRecord` hands `mutate` the record as it
   * stands while the write is exclusive, so a native sign-in that already
   * replaced the projection is visible here and the delete is skipped. The
   * seam exposes no delete-inside-modify primitive: a `mutate` may only
   * return a replacement or `undefined` (leave untouched), and calling
   * `deleteRecord` inside the mutate would deadlock the provider's own
   * serialized operation queue (credentials-local `enqueue`). The closest
   * equivalent — the exact primitives this method uses — are a decide-only
   * modify (returns `undefined`, no write) and a second pre-delete re-read
   * against the decided-against snapshot ({@link projectionStillMatches},
   * F2 step-1 hardening): a native writer landing between the decide and
   * the delete is therefore visible before the delete runs, and its grant
   * survives. The residual window is the sub-microtask gap between the
   * re-read releasing the lock and the delete's own queue entry; a native
   * writer landing there is still deleted, because closing that gap needs a
   * compare-and-delete primitive the seam does not expose (store issue
   * I-000090). `tests/host.test.ts` ("a native grant landing after the final
   * comparison is still lost") pins that exact outcome so the seam fix has a
   * test to flip.
   *
   * This is the only delete authority: a natively replaced grant — another
   * account signed in, a native api-key record, an unrecognized payload —
   * never matches and must survive the demotion of a stale row, and the
   * async hydration window must not decide ownership (round-2 review,
   * steps 1–2).
   */
  private async decideAndDeleteProjection(provider: string, row: KeyRecord): Promise<boolean> {
    if (row.kind !== 'oauth' || row.oauth === null) return false
    const records = this.credentialRecords()
    if (records === undefined) return false
    const accounts = this.store.provider(provider)?.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null) ?? []
    const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    let owns = false
    let decidedAgainst: string | undefined
    await records.modifyRecord(projectionKey, async current => {
      owns = current !== undefined && current.kind === 'grant'
        && isOAuthGrantPayload(current.payload)
        && matchOwningAccount(provider, accounts, current.payload)?.id === row.id
      // The decided-against payload snapshot (in-memory JSON, never logged
      // or persisted): the pre-delete re-read below skips the removal when
      // the live record no longer holds exactly this content.
      if (owns && current !== undefined) decidedAgainst = JSON.stringify(current.payload)
      // Decide only: the removal goes through deleteRecord below, outside
      // the mutate (see the primitive note above).
      return undefined
    })
    if (!owns) return false
    // F2 (step-1 removal window): re-read the live record under the seam's
    // per-key lock immediately before the delete and skip when a native
    // grant landed between the decide and the delete. Residual window,
    // documented honestly: the seam exposes no delete-inside-modify
    // primitive (a mutate may only return a replacement or undefined, and
    // deleteRecord inside the mutate would deadlock the provider's
    // serialized operation queue), so a native writer landing between THIS
    // re-read releasing the lock and the delete's own queue entry can still
    // lose its grant. That writer is the next writer's grant, and the
    // ownership oracle re-identifies it on the record-updated echo.
    if (!await this.projectionStillMatches(records, projectionKey, decidedAgainst)) return false
    // Mark BEFORE the delete: the deletion's echo handler reads this
    // marker across its own awaited record re-read, whenever that
    // continuation resumes. The TTL window — not scheduling order —
    // decides how long the marker stays trustworthy.
    const markedAt = Date.now()
    this.intentionalProjectionRemovals.set(provider, markedAt)
    try {
      await records.deleteRecord(projectionKey)
    } catch (error) {
      // R7-SF2: a delete that threw removed nothing, so no own-removal echo
      // is coming. Revoke this call's marker before rethrowing — left in
      // place it would consume a genuine out-of-band removal as the
      // manager's own for the whole TTL, hiding the warning, the missing
      // mark, and the stale owner cleanup. The identity check keeps a newer
      // marker (there is none on the serialized mutation queue) untouched.
      // R14-SF2: seam assumption — the throwing delete may have removed the
      // record before throwing; the later echo is then read as external
      // (warning + stale-owner drop), the conservative direction over
      // masking a genuine out-of-band removal.
      if (this.intentionalProjectionRemovals.get(provider) === markedAt) {
        this.intentionalProjectionRemovals.delete(provider)
      }
      throw error
    }
    return true
  }

  /**
   * F2 pre-delete re-read, shared by the demotion and harvest-compensation
   * decide-then-delete pairs: `true` while the live projection still holds
   * exactly the decided-against payload. Runs inside `modifyRecord`'s
   * per-key lock (the same primitive as the decide), so a native writer
   * that already replaced the record is visible here and the delete is
   * skipped instead of destroying the foreign grant. The lock is released
   * before the delete, so a writer landing in that final gap is still lost:
   * closing it needs the seam's compare-and-delete (store issue I-000090).
   */
  private async projectionStillMatches(
    records: CredentialRecordsLike,
    projectionKey: string,
    decidedAgainst: string | undefined,
  ): Promise<boolean> {
    if (decidedAgainst === undefined) return false
    let liveMatches = false
    await records.modifyRecord(projectionKey, async current => {
      liveMatches = current !== undefined && current.kind === 'grant'
        && JSON.stringify(current.payload) === decidedAgainst
      return undefined
    })
    return liveMatches
  }

  /**
   * The fallback body; callers own the mutation queue. `target` narrows the
   * ownership check to one explicit row: removal call sites pass the removed
   * row object, the failure path passes the failing row's id (R7-MF) — an
   * id is re-resolved here because the failure's demotion is queued and the
   * row object may be detached by the time it runs. Without a target the
   * provider's active account decides.
   */
  private async fallbackToKeysUnqueued(provider: string, target?: KeyRecord | string): Promise<void> {
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return
    const activeId = this.activeAccounts.get(provider)
    const resolveOAuthRow = (candidate: KeyRecord | undefined): KeyRecord | undefined =>
      candidate !== undefined && candidate.kind === 'oauth' && candidate.oauth !== null ? candidate : undefined
    const active = resolveOAuthRow(typeof target === 'string'
      ? providerRecord.keys.find(candidate => candidate.id === target)
      : target ?? (activeId === undefined
        ? undefined
        : providerRecord.keys.find(candidate => candidate.id === activeId)))
    // Ownership-verified delete: demote the projection only while it still
    // belongs to this row. The compare runs inside the seam's per-key lock
    // and the delete follows it (decideAndDeleteProjection, round-3
    // finding 1) — both inside this mutation.
    const ownsProjection = active !== undefined && await this.decideAndDeleteProjection(provider, active)
    if (ownsProjection) {
      // Full cascade demotion: no pool row serves the route anymore, so
      // every account row is demoted until re-activation. The owner entry
      // must go too (round-3 finding 4): oauthOwnerFor otherwise keeps
      // naming this row, so the client renders "Serving provider" next to
      // the missing pill and leaves "Set active" disabled — the documented
      // re-activation path unreachable until a restart or a new sign-in.
      this.activeAccounts.delete(provider)
      this.foreignProjections.delete(provider)
      for (const row of providerRecord.keys) {
        if (row.kind === 'oauth') row.valueMissing = true
      }
    } else if (active !== undefined && activeId === active.id) {
      // The projection is not ours anymore (native replacement): keep the
      // stale owner entry from routing attribution or demotion at this row.
      this.activeAccounts.delete(provider)
      // …and the replacement still serves ahead of the pool (round 3).
      this.foreignProjections.add(provider)
    }
    // The projection row is gone: a surviving key pool is the serving source
    // again, and a route with no API-key row stays unbound.
    await this.syncBrokerBinding(provider)
    this.store.touch()
  }

  /**
   * Drop one OAuth account's plugin-scope grant payload and — only while
   * this row still owns the live projection — demote the cascade to the key
   * pool first, so the route falls through to the API-key pool instead of
   * serving a grant whose owning row is gone. The demotion re-reads
   * `llm-pi-ai/<provider>` inside this mutation and runs it through the
   * ownership oracle ({@link matchOwningAccount}); a natively replaced
   * projection (another account signed in, a native api-key record) is left
   * untouched. Non-oauth rows are a no-op; every OAuth-removal call site
   * goes through this helper.
   */
  private async removeOAuthGrant(provider: string, row: KeyRecord): Promise<void> {
    if (row.kind !== 'oauth' || row.oauth === null) return
    // C6-1/I1: mark the row BEFORE the first awaited delete. A release
    // deletes every row's credential before it deletes the provider record
    // and never splices the rows, so from the first delete onward the row
    // object is no longer a truthful "still serving" signal; the reconciler
    // consults this mark instead (see accountRowStillCurrent).
    this.retiringAccounts.add(row)
    try {
      await this.fallbackToKeysUnqueued(provider, row)
      const records = this.credentialRecords()
      if (records !== undefined) await records.deleteRecord(row.oauth.grantRef)
    } catch (error) {
      // Round-7 minor: a throwing awaited step aborts the removal — the
      // callers rethrow before splicing the row or releasing the provider —
      // so the row is still live and still managed. Clear the mark or the
      // row would stay permanently retired and its rotation echoes would be
      // skipped until a restart. A retried removal re-marks before its own
      // first delete, and a successful removal never reaches this path.
      this.retiringAccounts.delete(row)
      throw error
    }
  }

  /**
   * Drop one account: its plugin-scope grant payload, its row, and — when
   * it was the active projection — the projection itself, so the route
   * falls back to the key pool.
   */
  removeAccount(provider: string, accountId: string): Promise<StateView> {
    return this.run(() => this.withRemovalInProgress(provider, async () => {
      // R8-2: the removal decides against the route's live records, so it must
      // not run inside a row test's borrow window.
      await this.settleTestBeforeRemoval(provider)
      const providerRecord = this.store.provider(provider)
      if (providerRecord === undefined) throw new Error(`Provider "${provider}" is not managed`)
      const index = providerRecord.keys.findIndex(candidate => candidate.id === accountId)
      if (index < 0) throw new Error(`Account "${accountId}" not found on ${provider}`)
      const row = providerRecord.keys[index]!
      if (row.kind !== 'oauth' || row.oauth === null) throw new Error(`Key "${accountId}" is not an OAuth account; use deleteKey`)
      await this.removeOAuthGrant(provider, row)
      providerRecord.keys.splice(index, 1)
      this.store.clearBindings((_key, binding) => binding.keyId === row.id)
      this.store.touch()
      return this.buildState()
    }))
  }

  /** Install the broker layer on one credential provider instance. */
  attachCredentials(credentials: CredentialsLike): void {
    const raw = ((credentials as CredentialsLike & Record<PropertyKey, unknown>)[ORIGINAL] as CredentialsLike | undefined) ?? credentials
    if (this.credentialWrappers.has(raw)) return
    const original: CredentialOriginals = {
      resolve: raw.resolve,
      describe: raw.describe,
      set: raw.set,
      unset: raw.unset,
    }
    const service = this
    const wrappers: CredentialWrappers = {
      resolve: async (ref: string): Promise<CredentialHit | undefined> => {
        const owner = service.brokerOwners.get(ref)
        if (owner === undefined) return original.resolve.call(raw, ref)
        const active = service.als.getStore()
        if (active !== undefined && active.provider === owner) {
          if (typeof active.keyValue === 'string' && active.keyValue.length > 0) {
            active.keyUsed = true
            return { value: active.keyValue, source: 'keys-manager' }
          }
          return undefined
        }
        // Listing models has no request scope; answer from any stored key
        // without moving the session cursor or changing health.
        const provider = service.store.provider(owner)
        if (provider !== undefined) {
          const now = Date.now()
          for (const key of provider.keys) {
            if (key.ref.length === 0 || !isSelectable(key, now)) continue
            const hit = await original.resolve.call(raw, key.ref)
            if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
              return { ...hit, source: 'keys-manager' }
            }
          }
        }
        return undefined
      },
      describe: async (ref: string) => {
        const owner = service.brokerOwners.get(ref)
        if (owner === undefined) return original.describe.call(raw, ref)
        const provider = service.store.provider(owner)
        const configured = provider !== undefined && provider.keys.length > 0
        return {
          configured,
          ...(configured ? { source: 'keys-manager' } : {}),
          writable: false,
        }
      },
      set: async (ref: string, value: string) => {
        if (service.brokerOwners.has(ref)) {
          throw new Error('This provider key is managed by Keys Manager; edit it on the plugin detail page')
        }
        return original.set.call(raw, ref, value)
      },
      unset: async (ref: string) => {
        if (service.brokerOwners.has(ref)) {
          throw new Error('This provider key is managed by Keys Manager; edit it on the plugin detail page')
        }
        return original.unset.call(raw, ref)
      },
    }
    raw.resolve = wrappers.resolve
    raw.describe = wrappers.describe
    raw.set = wrappers.set
    raw.unset = wrappers.unset
    this.credentialOriginals.set(raw, original)
    this.credentialWrappers.set(raw, wrappers)
    if (this.rawCredentials === undefined) this.rawCredentials = raw
    // A remount replaces the credential backend (PR review round 27): every
    // projection fact loaded so far describes the previous store, so drop the
    // classification and restart the ownership read before repairing. The
    // first mount is startup, whose fresh maps need no invalidation.
    if (this.credentialsMounted) this.invalidateProjectionOwnership()
    this.credentialsMounted = true
    // The credentials service can mount after this plugin (PR review round 23):
    // the load-time hydration then read nothing and left ownership unknown, so
    // the startup repair bound nothing. Re-read the projections now that the
    // record half is reachable, then repair — the same convergence as startup,
    // idempotent when the seam was mounted all along. The read lands through
    // {@link noteProviderHydrated}, so a repair already waiting wakes with it.
    this.projectionHydration = this.hydrateProjectionOwnership()
    void this.repairBrokerBindings().catch(error => {
      this.warn(`broker binding repair after the credentials mount failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Restore the credential provider methods when our fiber unloads. */
  detachCredentials(credentials: CredentialsLike): void {
    const raw = ((credentials as CredentialsLike & Record<PropertyKey, unknown>)[ORIGINAL] as CredentialsLike | undefined) ?? credentials
    const wrappers = this.credentialWrappers.get(raw)
    const original = this.credentialOriginals.get(raw)
    if (wrappers === undefined || original === undefined) return
    if (raw.resolve === wrappers.resolve) raw.resolve = original.resolve
    if (raw.describe === wrappers.describe) raw.describe = original.describe
    if (raw.set === wrappers.set) raw.set = original.set
    if (raw.unset === wrappers.unset) raw.unset = original.unset
    this.credentialWrappers.delete(raw)
    this.credentialOriginals.delete(raw)
    if (this.rawCredentials === raw) this.rawCredentials = undefined
  }

  /** Resolve a credential through the unwrapped provider. */
  private async resolveOriginal(ref: string): Promise<CredentialHit | undefined> {
    if (!isCredentialRefName(ref)) return undefined
    const raw = this.credentialsRaw()
    if (raw === undefined) return undefined
    const original = this.credentialOriginals.get(raw)
    const resolve = original?.resolve ?? raw.resolve
    try {
      return await resolve.call(raw, ref)
    } catch {
      return undefined
    }
  }

  /**
   * Probe one credential reference while distinguishing absence from a
   * transient credential-store failure. Selection must never persist a
   * permanent `valueMissing` marker for an error.
   */
  private async probeKey(ref: string): Promise<KeyProbe> {
    if (!isCredentialRefName(ref)) return { missing: false, failed: true }
    const raw = this.credentialsRaw()
    if (raw === undefined) return { missing: false, failed: true }
    const original = this.credentialOriginals.get(raw)
    const resolve = original?.resolve ?? raw.resolve
    try {
      const hit = await resolve.call(raw, ref)
      if (hit === undefined || typeof hit.value !== 'string' || hit.value.length === 0) {
        return { missing: true, failed: false }
      }
      return { hit, missing: false, failed: false }
    } catch {
      return { missing: false, failed: true }
    }
  }

  /** Write one key literal through the unwrapped provider. */
  private async setOriginal(ref: string, value: string): Promise<void> {
    const raw = this.credentialsRaw()
    if (raw === undefined) throw new Error('The credential store is unavailable')
    const original = this.credentialOriginals.get(raw)
    const set = original?.set ?? raw.set
    await set.call(raw, ref, value)
  }

  /**
   * Remove one key literal through the unwrapped provider. A rejected unset is
   * only ignored when the credential is confirmed absent; a transient or
   * permission failure must keep the metadata so a later retry can finish.
   */
  private async unsetOriginal(ref: string): Promise<void> {
    if (!isCredentialRefName(ref)) return
    const raw = this.credentialsRaw()
    if (raw === undefined) throw new Error('The credential store is unavailable')
    const original = this.credentialOriginals.get(raw)
    const unset = original?.unset ?? raw.unset
    try {
      await unset.call(raw, ref)
    } catch (error) {
      const probe = await this.probeKey(ref)
      if (probe.missing) return
      throw new Error(`Could not remove credential ${ref}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** All settings descriptors, with an explicit unreadable state. */
  private describeSettings(): SettingsSnapshot {
    const settings = this.settingsService()
    if (settings === undefined) return { writable: false, namespaces: [], readable: false }
    try {
      return { writable: settings.writable !== false, namespaces: settings.describe({ redactSecrets: true }), readable: true }
    } catch (error) {
      this.warn(`settings describe failed: ${error instanceof Error ? error.message : String(error)}`)
      return { writable: false, namespaces: [], readable: false }
    }
  }

  /** Find one live settings descriptor by entry id. */
  private namespace(descriptor: { namespaces: SettingsDescriptorLike[] }, ns: string): SettingsDescriptorLike | undefined {
    return descriptor.namespaces.find(entry => entry.ns === ns)
  }

  /**
   * Apply one path-addressed settings write through the live revision.
   *
   * `stillWrites` runs after the descriptor re-read and immediately before the
   * mutation: a decision derived from an earlier snapshot can be stale by then
   * ({@link syncBrokerBinding}'s bind gate, PR review round 25). A declining
   * guard skips the write and reports it.
   */
  private async mutateSettings(
    ns: string,
    ops: readonly SettingsPathOp[],
    stillWrites?: () => boolean,
  ): Promise<boolean> {
    const settings = this.settingsService()
    if (settings === undefined) throw new Error('Settings are unavailable in this composition')
    if (settings.writable === false) throw new Error('The active profile is read-only')
    let descriptor: SettingsDescriptorLike | undefined
    try {
      descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === ns)
    } catch (error) {
      throw new Error(`Cannot read settings: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (descriptor === undefined) throw new Error(`Settings namespace "${ns}" is not mounted`)
    if (stillWrites !== undefined && !stillWrites()) return false
    await settings.mutate(ns, ops, descriptor.revision)
    return true
  }

  /** Prune expired bindings at most once a minute, without a restart. */
  private pruneBindings(now: number): void {
    if (now - this.lastBindingPruneAt < 60_000) return
    this.lastBindingPruneAt = now
    this.store.pruneBindings(now)
    this.pruneAttempts(now)
  }

  /**
   * Project one provider's unattributed-request count into its row. Additive
   * and optional (`I-000120`): a row with no count spreads nothing, so an
   * older snapshot and a healthy store render exactly as before.
   */
  private unattributedView(provider: string): { unattributedRequests?: number } {
    const count = this.unattributedRequests.get(provider) ?? 0
    return count > 0 ? { unattributedRequests: count } : {}
  }

  /** Build the complete UI state. */
  buildState(): StateView {
    const now = Date.now()
    this.pruneBindings(now)
    const descriptor = this.describeSettings()
    const directory = this.ctx.llm.listConfigurableProviders()
    const active = new Set(this.ctx.llm.listProviders().map(provider => provider.id))
    const views: ProviderView[] = []
    const seen = new Set<string>()

    for (const entry of directory) {
      if (entry.provider === 'deepseek-account' || entry.settingsNs === 'deepseek-account' || entry.provider.startsWith('deepseek-account')) continue
      const namespace = this.namespace(descriptor, entry.settingsNs)
      const profile = namespace === undefined ? undefined : asProfile(getPath(namespace.value, entry.settingsPath))
      const managed = this.store.provider(entry.provider)
      const extra = EXTRA_PROVIDER_MAP.get(entry.provider)
      const oauthFlow = this.oauthFlowAvailable(entry.provider)
      const caps = capabilityOf(entry, profile, oauthFlow)
      const support: ProviderSupport = { supported: caps.keys, ...(caps.reason === undefined ? {} : { reason: caps.reason }) }
      const accountSupport = accountSupportOf(entry, oauthFlow)
      const apiKeyEnv = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : null
      const binding = managed === undefined ? undefined : this.bindingState(managed, descriptor)
      const bindingHealthy = binding === 'healthy' ? true : binding === 'mismatch' ? false : undefined
      const projectedAccountId = managed === undefined ? null : this.oauthOwnerFor(managed.provider)
      const keys = managed !== undefined ? managed.keys.map(key => publicKey(key, now, projectedAccountId)) : []
      const warning = binding === 'mismatch'
        ? 'The provider profile no longer points at Keys Manager. Re-adopt it after releasing it, or repair the provider in Models.'
        : undefined
      const models = profile !== undefined ? normalizeModels(profile.models) : extra?.models ?? managed?.models ?? []
      views.push({
        provider: entry.provider,
        displayName: extra?.name ?? entry.displayName ?? entry.provider,
        source: extra !== undefined ? 'extra' : 'dsh',
        origin: extra !== undefined ? 'plugin' : entry.declared === true ? 'custom' : 'dsh',
        managed: managed !== undefined,
        createdProfile: managed?.createdProfile ?? false,
        configured: active.has(entry.provider) || profile !== undefined,
        active: active.has(entry.provider),
        supported: support.supported,
        ...(support.reason === undefined ? {} : { reason: support.reason }),
        accountSupported: accountSupport.supported,
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        apiKeyEnv,
        brokerRef: managed?.brokerRef ?? null,
        ...(bindingHealthy === undefined ? {} : { bindingHealthy }),
        extra: extra !== undefined,
        extraId: extra?.id ?? managed?.extraId ?? null,
        api: (profile?.api as string | undefined) ?? extra?.api ?? managed?.api ?? null,
        baseURL: (profile?.baseURL as string | undefined) ?? extra?.baseURL ?? entry.defaultBaseURL ?? managed?.baseURL ?? null,
        env: [...(extra?.env ?? entry.nativeAuth?.env ?? [])],
        defaultBaseURL: entry.defaultBaseURL ?? extra?.baseURL ?? null,
        nativeAuth: entry.nativeAuth === undefined ? null : { env: [...entry.nativeAuth.env], oauth: entry.nativeAuth.oauth },
        models,
        keyCount: keys.length,
        healthyKeyCount: keys.filter(key => key.status === 'active').length,
        status: managed !== undefined ? statusOfProvider(managed.keys, now) : 'unmanaged',
        keys,
        ...(warning === undefined ? {} : { warning }),
        ...this.unattributedView(entry.provider),
      })
      seen.add(entry.provider)
    }

    for (const extra of EXTRA_PROVIDERS) {
      if (seen.has(extra.id)) continue
      const managed = this.store.provider(extra.id)
      const binding = managed === undefined ? undefined : this.bindingState(managed, descriptor)
      const projectedAccountId = managed === undefined ? null : this.oauthOwnerFor(managed.provider)
      const keys = managed !== undefined ? managed.keys.map(key => publicKey(key, now, projectedAccountId)) : []
      views.push({
        provider: extra.id,
        displayName: extra.name,
        source: 'extra',
        origin: 'plugin',
        managed: managed !== undefined,
        createdProfile: managed?.createdProfile ?? false,
        configured: managed !== undefined,
        active: false,
        supported: true,
        // Extra providers are key-pool routes; they offer no OAuth flow.
        accountSupported: false,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', extra.id],
        apiKeyEnv: managed?.brokerRef ?? null,
        brokerRef: managed?.brokerRef ?? null,
        ...(binding === 'healthy' ? { bindingHealthy: true } : binding === 'mismatch' ? { bindingHealthy: false } : {}),
        extra: true,
        extraId: extra.id,
        api: extra.api,
        baseURL: extra.baseURL,
        env: [...extra.env],
        defaultBaseURL: extra.baseURL,
        nativeAuth: null,
        models: extra.models,
        keyCount: keys.length,
        healthyKeyCount: keys.filter(key => key.status === 'active').length,
        status: managed !== undefined ? statusOfProvider(managed.keys, now) : 'unmanaged',
        keys,
        ...(managed === undefined ? {} : { warning: 'This extra provider is managed but its pi-ai route is not registered. Check the provider profile in Models.' }),
        ...this.unattributedView(extra.id),
      })
      seen.add(extra.id)
    }

    for (const managed of Object.values(this.store.providers)) {
      if (seen.has(managed.provider)) continue
      const projectedAccountId = this.oauthOwnerFor(managed.provider)
      const keys = managed.keys.map(key => publicKey(key, now, projectedAccountId))
      const binding = this.bindingState(managed, descriptor)
      views.push({
        provider: managed.provider,
        displayName: managed.displayName,
        source: managed.source,
        origin: managed.source === 'extra' ? 'plugin' : 'custom',
        managed: true,
        createdProfile: managed.createdProfile,
        configured: false,
        active: false,
        supported: true,
        accountSupported: false,
        settingsNs: managed.settingsNs,
        settingsPath: [...managed.settingsPath],
        apiKeyEnv: managed.brokerRef,
        brokerRef: managed.brokerRef,
        ...(binding === 'healthy' ? { bindingHealthy: true } : binding === 'mismatch' ? { bindingHealthy: false } : {}),
        extra: managed.source === 'extra',
        extraId: managed.extraId,
        api: managed.api,
        baseURL: managed.baseURL,
        env: [],
        defaultBaseURL: managed.baseURL,
        nativeAuth: null,
        models: managed.models,
        keyCount: keys.length,
        healthyKeyCount: keys.filter(key => key.status === 'active').length,
        status: statusOfProvider(managed.keys, now),
        keys,
        warning: 'This provider route is not currently registered. Check its profile in Models.',
        ...this.unattributedView(managed.provider),
      })
      seen.add(managed.provider)
    }

    views.sort((a, b) => {
      if (a.managed !== b.managed) return a.managed ? -1 : 1
      if (a.configured !== b.configured) return a.configured ? -1 : 1
      if (a.source !== b.source) return a.source === 'extra' ? 1 : -1
      return a.displayName.localeCompare(b.displayName) || a.provider.localeCompare(b.provider)
    })

    const allKeys = views.flatMap(view => view.keys)
    const warnings = this.takeWarnings()
    if (this.store.loadError !== undefined) warnings.unshift(`State file could not be read; started fresh (${this.store.loadError})`)
    if (descriptor.writable === false) warnings.push('The active profile is read-only; key changes cannot be saved.')
    return {
      now,
      writable: descriptor.writable && !this.store.readOnly,
      settings: { ...normalizeSettings(this.store.settings) },
      providers: views,
      managedCount: views.filter(view => view.managed).length,
      keyCount: allKeys.length,
      healthyKeyCount: allKeys.filter(key => key.status === 'active').length,
      coolingKeyCount: allKeys.filter(key => key.status === 'cooling').length,
      pausedKeyCount: allKeys.filter(key => key.status === 'paused').length,
      bindingsCount: Object.keys(this.store.state.sessionBindings).length,
      warnings,
      transportAccounts: this.transportRows.map(row => ({ ...row })),
    }
  }

  /**
   * Remote: complete manager state.
   *
   * The transport rows come from another package's records, and reading them
   * is async while this endpoint is synchronous, so every poll starts a
   * refresh for the next one (the client ticks every 30 s), unless one is
   * already in flight. The constructor warms the first read and record
   * updates refresh immediately, so the one-tick lag only shows on a cold
   * start.
   */
  getState(): StateView {
    this.refreshTransportAccountsIfIdle()
    return this.buildState()
  }

  /** Find one directory entry by route id. */
  private directoryEntry(provider: string): DirectoryEntry | undefined {
    return this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
  }

  /**
   * Whether the key pool is the credential source that serves this route: no
   * OAuth projection owns it and at least one API-key row still holds a value.
   * This is the one arbiter for both the verdict below and the binding write
   * ({@link syncBrokerBinding}).
   */
  private keyPoolServes(record: ProviderRecord): boolean {
    return this.oauthOwnerFor(record.provider) === null
      // A projection no managed row owns still serves ahead of the broker
      // reference: binding the pool here would take the foreign account out of
      // service (PR review round 3).
      && !this.foreignProjections.has(record.provider)
      && record.keys.some(key => key.kind === 'api-key' && key.valueMissing !== true)
  }

  /**
   * Classify the live binding. An unreadable settings snapshot is `unknown`,
   * not a confirmed mismatch: transient settings failures must not disable
   * key-pool recovery for a provider that is still managed.
   *
   * Only a value Keys Manager never wrote is a `mismatch`: the warning now
   * means "the user took the profile back", not "the OAuth route is broken".
   * An unbound profile is healthy while the key pool is not the serving
   * source (an OAuth projection serves, or no API-key row holds a value) —
   * that is the OAuth-only route's native shape.
   */
  private bindingState(record: ProviderRecord, descriptor: SettingsSnapshot = this.describeSettings()): BindingState {
    if (!descriptor.readable) {
      // Never re-enable a previously confirmed mismatch from an unreadable
      // snapshot; without evidence, leave the binding unknown.
      return this.bindingCache.get(record.provider) ?? 'unknown'
    }
    const namespace = this.namespace(descriptor, record.settingsNs)
    const profile = namespace === undefined ? undefined : asProfile(getPath(namespace.value, record.settingsPath))
    const current = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    const state: BindingState = current === record.brokerRef
      // The broker reference is Keys Manager's own value; a projection that
      // claimed the route is repaired by the binding sync, not by the user.
      ? 'healthy'
      : current !== undefined
        ? 'mismatch'
        : this.keyPoolServes(record) ? 'mismatch' : 'healthy'
    this.bindingCache.set(record.provider, state)
    return state
  }

  /**
   * The single authority for a managed provider's pi-ai `apiKeyEnv`.
   *
   * pi-ai resolves a named credential synchronously and throws
   * `MISSING_CREDENTIAL` when the credential seam cannot answer it, so the
   * broker reference may only sit on a profile whose requests the key pool
   * actually serves ({@link keyPoolServes}). Every other shape must be
   * unbound, or pi-ai never reaches its own stored OAuth grant.
   *
   * Each direction has exactly one provably owned write:
   * - bind: a profile that names no credential, or — with `takeover`, passed
   *   solely by {@link adoptProvider} — the pre-adoption reference adoption
   *   recorded and deliberately replaces;
   * - unbind: only the broker reference Keys Manager itself wrote.
   *
   * Any other value is a hand-edit (or the pre-adoption reference release
   * restored): it is never touched, and the `mismatch` verdict stays the
   * signal that the user took the profile back.
   *
   * `write: false` is the startup repair: it only touches a profile that
   * already exists, so a first run never materializes one from nothing. The
   * release direction is single-sourced in {@link releasingProviders}: a
   * provider being unmanaged is never bound again, whatever the row order of
   * the pool it is deleting.
   *
   * A read-side problem or a refused write degrades to a warning: the
   * callers' committed change must not fail on a settings problem, the user
   * still sees that the route may resolve the wrong credential source, and
   * the next repair pass retries.
   *
   * Returns whether the profile ends in the shape the serving source justifies
   * (`true` also when no write was needed). The connection test's borrow is the
   * one caller that acts on it: a failed release must refuse the test instead
   * of sending a request the wrong credential source would answer.
   *
   * While a row test borrows the route (QC B4) no caller may persist a decision
   * derived from that borrowed world — an `addKey` landing inside the window
   * would otherwise unbind the profile for good. The test's own writes pass
   * `borrow: true`; the window-end sync then writes the restored state.
   */
  private async syncBrokerBinding(
    provider: string,
    options: { takeover?: boolean; write?: boolean; borrow?: boolean; correction?: number } = {},
  ): Promise<boolean> {
    const record = this.store.provider(provider)
    if (record === undefined) return false
    // A borrow hides its world from this authority, except while the provider
    // is being unmanaged: release is a real state change, and the unbind
    // direction is already one-way there (a release that skipped it would
    // leave a dangling broker reference on a profile nothing repairs).
    if (options.borrow !== true && this.testBindingBorrows.has(provider) && !this.releasingProviders.has(provider)) {
      return false
    }
    const descriptor = this.describeSettings()
    if (!descriptor.readable) {
      // QC N3: a composition that has not mounted the settings service yet is
      // a not-yet, not a repair failure — the mount seam re-runs this pass and
      // owns the warning if the write then still fails.
      if (this.settingsService() === undefined) return false
      this.bindingWriteRefused(provider, 'the settings snapshot is unreadable')
      return false
    }
    const namespace = this.namespace(descriptor, record.settingsNs)
    if (namespace === undefined) {
      this.bindingWriteRefused(provider, `settings namespace "${record.settingsNs}" is not mounted`)
      return false
    }
    const profile = asProfile(getPath(namespace.value, record.settingsPath))
    if (options.write === false && profile === undefined) return true
    const current = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    const desired = this.keyPoolServes(record) ? record.brokerRef : undefined
    // Binding is a guess while this process cannot attribute the projection:
    // the empty owner/foreign maps otherwise read as "the pool serves" and
    // overwrite a persisted grant nobody could see (PR review round 24). The
    // unbind direction is the safe one and still runs.
    if (desired !== undefined && !this.projectionOwnershipKnown(provider)) return false
    if (current === desired) return true
    if (desired === undefined) {
      // Never strip a value Keys Manager did not write: a user hand-edit and
      // a restored pre-adoption reference look exactly like this.
      if (current !== record.brokerRef) return false
    } else {
      // Never bind over a value Keys Manager did not write — except adoption,
      // which recorded this exact pre-adoption reference to replace it.
      if (this.releasingProviders.has(provider)) return false
      if (current !== undefined && !(options.takeover === true && current === record.originalApiKeyEnv)) return false
    }
    const path = [...record.settingsPath, 'apiKeyEnv']
    // PR review round 35: the last point before the settings write. Only
    // `closing` is read: shutdown's own pre-close restoration writes here by
    // design and runs before that flag goes up.
    if (this.closing) return false
    try {
      // The entry gate above read a snapshot; ownership can turn unknown while
      // this write re-reads its descriptor (PR review round 25). Binding is a
      // guess then, so the gate closes again at the last point before the
      // mutation. Unbinding stays allowed.
      const written = await this.mutateSettings(
        record.settingsNs,
        [desired === undefined ? { op: 'unset', path } : { op: 'set', path, value: desired }],
        () => desired === undefined || this.projectionOwnershipKnown(provider),
      )
      if (!written) return false
    } catch (error) {
      this.bindingWriteRefused(provider, error instanceof Error ? error.message : String(error))
      return false
    }
    // The mutation is asynchronous, so the serving source can flip while it
    // settles: a native OAuth write classified foreign after the gates above
    // unbinds an already-unbound profile and returns, then this older bind
    // commits over that projection (PR review round 31). Each settled write
    // therefore re-derives the shape from the live source, and the correction
    // itself retries — bounded — because the source can move again while the
    // corrective write settles (PR review round 32). The counter, not a flag,
    // keeps a genuinely flapping route from cycling: past the bound the next
    // repair pass owns it.
    const correction = options.correction ?? 0
    if (correction < BINDING_CORRECTION_LIMIT) {
      // PR review round 35: the mutation above settled across an await, so the
      // corrective write it may recurse into is refused once shutdown began.
      if (this.closing) return false
      const settled = this.store.provider(provider)
      if (settled !== undefined && this.keyPoolServes(settled) !== (desired !== undefined)) {
        return this.syncBrokerBinding(provider, { ...options, correction: correction + 1 })
      }
    }
    // The profile matches the serving source now, by construction.
    this.bindingCache.set(provider, 'healthy')
    return true
  }

  /**
   * Repair every managed provider's binding through the one authority. The
   * startup pass and the settings-mount seam both run it, so a profile that
   * was unreadable when hydration settled is still healed in this process
   * instead of waiting for the next start.
   */
  private async repairBrokerBindings(): Promise<void> {
    const providers = Object.keys(this.store.providers)
    const deferred: string[] = []
    // A provider whose ownership is already known repairs first (PR review
    // round 3): one wedged OAuth read must not delay a pure key-pool route,
    // whose shape can never depend on a projection read. The skipped set is
    // carried to the second pass (PR review round 5): re-deriving readiness
    // there would drop a provider whose read landed while pass 1 awaited
    // another provider.
    for (const provider of providers) {
      if (!this.projectionOwnershipKnown(provider)) {
        deferred.push(provider)
        continue
      }
      await this.repairBinding(provider)
    }
    for (const provider of deferred) {
      // An OAuth provider whose own read has not landed is never repaired
      // from a guessed shape; the read is bounded, so a provider that never
      // answers only skips itself.
      if (!await this.awaitProjectionOwnership(provider)) continue
      await this.repairBinding(provider)
    }
  }

  /**
   * One provider's repair pass (PR review round 42). A recorded adoption
   * takeover debt is settled here only when the authoritative readiness says
   * no projection serves the route — the case a restart leaves behind when the
   * foreign record disappeared while the process was down.
   */
  private async repairBinding(provider: string): Promise<void> {
    const record = this.store.provider(provider)
    const takeover = record?.takeoverPending === true
      && !this.foreignProjections.has(provider)
      && this.oauthOwnerFor(provider) === null
    const bound = await this.syncBrokerBinding(provider, { write: false, takeover })
    if (takeover && bound && record !== undefined) {
      record.takeoverPending = false
      this.store.touch()
    }
  }

  /**
   * Re-derive a managed route's binding after its projection changed outside
   * this manager's account pool: a removal, a committed harvest that handed
   * the route back to its API-key pool (PR review round 2), or a foreign
   * projection taking a bound route over (round 4).
   *
   * The route's serving source is no longer the managed pool, or the pool is
   * the only source left: either way `syncBrokerBinding` derives the one
   * profile shape pi-ai's resolution order requires. A store refusal only
   * warns — these are compensation paths and must never fail the change that
   * triggered them; the next repair pass retries.
   */
  private async syncBindingAfterProjectionChange(provider: string): Promise<void> {
    // PR review round 30: this body is chained behind a hydration read that can
    // land after `close()` has drained the chains; the binding write it ends in
    // is persistence, so shutdown refuses it.
    if (this.closing) return
    try {
      // PR review round 40: adoption keeps the pre-adoption reference while a
      // foreign projection serves the route and records that it still owes the
      // takeover on the provider record (so the debt survives a restart). Only
      // that recorded debt lets this sync pass `takeover`, and it is cleared
      // once the bind lands; `originalApiKeyEnv` alone proves nothing.
      const record = this.store.provider(provider)
      const takeover = record?.takeoverPending === true
      const bound = await this.syncBrokerBinding(provider, { takeover })
      if (takeover && bound && record !== undefined) {
        record.takeoverPending = false
        this.store.touch()
      }
    } catch (error) {
      this.warn(`could not re-derive the pi-ai binding for ${provider} after its projection changed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * A refused binding write must not fail the change that triggered it, but
   * it cannot stay in the log alone either: the route may resolve the wrong
   * credential source until the next repair.
   */
  private bindingWriteRefused(provider: string, reason: string): void {
    this.warn(`could not update the pi-ai broker binding for ${provider}: ${reason}`)
    this.pushWarning(`The pi-ai credential reference for ${provider} was not updated (${reason}). Requests may use a different credential source until this is repaired.`)
  }

  /** Candidate credential refs from which an existing key can be imported. */
  private importRefs(entry: DirectoryEntry, profile: ProfileShape | undefined): string[] {
    const refs: string[] = []
    if (profile !== undefined && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) refs.push(profile.apiKeyEnv)
    for (const name of entry.nativeAuth?.env ?? []) {
      if (isKeyishEnv(name)) refs.push(name)
    }
    if (entry.provider === 'deepseek-official') refs.push('DEEPSEEK_API_KEY')
    refs.push(derivedKeyRef(entry.provider))
    return [...new Set(refs.filter(ref => isCredentialRefName(ref) && !ref.startsWith(BROKER_PREFIX)))]
  }

  /** Create and store one key record without adding it to a provider. */
  private async createKeyRecord(provider: string, alias: string, value: string, importedFrom: string | null = null): Promise<KeyRecord> {
    const keyRef = newKeyRef(provider)
    await this.setOriginal(keyRef, value)
    return {
      id: newKeyId(),
      alias,
      ref: keyRef,
      kind: 'api-key',
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: 0,
      cooldownUntil: 0,
      lastFailureAt: 0,
      lastFailureCode: '',
      failureLevel: 0,
      consecutiveFailures: 0,
      totalUses: 0,
      totalFailures: 0,
      valueMissing: false,
      importedFrom,
      oauth: null,
    }
  }

  /** Find the first existing key value worth importing. */
  private async findImport(entry: DirectoryEntry, profile: ProfileShape | undefined): Promise<{ ref: string; value: string } | undefined> {
    for (const ref of this.importRefs(entry, profile)) {
      const probe = await this.probeKey(ref)
      if (probe.hit !== undefined) return { ref, value: probe.hit.value }
      if (probe.failed) {
        throw new Error(`Could not read credential ${ref}; the credential store is unavailable. Try adoption again after it recovers.`)
      }
    }
    return undefined
  }

  /** Remote: take over one existing provider route. */
  adoptProvider(provider: string): Promise<StateView> {
    return this.run(async () => {
      if (typeof provider !== 'string' || provider.length === 0) throw new Error('provider is required')
      if (this.store.provider(provider) !== undefined) return this.buildState()
      const entry = this.directoryEntry(provider)
      const extra = EXTRA_PROVIDER_MAP.get(provider)
      if (entry === undefined) {
        if (extra !== undefined) throw new Error('This extra provider needs a key; add it from the extra-provider section')
        throw new Error(`Provider "${provider}" is not registered by any adapter`)
      }
      const descriptor = this.describeSettings()
      const namespace = this.namespace(descriptor, entry.settingsNs)
      if (namespace === undefined) throw new Error(`Settings namespace "${entry.settingsNs}" is not mounted`)
      const profile = asProfile(getPath(namespace.value, entry.settingsPath))
      // MF1: adoption is reachable through EITHER capability. An OAuth-only
      // route adopts with zero keys (account-only management); a key-only
      // route adopts as before; the key-pool table alone no longer blocks
      // an adoptable account route.
      const oauthFlow = this.oauthFlowAvailable(entry.provider)
      const caps = capabilityOf(entry, profile, oauthFlow)
      const accountSupport = accountSupportOf(entry, oauthFlow)
      if (!caps.keys && !accountSupport.supported) {
        throw new Error(caps.reason ?? accountSupport.reason ?? 'This provider cannot be managed')
      }
      if (entry.declared === true && profile === undefined) {
        throw new Error('Add this hand-declared provider in Models first, then adopt it here')
      }
      const brokerRef = brokerRefFor(provider)
      const collision = [...this.brokerOwners.keys()].find(ref => ref === brokerRef)
      if (collision !== undefined) throw new Error(`Broker reference collision for "${provider}"`)
      const originalApiKeyEnv = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : null
      // A read-only profile cannot carry the binding; refuse before any
      // managed state or imported credential exists.
      if (!descriptor.writable) throw new Error('The active profile is read-only')
      const hit = await this.findImport(entry, profile)
      let imported: KeyRecord | undefined
      if (hit !== undefined) imported = await this.createKeyRecord(provider, 'Imported', hit.value, hit.ref)
      const record: ProviderRecord = {
        provider,
        displayName: extra?.name ?? entry.displayName ?? provider,
        source: extra !== undefined ? 'extra' : 'dsh',
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        adapter: entry.settingsNs.includes('deepseek') || provider === 'deepseek-official' ? 'deepseek' : 'pi-ai',
        brokerRef,
        originalApiKeyEnv,
        createdProfile: false,
        hadProfile: profile !== undefined,
        extraId: extra?.id ?? null,
        api: (profile?.api as string | undefined) ?? extra?.api ?? null,
        baseURL: (profile?.baseURL as string | undefined) ?? extra?.baseURL ?? entry.defaultBaseURL ?? null,
        models: profile !== undefined ? normalizeModels(profile.models) : extra?.models ?? [],
        adoptedAt: Date.now(),
        cursor: 0,
        keys: imported !== undefined ? [imported] : [],
      }
      this.store.providers[provider] = record
      this.rebuildBrokerMap()
      // PR review round 17: this provider was not in the startup hydration
      // snapshot, so its projection is read HERE, before the first binding
      // sync. Without the read, "not in the snapshot" looked exactly like "no
      // projection" and the sync bound the pool over the route's native grant.
      let ownershipRead = await this.readAdoptionProjection(provider)
      // PR review round 28 (I-000186): a read a projection event overtook lands
      // nothing, and the reconciliation queued behind it repairs the binding
      // WITHOUT the takeover only this adoption may perform — so a superseded
      // answer left a committed adoption on its pre-adoption reference forever
      // (the pool never serves, and re-adopting returns immediately because the
      // provider is managed). The retry only reads, and the chain is drained by
      // definition once this read is its tail: the adoption waits for that
      // authoritative answer instead of committing an undecided bind.
      // No deadlock: no grant-chain body awaits the mutation queue this body holds.
      while (ownershipRead === 'superseded') ownershipRead = await this.readAdoptionProjection(provider)
      // The binding follows the serving credential, never the route's ability
      // to hold keys: an OAuth-only route (`caps.keys === false`, no key row)
      // keeps its profile unbound so pi-ai reaches the stored grant, while a
      // route with an imported API key binds through the one authority.
      // Adoption is the only caller allowed to take over the pre-adoption
      // reference it recorded as `originalApiKeyEnv`.
      const bound = ownershipRead === 'known'
        ? await this.syncBrokerBinding(provider, { takeover: true })
        : false
      // A refused write the pool's serving shape required leaves a state no
      // later repair may touch (it cannot tell that value from a hand edit), so
      // undo the adoption entirely (PR review round 2). A foreign projection or
      // an unreadable one needs no write: the profile is not the pool's to
      // rewrite, and the adoption itself is complete.
      if (ownershipRead === 'known' && !bound && this.keyPoolServes(record)) {
        await this.rollbackAdoption(record, imported)
        throw new Error(`The ${provider} profile refused the credential binding write; the adoption was rolled back. Repair the profile in Models and adopt again.`)
      }
      if (ownershipRead === 'known' && this.foreignProjections.has(provider) && record.originalApiKeyEnv !== null) {
        // A foreign projection serves the route, so this adoption binds
        // nothing; the pre-adoption reference it kept may only be taken over
        // when that projection disappears (round 40).
        record.takeoverPending = true
      }
      if (ownershipRead === 'unknown') {
        // Ownership stays unknown and nothing was bound; a later authoritative
        // read clears the marker and re-derives the binding.
        this.pushWarning(`The ${provider} route was adopted, but its stored credential could not be read; its models profile was left unbound until the credential store answers.`)
      }
      if (hit !== undefined) this.pushWarning(`Imported the existing credential ${hit.ref}.`)
      this.store.touch()
      return this.buildState()
    })
  }

  /**
   * Read and classify one provider's live projection at adoption (PR review
   * round 17) — the same read hydration does, for the one route hydration
   * cannot cover: a provider that did not exist when the snapshot was taken.
   *
   * An adoption owns no account row yet, so any live record is one no row of
   * this pool owns: a native api-key, an unrecognized payload, and a grant left
   * behind by a released account all serve the route ahead of the broker
   * reference, so the route is marked foreign and the pool is not bound over it
   * (PR review rounds 3–4). An absent record clears any stale marker: the pool
   * may serve. A failed read is not an absent projection (round 8): ownership
   * stays unknown, so nothing may be bound and no repair touches the route
   * until an authoritative read answers ({@link noteProjectionReadSucceeded}).
   *
   * Returns `unknown` for that failure; the adoption itself is kept — there is
   * no write to roll back, and only the binding is undecided.
   *
   * The classification runs inside the route's grant chain (PR review round
   * 22, Codex P1). A native write or deletion reconciled while the read is
   * outstanding is therefore either already visible to it or queued behind it:
   * a read whose snapshot a newer event overtook reports `superseded` and lands
   * nothing, so a stale absence can never bind the broker over a newer
   * projection state and a stale presence can never leave the pool unbound.
   */
  private readAdoptionProjection(provider: string): Promise<AdoptionProjectionRead> {
    return this.scheduleGrantReconciliation(provider, () => this.classifyAdoptionProjection(provider))
  }

  /** Body of {@link readAdoptionProjection}: read, then land the classification. */
  private async classifyAdoptionProjection(provider: string): Promise<AdoptionProjectionRead> {
    // This body's own chain entry. A projection event reconciled during the
    // read appends a newer tail, which re-reads the live state.
    const chainTail = this.grantReconciliations.get(provider)
    const grantKey = `${OAUTH_GRANT_RECORD_SCOPE}/${provider}`
    const records = this.credentialRecords()
    if (records === undefined) {
      this.ownershipReadFailures.add(provider)
      this.warn(`projection ownership for ${provider} could not be read during adoption: the credential store is unavailable`)
      return 'unknown'
    }
    let record: Awaited<ReturnType<CredentialRecordsLike['readRecord']>>
    try {
      record = await records.readRecord(grantKey)
    } catch (error) {
      this.ownershipReadFailures.add(provider)
      this.warn(`projection ownership for ${provider} could not be read during adoption: ${error instanceof Error ? error.message : String(error)}`)
      return 'unknown'
    }
    if (this.grantReconciliations.get(provider) !== chainTail) {
      // Ownership stays unknown until the queued read answers; nothing here may
      // land, and the adoption binds nothing.
      this.ownershipReadFailures.add(provider)
      return 'superseded'
    }
    this.ownershipReadFailures.delete(provider)
    this.unattributedRequests.delete(provider)
    this.noteProviderHydrated(provider)
    if (record === undefined) this.foreignProjections.delete(provider)
    else this.foreignProjections.add(provider)
    return 'known'
  }

  /**
   * Undo an adoption whose initial binding write was refused (PR review
   * round 2): drop the managed record and its broker entry, delete the
   * plugin-scope copy this call created, and put back a pre-adoption
   * reference that landed despite the refusal. The source credential and the
   * profile's other fields are never touched — adoption only read them.
   */
  private async rollbackAdoption(record: ProviderRecord, imported: KeyRecord | undefined): Promise<void> {
    const provider = record.provider
    delete this.store.providers[provider]
    this.rebuildBrokerMap()
    if (imported !== undefined) {
      try {
        await this.unsetOriginal(imported.ref)
      } catch (error) {
        this.warn(`adoption rollback could not delete the imported credential ${imported.ref} for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const descriptor = this.describeSettings()
    const namespace = this.namespace(descriptor, record.settingsNs)
    const profile = asProfile(namespace === undefined ? undefined : getPath(namespace.value, record.settingsPath))
    const current = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    if (current === record.brokerRef) {
      try {
        const path = [...record.settingsPath, 'apiKeyEnv']
        await this.mutateSettings(record.settingsNs, [
          record.originalApiKeyEnv === null ? { op: 'unset', path } : { op: 'set', path, value: record.originalApiKeyEnv },
        ])
      } catch (error) {
        this.warn(`adoption rollback could not restore the pre-adoption reference for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.store.touch()
  }

  /**
   * Discover models for a new extra provider, falling back to the seed catalog.
   * A route that declares a static header installs the seed catalog directly:
   * the discovery request has no header slot, so probing such an endpoint can
   * only fail (and would hold the serialized mutation queue for the probe's
   * whole timeout).
   */
  private async discoverModels(extra: ExtraProvider, value: string): Promise<{ models: ModelRecord[]; failure?: string }> {
    if (extra.headerEnv !== undefined) return { models: normalizeModels(extra.models) }
    let discovered: DiscoveredModel[] = []
    let failure: string | undefined
    try {
      discovered = await this.ctx.llm.discoverModels(
        'llm-pi-ai',
        { provider: extra.id, baseURL: extra.baseURL, api: extra.api, apiKey: value },
        AbortSignal.timeout(20_000),
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const models: ModelRecord[] = []
    const seen = new Set<string>()
    for (const model of discovered) {
      const normalized = discoveredModel(model)
      if (normalized === undefined || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      models.push(normalized)
      if (models.length >= 60) break
    }
    if (models.length > 0) return { models, failure }
    return { models: normalizeModels(extra.models), failure }
  }

  /**
   * Remote: install and adopt one extra built-in provider.
   *
   * Deliberate exemption from the one-authority rule
   * ({@link syncBrokerBinding}): this call creates the profile it binds and
   * the key that serves it in the same mutation, so the write below is the
   * route's first binding rather than a takeover of a value the user owns.
   */
  addExtraProvider(extraId: string, alias: string, value: string): Promise<StateView> {
    return this.run(async () => {
      if (typeof extraId !== 'string' || extraId.length === 0) throw new Error('extraId is required')
      const input = validateKeyInput(alias, value)
      const extra = EXTRA_PROVIDER_MAP.get(extraId)
      if (extra === undefined) throw new Error(`Unknown extra provider "${extraId}"`)
      // Resolved before the first credential/settings write on every add path,
      // so a missing variable refuses the add without leaving a key or a
      // partial profile.
      const headers = resolveHeaderEnv(extra)
      const managed = this.store.provider(extraId)
      if (managed !== undefined) {
        this.pushWarning('Provider is already managed; the key was added instead.')
        // The shared managed-key path repairs the declared headers, so every
        // add-key flow restores them and the repair keeps one implementation.
        // Hand it the value resolved above: the entry refusal stays the single
        // decision for this surface, and the environment is read once per add.
        await this.addKeyLocked(extraId, input.alias, input.value, headers)
        this.store.touch()
        return this.buildState()
      }
      const descriptor = this.describeSettings()
      const namespace = this.namespace(descriptor, 'llm-pi-ai')
      if (namespace === undefined) throw new Error('The llm-pi-ai settings namespace is not mounted')
      const existing = asProfile(getPath(namespace.value, ['providers', extraId]))
      if (existing !== undefined) {
        this.pushWarning('A stored profile already exists for this provider; adopting it without replacing its models.')
        const record: ProviderRecord = {
          provider: extraId,
          displayName: extra.name,
          source: 'extra',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', extraId],
          adapter: 'pi-ai',
          brokerRef: brokerRefFor(extraId),
          originalApiKeyEnv: typeof existing.apiKeyEnv === 'string' ? existing.apiKeyEnv : null,
          createdProfile: false,
          hadProfile: true,
          extraId,
          api: (existing.api as string | undefined) ?? extra.api,
          baseURL: (existing.baseURL as string | undefined) ?? extra.baseURL,
          models: normalizeModels(existing.models).length > 0 ? normalizeModels(existing.models) : normalizeModels(extra.models),
          adoptedAt: Date.now(),
          cursor: 0,
          keys: [],
        }
        const key = await this.createKeyRecord(extraId, input.alias, input.value)
        const ops: SettingsPathOp[] = [{ op: 'set', path: ['providers', extraId, 'apiKeyEnv'], value: record.brokerRef }]
        // Fill the declared headers the stored profile does not carry; a value
        // the profile already sets for the same header is never overwritten.
        const storedHeaders = staticHeaders(existing.headers)
        this.warnHeaderDrift(extra, headers, storedHeaders)
        const missing = missingHeaders(headers, storedHeaders)
        if (Object.keys(missing).length > 0) {
          ops.push({ op: 'set', path: ['providers', extraId, 'headers'], value: { ...storedHeaders, ...missing } })
        }
        try {
          // First binding of a profile this manager does not own yet, written
          // together with the key that serves it (see the method comment); the
          // declared-header repair above travels in the same write.
          await this.mutateSettings('llm-pi-ai', ops)
        } catch (error) {
          try {
            await this.unsetOriginal(key.ref)
          } catch (cleanupError) {
            this.warn(`extra-provider cleanup left credential ${key.ref}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
          }
          throw error
        }
        record.keys.push(key)
        this.store.providers[extraId] = record
        this.rebuildBrokerMap()
        // Readiness is per provider now (PR review round 17): this route was
        // created here and its binding is written by this very call, so no
        // snapshot will ever read it.
        this.noteProviderHydrated(extraId)
        this.store.touch()
        return this.buildState()
      }

      const { models, failure } = await this.discoverModels(extra, input.value)
      if (models.length === 0) throw new Error('No models were discovered and the seed catalog is empty')
      if (failure !== undefined) this.pushWarning(`Model discovery failed; installed ${models.length} seed models instead: ${failure}`)
      const brokerRef = brokerRefFor(extraId)
      const profile = {
        displayName: extra.name,
        api: extra.api,
        baseURL: extra.baseURL,
        apiKeyEnv: brokerRef,
        ...(headers === undefined ? {} : { headers }),
        models,
      }
      const key = await this.createKeyRecord(extraId, input.alias, input.value)
      try {
        // The profile and its binding are created together (see the method
        // comment); no user value exists to take over here.
        await this.mutateSettings('llm-pi-ai', [{ op: 'set', path: ['providers', extraId], value: profile }])
      } catch (error) {
        try {
          await this.unsetOriginal(key.ref)
        } catch (cleanupError) {
          this.warn(`extra-provider cleanup left credential ${key.ref}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        }
        throw error
      }
      const record: ProviderRecord = {
        provider: extraId,
        displayName: extra.name,
        source: 'extra',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', extraId],
        adapter: 'pi-ai',
        brokerRef,
        originalApiKeyEnv: null,
        createdProfile: true,
        hadProfile: false,
        extraId,
        api: extra.api,
        baseURL: extra.baseURL,
        models,
        adoptedAt: Date.now(),
        cursor: 0,
        keys: [key],
      }
      this.store.providers[extraId] = record
      this.rebuildBrokerMap()
      // Same as the take-over branch above: the profile and its binding are
      // this call's own write, so the route is attributable immediately.
      this.noteProviderHydrated(extraId)
      this.store.touch()
      return this.buildState()
    })
  }

  /**
   * Restore a managed extra route's declared static headers.
   *
   * A managed profile can lose its declared headers through a Models edit;
   * every managed add-key flow repairs them instead of leaving a route whose
   * required header is silently absent. Only a live profile with a healthy
   * binding is ours to repair: a deleted profile would gain a header-only
   * half-profile, and a replaced one is the state release refuses to touch. A
   * stored value for the same header always wins. The caller may pass the
   * headers it already resolved at its own entry (where a missing variable can
   * still refuse the add before any write); otherwise this method resolves
   * them. Either way a failure only warns, because the key has already been
   * added: a route whose headers cannot be resolved, and a settings write that
   * cannot be performed, both leave the repair pending for the next add so a
   * half-applied add is never turned into a rejected one.
   */
  private async repairDeclaredHeaders(record: ProviderRecord, declared?: Record<string, string>): Promise<void> {
    const extra = record.extraId === null ? undefined : EXTRA_PROVIDER_MAP.get(record.extraId)
    if (extra?.headerEnv === undefined) return
    let headers = declared
    if (headers === undefined) {
      try {
        headers = resolveHeaderEnv(extra)
      } catch (error) {
        this.pushWarning(
          `Did not restore the declared headers on the ${extra.id} route: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
    }
    if (headers === undefined) return
    const liveProfile = this.profileAt(record.settingsNs, record.settingsPath)
    if (liveProfile === undefined || this.bindingState(record) === 'mismatch') {
      this.pushWarning(
        `Did not restore the ${Object.keys(headers).join(', ')} header on the ${extra.id} route: ${
          liveProfile === undefined ? 'its Models profile no longer exists' : 'its Models profile was replaced'
        }.`,
      )
      return
    }
    const stored = staticHeaders(liveProfile.headers)
    this.warnHeaderDrift(extra, headers, stored)
    const missing = missingHeaders(headers, stored)
    if (Object.keys(missing).length === 0) return
    try {
      await this.mutateSettings(record.settingsNs, [
        { op: 'set', path: [...record.settingsPath, 'headers'], value: { ...stored, ...missing } },
      ])
    } catch (error) {
      // The key and its credential are already written; a failing settings
      // write must not reject the add. The repair stays pending, so the next
      // add-key flow retries it.
      this.pushWarning(
        `Did not restore the ${Object.keys(missing).join(', ')} header on the ${extra.id} route: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    this.pushWarning(`Restored the missing ${Object.keys(missing).join(', ')} header on the managed profile.`)
  }

  /** Add one key; caller already owns the mutation queue. */
  private async addKeyLocked(provider: string, alias: string, value: string, declaredHeaders?: Record<string, string>): Promise<void> {
    const record = this.store.provider(provider)
    if (record === undefined) throw new Error(`Provider "${provider}" is not managed`)
    // MF1: the key-pool restriction lives on the key entry path. A route
    // adopted for accounts only (no key-pool credential) refuses new keys.
    const entry = this.directoryEntry(provider)
    if (entry !== undefined) {
      const namespace = this.namespace(this.describeSettings(), entry.settingsNs)
      const profile = namespace === undefined ? undefined : asProfile(getPath(namespace.value, entry.settingsPath))
      const caps = capabilityOf(entry, profile, this.oauthFlowAvailable(entry.provider))
      if (!caps.keys) throw new Error(caps.reason ?? `Provider "${provider}" does not accept API keys`)
    }
    const input = validateKeyInput(alias, value)
    if (record.keys.length >= KEY_LIMIT) throw new Error(`A provider may have at most ${KEY_LIMIT} keys`)
    const key = await this.createKeyRecord(provider, input.alias, input.value)
    record.keys.push(key)
    // After the key add: a refused key (capability or capacity) must leave the
    // settings document untouched, so the repair never runs ahead of it.
    await this.repairDeclaredHeaders(record, declaredHeaders)
    // A route adopted for accounts only, or one whose pool lost its last key,
    // binds as soon as a usable API-key row exists again. An extra route's
    // profile is its whole route, so a deleted one is never re-materialized
    // from a binding write; a native route keeps its directory defaults and
    // may adopt the binding as its first profile content.
    await this.syncBrokerBinding(provider, record.extraId === null ? {} : { write: false })
  }

  /** Remote: add one key to a managed provider. */
  addKey(provider: string, alias: string, value: string): Promise<StateView> {
    return this.run(async () => {
      await this.addKeyLocked(provider, alias, value)
      this.store.touch()
      return this.buildState()
    })
  }

  /** Remote: rename or pause/resume one key. */
  updateKey(provider: string, keyId: string, patch: unknown): Promise<StateView> {
    return this.run(async () => {
      const record = this.store.provider(provider)
      if (record === undefined) throw new Error(`Provider "${provider}" is not managed`)
      const key = record.keys.find(candidate => candidate.id === keyId)
      if (key === undefined) throw new Error('Key not found')
      const clean = validateKeyPatch(patch)
      if (clean.alias !== undefined) key.alias = clean.alias
      if (clean.enabled !== undefined) key.enabled = clean.enabled
      this.store.touch()
      return this.buildState()
    })
  }

  /** Remote: delete one key, releasing the provider when it was the last one. */
  deleteKey(provider: string, keyId: string): Promise<StateView> {
    return this.run(() => this.withRemovalInProgress(provider, async () => {
      // R8-2: a test may still be about to send this row's credential.
      await this.settleTestBeforeRemoval(provider)
      const record = this.store.provider(provider)
      if (record === undefined) throw new Error(`Provider "${provider}" is not managed`)
      const index = record.keys.findIndex(candidate => candidate.id === keyId)
      if (index < 0) throw new Error('Key not found')
      if (record.keys.length === 1) {
        await this.releaseLocked(provider)
        return this.buildState()
      }
      const key = record.keys[index]
      // An OAuth account leaves the pool like removeAccount: drop its
      // plugin-scope payload and, when it was the projection, fall back to
      // the key pool. API keys remove their broker literal.
      if (key.kind === 'oauth' && key.oauth !== null) {
        await this.removeOAuthGrant(provider, key)
      } else {
        // Unset first: if the credential backend refuses, keep the metadata so a
        // later retry can remove both together.
        await this.unsetOriginal(key.ref)
      }
      record.keys.splice(index, 1)
      this.store.clearBindings((_key, binding) => binding.keyId === key.id)
      // Removing the last usable API-key row leaves nothing for a broker
      // reference to resolve; a surviving pool keeps its binding.
      await this.syncBrokerBinding(provider)
      this.store.touch()
      return this.buildState()
    }))
  }

  /** Read one live profile for repair and release-time cleanup decisions. */
  private profileAt(ns: string, path: readonly string[]): ProfileShape | undefined {
    const descriptor = this.describeSettings()
    const namespace = this.namespace(descriptor, ns)
    return namespace === undefined ? undefined : asProfile(getPath(namespace.value, path))
  }

  /**
   * Restore the exact live profile captured before release mutated it.
   *
   * Deliberate exemption from the one-authority rule: release is unmanaging,
   * so this write puts the pre-adoption document back instead of deriving a
   * binding from a key pool that is being deleted. Every other caller goes
   * through {@link syncBrokerBinding}.
   */
  private async restoreProfileSnapshot(record: ProviderRecord, snapshot: ProfileShape | undefined): Promise<void> {
    if (record.settingsPath.length === 0) {
      const apiKeyEnv = snapshot !== undefined && typeof snapshot.apiKeyEnv === 'string' ? snapshot.apiKeyEnv : record.brokerRef
      await this.mutateSettings(record.settingsNs, [{ op: 'set', path: ['apiKeyEnv'], value: apiKeyEnv }])
      return
    }
    await this.mutateSettings(record.settingsNs, [
      snapshot === undefined
        ? { op: 'unset', path: record.settingsPath }
        : { op: 'set', path: record.settingsPath, value: snapshot },
    ])
  }

  /**
   * Remove every managed credential, recording progress before a retry.
   *
   * The provider is flagged as releasing for the whole loop: a demotion
   * inside it (an `oauth` row iterated before a surviving `api-key` row) must
   * not re-bind the profile, or the reference release just restored would be
   * overwritten and then stripped by the closing unbind. While unmanaging the
   * binding only ever goes one way — off.
   */
  private async deleteManagedCredentials(record: ProviderRecord): Promise<void> {
    this.releasingProviders.add(record.provider)
    try {
      for (const key of record.keys) {
        if (key.kind === 'oauth' && key.oauth !== null) {
          // Same cleanup as removeAccount/deleteKey: when this row owns the
          // activation projection, demote it first so the released route
          // resolves through the restored apiKeyEnv instead of a grant whose
          // manager is gone (pi-ai resolution prefers a stored credential).
          await this.removeOAuthGrant(record.provider, key)
        } else {
          await this.unsetOriginal(key.ref)
        }
        key.valueMissing = true
        this.store.touch()
      }
      this.activeAccounts.delete(record.provider)
      this.foreignProjections.delete(record.provider)
      // Every projection row is gone and every key is marked missing. This is
      // also releaseLocked's binding step: its profile already carries the
      // captured original, so only a lingering broker reference of our own is
      // removed and a released route keeps the value the user had.
      await this.syncBrokerBinding(record.provider)
    } finally {
      this.releasingProviders.delete(record.provider)
    }
  }

  /**
   * Drop any armed intentional-removal marker for a provider being released.
   *
   * The marker only exists to silence the record-updated echo of the manager's
   * own projection removal, and that echo is dropped outright once the provider
   * is unmanaged: {@link onGrantRecordUpdated} returns at event time and
   * {@link reconcileGrantRecord} at body time. A release can land between the
   * arm and that echo — the abort compensation arms inside the mutation queue
   * while its echo is still chained behind an in-flight body — leaving the
   * marker armed for its whole TTL with nothing left to consume it. A provider
   * re-adopted inside that window would then read a genuine out-of-band
   * removal as the manager's own: no warning, no `valueMissing`, no
   * stale-owner cleanup.
   *
   * Called only on the successful release path: a release that throws leaves
   * the provider managed, and its echo may still legitimately arrive.
   */
  private dropIntentionalRemoval(provider: string): void {
    this.intentionalProjectionRemovals.delete(provider)
  }

  /** Restore the provider profile and drop management; caller owns the queue. */
  private async releaseLocked(provider: string): Promise<void> {
    const record = this.store.provider(provider)
    if (record === undefined) return
    // PR review round 10 (I-000179): release is a removal path too — it deletes
    // every managed credential below, so it holds the same window coordination
    // as removeAccount/deleteKey instead of racing a running row test.
    await this.settleTestBeforeRemoval(provider)
    // Round-2 review step 4: releasing a provider revokes its in-flight
    // sign-in attempts. A login whose seam flow is aborted can no longer
    // harvest rows for a provider that is no longer managed (the harvest
    // itself also refuses settled attempts).
    for (const attempt of this.loginAttempts.values()) {
      if (attempt.provider !== provider || attempt.settledAt !== undefined) continue
      this.failLoginAttempt(attempt, new Error(`Provider "${provider}" was released during sign-in`))
    }
    const descriptor = this.describeSettings()
    if (!descriptor.readable) {
      throw new Error('Settings are currently unreadable; refusing to release a provider whose binding cannot be inspected.')
    }
    const namespace = this.namespace(descriptor, record.settingsNs)
    if (namespace === undefined) throw new Error(`Settings namespace "${record.settingsNs}" is not mounted`)
    const binding = this.bindingState(record, descriptor)
    if (binding === 'unknown') {
      throw new Error('Settings are currently unreadable; refusing to release a provider whose binding cannot be inspected.')
    }

    // The user may have repaired or replaced the provider in Models. In that
    // case release only drops manager metadata and credentials; it must not
    // overwrite the live profile.
    if (binding === 'mismatch') {
      await this.deleteManagedCredentials(record)
      this.dropIntentionalRemoval(provider)
      delete this.store.providers[provider]
      this.store.clearBindings(key => key.endsWith(`\u0000${provider}`))
      this.rebuildBrokerMap()
      this.store.touch()
      return
    }

    const liveProfile = asProfile(getPath(namespace.value, record.settingsPath))
    const snapshot = liveProfile === undefined ? undefined : structuredClone(liveProfile)
    let profileMutated = false
    try {
      if (record.createdProfile && record.extraId !== null && record.settingsNs === 'llm-pi-ai') {
        await this.mutateSettings(record.settingsNs, [{ op: 'unset', path: ['providers', record.extraId] }])
        profileMutated = true
      } else {
        // Native and pre-existing extra routes own only the values this plugin
        // wrote: apiKeyEnv, plus the declared static headers it injected into
        // an adopted profile. Leave every other profile field (baseURL,
        // models, hand edits) exactly as it is.
        // Exempt from the one-authority rule by design: release restores the
        // pre-adoption document, and the deletion loop that follows is
        // unbind-only ({@link deleteManagedCredentials}).
        const path = [...record.settingsPath, 'apiKeyEnv']
        const ops: SettingsPathOp[] = [
          record.originalApiKeyEnv !== null
            ? { op: 'set', path, value: record.originalApiKeyEnv }
            : { op: 'unset', path },
        ]
        // An injected header is identified by the environment value the add
        // wrote into it, so no extra record field has to remember the write.
        // Anything else stays, and release says so instead of guessing.
        const storedHeaders = staticHeaders(liveProfile?.headers)
        const extra = record.extraId === null ? undefined : EXTRA_PROVIDER_MAP.get(record.extraId)
        const envHeaders = environmentHeaders(extra)
        const injected: string[] = []
        for (const [header, envName] of Object.entries(extra?.headerEnv ?? {})) {
          // Fetch field names are case-insensitive: attribute the stored
          // variant whatever its case, and unset that same stored key.
          const storedKey = storedHeaderKey(storedHeaders, header)
          if (storedKey === undefined) continue
          const envValue = envHeaders[header]
          if (envValue === undefined) {
            this.pushWarning(`Release left the ${storedKey} header in the ${provider} profile: ${envName} is no longer set, so an injected value cannot be identified.`)
          } else if (storedHeaders[storedKey] === envValue) {
            injected.push(storedKey)
          } else {
            this.pushWarning(`Release left the ${storedKey} header in the ${provider} profile: it is not the value ${envName} currently supplies.`)
          }
        }
        if (injected.length > 0) {
          const remaining = Object.keys(storedHeaders).filter(header => !injected.includes(header))
          if (remaining.length === 0) {
            ops.push({ op: 'unset', path: [...record.settingsPath, 'headers'] })
          } else {
            for (const header of injected) ops.push({ op: 'unset', path: [...record.settingsPath, 'headers', header] })
          }
        }
        await this.mutateSettings(record.settingsNs, ops)
        profileMutated = true
        // Remove an auto-created profile only when it is still empty after
        // clearing apiKeyEnv; a profile with later user edits stays.
        if (!record.hadProfile && record.settingsPath.length > 0) {
          const current = this.profileAt(record.settingsNs, record.settingsPath)
          if (current !== undefined && Object.keys(current).length === 0) {
            await this.mutateSettings(record.settingsNs, [{ op: 'unset', path: record.settingsPath }])
          }
        }
      }
      // The profile mutation came first so a read-only profile fails before
      // any managed credential is deleted.
      await this.deleteManagedCredentials(record)
    } catch (error) {
      if (profileMutated) {
        try {
          await this.restoreProfileSnapshot(record, snapshot)
        } catch (restoreError) {
          this.warn(`release compensation failed for ${provider}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
        }
      }
      throw error
    }
    this.dropIntentionalRemoval(provider)
    delete this.store.providers[provider]
    this.store.clearBindings(key => key.endsWith(`\u0000${provider}`))
    this.rebuildBrokerMap()
    this.store.touch()
  }

  /** Remote: stop managing a provider and restore its original key reference. */
  releaseProvider(provider: string): Promise<StateView> {
    return this.run(() => this.withRemovalInProgress(provider, async () => {
      if (this.store.provider(provider) === undefined) throw new Error(`Provider "${provider}" is not managed`)
      await this.releaseLocked(provider)
      return this.buildState()
    }))
  }

  /** Remote: update manager policy. */
  setSettings(patch: unknown): Promise<StateView> {
    return this.run(async () => {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch is required')
      const next = patchSettings(this.store.settings, patch)
      this.store.state.settings = next
      this.store.touch()
      return this.buildState()
    })
  }

  /**
   * Serialize the first selection for a sticky session/provider pair so two
   * concurrent requests cannot advance the cursor and bind different keys.
   */
  async selectKey(
    providerId: string,
    sessionId: string | undefined,
    step?: { turn: number; step: number },
  ): Promise<KeySelection> {
    if (!this.store.settings.stickySession || sessionId === undefined) {
      return this.doSelectKey(providerId, sessionId, step)
    }
    const queueKey = `${sessionId}\u0000${providerId}`
    const previous = this.selectionQueues.get(queueKey) ?? Promise.resolve()
    const next = previous.then(
      () => this.doSelectKey(providerId, sessionId, step),
      () => this.doSelectKey(providerId, sessionId, step),
    )
    const tail = next.then(() => undefined, () => undefined)
    this.selectionQueues.set(queueKey, tail)
    try {
      return await next
    } finally {
      if (this.selectionQueues.get(queueKey) === tail) this.selectionQueues.delete(queueKey)
    }
  }

  /** Pin the key a retry must use, scoped to the failing step. */
  private pinRetry(
    providerId: string,
    sessionId: string | undefined,
    turn: number,
    step: number,
    keyId: string,
  ): void {
    if (sessionId === undefined) return
    this.retryBindings.set(`${bindingKey(sessionId, providerId)}\u0000${turn}\u0000${step}`, { keyId, at: Date.now() })
  }

  /** Record the turn/step the agent loop is about to request for one provider. */
  noteRequestStep(payload: AgentRequestPayload, providerId: string): void {
    const raw = payload.agent?.session?.id
    if (raw === undefined || providerId.length === 0) return
    // Unmanaged providers never consult this map; do not let them accumulate.
    if (this.store.provider(providerId) === undefined) return
    const sessionId = String(raw)
    this.requestSteps.set(`${sessionId}\u0000${providerId}`, { turn: payload.turn, step: payload.step, at: Date.now() })
  }

  /** Drop one step's retry pin once its attempt settles. */
  private clearRetry(providerId: string, sessionId: string | undefined, turn: number, step: number): void {
    if (sessionId === undefined) return
    this.retryBindings.delete(`${bindingKey(sessionId, providerId)}\u0000${turn}\u0000${step}`)
  }

  /** Selection body; callers reach it through {@link selectKey}. */
  private async doSelectKey(
    providerId: string,
    sessionId: string | undefined,
    step?: { turn: number; step: number },
  ): Promise<KeySelection> {
    const provider = this.store.provider(providerId)
    if (provider === undefined) return { key: undefined, value: undefined }
    const now = Date.now()
    this.pruneBindings(now)
    if (sessionId !== undefined && step !== undefined) {
      const pinKey = `${bindingKey(sessionId, providerId)}\u0000${step.turn}\u0000${step.step}`
      const pinned = this.retryBindings.get(pinKey)
      this.retryBindings.delete(pinKey)
      if (pinned !== undefined && now - pinned.at <= PIN_TTL_MS) {
        const candidate = provider.keys.find(entry => entry.id === pinned.keyId)
        if (isSelectable(candidate, now)) {
          const probe = await this.probeKey(candidate.ref)
          if (probe.hit !== undefined) {
            candidate!.valueMissing = false
            markKeyUsed(candidate!, now)
            this.store.touch()
            if (this.store.settings.stickySession) this.store.bind(sessionId, providerId, candidate!.id, now)
            return { key: candidate!, value: probe.hit.value }
          }
          if (probe.missing) {
            candidate!.valueMissing = true
            this.store.touch()
          }
        }
      }
    }
    let key: KeyRecord | undefined
    if (sessionId !== undefined && this.store.settings.stickySession) {
      const binding = this.store.binding(sessionId, providerId)
      if (binding !== undefined) {
        const bound = provider.keys.find(candidate => candidate.id === binding.keyId)
        if (isSelectable(bound, now)) key = bound
      }
    }
    if (key === undefined) key = pickRoundRobin(provider, now)

    const tryCandidate = async (candidate: KeyRecord | undefined): Promise<KeySelection | undefined> => {
      if (candidate === undefined) return undefined
      const probe = await this.probeKey(candidate.ref)
      if (probe.hit !== undefined) {
        candidate.valueMissing = false
        markKeyUsed(candidate, now)
        this.store.touch()
        if (sessionId !== undefined && this.store.settings.stickySession) {
          this.store.bind(sessionId, providerId, candidate.id, now)
        }
        return { key: candidate, value: probe.hit.value }
      }
      if (probe.missing) {
        candidate.valueMissing = true
        this.store.touch()
      }
      return undefined
    }

    const tried = new Set<string>()
    while (key !== undefined && !tried.has(key.id)) {
      tried.add(key.id)
      const selected = await tryCandidate(key)
      if (selected !== undefined) return selected
      key = pickRoundRobin(provider, now, tried)
    }

    // A previously missing key may have been restored in the credential store.
    // Re-probe those candidates when no healthy key remains; a transient read
    // failure is never written back as missing.
    for (const candidate of provider.keys) {
      if (candidate.valueMissing !== true || candidate.enabled === false || Number(candidate.cooldownUntil) > now) continue
      const selected = await tryCandidate(candidate)
      if (selected !== undefined) return selected
    }
    return { key: undefined, value: undefined }
  }

  /** Record a terminal failure without deciding policy yet. */
  private recordFailure(providerId: string, sessionId: string | undefined, keyId: string | undefined, failure: LlmFailureLike, usedManagedKey = false): void {
    if (sessionId === undefined) return
    const key = bindingKey(sessionId, providerId)
    const previous = this.attempts.get(key)
    const effectiveKeyId = keyId ?? previous?.keyId
    this.attempts.set(key, {
      keyId: effectiveKeyId,
      retries: previous !== undefined && previous.keyId === effectiveKeyId ? previous.retries : 0,
      failure,
      at: Date.now(),
      turn: previous?.turn,
      step: previous?.step,
      usedManagedKey,
    })
  }

  /** Record a successful terminal finish. */
  private recordSuccess(
    providerId: string,
    sessionId: string | undefined,
    keyId: string | undefined,
    step?: { turn: number; step: number },
  ): void {
    const provider = this.store.provider(providerId)
    if (provider !== undefined) {
      const key = provider.keys.find(candidate => candidate.id === keyId)
      if (key !== undefined) markKeySuccess(key, Date.now())
      this.store.touch()
    }
    if (sessionId !== undefined) {
      this.attempts.delete(bindingKey(sessionId, providerId))
      if (step !== undefined) this.clearRetry(providerId, sessionId, step.turn, step.step)
      // Do not clear step-scoped switch/attempt records here: another step of
      // the same session may still be in flight. Step records expire by TTL or
      // are cleared when their own request-error path terminates.
    }
  }

  /**
   * Codex P2: record a projection-served success on the owning account row —
   * `lastUsedAt`/`totalUses` move and the failure streak resets, symmetric to
   * the MF2 failure attribution.
   */
  private recordProjectionSuccess(providerId: string, accountId: string): void {
    const provider = this.store.provider(providerId)
    if (provider === undefined) return
    const row = provider.keys.find(candidate => candidate.id === accountId)
    if (row !== undefined) markKeySuccess(row, Date.now())
    this.store.touch()
  }

  /** Mark one key cooling, preserving escalation across recovery windows. */
  private markFailure(providerId: string, keyId: string | undefined, failure: LlmFailureLike): void {
    const provider = this.store.provider(providerId)
    if (provider === undefined || keyId === undefined) return
    const key = provider.keys.find(candidate => candidate.id === keyId)
    if (key === undefined) return
    const now = Date.now()
    // R6-SF1/R7-SF1: the projection generation is read at failure time and
    // stamped on the row's window. It must be stamped on EVERY observed
    // failure, including one the dedupe below skips: a failure of a freshly
    // projected grant that lands inside an existing window still belongs to
    // the new projection, and leaving the old stamp would let a later
    // harvest clear a window the new projection earned.
    const generation = this.ownershipGenerations.get(providerId) ?? 0
    // D1/D2 pool arbitration: when the OAuth grant itself failed (the pinned
    // pi-ai `ModelsError("oauth", …)` code), the account cools down AND the
    // cascade demotes to the key pool by deleting the projection record.
    const oauthDemotion = key.kind === 'oauth' && classifyOAuthFailure(failure) === 'oauth'
    if (key.cooldownUntil > now && now - key.lastFailureAt < 10_000) {
      // Dedupe skips only the cooldown EXTENSION; the attribution stamp
      // always follows the live projection.
      this.cooldownGenerations.set(key.id, generation)
      // R14-M1: the demotion is not part of the extension this dedupe
      // suppresses. The first attempt may have thrown on its delete (or a
      // native write re-projected the grant inside the window), leaving the
      // route on a grant whose row already cooled while C1's await pointed
      // at that settled attempt. Re-running the idempotent demotion repairs
      // exactly that; skipping it made C1's awaited demotion pointless for
      // every deduped failure.
      if (oauthDemotion) this.demoteProjection(providerId, key.id)
      return
    }
    const result = applyFailureCooldown(key, this.store.settings, now, failure)
    // R6-SF1: stamp which projection earned this window. The generation is
    // read at failure time — never derived later from a cooldown timestamp —
    // so a harvest can clear only a window an older projection earned.
    this.cooldownGenerations.set(key.id, generation)
    if (oauthDemotion) {
      this.warn(`oauth account ${key.id} on ${providerId} failed (${failure.code}); demoting to the key pool for ${Math.round(result.cooldownMs / 1000)}s`)
      // Persist the applied cooldown on this path too: the deferred
      // fallbackToKeys touch never runs when its deleteRecord throws, and
      // this touch is what schedules the debounced write regardless.
      this.store.touch()
      // Round-5 finding C1: publish the demotion so the request-error handler
      // can wait for the projection to actually be gone before its retry
      // re-enters the stream (otherwise pi-ai serves the stored grant again).
      // R7-MF: carry THIS row's identity through the queued demotion. The
      // failure belongs to the account that served the request, not to
      // whichever account is active when the queue drains — a "Set active"
      // landing in between must keep its healthy projection.
      this.demoteProjection(providerId, key.id)
      return
    }
    this.warn(`key ${key.id} on ${providerId} cooled for ${Math.round(result.cooldownMs / 1000)}s`)
    this.store.touch()
  }

  /**
   * Queue one projection demotion for a failed account and publish its
   * promise so the request-error handler can wait for the projection to be
   * gone (round-5 finding C1). `keyId` is the failing row (R7-MF), so the
   * queued body deletes only a projection that still belongs to it. R14-M1:
   * both the cooldown-extension branch and the dedupe branch start the
   * demotion; it is idempotent when the projection is already gone.
   */
  private demoteProjection(providerId: string, keyId: string): void {
    const demotion = this.fallbackToKeys(providerId, keyId).catch(error => {
      this.warn(`key-pool fallback failed for ${providerId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.projectionDemotions.set(providerId, demotion)
    void demotion.then(() => {
      if (this.projectionDemotions.get(providerId) === demotion) this.projectionDemotions.delete(providerId)
    })
  }

  /**
   * Wait for any in-flight projection demotion on `providerId` (round-5
   * finding C1). Resolves immediately when nothing is pending, and always
   * resolves — the recorded promise already absorbed its own error.
   */
  private settleProjectionDemotion(providerId: string): Promise<void> {
    const pending = this.projectionDemotions.get(providerId)
    return pending === undefined ? Promise.resolve() : pending
  }

  /**
   * Whether the key pool can serve a request right now (round-5 finding C1):
   * a selectable non-account row other than `excludeKeyId`. Account rows are
   * excluded because their reference is not broker-resolvable — only a
   * projected grant serves them.
   */
  private hasFailoverCandidate(providerId: string, excludeKeyId: string): boolean {
    const provider = this.store.provider(providerId)
    if (provider === undefined) return false
    const now = Date.now()
    return provider.keys.some(key => key.id !== excludeKeyId && key.kind !== 'oauth' && isSelectable(key, now))
  }

  /** Prune stale attempt records. */
  private pruneAttempts(now: number): void {
    if (this.attempts.size >= 128) {
      for (const [key, attempt] of this.attempts) {
        if (now - attempt.at <= ATTEMPT_TTL_MS) continue
        const stepKey = attempt.turn !== undefined && attempt.step !== undefined
          ? `${key}\u0000${attempt.turn}\u0000${attempt.step}`
          : undefined
        // A step-scoped record or a recent switch means the step still owns a
        // budget; do not drop the in-flight attribution record first.
        if (stepKey !== undefined && (this.stepAttempts.has(stepKey) || (this.switches.get(stepKey)?.at ?? 0) > now - ATTEMPT_TTL_MS)) continue
        this.attempts.delete(key)
      }
    }

    const liveSteps = new Set<string>()
    const maxRetention = 24 * 60 * 60 * 1000
    for (const [key, attempt] of this.stepAttempts) {
      const age = now - attempt.at
      const hasSwitch = this.switches.has(key)
      if (age <= ATTEMPT_TTL_MS || (hasSwitch && age <= maxRetention)) {
        liveSteps.add(key)
        continue
      }
      this.stepAttempts.delete(key)
    }
    for (const [key, entry] of this.switches) {
      if (liveSteps.has(key)) continue
      if (now - entry.at <= ATTEMPT_TTL_MS) continue
      this.switches.delete(key)
    }
    for (const [key, attempts] of this.streamAttempts) {
      const kept = attempts.filter(entry => now - entry.at <= ATTEMPT_TTL_MS)
      if (kept.length === 0) this.streamAttempts.delete(key)
      else this.streamAttempts.set(key, kept)
    }
    for (const [key, pin] of this.retryBindings) {
      if (now - pin.at > PIN_TTL_MS) this.retryBindings.delete(key)
    }
    for (const [key, step] of this.requestSteps) {
      if (now - step.at > ATTEMPT_TTL_MS) this.requestSteps.delete(key)
    }
  }

  /** Waterfall listener: bind a key to the request and observe its terminal chunk. */
  streamListener(options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>): AsyncIterable<StreamChunkLike> {
    const providerId = options.provider
    // A per-row connection test owns its credential pin; it must not select a
    // key, move a cursor or write health state, so it never enters the
    // bookkeeping path below.
    const testScope = this.als.getStore()
    if (testScope?.test === true) return this.wrapTestStream(next, testScope)
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    // `options.provider` is the route the agent/request waterfall finally
    // resolved; noteRequestStep keys its record by the same
    // `${sessionId}\u0000${providerId}` pair, so the two must stay in sync or
    // the retry pin below will not be found.
    const current = sessionId === undefined || options.purpose !== undefined
      ? undefined
      : this.requestSteps.get(`${sessionId}\u0000${providerId}`)
    const step = current !== undefined && Date.now() - current.at <= ATTEMPT_TTL_MS
      ? { turn: current.turn, step: current.step }
      : undefined
    const record = this.store.provider(providerId)
    if (record === undefined) {
      if (sessionId !== undefined && step !== undefined) this.clearRetry(providerId, sessionId, step.turn, step.step)
      return next()
    }
    const binding = this.bindingState(record)
    if (binding === 'mismatch') {
      if (sessionId !== undefined && step !== undefined) this.clearRetry(providerId, sessionId, step.turn, step.step)
      // QC B5: the provider stream is handed over as a thunk on both
      // branches, so it is constructed after the isolation wait — a mismatch
      // profile still resolves pi-ai's stored grant, so the borrowed
      // projection reaches it too.
      return this.isolateFromTest(providerId, () => next())
    }
    // An ordinary request must never be served by the grant a row test has
    // borrowed for this provider, nor be attributed to the tested account.
    // The isolation wrapper waits for that test to settle before the normal
    // path resolves its credential; a test-scope request returned above, so
    // it never waits on its own guard.
    return this.isolateFromTest(providerId, () => this.wrapStream(options, next, providerId, sessionId, step))
  }

  /**
   * The account row whose grant payload currently IS the live projection,
   * verified against the provider's rows (MF2/MF3 read side). A stale map
   * entry (row removed) resolves to null.
   */
  private oauthOwnerFor(provider: string): string | null {
    const accountId = this.activeAccounts.get(provider)
    if (accountId === undefined) return null
    const row = this.store.provider(provider)?.keys.find(candidate => candidate.id === accountId)
    return row !== undefined && row.kind === 'oauth' && row.oauth !== null ? row.id : null
  }

  /**
   * Keep an ordinary request out of the window where a row test borrows (or
   * is restoring) this provider's projection. The provider stream is built
   * only after the bounded wait, so neither branch can start a request inside
   * the borrowed window; a consumer that cancels during the wait constructs
   * nothing at all. A test-scope request returns from `streamListener` before
   * this wrapper, so a test never waits on its own guard.
   */
  private isolateFromTest(
    providerId: string,
    open: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> {
    const service = this
    let iterator: AsyncIterator<StreamChunkLike> | undefined
    let waited = false
    let closed = false
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunkLike> {
        return {
          async next(): Promise<IteratorResult<StreamChunkLike>> {
            if (closed) return { done: true, value: undefined }
            if (!waited) {
              waited = true
              await service.settleProviderTest(providerId)
            }
            // QC N5: the consumer cancelled while this pull waited; there is
            // no one left to close a stream built here, so never build it.
            if (closed) return { done: true, value: undefined }
            if (iterator === undefined) iterator = open()[Symbol.asyncIterator]()
            return iterator.next()
          },
          async return(value?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            closed = true
            if (iterator?.return !== undefined) return iterator.return(value as StreamChunkLike)
            return { done: true, value: undefined }
          },
          async throw(error?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            closed = true
            if (iterator?.throw !== undefined) return iterator.throw(error)
            throw error
          },
        }
      },
    }
  }

  /**
   * Wait (bounded) for the in-flight borrowing test on this provider to
   * settle. The bound is {@link KEY_TEST_ISOLATION_WAIT_MS}, not the test's
   * own request timeout: the awaited promise also covers untimed
   * credential-store reads, so without this an ordinary request could park
   * here forever. A failed or timed-out test never fails the waiting request.
   *
   * QC fix wave 2: the one exception is a provider whose abandoned window is
   * still fenced. The wait is over, but the route's credential surface has not
   * been reconciled, so serving the request would answer it with the borrowed
   * grant (or, after a released binding, with no bound route at all). Such a
   * request is refused instead — the fence is what keeps cross-use impossible
   * until the cleanup completes.
   */
  private async settleProviderTest(providerId: string): Promise<void> {
    // QC fix wave 3 (S-004): a fence that is already known at entry is not a
    // reason to wait — the wait exists for a live test, and this route cannot
    // be served until its abandoned window is reconciled. Acting on the known
    // fence keeps the isolation deadline (25 s) off the refusal path.
    if (this.cleaningTests.has(providerId)) throw this.testCleanupRefusal(providerId)
    const pending = this.testsInFlight.get(providerId)
    if (pending === undefined) return
    const settled = await new Promise<boolean>(resolve => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(value)
      }
      timer = setTimeout(() => {
        if (!this.isolationWaitWarned.has(providerId)) {
          this.isolationWaitWarned.add(providerId)
          this.warn(`connection test for ${providerId} did not settle within ${this.isolationWaitMs}ms; the waiting request proceeds without it`)
        }
        finish(false)
      }, this.isolationWaitMs)
      timer.unref?.()
      void pending.then(() => finish(true), () => finish(true))
    })
    // A fence set while the request waited (the watchdog abandoned the test, or
    // its cleanup failed after settling) still owns the route, whatever the
    // test's own settlement says.
    if (this.cleaningTests.has(providerId)) throw this.testCleanupRefusal(providerId)
    if (settled) return
  }

  /** The refusal an ordinary request gets while its route is still unreconciled. */
  private testCleanupRefusal(providerId: string): Error {
    return new Error(`The connection test for ${providerId} is still being cleaned up; this request was not sent.`)
  }

  /**
   * Wrap one connection-test stream: keep the pinned credential scope alive
   * for every chunk and do nothing else. No selection, no cursor, no health
   * writes — the request is pure observation.
   */
  private wrapTestStream(
    next: () => AsyncIterable<StreamChunkLike>,
    scope: RequestScope,
  ): AsyncIterable<StreamChunkLike> {
    const service = this
    let iterator: AsyncIterator<StreamChunkLike> | undefined
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunkLike> {
        return {
          async next(): Promise<IteratorResult<StreamChunkLike>> {
            if (iterator === undefined) iterator = await service.als.run(scope, () => next()[Symbol.asyncIterator]())
            return service.als.run(scope, () => iterator!.next())
          },
          async return(value?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            if (iterator?.return !== undefined) return service.als.run(scope, () => iterator!.return!(value as StreamChunkLike))
            return { done: true, value: undefined }
          },
          async throw(error?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            if (iterator?.throw !== undefined) return service.als.run(scope, () => iterator!.throw!(error))
            throw error
          },
        }
      },
    }
  }

  /** Wrap one managed stream so credential resolution sees this key. */
  private wrapStream(
    _options: GenerateOptionsLike,
    next: () => AsyncIterable<StreamChunkLike>,
    providerId: string,
    sessionId: string | undefined,
    step?: { turn: number; step: number },
  ): AsyncIterable<StreamChunkLike> {
    const service = this
    let iterator: AsyncIterator<StreamChunkLike> | undefined
    let store: RequestScope | undefined
    let started = false
    let keyId: string | undefined
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunkLike> {
        return {
          async next(): Promise<IteratorResult<StreamChunkLike>> {
            if (!started) {
              started = true
              // Round-8 finding I-000108: a restarted process serves the
              // persisted projection before the ownership hydration settles.
              // Attribution must wait for it — otherwise this request selects
              // and mutates a key cursor even though pi-ai serves the stored
              // grant, and an OAuth failure is classified as externally
              // authenticated. Round-9 should-fix: the wait is bounded per
              // provider, so a stalled credential read can neither wedge this
              // request nor delay a provider whose own read already landed.
              const hydrated = await service.awaitProjectionOwnership(providerId)
              // I-000120 / D8: this request is served without an attribution, and
              // this is the only site that counts one. Both causes — the bounded
              // wait expired, or the read had already failed — arrive here as the
              // same `false`; the hydration pass itself never counts.
              if (!hydrated) {
                service.unattributedRequests.set(providerId, (service.unattributedRequests.get(providerId) ?? 0) + 1)
              }
              // Round-5 finding C4: while a projection exists, pi-ai serves
              // the stored grant and never consults the broker, so selecting
              // a key here would only mutate unused key state (cursor,
              // lastUsedAt, sticky binding) on every OAuth-backed request.
              // Skip selection entirely; the request is attributed to the
              // serving account row below. The retry after a demotion runs
              // with no projection, so it selects from the key pool.
              //
              // When the bounded wait elapsed, attribution is unknown: no
              // owner, and no key selection either, because a projection may
              // still be serving (the hydration result lands later under its
              // generation guard).
              const oauthAccountId = hydrated ? service.oauthOwnerFor(providerId) : null
              let selection: KeySelection = { key: undefined, value: undefined }
              if (hydrated && oauthAccountId === null) {
                try {
                  selection = await service.selectKey(providerId, sessionId, step)
                } catch (error) {
                  service.warn(`key selection failed: ${error instanceof Error ? error.message : String(error)}`)
                }
              } else if (hydrated && sessionId !== undefined && step !== undefined) {
                // A projection-served attempt cannot consume a step retry pin;
                // dropping it here keeps a stale pin from leaking into a later
                // attempt of the same step.
                service.clearRetry(providerId, sessionId, step.turn, step.step)
              }
              keyId = selection.key?.id
              store = {
                provider: providerId,
                keyId: keyId ?? null,
                keyValue: selection.value ?? null,
                // Only the broker resolver proves that this request actually
                // used a managed key credential.
                keyUsed: false,
                // Captured where the broker resolve path is set up (MF2):
                // when a projection exists, pi-ai serves the stored grant
                // and this scope owns the failure attribution.
                oauthAccountId,
                test: false,
              }
              if (sessionId !== undefined && keyId !== undefined) {
                const key = bindingKey(sessionId, providerId)
                const previous = service.attempts.get(key)
                service.attempts.set(key, {
                  keyId,
                  // Preserve the retry budget across key changes. With sticky
                  // sessions off, round-robin picks a different key each request;
                  // resetting here would make the retry budget unbounded.
                  retries: previous?.retries ?? 0,
                  failure: undefined,
                  at: Date.now(),
                  turn: previous?.turn,
                  step: previous?.step,
                  usedManagedKey: false,
                })
              }
              iterator = await service.als.run(store!, () => next()[Symbol.asyncIterator]())
            }
            if (iterator === undefined) throw new Error('managed stream has no iterator')
            const result = await service.als.run(store!, () => iterator!.next())
            if (result.done === true) return result
            const chunk = result.value
            if (chunk.type === 'finish' && chunk.reason !== undefined) {
              const reason = chunk.reason
              const used = store?.keyUsed === true
              // Captured where the broker resolve path is set up: when a
              // projection exists, pi-ai serves the stored grant, so both
              // terminal kinds attribute to the owning account row.
              const oauthAccountId = store?.oauthAccountId ?? null
              if (reason.kind === 'error') {
                // MF2 attribution: with an active projection, pi-ai served the
                // stored grant, so an oauth-coded failure belongs to the
                // account row — cool it and demote the projection exactly as
                // markFailure's oauth branch does, instead of delegating with
                // no recovery evidence.
                const failure = reason.failure
                if (oauthAccountId !== null && failure !== undefined && classifyOAuthFailure(failure) === 'oauth') {
                  service.recordFailure(providerId, sessionId, oauthAccountId, failure, true)
                  service.markFailure(providerId, oauthAccountId, failure)
                  // Round-5 finding C1: the demotion alone only helps a LATER
                  // request. Recording request-scoped evidence in the same
                  // linked form the key paths produce lets the manager's retry
                  // policy fail over inside THIS request. It is recorded only
                  // when the pool holds a candidate: with none, neither the
                  // demoted account nor a key can serve the retry, and a retry
                  // would be a phantom loop — delegation stays the answer.
                  if (service.hasFailoverCandidate(providerId, oauthAccountId)) {
                    service.recordStreamAttempt(providerId, sessionId, oauthAccountId, true, failure)
                  }
                } else {
                  if (reason.failure !== undefined && shouldFailover(reason.failure.code) && service.store.settings.autoSwitch) {
                    service.recordStreamAttempt(providerId, sessionId, keyId, used, reason.failure)
                  }
                  if (used && reason.failure !== undefined) {
                    service.recordFailure(providerId, sessionId, keyId, reason.failure, true)
                  } else if (sessionId !== undefined) {
                    // The request failed on an external credential; do not
                    // attribute it to a managed key.
                    service.attempts.delete(bindingKey(sessionId, providerId))
                    if (step !== undefined) service.clearRetry(providerId, sessionId, step.turn, step.step)
                  }
                }
                service.pruneAttempts(Date.now())
              } else if (reason.kind === 'aborted') {
                if (sessionId !== undefined && step !== undefined) service.clearRetry(providerId, sessionId, step.turn, step.step)
              } else if (used) {
                service.recordSuccess(providerId, sessionId, keyId, step)
              } else if (oauthAccountId !== null) {
                // Codex P2: symmetric to the failure attribution — a request
                // served by the projected grant succeeded on the owning
                // account row, so its counters and failure streak update
                // there, not on a broker key.
                service.recordProjectionSuccess(providerId, oauthAccountId)
                if (sessionId !== undefined) {
                  service.attempts.delete(bindingKey(sessionId, providerId))
                  if (step !== undefined) service.clearRetry(providerId, sessionId, step.turn, step.step)
                }
              } else if (sessionId !== undefined) {
                service.attempts.delete(bindingKey(sessionId, providerId))
                if (step !== undefined) service.clearRetry(providerId, sessionId, step.turn, step.step)
              }
            }
            return result
          },
          async return(value?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            if (iterator?.return !== undefined && store !== undefined) {
              return service.als.run(store!, () => iterator!.return!(value as StreamChunkLike))
            }
            return { done: true, value: undefined }
          },
          async throw(error?: unknown): Promise<IteratorResult<StreamChunkLike>> {
            if (iterator?.throw !== undefined && store !== undefined) {
              return service.als.run(store!, () => iterator!.throw!(error))
            }
            throw error
          },
        }
      },
    }
  }

  /**
   * Delegate recovery to the next agent/request-error listener. Preserve the
   * current key only when that listener actually requests a retry; a declined
   * (undefined) recovery is terminal and must still cool the exhausted key.
   */
  private async delegateAndMaybeCool(
    payload: RequestErrorPayload,
    providerId: string,
    keyId: string,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    let action: RequestErrorAction
    try {
      action = await next()
    } catch (error) {
      this.markFailure(providerId, keyId, payload.failure)
      throw error
    }
    if (action === undefined) this.markFailure(providerId, keyId, payload.failure)
    return action
  }

  /** Record one failed stream attempt for turn/step attribution. */
  private recordStreamAttempt(
    providerId: string,
    sessionId: string | undefined,
    keyId: string | undefined,
    usedManagedKey: boolean,
    failure?: unknown,
  ): void {
    if (sessionId === undefined) return
    const entry: StreamAttempt = {
      keyId,
      usedManagedKey,
      at: Date.now(),
      sequence: ++this.attemptSequence,
      claimed: false,
    }
    if (typeof failure === 'object' && failure !== null) {
      // The agent loop forwards this exact failure object to
      // agent/request-error; it is a request-scoped identity.
      this.linkedAttempts.set(failure, entry)
      return
    }
    const key = bindingKey(sessionId, providerId)
    const attempts = this.streamAttempts.get(key) ?? []
    attempts.push(entry)
    while (attempts.length > 8) attempts.shift()
    this.streamAttempts.set(key, attempts)
  }

  /** Consume the stream record linked to this exact failure object. */
  private takeLinkedAttempt(failure: unknown): StreamAttempt | undefined {
    if (typeof failure !== 'object' || failure === null) return undefined
    const entry = this.linkedAttempts.get(failure)
    if (entry === undefined) return undefined
    this.linkedAttempts.delete(failure)
    return entry
  }

  /** Claim the next unclaimed stream attempt after a step's last sequence. */
  private claimStreamAttempt(
    providerId: string,
    sessionId: string | undefined,
    afterSequence: number,
  ): StreamAttempt | undefined {
    if (sessionId === undefined) return undefined
    const attempts = this.streamAttempts.get(bindingKey(sessionId, providerId))
    if (attempts === undefined) return undefined
    const found = attempts.find(entry => !entry.claimed && entry.sequence > afterSequence)
    if (found === undefined) return undefined
    found.claimed = true
    return found
  }

  /**
   * Find a metadata-selectable alternate whose credential actually resolves.
   * A key whose credential was removed outside the manager must not cause the
   * current, working key to be cooled and the session rebound.
   */
  private async findVerifiedAlternate(
    record: ProviderRecord,
    currentKeyId: string,
    now: number,
  ): Promise<KeyRecord | undefined> {
    const tried = new Set<string>()
    for (;;) {
      const candidate = pickHealthyExcluding(record, currentKeyId, now)
      if (candidate === undefined || tried.has(candidate.id)) return undefined
      tried.add(candidate.id)
      const probe = await this.probeKey(candidate.ref)
      if (probe.hit !== undefined) return candidate
      if (probe.missing) {
        candidate.valueMissing = true
        this.store.touch()
      }
    }
  }

  /** Waterfall listener: bounded retry, then key switch and cool-down. */
  async requestErrorListener(payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    // Consume a linked record on every path, including skipped recovery, so a
    // later request cannot claim this failure's evidence.
    const linked = this.takeLinkedAttempt(payload.failure)
    const providerId = payload.provider
    const sessionId = payload.agent?.session?.id === undefined ? undefined : String(payload.agent.session.id)
    const dropPin = (): void => {
      if (sessionId !== undefined) this.clearRetry(providerId, sessionId, payload.turn, payload.step)
    }
    if (payload.signal?.aborted) {
      dropPin()
      return next()
    }
    const record = this.store.provider(providerId)
    if (record === undefined || this.bindingState(record) === 'mismatch') {
      dropPin()
      return next()
    }
    const settings = this.store.settings
    if (!settings.autoSwitch) {
      dropPin()
      return next()
    }
    if (!shouldFailover(payload.failure?.code)) {
      dropPin()
      return next()
    }
    if (sessionId === undefined) return next()
    // Round-5 finding C1: an OAuth-grant failure cools the account and starts
    // an asynchronous projection demotion. The retry must not re-enter the
    // stream while that demotion is pending — pi-ai would serve the stored
    // grant again and the key-pool failover would never happen. Awaiting here
    // is what makes the retry attempt land on the pool within this request.
    await this.settleProjectionDemotion(providerId)
    const now = Date.now()
    const attemptKey = bindingKey(sessionId, providerId)
    const switchKey = `${attemptKey}\u0000${payload.turn}\u0000${payload.step}`
    let attempt = this.stepAttempts.get(switchKey)
    const evidence = linked ?? this.claimStreamAttempt(providerId, sessionId, attempt?.lastSequence ?? 0)
    if (attempt === undefined) {
      // Do not fall back to the shared session record: another step may have
      // overwritten it. Without request-scoped evidence, delegating is safer.
      if (evidence === undefined || evidence.usedManagedKey !== true) return next()
      attempt = {
        keyId: evidence.keyId,
        retries: 0,
        at: now,
        turn: payload.turn,
        step: payload.step,
        usedManagedKey: true,
        lastSequence: evidence.sequence,
        keyRetries: {},
      }
      this.stepAttempts.set(switchKey, attempt)
    } else {
      // Every recovery needs evidence for the request that just failed; an
      // existing step must not reuse stale attribution or budget.
      if (evidence === undefined) {
        this.switches.delete(switchKey)
        this.stepAttempts.delete(switchKey)
        this.clearRetry(providerId, sessionId, payload.turn, payload.step)
        return next()
      }
      const keyChanged = attempt.keyId !== evidence.keyId
      attempt.keyId = evidence.keyId
      attempt.usedManagedKey = evidence.usedManagedKey
      attempt.lastSequence = evidence.sequence
      attempt.at = now
      if (keyChanged) {
        attempt.keyRetries ??= {}
        attempt.retries = evidence.keyId === undefined ? 0 : attempt.keyRetries[evidence.keyId] ?? 0
      }
    }
    if (attempt.usedManagedKey !== true) {
      this.switches.delete(switchKey)
      this.stepAttempts.delete(switchKey)
      this.clearRetry(providerId, sessionId, payload.turn, payload.step)
      return next()
    }
    const currentKeyId = attempt.keyId
    if (currentKeyId === undefined) {
      this.clearRetry(providerId, sessionId, payload.turn, payload.step)
      return next()
    }
    const current = record.keys.find(key => key.id === currentKeyId)
    if (current === undefined) return next()
    const switchCount = this.switches.get(switchKey)?.count ?? 0

    if (attempt.retries < settings.retryCount) {
      attempt.retries += 1
      attempt.keyRetries ??= {}
      if (attempt.keyId !== undefined) attempt.keyRetries[attempt.keyId] = attempt.retries
      this.pinRetry(providerId, sessionId, payload.turn, payload.step, currentKeyId)
      this.warn(`${providerId} key ${currentKeyId} failed (${payload.failure?.code ?? 'error'}); retry ${attempt.retries}/${settings.retryCount}`)
      return { kind: 'retry' }
    }

    if (switchCount >= Math.min(MAX_SWITCHES, Math.max(1, record.keys.length))) {
      this.warn(`${providerId} exhausted key switches for this step; delegating recovery`)
      const action = await this.delegateAndMaybeCool(payload, providerId, currentKeyId, next)
      if (action === undefined) {
        this.switches.delete(switchKey)
        this.stepAttempts.delete(switchKey)
        this.clearRetry(providerId, sessionId, payload.turn, payload.step)
      } else {
        this.pinRetry(providerId, sessionId, payload.turn, payload.step, currentKeyId)
        }
      return action
    }
    const candidate = await this.findVerifiedAlternate(record, currentKeyId, now)
    if (candidate === undefined) {
      this.warn(`${providerId} has no alternate with a resolvable credential; preserving the current key via delegation`)
      const action = await this.delegateAndMaybeCool(payload, providerId, currentKeyId, next)
      if (action === undefined) {
        this.switches.delete(switchKey)
        this.stepAttempts.delete(switchKey)
        this.clearRetry(providerId, sessionId, payload.turn, payload.step)
      } else {
        this.pinRetry(providerId, sessionId, payload.turn, payload.step, currentKeyId)
        }
      return action
    }
    // Keep the current key usable until an alternate is actually chosen. If
    // the delegated retry re-enters llm/stream, selectKey must still find a
    // credential; cooling it before this point would strand that retry.
    this.markFailure(providerId, currentKeyId, payload.failure)
    this.store.bind(sessionId, providerId, candidate.id, now)
    attempt.keyId = candidate.id
    attempt.keyRetries ??= {}
    attempt.keyRetries[candidate.id] ??= 0
    attempt.retries = attempt.keyRetries[candidate.id]
    attempt.at = now
    this.pinRetry(providerId, sessionId, payload.turn, payload.step, candidate.id)
    this.switches.set(switchKey, { count: switchCount + 1, at: now })
    this.store.touch()
    this.warn(`${providerId} switched to key ${candidate.id} after ${settings.retryCount} retries`)
    return { kind: 'retry' }
  }
}

/** Host entry. */
export function apply(ctx: HostContext): void {
  const file = statePath()
  ensureStateFile(file)
  const store = new KeysManagerStore(file, { warn: message => ctx.logger.warn(message) })
  const service = new KeysManagerService(ctx, store)

  ctx.effect(() => () => service.close(), 'keys-manager: persist state')

  ctx.inject(['credentials'], child => {
    const credentials = (child as HostContext).credentials
    service.attachCredentials(credentials)
    return () => service.detachCredentials(credentials)
  })

  ctx.inject(['settings'], child => {
    const settings = (child as HostContext).settings
    if (settings === undefined) return
    service.attachSettings(settings)
    return () => service.detachSettings(settings)
  })

  const on = ctx.on as unknown as (
    name: string,
    listener: (...args: any[]) => unknown,
    options?: boolean | { prepend?: boolean },
  ) => () => void
  on('llm/stream', (options: unknown, next: () => AsyncIterable<StreamChunkLike>) => service.streamListener(options as GenerateOptionsLike, next))
  const pruneTimer = setInterval(() => service.pruneTransient(), 60_000)
  pruneTimer.unref?.()
  ctx.effect(() => () => {
    clearInterval(pruneTimer)
  }, 'keys-manager: prune transient state')
  on('agent/request', async (payload: unknown, next: () => Promise<unknown>) => {
    const config = await next()
    const provider = config !== null && typeof config === 'object' && typeof (config as { provider?: unknown }).provider === 'string'
      ? (config as { provider: string }).provider
      : ''
    service.noteRequestStep(payload as AgentRequestPayload, provider)
    return config
  }, { prepend: true })
  on('agent/request-error', (payload: unknown, next: () => Promise<RequestErrorAction>) => service.requestErrorListener(payload as RequestErrorPayload, next), { prepend: true })

  ;(ctx.provide as unknown as (name: string, value: unknown) => () => void)(SERVICE, service)
  ctx.effect(() => ctx.typert.register({
    package: 'dsh-keys-manager',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: INVOCATIONS,
  }), 'keys-manager: typert registration')

  ctx.logger.info(`keys-manager: ${Object.keys(store.providers).length} managed provider(s), ${file}`)
}
