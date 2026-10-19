/** Browser-half domain and service contracts for the Keys Manager. */
import type * as React from 'react'
import type { KeyStatus, KeyView, ManagerSettings, OAuthAccountView, ProviderStatus, ProviderView, StateView } from '../domain'

export type { KeyStatus, KeyView, ManagerSettings, OAuthAccountView, ProviderStatus, ProviderView, StateView }

/** Locale dictionaries registered under the plugin namespace. */
export interface LocaleDicts {
  zh: Record<string, string>
  en: Record<string, string>
}

/**
 * Successful or failed `keysManager/*` Remote answer. The payload is wire
 * JSON; each store method narrows it to its own view type.
 */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { message: string } }

/** One unary result surfaced by the client store. */
export type ActionOutcome =
  | { ok: true; value: StateView }
  | { ok: false; error: string }

/** Serializable notice captured on a sign-in attempt (mirror of the host's LoginNoticeView). */
export interface AccountAttemptNotice {
  message: string
  url?: string
  code?: string
}

/** Serializable prompt parked on a sign-in attempt (mirror of LoginPromptView). */
export interface AccountAttemptPrompt {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

/**
 * Serializable state of one interactive OAuth sign-in attempt (mirror of the
 * host's LoginAttemptView). Secrets never appear: prompts and notices carry
 * messages, URLs, and codes only.
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

/** Result of an attempt-scoped RPC; `null` means the attempt id is unknown. */
export type AccountAttemptResult =
  | { ok: true; value: AccountAttemptView | null }
  | { ok: false; error: string }

/** Result of the attempt-list RPC. */
export type AccountAttemptListResult =
  | { ok: true; value: AccountAttemptView[] }
  | { ok: false; error: string }

/** Result of an RPC that carries no meaningful payload. */
export type AckResult =
  | { ok: true; value: null }
  | { ok: false; error: string }

/** Immutable UI snapshot. */
export interface ClientSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  state: StateView | null
  error: string | null
  busy: string | null
  now: number
}

/** Store shared by the plugin-detail card and the Models badges. */
export interface ClientStore {
  getSnapshot(): ClientSnapshot
  subscribe(listener: () => void): () => void
  load(options?: { keepError?: boolean }): Promise<void>
  call(method: string, args: Record<string, unknown>): Promise<ActionOutcome>
  /** Start an interactive OAuth sign-in; resolves with the attempt view. */
  beginAccountLogin(provider: string, alias?: string): Promise<AccountAttemptResult>
  /** Resolve the attempt's parked prompt with the human's answer. */
  answerAccountPrompt(attemptId: string, value: string): Promise<AckResult>
  /** Poll one attempt's state; read-only, never sets the busy flag. */
  accountAttempt(attemptId: string): Promise<AccountAttemptResult>
  /** List every known attempt, newest first (page reload recovery). */
  listAccountAttempts(): Promise<AccountAttemptListResult>
  /** Project one account's grant as the provider's active credential. */
  activateAccount(provider: string, accountId: string): Promise<ActionOutcome>
  /** Drop one account row and its stored grant payload. */
  removeAccount(provider: string, accountId: string): Promise<ActionOutcome>
  tick(): void
  dismissError(): void
}

/** Locale snapshot exposed by the Client locale service. */
export interface LocaleSnapshot {
  active: string
  locales: readonly unknown[]
  revision: number
}

/** Slot registration options, narrowed to the fields this plugin uses. */
export interface SlotRegistrationOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
}

/** Services required by the browser half. */
export interface ClientContext {
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: { args: Record<string, unknown> }): Promise<RpcResult>
    }
  }
  locale: {
    register(ns: string, dicts: LocaleDicts): () => void
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string
    subscribe(listener: () => void): () => void
    getSnapshot(): LocaleSnapshot
  }
  slots: {
    inject(key: string, callback: () => undefined | (() => void)): () => void
    register(options: SlotRegistrationOptions, component: React.ComponentType<any>): () => void
  }
  on(name: string, listener: (...args: any[]) => void): () => void
  effect(effect: () => undefined | (() => void), label?: string): () => void
}

/** Runtime value threaded through the generated React context. */
export interface Runtime {
  ctx: ClientContext
  store: ClientStore
}
