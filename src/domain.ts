/**
 * Shared, transport-safe domain shapes for the Keys Manager.
 *
 * The Host and the Web Client both compile against these declarations. They
 * deliberately contain no Cordis, Node, or React types so the client bundle
 * can import them type-only without pulling Host code into the browser.
 */

/** Health state a key row renders. */
export type KeyStatus = 'active' | 'cooling' | 'paused' | 'missing'

/** Health state a provider row renders. */
export type ProviderStatus = KeyStatus | 'empty' | 'unmanaged'

/** Manager policy shared by the Host selection engine and the UI form. */
export interface ManagerSettings {
  /** Retries on the same key before switching to another key. */
  retryCount: number
  /** First cooldown after a key starts failing. */
  baseCooldownMs: number
  /** A failure within this window after recovery escalates the cooldown. */
  recoveryGraceMs: number
  /** Hard ceiling for any cooldown. */
  maxCooldownMs: number
  /** Keep one key for one session instead of rotating every request. */
  stickySession: boolean
  /** Automatically mark and switch away from a failing key. */
  autoSwitch: boolean
}

/**
 * OAuth account metadata persisted for one `kind: 'oauth'` pool member.
 *
 * The manager state stays secret-free: the grant payload (refresh/access
 * tokens) lives in the credential store under `grantRef`, and only this
 * reference plus display metadata is stored here.
 */
export interface OAuthAccount {
  /** OAuth2 provider id the account belongs to, e.g. 'anthropic'. */
  provider: string
  /** Account email when the provider disclosed one. */
  email?: string
  /** Provider-side account identifier when disclosed. */
  accountId?: string
  /** Epoch ms when the current access token expires; informational only. */
  expiresAt?: number
  /** Plugin-scope credential reference holding this account's grant payload. */
  grantRef: string
}

/** OAuth account facts surfaced to the UI; the grant reference stays host-side. */
export interface OAuthAccountView {
  provider: string
  email?: string
  accountId?: string
  expiresAt?: number
}

/** One persisted key. Key literals live only in the credential store. */
export interface KeyRecord {
  id: string
  alias: string
  /** Credential reference holding this key's literal. */
  ref: string
  kind: 'api-key' | 'oauth'
  enabled: boolean
  createdAt: number
  lastUsedAt: number
  cooldownUntil: number
  lastFailureAt: number
  lastFailureCode: string
  failureLevel: number
  consecutiveFailures: number
  totalUses: number
  totalFailures: number
  valueMissing: boolean
  importedFrom: string | null
  /** OAuth account metadata; null for API-key rows. */
  oauth: OAuthAccount | null
}

/** One model entry installed into a pi-ai route profile. */
export interface ModelRecord {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoningEfforts?: Record<string, unknown>
  compat?: Record<string, unknown>
}

/** One managed provider and its adoption facts. */
export interface ProviderRecord {
  provider: string
  displayName: string
  source: 'dsh' | 'extra'
  settingsNs: string
  settingsPath: string[]
  adapter: 'pi-ai' | 'deepseek'
  /** Broker reference written into the provider profile's `apiKeyEnv`. */
  brokerRef: string
  /** The profile's reference before adoption, restored on release. */
  originalApiKeyEnv: string | null
  /**
   * Adoption found a foreign projection serving the route, so it could not
   * complete its one-time takeover of `originalApiKeyEnv` (PR review round 40).
   * The debt survives a restart and is settled by the next projection-change
   * sync; it never authorises an ordinary repair.
   */
  takeoverPending?: boolean
  /** True when the profile itself was created by adding an extra provider. */
  createdProfile: boolean
  /** True when a profile existed before adoption. */
  hadProfile: boolean
  extraId: string | null
  api: string | null
  baseURL: string | null
  models: ModelRecord[]
  adoptedAt: number
  /** Next round-robin position in `keys`. */
  cursor: number
  keys: KeyRecord[]
}

/** Durable, secret-free manager document. */
export interface StateDocument {
  version: 1
  settings: ManagerSettings
  providers: Record<string, ProviderRecord>
  sessionBindings: Record<string, { keyId: string; boundAt: number }>
}

/** One plan window projected into an account row. */
/** The plan windows a card can render; the one declaration every layer imports. */
export type QuotaWindowId = 'session' | 'week'

export interface QuotaWindowView {
  id: QuotaWindowId
  /** Share of the window already used, `0`..`1`. */
  usedFraction: number
  /** Reset time as epoch milliseconds. */
  resetsAt: number
}

/**
 * Latest quota snapshot of one account row. Runtime-only: never persisted, so
 * it is deliberately absent from `KeyRecord` and `sanitizeState` (plan D1).
 */
export interface QuotaView {
  status: 'ok' | 'absent' | 'unauthorized' | 'error' | 'natively-managed'
  fetchedAt: number
  /** True when the windows are last-good data served behind a failed probe. */
  stale?: boolean
  windows: QuotaWindowView[]
}

/** Public key row returned to the UI (no credential reference or value). */
export interface KeyView {
  id: string
  alias: string
  status: KeyStatus
  enabled: boolean
  createdAt: number
  lastUsedAt: number
  cooldownUntil: number
  failureLevel: number
  consecutiveFailures: number
  totalUses: number
  totalFailures: number
  importedFrom: string | null
  valueMissing: boolean
  kind: 'api-key' | 'oauth'
  /** Identity line + expiry for `kind: 'oauth'` rows; absent for API keys. */
  oauth?: OAuthAccountView | null
  /**
   * True when this account's grant IS the provider's live projection
   * (round-2 review, step 6); only ever set on `kind: 'oauth'` rows.
   * Round-3 N3: this per-key flag is the single wire carrier of ownership —
   * the provider-view `projectedAccountId` duplicate was removed.
   */
  projected?: boolean
  /** Latest cached plan usage; absent until a quota refresh ran for this row. */
  quota?: QuotaView
}

/** Public provider row returned to the UI. */
export interface ProviderView {
  provider: string
  displayName: string
  source: 'dsh' | 'extra'
  /** Where the route came from: DSH catalog, this plugin's catalog, or a hand-declared profile. */
  origin?: 'dsh' | 'plugin' | 'custom'
  /** True when this plugin created the route profile and release removes it. */
  createdProfile?: boolean
  managed: boolean
  configured: boolean
  active: boolean
  /** Key-pool verdict: can this route take API keys (Add key / addKey). */
  supported: boolean
  /**
   * Account-management verdict: can this route be adopted for OAuth
   * account sign-in. Distinct from `supported` (MF1): an OAuth-only route
   * is account-adoptable while carrying no key-pool credential.
   */
  accountSupported?: boolean
  /** True when another plugin serves this route on its own credential (not the pi-ai key pool). */
  transport?: boolean
  reason?: string
  settingsNs: string
  settingsPath: string[]
  apiKeyEnv: string | null
  brokerRef: string | null
  bindingHealthy?: boolean
  extra: boolean
  extraId: string | null
  api: string | null
  baseURL: string | null
  env: string[]
  defaultBaseURL: string | null
  nativeAuth: { env: string[]; oauth: boolean } | null
  models: ModelRecord[]
  keyCount: number
  healthyKeyCount: number
  status: ProviderStatus
  keys: KeyView[]
  warning?: string
  /**
   * Requests this route served before its ownership read decided which
   * account serves it (`I-000120`, D8). Process-local and additive: an older
   * snapshot without the field still renders, and zero keeps it absent.
   */
  unattributedRequests?: number
}

/** Health state a transport account row renders. */
export type TransportAccountStatus = 'active' | 'expired' | 'needs-reauth' | 'signed-out'

/**
 * One `llm-omp-transports/<route>` account held beside the pi-ai pool.
 *
 * A transport route keeps exactly one grant record, so a row is either that
 * record's secret-free view or the route's signed-out placeholder. It never
 * carries the grant payload itself, and it is never part of a pi-ai
 * projection: the transports package's own adapter resolves the record.
 */
export interface TransportAccountView {
  /** Provider route the grant serves, e.g. 'cursor'. */
  id: string
  /** The credential record holding the grant, e.g. 'llm-omp-transports/cursor'. */
  scope: string
  displayName: string
  email?: string
  accountId?: string
  /** Epoch ms when the access token expires. */
  expiresAt?: number
  status: TransportAccountStatus
  /** Derived from {@link status}: true only while it is `'active'`. */
  active: boolean
}

/** One model row a transport route can advertise. */
export interface TransportCatalogModel {
  id: string
  name: string
}

/**
 * Catalog plus configured allow-list for one transport route's model picker.
 *
 * `models` is the allow-list; an empty list means the route advertises the
 * full catalog, exactly like its adapter.
 */
export interface TransportModelsView {
  catalog: TransportCatalogModel[]
  models: string[]
  /**
   * The installed transport build ships no catalog accessor for this route.
   *
   * A stable marker rather than host copy: the picker explains the empty list
   * with its own localized string, so the wire carries only the fact. Set on
   * every read whose accessor is missing, so a remounted or reloaded picker
   * still explains the empty list; absent for every route that does ship a
   * catalog. The one-shot part of this report is the {@link StateView.warnings}
   * entry, not this field.
   */
  missingCatalog?: boolean
}

/** Complete manager snapshot the UI renders. */
export interface StateView {
  now: number
  writable: boolean
  settings: ManagerSettings
  providers: ProviderView[]
  managedCount: number
  keyCount: number
  healthyKeyCount: number
  coolingKeyCount: number
  pausedKeyCount: number
  bindingsCount: number
  warnings: string[]
  /**
   * Transport accounts managed beside the pi-ai pool. Additive and optional,
   * so a snapshot from a build without transport support still renders.
   */
  transportAccounts?: TransportAccountView[]
}

/**
 * Outcome of one per-row connection test: one minimal request through the
 * provider route, with no health or selection side effects.
 */
export interface KeyTestResult {
  ok: boolean
  /** Wall-clock time of the request that was actually sent. */
  latencyMs: number
  /** Provider failure message, timeout, or the reason no request was sent. */
  error?: string
}

/** One curated extra built-in provider. */
export interface ExtraProvider {
  id: string
  name: string
  api: string
  baseURL: string
  env: string[]
  /**
   * Static request headers this route needs. Maps header name → environment
   * variable name; each value is resolved from the environment at add time.
   * Only non-secret metadata headers are supported: values are persisted as
   * plain profile settings, so a credential-bearing name (`authorization`,
   * `proxy-authorization`, `cookie`, `x-api-key`, `*-api-key`) is refused.
   */
  headerEnv?: Record<string, string>
  models: ModelRecord[]
}

/** Serializable notice captured on an interactive sign-in attempt. */
export interface AccountAttemptNotice {
  message: string
  url?: string
  code?: string
}

/** Serializable prompt parked on an interactive sign-in attempt. */
export interface AccountAttemptPrompt {
  /**
   * `manual-code` is the out-of-band paste step an OAuth-code flow parks on
   * (a `zcode://` redirect, or the Devin callback address): the dialog masks
   * the field like a `secret`, offers a reveal toggle and carries the paste
   * guidance, unlike a generic `text` prompt.
   */
  kind: 'text' | 'secret' | 'select' | 'manual-code'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

/**
 * Serializable state of one interactive OAuth sign-in attempt, shared by the
 * Host service and the Web Client. Secrets never appear: prompts and notices
 * carry messages, URLs, and codes only.
 */
export interface AccountAttemptView {
  id: string
  provider: string
  alias?: string
  status: 'pending' | 'prompt' | 'ready' | 'failed' | 'cancelled'
  notices: AccountAttemptNotice[]
  prompt?: AccountAttemptPrompt
  error?: string
  /** Pool member id of the account row a successful login produced. */
  accountId?: string
  createdAt: number
  updatedAt: number
}
