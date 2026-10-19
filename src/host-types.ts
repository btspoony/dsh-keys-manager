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

/** The credential provider methods the broker wraps. */
export interface CredentialsLike {
  resolve(ref: string): Promise<CredentialHit | undefined>
  describe(ref: string): Promise<CredentialDescription>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
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
  credentials: CredentialsLike
  settings?: SettingsLike
  typert: TypertLike
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
