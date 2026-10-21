/**
 * Minimal Host service contracts used by the plugin.
 *
 * These interfaces name only the methods Keys Manager calls. The real
 * implementations are the shipped DSH services; keeping the contract local
 * avoids coupling the plugin to adapter internals while still type-checking
 * every call site.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { KeyRecord, ManagerSettings, ModelRecord } from './domain.js'

/** One provider route from `llm.listConfigurableProviders()`. */
export interface DirectoryEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared?: boolean
  defaultBaseURL?: string
  baseURLEnv?: readonly string[]
  nativeAuth?: { env: readonly string[]; oauth: boolean }
  error?: string
}

/** One model an endpoint disclosed during discovery. */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ReadonlyArray<'text' | 'image'>
}

/** Request sent to the adapter's model-discovery operation. */
export interface DiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

/** The LLM runtime methods Keys Manager uses. */
export interface LlmRuntimeLike {
  listConfigurableProviders(): DirectoryEntry[]
  listProviders(): Array<{ id: string; name: string }>
  discoverModels(settingsNs: string, request: DiscoveryRequest, signal: AbortSignal): Promise<DiscoveredModel[]>
  /**
   * One model request through the provider route. The host runs the
   * `llm/stream` waterfall, so the manager's own stream listener — and the
   * broker credential wrapper — observe it exactly like a chat request.
   */
  stream(options: {
    provider: string
    model: string
    messages: readonly unknown[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<StreamChunkLike>
}

/** Credential value/source facts returned by the credential seam. */
export interface CredentialHit {
  value: string
  source: string
}

/** Credential presence facts returned by the credential seam. */
export interface CredentialDescription {
  configured: boolean
  source?: string
  writable: boolean
}

/** One way a flow can obtain its credential, named by the flow that offers it. */
export interface AuthorizationMethodEntry {
  id: string
  label: string
}

/** One registered authorization flow (shape of `AuthorizationEntry`). */
export interface AuthorizationFlowEntry {
  /** The credential record this flow writes, e.g. `llm-pi-ai/anthropic`. */
  key: string
  label: string
  methods: readonly AuthorizationMethodEntry[]
  inFlight: boolean
}

/** The interaction surface a begin() caller supplies (shape of `AuthorizationInteraction`). */
export interface AuthorizationInteractionLike {
  notify(notice: { message: string; url?: string; code?: string }): void
  prompt(prompt: {
    kind?: 'text' | 'secret' | 'select'
    message: string
    placeholder?: string
    options?: ReadonlyArray<{ id: string; label: string; description?: string }>
    signal?: AbortSignal
  }): Promise<string>
}

/** The outcome of one begin() attempt (shape of `AuthorizationOutcome`). */
export interface AuthorizationOutcomeLike {
  status: 'authorized' | 'cancelled'
}

/** The authorization service methods Keys Manager uses. */
export interface AuthorizationLike {
  list(): readonly AuthorizationFlowEntry[]
  describe(key: string): AuthorizationFlowEntry | undefined
  begin(request: {
    key: string
    method?: string
    interaction: AuthorizationInteractionLike
    signal?: AbortSignal
  }): Promise<AuthorizationOutcomeLike>
}

/** The credential provider methods the broker wraps. */
export interface CredentialsLike {
  resolve(ref: string): Promise<CredentialHit | undefined>
  describe(ref: string): Promise<CredentialDescription>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** One stored credential record (shape of `CredentialRecord`). */
export interface CredentialRecordLike {
  kind: 'api-key' | 'grant'
  key?: string
  env?: Record<string, string>
  /** Grant payloads are opaque JSON owned by their writer (pi-ai). */
  payload?: unknown
}

/** The credential record methods Keys Manager uses for OAuth grants. */
export interface CredentialRecordsLike {
  readRecord(key: string): Promise<CredentialRecordLike | undefined>
  modifyRecord(
    key: string,
    mutate: (current: CredentialRecordLike | undefined) => Promise<CredentialRecordLike | undefined>,
  ): Promise<CredentialRecordLike | undefined>
  deleteRecord(key: string): Promise<void>
}

/**
 * The grant payload the llm-omp transports package writes at
 * `llm-omp-transports/<route>`. Keys Manager only reads it (list/status) and
 * deletes the whole record; the payload stays owned by its writer, so this is
 * a structural shape (the package exports no runtime type for it without
 * pulling its transport code in).
 */
export interface TransportGrantLike {
  /** Bearer token the route's adapter sends. */
  access: string
  /** Refresh token; absent on a grant that cannot be renewed. */
  refresh?: string
  /** Epoch ms when the access token expires. */
  expires: number
  email?: string
  accountId?: string
}

/** One path-addressed settings edit. */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** One live settings namespace descriptor. */
export interface SettingsDescriptorLike {
  ns: string
  value: unknown
  revision: number
}

/** The settings service methods Keys Manager uses. */
export interface SettingsLike {
  readonly writable: boolean
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** The Typert registry method Keys Manager uses. */
export interface TypertLike {
  register(contribution: unknown): () => void
}

/** Host context surface this plugin requires. */
export type HostContext = Context & {
  llm: LlmRuntimeLike
  credentials: CredentialsLike & Partial<CredentialRecordsLike>
  settings?: SettingsLike
  typert: TypertLike
  authorization?: AuthorizationLike
}

/** Serializable provider failure facts relevant to key health. */
export interface LlmFailureLike {
  code: string
  message?: string
  providerRetryAfterMs?: number
}

/** One stream chunk; only `finish` is inspected by the broker. */
export interface StreamChunkLike {
  type: string
  reason?: {
    kind: string
    failure?: LlmFailureLike
  }
}

/** Minimal `GenerateOptions` surface observed by the stream listener. */
export interface GenerateOptionsLike {
  provider: string
  model: string
  sessionId?: string
  /** Host-side bypass purposes; any value opts the stream out of retry pins. */
  purpose?: 'compaction' | 'session-title'
  messages: readonly unknown[]
}

/** Payload of the `agent/request` waterfall (subset used here). */
export interface AgentRequestPayload {
  agent?: { session?: { id?: string } }
  turn: number
  step: number
}

/** Payload of the `agent/request-error` waterfall. */
export interface RequestErrorPayload {
  agent: { session: { id: string } }
  turn: number
  step: number
  provider: string
  failure: LlmFailureLike
  retryPolicy?: unknown
  signal: AbortSignal
}

/** Return value of the request-error waterfall. */
export type RequestErrorAction = { kind: 'retry' } | undefined

/** Selection result for one request. */
export interface KeySelection {
  key: KeyRecord | undefined
  value: string | undefined
}

/** Attempt bookkeeping for retry/failover decisions. */
export interface AttemptState {
  keyId: string | undefined
  retries: number
  failure?: LlmFailureLike
  at: number
  turn?: number
  step?: number
  /** Whether the request actually resolved a managed key through the broker. */
  usedManagedKey?: boolean
  /** Monotonic stream-sequence attribution for this step. */
  lastSequence?: number
  /** Retry budget consumed per selected key. */
  keyRetries?: Record<string, number>
}

/** Provider support verdict used by the UI. */
export interface ProviderSupport {
  supported: boolean
  reason?: string
}

export type { ManagerSettings, ModelRecord }
