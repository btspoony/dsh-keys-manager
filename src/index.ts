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
  ProviderRecord,
  ProviderView,
  StateView,
} from './domain.js'
import type {
  AttemptState,
  CredentialHit,
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
} from './host-types.js'
import { EXTRA_PROVIDER_MAP, EXTRA_PROVIDERS } from './providers.js'
import { KeysManagerStore, ensureStateFile, statePath } from './store.js'

export const name = 'keys-manager'
export const inject = ['llm', 'credentials', 'typert']
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
 */
function capabilityOf(entry: DirectoryEntry, profile: ProfileShape | undefined): CapabilitySplit {
  if (entry.error !== undefined) return { keys: false, accounts: false, reason: entry.error }
  const unsupportedReason = UNSUPPORTED_KEY_POOL_PROVIDERS[entry.provider]
  if (unsupportedReason !== undefined) {
    return { keys: false, accounts: entry.nativeAuth?.oauth === true, reason: unsupportedReason }
  }
  const accounts = entry.nativeAuth?.oauth === true
  if (entry.provider === 'deepseek-official') return { keys: true, accounts }
  if (profile !== undefined && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) return { keys: true, accounts }
  const auth = entry.nativeAuth
  if (auth !== undefined) {
    // A dual-auth route (key env + OAuth, e.g. anthropic) keeps BOTH
    // capabilities; the oauth-only verdict below is for routes with no
    // key credential at all.
    if (auth.env.some(isKeyishEnv)) return { keys: true, accounts }
    if (auth.oauth) return { keys: false, accounts: true, reason: 'This provider signs in with an OAuth account; no API key is used' }
    if (auth.env.length > 0) return { keys: false, accounts: false, reason: 'This provider uses native cloud credentials, not one API key' }
    return { keys: false, accounts: false, reason: 'This provider declares no API-key authentication' }
  }
  return { keys: true, accounts }
}

/** Whether the route can be adopted for OAuth account management (MF1). */
function accountSupportOf(entry: DirectoryEntry | undefined, managed: ProviderRecord | undefined): ProviderSupport {
  if (managed !== undefined) return { supported: true }
  if (entry === undefined) return { supported: false, reason: 'This provider route is not registered' }
  if (entry.error !== undefined) return { supported: false, reason: entry.error }
  if (entry.nativeAuth?.oauth === true) return { supported: true }
  return { supported: false, reason: 'This provider offers no OAuth account sign-in' }
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
 * payload's identity metadata re-associates, guarded by the same
 * `accountId === undefined` rule the rotation reconciler applies to its
 * email-only fallback.
 */
function matchOwningAccount(provider: string, accounts: KeyRecord[], payload: OAuthGrantPayload): KeyRecord | undefined {
  const hash = createHash('sha256').update(payload.refresh).digest('hex').slice(0, 12)
  const projectedRef = accountRef(provider, hash)
  return accounts.find(candidate => candidate.oauth!.grantRef === projectedRef)
    ?? accounts.find(candidate =>
      (payload.accountId !== undefined && candidate.oauth!.accountId === payload.accountId)
      || (payload.email !== undefined && candidate.oauth!.email === payload.email && candidate.oauth!.accountId === undefined))
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
  /** The account row whose grant payload currently IS the projection, per provider. */
  private readonly activeAccounts = new Map<string, string>()
  /**
   * Per-provider write counter for {@link activeAccounts} claims (round-3
   * finding 3): activation and harvest claims bump it, and a hydration
   * result whose generation no longer matches is discarded instead of
   * overwriting a newer activation with a stale read.
   */
  private readonly ownershipGenerations = new Map<string, number>()
  /**
   * Providers whose projection deletion this manager initiated, mapped to
   * the moment it was initiated. The `record-updated` echo of our own
   * demotion consumes the marker (one-shot) and stays silent while the
   * marker is inside its TTL window; past the window the marker is expired
   * and a removal warns as genuinely out-of-band again.
   */
  private readonly intentionalProjectionRemovals = new Map<string, number>()
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
    this.hydrateProjectionOwnership()
    this.settledDisposer = this.watchAuthorizationSettled()
    this.recordUpdatedDisposer = this.watchGrantRecordUpdated()
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
   */
  private hydrateProjectionOwnership(): void {
    void (async () => {
      const records = this.credentialRecords()
      if (records === undefined) {
        this.warnSubscriptionLost('credentials record access')
        return
      }
      for (const providerRecord of Object.values(this.store.providers)) {
        const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
        if (accounts.length === 0) continue
        const grantKey = `${OAUTH_GRANT_RECORD_SCOPE}/${providerRecord.provider}`
        // Generation tag (round-3 finding 3): the read below is awaited, and
        // an activation or login landing while it is in flight must win —
        // the hydrated write only lands while the generation still matches.
        const generation = this.ownershipGenerations.get(providerRecord.provider) ?? 0
        let record: Awaited<ReturnType<typeof records.readRecord>>
        try {
          record = await records.readRecord(grantKey)
        } catch (error) {
          this.warn(`projection ownership hydration could not read ${grantKey}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (record === undefined || record.kind !== 'grant' || !isOAuthGrantPayload(record.payload)) continue
        const owner = matchOwningAccount(providerRecord.provider, accounts, record.payload)
        // A newer activation/login claimed the owner while this read was in
        // flight: the stale read is discarded, never written over it.
        if ((this.ownershipGenerations.get(providerRecord.provider) ?? 0) !== generation) continue
        // A concurrent removal may have dropped the row while this read was
        // in flight: never resurrect an owner entry for a row that is gone.
        if (owner !== undefined && providerRecord.keys.some(candidate => candidate.id === owner.id)) {
          this.activeAccounts.set(providerRecord.provider, owner.id)
        }
      }
    })().catch(error => {
      this.warn(`projection ownership hydration failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Claim the projection owner for one account row, bumping the provider's
   * ownership generation so an in-flight hydration read of an older state
   * is discarded instead of overwriting the claim (round-3 finding 3).
   */
  private claimProjectionOwner(provider: string, accountId: string): void {
    this.activeAccounts.set(provider, accountId)
    this.ownershipGenerations.set(provider, (this.ownershipGenerations.get(provider) ?? 0) + 1)
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
   */
  oauthFlowFor(provider: string): { key: string; method: string } | undefined {
    const flows = this.ctx.authorization?.list() ?? []
    const flow = flows.find(entry => entry.key === `llm-pi-ai/${provider}`)
    if (flow === undefined) return undefined
    if (!flow.methods.some(method => method.id === 'oauth')) return undefined
    return { key: flow.key, method: 'oauth' }
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
      void this.harvestLogin(attempt)
      return
    }
    if (settlement === 'cancelled') this.finishLoginAttempt(attempt, 'cancelled')
    else this.failLoginAttempt(attempt, new Error(`the sign-in attempt failed (${settlement || 'unknown outcome'})`))
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
    if (this.loginsInFlight.has(provider)) throw new Error(`A sign-in for "${provider}" is already in progress`)
    // Validate the re-authentication target up front (round-3 finding 6):
    // the harvest binds the new grant to this row, so it must already name
    // a live OAuth account of this provider.
    let cleanTarget: string | undefined
    if (typeof targetAccountId === 'string' && targetAccountId.length > 0) {
      const target = providerRecord.keys.find(candidate => candidate.id === targetAccountId)
      if (target === undefined) throw new Error(`Account "${targetAccountId}" not found on ${provider}`)
      if (target.kind !== 'oauth' || target.oauth === null) throw new Error(`Key "${targetAccountId}" is not an OAuth account`)
      cleanTarget = targetAccountId
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
    const interaction = {
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
   * Turn a committed sign-in into pool state: read the grant pi-ai wrote to
   * `llm-pi-ai/<provider>`, persist the payload under the plugin-scope
   * account ref, and upsert the `kind: 'oauth'` row. Any failure fails the
   * attempt loudly — a login whose grant could not be captured must not
   * look like success.
   */
  private async harvestLogin(attempt: LoginAttempt): Promise<void> {
    // A revoke (provider release) may have finalized this attempt before
    // the seam's authorized settlement arrives: never resurrect rows for a
    // settled login (round-2 review, step 4).
    if (attempt.settledAt !== undefined) return
    // Records this login's grant identity for the failure-path
    // compensation below: `wroteRef` says the plugin-scope copy exists,
    // and the projection is reverted only while it still carries this
    // login's refresh token.
    let harvest: { payload: OAuthGrantPayload; grantRef: string; wroteRef: boolean } | undefined
    try {
      await this.run(async () => {
        const records = this.credentialRecords()
        if (records === undefined) throw new Error('The credential store does not support records')
        const grantKey = `${OAUTH_GRANT_RECORD_SCOPE}/${attempt.provider}`
        const record = await records.readRecord(grantKey)
        if (record === undefined || record.kind !== 'grant') {
          throw new Error(`No grant record was committed to ${grantKey}`)
        }
        if (!isOAuthGrantPayload(record.payload)) {
          throw new Error(`The record at ${grantKey} does not hold a pi-ai OAuth credential`)
        }
        const payload = record.payload
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
        harvest = { payload, grantRef, wroteRef: false }
        // Managed state and key capacity are checked BEFORE the
        // plugin-scope write (round-2 review, step 4): a login whose row
        // cannot exist must not strand the persisted grant.
        const providerRecord = this.store.provider(attempt.provider)
        if (providerRecord === undefined) throw new Error(`Provider "${attempt.provider}" is no longer managed`)
        const existing = providerRecord.keys.find(candidate =>
          candidate.kind === 'oauth' && candidate.oauth !== null
          && (candidate.oauth.grantRef === grantRef
            || (payload.accountId !== undefined && candidate.oauth.accountId === payload.accountId)
            || (payload.email !== undefined && candidate.oauth.email === payload.email && candidate.oauth.accountId === undefined)))
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
        await records.modifyRecord(grantRef, () => Promise.resolve({ kind: 'grant', payload: structuredClone(payload) }))
        if (harvest !== undefined) harvest.wroteRef = true
        else harvest = { payload, grantRef, wroteRef: true }
        const now = Date.now()
        if (existing !== undefined) {
          // Replacing the credential removes the superseded plugin-scope
          // record: a changed refresh token hashes to a new ref, and the
          // old payload (old refresh token included) must not strand as a
          // secret-bearing orphan. Cleanup is best-effort — the fresh grant
          // is already persisted, so a locked store must not fail an
          // otherwise successful login; the warning keeps it observable.
          if (existing.oauth !== null && existing.oauth.grantRef !== grantRef) {
            try {
              await records.deleteRecord(existing.oauth.grantRef)
            } catch (error) {
              this.warn(`cleanup of the superseded grant record failed for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
            }
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
        } else {
          providerRecord.keys.push({
            id: newKeyId(),
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
        attempt.accountId = existing !== undefined ? existing.id : providerRecord.keys[providerRecord.keys.length - 1]!.id
        // The grant pi-ai just committed IS the projection; the fresh row
        // owns it until activation or fallback says otherwise.
        this.claimProjectionOwner(attempt.provider, attempt.accountId)
        // No terminal here: `run` flushes the state document after this
        // callback resolves, and the ready terminal publishes below — only
        // once persistence has actually resolved (round-2 review, step 3).
      })
      this.finishLoginAttempt(attempt, 'ready')
    } catch (error) {
      this.failLoginAttempt(attempt, error)
      this.warn(`oauth sign-in harvest failed for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
      // Round-2 review step 4: when no row could be created, compensate
      // with an ownership-checked delete of both written records — the
      // plugin-scope grant copy (when its write resolved), and the
      // llm-pi-ai projection only while it still carries THIS login's
      // payload.
      if (attempt.accountId === undefined) {
        await this.compensateFailedHarvest(attempt, harvest)
      }
    }
  }

  /**
   * Roll a failed harvest back to a clean credential surface: the
   * plugin-scope grant copy is deleted when it was written; the
   * `llm-pi-ai` projection is deleted only while it still carries this
   * login's refresh token, so compensation can never delete a grant
   * another account owns.
   */
  private async compensateFailedHarvest(
    attempt: LoginAttempt,
    harvest: { payload: OAuthGrantPayload; grantRef: string; wroteRef: boolean } | undefined,
  ): Promise<void> {
    const records = this.credentialRecords()
    if (records === undefined || harvest === undefined) return
    if (harvest.wroteRef) {
      try {
        await records.deleteRecord(harvest.grantRef)
      } catch (error) {
        this.warn(`harvest compensation could not delete ${harvest.grantRef}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const projectionKey = `${OAUTH_GRANT_RECORD_SCOPE}/${attempt.provider}`
      // Same atomic decide-and-delete as the demotion path (round-3
      // finding 1): the refresh compare runs inside `modifyRecord`'s per-key
      // lock, so a native writer that replaced the projection before the
      // lock is never matched, and the delete runs only on a locked-in
      // match (no delete-inside-modify primitive exists on the seam; see
      // decideAndDeleteProjection for the exact primitive).
      let owns = false
      await records.modifyRecord(projectionKey, async current => {
        owns = current !== undefined && current.kind === 'grant'
          && isOAuthGrantPayload(current.payload) && current.payload.refresh === harvest.payload.refresh
        return undefined
      })
      if (owns) await records.deleteRecord(projectionKey)
    } catch (error) {
      this.warn(`harvest compensation could not revert the projection for ${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`)
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
   */
  private onGrantRecordUpdated(key: string): void {
    if (!key.startsWith(`${OAUTH_GRANT_RECORD_SCOPE}/`)) return
    const provider = key.slice(OAUTH_GRANT_RECORD_SCOPE.length + 1)
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return
    const accounts = providerRecord.keys.filter(candidate => candidate.kind === 'oauth' && candidate.oauth !== null)
    if (accounts.length === 0) return
    const activeId = this.activeAccounts.get(provider)
    const active = activeId === undefined
      ? undefined
      : accounts.find(candidate => candidate.id === activeId)
    void (async () => {
      const records = this.credentialRecords()
      if (records === undefined) return
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
    })().catch(error => {
      this.warn(`grant reconciliation failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Make one account's grant payload the route's stored credential
   * (D1 activation projection). The decide snapshot is read from the
   * account's own `grantRef` before the write, outside the seam's lock;
   * the seam's per-provider lock then serializes the read-decide-replace
   * steps of `modifyRecord` (credentials/src/index.ts:236-250) so that
   * concurrent writers cannot interleave. The account whose payload lands
   * becomes the pool's active account and is cascade-selectable again.
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
      const stored = await records.readRecord(row.oauth.grantRef)
      if (stored === undefined || stored.kind !== 'grant' || !isOAuthGrantPayload(stored.payload)) {
        throw new Error(`The grant payload at ${row.oauth.grantRef} is missing or unusable; sign in to this account again`)
      }
      this.intentionalProjectionRemovals.delete(provider)
      await records.modifyRecord(`${OAUTH_GRANT_RECORD_SCOPE}/${provider}`, () =>
        Promise.resolve({ kind: 'grant', payload: structuredClone(stored.payload) }))
      this.claimProjectionOwner(provider, row.id)
      row.valueMissing = false
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
   */
  fallbackToKeys(provider: string): Promise<void> {
    return this.run(() => this.fallbackToKeysUnqueued(provider))
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
   * equivalent — the exact primitive this method uses — is a decide-only
   * modify (returns `undefined`, no write) followed immediately by
   * `deleteRecord`; the decide therefore never acts on a value a native
   * writer replaced before the lock, which is the window the previous
   * separate read + delete left open. Only the sub-microtask gap between the
   * modify returning and the delete's own queue entry remains, and a native
   * writer landing there is the next writer's grant, which the ownership
   * oracle re-identifies on its `record-updated` echo.
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
    await records.modifyRecord(projectionKey, async current => {
      owns = current !== undefined && current.kind === 'grant'
        && isOAuthGrantPayload(current.payload)
        && matchOwningAccount(provider, accounts, current.payload)?.id === row.id
      // Decide only: the removal goes through deleteRecord below, outside
      // the mutate (see the primitive note above).
      return undefined
    })
    if (owns) {
      // Mark BEFORE the delete: the deletion's echo handler reads this
      // marker across its own awaited record re-read, whenever that
      // continuation resumes. The TTL window — not scheduling order —
      // decides how long the marker stays trustworthy.
      this.intentionalProjectionRemovals.set(provider, Date.now())
      await records.deleteRecord(projectionKey)
    }
    return owns
  }

  /**
   * The fallback body; callers own the mutation queue. `owner` narrows the
   * ownership check to one explicit row (removeAccount/deleteKey pass the
   * removed row); without it the provider's active account decides.
   */
  private async fallbackToKeysUnqueued(provider: string, owner?: KeyRecord): Promise<void> {
    const providerRecord = this.store.provider(provider)
    if (providerRecord === undefined) return
    const activeId = this.activeAccounts.get(provider)
    const active = owner ?? (activeId === undefined
      ? undefined
      : providerRecord.keys.find(candidate =>
          candidate.id === activeId && candidate.kind === 'oauth' && candidate.oauth !== null))
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
    await this.fallbackToKeysUnqueued(provider, row)
    const records = this.credentialRecords()
    if (records !== undefined) await records.deleteRecord(row.oauth.grantRef)
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
      const caps = capabilityOf(entry, profile)
      const support: ProviderSupport = { supported: caps.keys, ...(caps.reason === undefined ? {} : { reason: caps.reason }) }
      const accountSupport = accountSupportOf(entry, managed)
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
    }
  }

  /** Remote: complete manager state. */
  getState(): StateView {
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
      const caps = capabilityOf(entry, profile)
      const accountSupport = accountSupportOf(entry, undefined)
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
      const caps = capabilityOf(entry, profile)
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
    if (key.cooldownUntil > now && now - key.lastFailureAt < 10_000) return
    const result = applyFailureCooldown(key, this.store.settings, now, failure)
    // D1/D2 pool arbitration: when the OAuth grant itself failed (the pinned
    // pi-ai `ModelsError("oauth", …)` code), the account cools down AND the
    // cascade demotes to the key pool by deleting the projection record.
    if (key.kind === 'oauth' && classifyOAuthFailure(failure) === 'oauth') {
      this.warn(`oauth account ${key.id} on ${providerId} failed (${failure.code}); demoting to the key pool for ${Math.round(result.cooldownMs / 1000)}s`)
      // Persist the applied cooldown on this path too: the deferred
      // fallbackToKeys touch never runs when its deleteRecord throws, and
      // this touch is what schedules the debounced write regardless.
      this.store.touch()
      void this.fallbackToKeys(providerId).catch(error => {
        this.warn(`key-pool fallback failed for ${providerId}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.warn(`key ${key.id} on ${providerId} cooled for ${Math.round(result.cooldownMs / 1000)}s`)
    this.store.touch()
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
              let selection: KeySelection = { key: undefined, value: undefined }
              try {
                selection = await service.selectKey(providerId, sessionId, step)
              } catch (error) {
                service.warn(`key selection failed: ${error instanceof Error ? error.message : String(error)}`)
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
                oauthAccountId: service.oauthOwnerFor(providerId),
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
