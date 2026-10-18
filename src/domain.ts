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

/** Reserved OAuth2 account payload; unset for API-key rows. */
export type OAuthRecord = Record<string, unknown>

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
  /** Reserved for subscription OAuth2 accounts. */
  oauth: OAuthRecord | null
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
}

/** Public provider row returned to the UI. */
export interface ProviderView {
  provider: string
  displayName: string
  source: 'dsh' | 'extra'
  /** Where the route came from: DSH catalog, this plugin's catalog, or a hand-declared profile. */
  origin?: 'dsh' | 'plugin' | 'custom'
  managed: boolean
  configured: boolean
  active: boolean
  supported: boolean
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
}

/** One curated extra built-in provider. */
export interface ExtraProvider {
  id: string
  name: string
  api: string
  baseURL: string
  env: string[]
  models: ModelRecord[]
}
