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
  applyFailureCooldown,
  bindingKey,
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
  CredentialsLike,
  DirectoryEntry,
  DiscoveredModel,
  GenerateOptionsLike,
  HostContext,
  KeySelection,
  LlmFailureLike,
  ProviderSupport,
  RequestErrorAction,
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
function publicKey(key: KeyRecord, now: number): KeyView {
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
 * DSH catalog routes that are explicitly outside the single-key pool. Keeping
 * this as a named table (rather than only deriving it from env names) makes a
 * reviewed decision visible and stable when a provider adds another auth path.
 */
const UNSUPPORTED_KEY_POOL_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  'amazon-bedrock': 'Uses an AWS credential chain (profile, IAM keys, container/IRSA tokens), not a single API key',
  'cloudflare-ai-gateway': 'Needs Cloudflare account and gateway IDs in addition to the API key',
  'cloudflare-workers-ai': 'Needs a Cloudflare account ID in addition to the API key',
  'openai-codex': 'Uses ChatGPT OAuth sign-in only; no API-key credential',
})

/** Whether the provider looks like it can authenticate with one API key. */
function supportOf(entry: DirectoryEntry, profile: ProfileShape | undefined, managed: ProviderRecord | undefined): ProviderSupport {
  if (managed !== undefined) return { supported: true }
  if (entry.error !== undefined) return { supported: false, reason: entry.error }
  const unsupportedReason = UNSUPPORTED_KEY_POOL_PROVIDERS[entry.provider]
  if (unsupportedReason !== undefined) return { supported: false, reason: unsupportedReason }
  if (entry.provider === 'deepseek-official') return { supported: true }
  if (profile !== undefined && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) return { supported: true }
  const auth = entry.nativeAuth
  if (auth !== undefined) {
    if (auth.env.some(isKeyishEnv)) return { supported: true }
    if (auth.oauth) return { supported: false, reason: 'OAuth sign-in is not managed yet' }
    if (auth.env.length > 0) return { supported: false, reason: 'This provider uses native cloud credentials, not one API key' }
    return { supported: false, reason: 'This provider declares no API-key authentication' }
  }
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

export class KeysManagerService {
  readonly ctx: HostContext
  readonly store: KeysManagerStore
  private readonly als = new AsyncLocalStorage<RequestScope>()
  private readonly attempts = new Map<string, AttemptState>()
  private readonly stepAttempts = new Map<string, AttemptState>()
  private readonly streamAttempts = new Map<string, StreamAttempt[]>()
  private readonly linkedAttempts = new WeakMap<object, StreamAttempt>()
  private readonly retryBindings = new Map<string, { keyId: string; at: number }>()
  private readonly recoverySteps = new AsyncLocalStorage<{ provider: string; sessionId: string; turn: number; step: number; at: number }>()
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
  readonly typertRemote: TypertRemoteBinding

  constructor(ctx: HostContext, store: KeysManagerStore) {
    this.ctx = ctx
    this.store = store
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE, namespace: NAMESPACE })
    this.rebuildBrokerMap()
  }

  /** Log without ever echoing secret material. */
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

  /** Stop accepting mutations, drain the queue, then persist the final snapshot. */
  async close(): Promise<void> {
    this.closing = true
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
      const support = supportOf(entry, profile, managed)
      const apiKeyEnv = profile !== undefined && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : null
      const binding = managed === undefined ? undefined : this.bindingState(managed, descriptor)
      const bindingHealthy = binding === 'healthy' ? true : binding === 'mismatch' ? false : undefined
      const keys = managed !== undefined ? managed.keys.map(key => publicKey(key, now)) : []
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
      const keys = managed !== undefined ? managed.keys.map(key => publicKey(key, now)) : []
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
      const keys = managed.keys.map(key => publicKey(key, now))
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
      const support = supportOf(entry, profile, undefined)
      if (!support.supported) throw new Error(support.reason ?? 'This provider cannot be managed')
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
      // Unset first: if the credential backend refuses, keep the metadata so a
      // later retry can remove both together.
      await this.unsetOriginal(key.ref)
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
      await this.unsetOriginal(key.ref)
      key.valueMissing = true
      this.store.touch()
    }
  }

  /** Restore the provider profile and drop management; caller owns the queue. */
  private async releaseLocked(provider: string): Promise<void> {
    const record = this.store.provider(provider)
    if (record === undefined) return
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

  /** Carry this step's identity into the next llm/stream call in this context. */
  private markRecovery(providerId: string, sessionId: string | undefined, turn: number, step: number): void {
    if (sessionId === undefined) return
    this.recoverySteps.enterWith({ provider: providerId, sessionId, turn, step, at: Date.now() })
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
      if (pinned !== undefined && now - pinned.at <= ATTEMPT_TTL_MS) {
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

  /** Mark one key cooling, preserving escalation across recovery windows. */
  private markFailure(providerId: string, keyId: string | undefined, failure: LlmFailureLike): void {
    const provider = this.store.provider(providerId)
    if (provider === undefined || keyId === undefined) return
    const key = provider.keys.find(candidate => candidate.id === keyId)
    if (key === undefined) return
    const now = Date.now()
    if (key.cooldownUntil > now && now - key.lastFailureAt < 10_000) return
    const result = applyFailureCooldown(key, this.store.settings, now, failure)
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
      if (now - pin.at > ATTEMPT_TTL_MS) this.retryBindings.delete(key)
    }
  }

  /** Waterfall listener: bind a key to the request and observe its terminal chunk. */
  streamListener(options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>): AsyncIterable<StreamChunkLike> {
    const providerId = options.provider
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const recovered = this.recoverySteps.getStore()
    if (recovered !== undefined) this.recoverySteps.enterWith(undefined as never)
    const step = recovered !== undefined && sessionId !== undefined
      && recovered.provider === providerId && recovered.sessionId === sessionId
      && Date.now() - recovered.at <= ATTEMPT_TTL_MS
      ? { turn: recovered.turn, step: recovered.step }
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
                // used a managed credential.
                keyUsed: false,
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
              if (reason.kind === 'error') {
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
                service.pruneAttempts(Date.now())
              } else if (reason.kind === 'aborted') {
                if (sessionId !== undefined && step !== undefined) service.clearRetry(providerId, sessionId, step.turn, step.step)
              } else if (used) {
                service.recordSuccess(providerId, sessionId, keyId, step)
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
      this.markRecovery(providerId, sessionId, payload.turn, payload.step)
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
        this.markRecovery(providerId, sessionId, payload.turn, payload.step)
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
        this.markRecovery(providerId, sessionId, payload.turn, payload.step)
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
    this.markRecovery(providerId, sessionId, payload.turn, payload.step)
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

  ctx.effect(() => () => {
    void service.close()
  }, 'keys-manager: persist state')

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
