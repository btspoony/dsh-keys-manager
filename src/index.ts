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
  private lastBindingPruneAt = 0
  private readonly selectionQueues = new Map<string, Promise<unknown>>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  /** Interactive sign-in attempts, by attempt id. */
  private readonly loginAttempts = new Map<string, LoginAttempt>()
  /** The provider → attempt id index for the single-attempt rule. */
  private readonly loginsInFlight = new Map<string, string>()
  private loginSequence = 0
  /** The route → attempt id index for the single transport sign-in rule. */
  private readonly transportInFlight = new Map<string, string>()
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
   * on no provider's read can land, so attribution is known for every provider
   * — including one adopted after the read, whose OAuth rows did not exist
   * when the projection was looked for.
   */
  private hydrationSettled = false
  /** Providers whose bounded-wait warning already fired (warn once). */
  private readonly hydrationWaitWarned = new Set<string>()
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
   * management warning.
   *
   * Returns its own completion (round-8 finding I-000108), and the returned
   * promise is already caught, so a failed hydration degrades to "no owner"
   * instead of wedging every request. Request attribution does not subscribe
   * to that promise (round-10 should-fix SF2 — it may stay pending forever);
   * each request waits on its own provider's landing instead.
   */
  private hydrateProjectionOwnership(): Promise<void> {
    return (async () => {
      try {
        const records = this.credentialRecords()
        if (records === undefined) {
          this.warnSubscriptionLost('credentials record access')
          return
        }
        for (const providerRecord of Object.values(this.store.providers)) {
          const provider = providerRecord.provider
          const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
          if (accounts.length === 0) continue
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
              this.warn(`projection ownership hydration could not read ${grantKey}: ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            if (record === undefined || record.kind !== 'grant' || !isOAuthGrantPayload(record.payload)) continue
            const owner = matchOwningAccount(provider, accounts, record.payload)
            // A newer activation/login claimed the owner while this read was in
            // flight: the stale read is discarded, never written over it.
            if ((this.ownershipGenerations.get(provider) ?? 0) !== generation) continue
            // A concurrent removal may have dropped the row while this read was
            // in flight: never resurrect an owner entry for a row that is gone.
            if (owner !== undefined && providerRecord.keys.some(candidate => candidate.id === owner.id)) {
              this.activeAccounts.set(provider, owner.id)
            }
          } finally {
            // This provider's own read is over (owner or not): its requests are
            // attributable now and must not wait behind another provider's
            // stalled read (round-10 should-fix SF1).
            this.noteProviderHydrated(provider)
          }
        }
      } finally {
        // The read is over (completed or abandoned): from now on no result can
        // land, so every provider is ready — including one whose OAuth rows
        // appear later, which this read could not have projected.
        this.hydrationSettled = true
        this.settleHydrationWaits()
      }
    })().catch(error => {
      this.warn(`projection ownership hydration failed: ${error instanceof Error ? error.message : String(error)}`)
    })
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
        wake(true)
      }
      timer = setTimeout(() => {
        wake(false)
      }, ms)
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
   * A provider without OAuth rows can never own a projection, so it never
   * waits — a stalled read for some other provider must not delay it
   * (round-9 should-fix: this used to gate every managed provider, API-key-
   * only ones included).
   *
   * Returns false when the bound elapsed first. The caller then treats
   * attribution as unknown (no owner) and keeps key state untouched: a
   * projection may still be serving, and selecting/mutating a key here would
   * repeat the I-000108 corruption. The hydration promise is not cancelled,
   * so a late result still lands under the generation guard and later
   * requests are attributed normally.
   *
   * Readiness is decided PER PROVIDER (round-10 should-fix SF1). Hydration
   * writes owners progressively, so racing the one global promise would
   * discard an owner this provider already confirmed just because another
   * provider's read stalled. A provider whose own read has landed — with an
   * owner or with none — is ready without waiting, and the "unknown" fallback
   * is confined to the requested provider's own unresolved read.
   */
  private async awaitProjectionOwnership(providerId: string): Promise<boolean> {
    const provider = this.store.provider(providerId)
    if (provider === undefined) return true
    const hasOauthRows = provider.keys.some(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
    if (!hasOauthRows) return true
    // This provider's own read already landed (or a newer claim already owns
    // it, or the whole read is over): nothing can arrive later, so no wait.
    if (this.hydrationSettled || this.hydratedProviders.has(providerId) || this.activeAccounts.has(providerId)) return true
    const landed = await this.waitForProviderHydration(providerId, this.hydrationWaitMs)
    if (landed) return true
    if (!this.hydrationWaitWarned.has(providerId)) {
      this.hydrationWaitWarned.add(providerId)
      this.warn(`projection ownership hydration did not settle within ${this.hydrationWaitMs}ms for ${providerId}; requests proceed without an attributed account until it does`)
    }
    return false
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
    this.noteProjectionCommitted(provider)
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

  /** Stop accepting mutations, drain the queue, then persist the final snapshot. */
  async close(): Promise<void> {
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
    await Promise.allSettled([...this.grantReconciliations.values()])
    await this.store.close()
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

  /** Current settings service, if the composition mounted one. */
  private settingsService(): SettingsLike | undefined {
    if (this.settings !== undefined) return this.settings
    return (this.ctx.get as (name: string) => unknown)('settings') as SettingsLike | undefined
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
    // `transportFlowFor` already proved the seam is mounted and the flow has a
    // method; the method id is the flow's own, not the pi-ai `'oauth'` literal.
    void this.ctx.authorization!.begin({
      key: flow.key,
      method: transportMethodOf(flow)!,
      interaction: this.attemptInteraction(attempt),
      signal: attempt.controller.signal,
    }).then(
      outcome => {
        if (outcome.status === 'authorized') {
          this.finishLoginAttempt(attempt, 'ready')
          void this.refreshTransportAccounts()
          return
        }
        this.finishLoginAttempt(attempt, 'cancelled')
      },
      error => this.failLoginAttempt(attempt, error),
    )
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
   * so deleting it leaves the route signed out until the next sign-in. No
   * manager state is written, hence no `run` queue and no state flush.
   */
  async removeTransportAccount(route: string): Promise<StateView> {
    const flow = this.transportFlowFor(route)
    if (flow === undefined) throw new Error(`Provider "${route}" offers no transport account`)
    const records = this.credentialRecords()
    if (records === undefined) throw new Error('The credential store does not support records')
    await records.deleteRecord(flow.key)
    await this.refreshTransportAccounts()
    return this.buildState()
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
    if (this.transportInFlight.get(attempt.provider) === attempt.id) this.transportInFlight.delete(attempt.provider)
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
        // copy or a row. Nothing of this harvest is written yet, so the
        // abort needs no compensation, and the release already published the
        // terminal it owns.
        if (attempt.settledAt !== undefined) return
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
        await records.deleteRecord(projectionKey)
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
  private scheduleGrantReconciliation(provider: string, body: () => Promise<void>): Promise<void> {
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
    const records = this.credentialRecords()
    if (records === undefined) return
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return
    const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
    if (accounts.length === 0) return
    const activeId = this.activeAccounts.get(provider)
    const active = activeId === undefined
      ? undefined
      : accounts.find(candidate => candidate.id === activeId)
    // F1 (I-000081): the owner claim below must not overwrite a claim an
    // activation or login lands while this awaited re-read is in flight —
    // the same generation guard load-time hydration applies.
    const generation = this.ownershipGenerations.get(provider) ?? 0
    const record = await records.readRecord(key)
    if (record === undefined) {
      // This manager's own demotion marked the removal just before
      // deleting; while the marker is inside its TTL window the echo is
      // ours — consume the one-shot marker and stay silent. An expired
      // marker no longer masks anything (and is dropped for hygiene).
      const markedAt = this.intentionalProjectionRemovals.get(provider)
      if (markedAt !== undefined && Date.now() - markedAt <= INTENTIONAL_REMOVAL_TTL_MS) {
        this.intentionalProjectionRemovals.delete(provider)
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
      return
    }
    if (record.kind === 'api-key') {
      // Native api-key management took the route over: the manager no
      // longer owns any projection here.
      this.activeAccounts.delete(provider)
      this.pushWarning(`The ${provider} route now holds a natively managed API-key credential; the Keys Manager account pool is not serving it.`)
      return
    }
    if (!isOAuthGrantPayload(record.payload)) {
      // An unrecognized payload is not ours to interpret: drop the stale
      // owner entry so failure attribution and demotion never fire on it.
      this.activeAccounts.delete(provider)
      this.pushWarning(`The ${provider} OAuth record holds an unrecognized payload; Keys Manager left it untouched.`)
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
      // projection, so the previous owner entry must not survive it.
      this.activeAccounts.delete(provider)
      this.pushWarning(`An OAuth account for ${provider} is managed natively outside Keys Manager and is not part of the account pool.`)
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
    // SF2: once the new payload persists and the row points at it, delete
    // the superseded generation's plugin-scope record — harvest parity. A
    // rotated refresh token must not strand its secret-bearing record
    // outside manager state; cleanup is best-effort with a warning,
    // exactly like the harvest-time cleanup.
    if (previousRef !== rotatedRef) {
      owner.oauth = { ...owner.oauth!, grantRef: rotatedRef }
      try {
        await records.deleteRecord(previousRef)
      } catch (error) {
        this.warn(`cleanup of the superseded grant record failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Refresh-derived identity fields are informational and update in place.
    owner.oauth = {
      ...owner.oauth!,
      ...(payload.email === undefined ? {} : { email: payload.email }),
      ...(payload.accountId === undefined ? {} : { accountId: payload.accountId }),
      ...(typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? { expiresAt: payload.expires } : {}),
    }
    this.store.touch()
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
   * Round-8 finding I-000106 (must-fix): the decide snapshot used to be read
   * before the seam's lock, and `reconcileGrantRecord` runs OUTSIDE the
   * mutation queue — so a rotation echo could repoint `row.oauth.grantRef` and
   * delete the record being projected between the read and the write, leaving
   * the route on an older generation than the row names. The whole
   * read → project → claim section therefore runs on the provider's grant
   * chain ({@link scheduleGrantReconciliation}) — the same chain the
   * reconciler bodies use. A rotation committed before this body is observed
   * in `row.oauth.grantRef`; one that arrives while the body runs is queued
   * behind it and reconciles the generation this body projected. Either way
   * the projection holds exactly the generation the row names.
   *
   * The seam's per-key lock still serializes the read-decide-replace steps of
   * `modifyRecord` (credentials/src/index.ts:236-250) against other writers.
   * The account whose payload lands becomes the pool's active account and is
   * cascade-selectable again.
   */
  activateAccount(provider: string, accountId: string): Promise<StateView> {
    return this.run(async () => {
      const providerRecord = this.store.provider(provider)
      if (providerRecord === undefined) throw new Error(`Provider "${provider}" is not managed`)
      const row = providerRecord.keys.find(candidate => candidate.id === accountId)
      if (row === undefined) throw new Error(`Account "${accountId}" not found on ${provider}`)
      if (row.kind !== 'oauth' || row.oauth === null) throw new Error(`Key "${accountId}" is not an OAuth account`)
      const records = this.credentialRecords()
      if (records === undefined) throw new Error('The credential store does not support records')
      await this.scheduleGrantReconciliation(provider, async () => {
        // Re-read the generation under the chain: a rotation that committed
        // before this body claimed its slot is already reflected here.
        const grantRef = row.oauth!.grantRef
        const stored = await records.readRecord(grantRef)
        if (stored === undefined || stored.kind !== 'grant' || !isOAuthGrantPayload(stored.payload)) {
          throw new Error(`The grant payload at ${grantRef} is missing or unusable; sign in to this account again`)
        }
        this.intentionalProjectionRemovals.delete(provider)
        await records.modifyRecord(`${OAUTH_GRANT_RECORD_SCOPE}/${provider}`, () =>
          Promise.resolve({ kind: 'grant', payload: structuredClone(stored.payload) }))
        this.claimProjectionOwner(provider, row.id)
      })
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
      for (const row of providerRecord.keys) {
        if (row.kind === 'oauth') row.valueMissing = true
      }
    } else if (active !== undefined && activeId === active.id) {
      // The projection is not ours anymore (native replacement): keep the
      // stale owner entry from routing attribution or demotion at this row.
      this.activeAccounts.delete(provider)
    }
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
    return this.run(async () => {
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
    })
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

  /** Apply one path-addressed settings write through the live revision. */
  private async mutateSettings(ns: string, ops: readonly SettingsPathOp[]): Promise<void> {
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
    await settings.mutate(ns, ops, descriptor.revision)
  }

  /** Prune expired bindings at most once a minute, without a restart. */
  private pruneBindings(now: number): void {
    if (now - this.lastBindingPruneAt < 60_000) return
    this.lastBindingPruneAt = now
    this.store.pruneBindings(now)
    this.pruneAttempts(now)
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
   * Classify the live binding. An unreadable settings snapshot is `unknown`,
   * not a confirmed mismatch: transient settings failures must not disable
   * key-pool recovery for a provider that is still managed.
   */
  private bindingState(record: ProviderRecord, descriptor: SettingsSnapshot = this.describeSettings()): BindingState {
    if (!descriptor.readable) {
      // Never re-enable a previously confirmed mismatch from an unreadable
      // snapshot; without evidence, leave the binding unknown.
      return this.bindingCache.get(record.provider) ?? 'unknown'
    }
    const namespace = this.namespace(descriptor, record.settingsNs)
    const profile = namespace === undefined ? undefined : asProfile(getPath(namespace.value, record.settingsPath))
    const state: BindingState = profile !== undefined && profile.apiKeyEnv === record.brokerRef ? 'healthy' : 'mismatch'
    this.bindingCache.set(record.provider, state)
    return state
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
      const path = [...entry.settingsPath, 'apiKeyEnv']
      const hit = await this.findImport(entry, profile)
      let imported: KeyRecord | undefined
      if (hit !== undefined) imported = await this.createKeyRecord(provider, 'Imported', hit.value, hit.ref)
      try {
        await this.mutateSettings(entry.settingsNs, [{ op: 'set', path, value: brokerRef }])
      } catch (error) {
        if (imported !== undefined) {
          try {
            await this.unsetOriginal(imported.ref)
          } catch (cleanupError) {
            this.warn(`adoption cleanup left credential ${imported.ref}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
          }
        }
        throw error
      }
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
      if (hit !== undefined) this.pushWarning(`Imported the existing credential ${hit.ref}.`)
      this.store.touch()
      return this.buildState()
    })
  }

  /** Discover models for a new extra provider, falling back to the seed catalog. */
  private async discoverModels(extra: ExtraProvider, value: string): Promise<{ models: ModelRecord[]; failure?: string }> {
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

  /** Remote: install and adopt one extra built-in provider. */
  addExtraProvider(extraId: string, alias: string, value: string): Promise<StateView> {
    return this.run(async () => {
      if (typeof extraId !== 'string' || extraId.length === 0) throw new Error('extraId is required')
      const input = validateKeyInput(alias, value)
      const extra = EXTRA_PROVIDER_MAP.get(extraId)
      if (extra === undefined) throw new Error(`Unknown extra provider "${extraId}"`)
      if (this.store.provider(extraId) !== undefined) {
        this.pushWarning('Provider is already managed; the key was added instead.')
        await this.addKeyLocked(extraId, input.alias, input.value)
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
        try {
          await this.mutateSettings('llm-pi-ai', [{ op: 'set', path: ['providers', extraId, 'apiKeyEnv'], value: record.brokerRef }])
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
        models,
      }
      const key = await this.createKeyRecord(extraId, input.alias, input.value)
      try {
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
      this.store.touch()
      return this.buildState()
    })
  }

  /** Add one key; caller already owns the mutation queue. */
  private async addKeyLocked(provider: string, alias: string, value: string): Promise<void> {
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
    return this.run(async () => {
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
      this.store.touch()
      return this.buildState()
    })
  }

  /** Read one live profile for release-time cleanup decisions. */
  private profileAt(ns: string, path: readonly string[]): ProfileShape | undefined {
    const descriptor = this.describeSettings()
    const namespace = this.namespace(descriptor, ns)
    return namespace === undefined ? undefined : asProfile(getPath(namespace.value, path))
  }

  /** Restore the exact live profile captured before release mutated it. */
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

  /** Remove every managed credential, recording progress before a retry. */
  private async deleteManagedCredentials(record: ProviderRecord): Promise<void> {
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
  }

  /** Restore the provider profile and drop management; caller owns the queue. */
  private async releaseLocked(provider: string): Promise<void> {
    const record = this.store.provider(provider)
    if (record === undefined) return
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
        // Native and pre-existing extra routes own only apiKeyEnv. Leave every
        // other profile field (baseURL, models, hand edits) exactly as it is.
        const path = [...record.settingsPath, 'apiKeyEnv']
        await this.mutateSettings(record.settingsNs, [
          record.originalApiKeyEnv !== null
            ? { op: 'set', path, value: record.originalApiKeyEnv }
            : { op: 'unset', path },
        ])
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
    delete this.store.providers[provider]
    this.store.clearBindings(key => key.endsWith(`\u0000${provider}`))
    this.rebuildBrokerMap()
    this.store.touch()
  }

  /** Remote: stop managing a provider and restore its original key reference. */
  releaseProvider(provider: string): Promise<StateView> {
    return this.run(async () => {
      if (this.store.provider(provider) === undefined) throw new Error(`Provider "${provider}" is not managed`)
      await this.releaseLocked(provider)
      return this.buildState()
    })
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
      return next()
    }
    return this.wrapStream(options, next, providerId, sessionId, step)
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
              // authenticated. Round-9 should-fix: the wait is bounded and is
              // skipped entirely for providers that hold no OAuth rows, so a
              // stalled credential read can neither wedge this request nor
              // delay an API-key-only provider.
              const hydrated = await service.awaitProjectionOwnership(providerId)
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
    service.settings = (child as HostContext).settings
    return () => {
      if (service.settings === (child as HostContext).settings) service.settings = undefined
    }
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
