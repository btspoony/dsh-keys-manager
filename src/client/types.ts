/** Browser-half domain and service contracts for the Keys Manager. */
import type * as React from 'react'
import type { KeyStatus, KeyView, ManagerSettings, ProviderStatus, ProviderView, StateView } from '../domain'

export type { KeyStatus, KeyView, ManagerSettings, ProviderStatus, ProviderView, StateView }

/** Locale dictionaries registered under the plugin namespace. */
export interface LocaleDicts {
  zh: Record<string, string>
  en: Record<string, string>
}

/** Successful or failed `keysManager/*` Remote answer. */
export type RpcResult =
  | { ok: true; value: StateView }
  | { ok: false; error: { message: string } }

/** One unary result surfaced by the client store. */
export type ActionOutcome =
  | { ok: true; value: StateView }
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
