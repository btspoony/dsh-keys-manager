/**
 * llm-omp-transports Host half — the transport plugin for providers whose wire protocols
 * cannot be expressed through DSH's provider *configuration* surfaces.
 *
 * The plugin registers its own route on the `llm` seam, so nothing here depends
 * on an upstream DSH change. Per run it:
 *
 * - registers the bundled omp `cursor` adapter (`lib/omp/cursor.mjs`, imported
 *   lazily so an install without the artifact still loads), with an access
 *   resolver that reads and refreshes `llm-omp-transports/cursor` through
 *   `ctx.credentials`;
 * - declares the route as configurable, so the Models settings page has a
 *   profile entry for it;
 * - registers the `llm-omp-transports/cursor` authorization flow (browser
 *   sign-in, poll, commit).
 *
 * DSH ships no generic flow browser, so a surface that wants a "Sign in"
 * button calls {@link beginCursorSignIn}. The keys-manager Web page is that
 * surface in the next task; nothing here requires a client.
 *
 * @module dsh-llm-omp-transports
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import { CURSOR_ROUTE, DEVIN_ROUTE, OmpCursorAdapter, OmpDevinAdapter } from './adapter.js'
import type { OmpTransportOf } from './adapter.js'
import { CURSOR_MODELS } from './catalog/cursor.js'
import { DEVIN_MODELS } from './catalog/devin.js'
import { loginCursor } from './cursor/auth.js'
import type { CursorFetch } from './cursor/auth.js'
import { CURSOR_CREDENTIAL_KEY, createCursorAccess } from './cursor/credentials.js'
import type { CredentialRecordsLike } from './cursor/credentials.js'
import { DevinAuthError, loginDevin } from './devin/auth.js'
import type { DevinFetch, DevinGrant } from './devin/auth.js'
import { DEVIN_CREDENTIAL_KEY, createDevinAccess } from './devin/credentials.js'

/** Machine code for a transport artifact that cannot be loaded. */
export const TRANSPORT_UNAVAILABLE = 'TRANSPORT_UNAVAILABLE'

/** One model row the Cursor route can advertise. */
export interface TransportCatalogModel {
  id: string
  name: string
}

/** One configured model row beneath `providers.cursor.models`. */
export type TransportModelProfile = TransportCatalogModel

/** The configured profile of one transport route. */
export interface TransportProviderProfile {
  models: TransportModelProfile[]
}

/** The `providers` profile a volatile config reference snapshots. */
export interface TransportProvidersProfile {
  cursor?: TransportProviderProfile
  devin?: TransportProviderProfile
}

/** A live config reference (cosmokit `Volatile`) a volatile schema node resolves to. */
export interface ConfigReference<T> {
  get(): T
}

/**
 * Plugin configuration.
 *
 * @remarks
 * `providers.cursor` is the route's entry in the configurable-provider
 * directory (`CURSOR_PROVIDER.settingsPath`). Consumers that list *configured*
 * providers decide by that settings path, so the entry must resolve with no
 * user write; the node is `.volatile()` because `settings.describe` only
 * projects declared fields below a volatile ancestor. A volatile node arrives
 * as a live reference, not a plain object: a settings save updates it in place
 * without re-running `apply`.
 */
export interface Config {
  providers?: ConfigReference<TransportProvidersProfile>
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  providers: z
    .object({
      cursor: z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
      devin: z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
    })
    .default({ cursor: { models: [] }, devin: { models: [] } })
    .volatile(),
})

/**
 * The full Cursor catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * `listModels` answers with the configured allow-list, so a picker cannot
 * discover the models a narrowed route could still advertise. The transport
 * package exports the unfiltered projection instead of adding a service or a
 * package subpath.
 */
export function cursorCatalogModels(): TransportCatalogModel[] {
  return CURSOR_MODELS.map(row => ({ id: row.id, name: row.name }))
}

/**
 * The full Devin catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * The twin of {@link cursorCatalogModels}: the root keys-manager's model picker
 * needs the unfiltered rows even when `providers.devin.models` narrows what the
 * route advertises.
 */
export function devinCatalogModels(): TransportCatalogModel[] {
  return DEVIN_MODELS.map(row => ({ id: row.id, name: row.name }))
}

export const name = 'llm-omp-transports'

/**
 * Sibling services this plugin reads. `llm` owns the route, `credentials` the
 * grant record, and `authorization` the flow that writes it.
 */
export const inject = ['llm', 'credentials', 'authorization']

/** The route's Models-page entry: Cursor is served by this adapter, not by configuration alone. */
const CURSOR_PROVIDER = {
  provider: CURSOR_ROUTE,
  displayName: 'Cursor',
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'cursor'],
  declared: false,
} as const

/** The route's Models-page entry, beside {@link CURSOR_PROVIDER}. */
const DEVIN_PROVIDER = {
  provider: DEVIN_ROUTE,
  displayName: 'Devin',
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'devin'],
  declared: false,
} as const

/** The authorization seam surface this plugin registers a flow on. */
interface AuthorizationLike {
  registerFlow(flow: CursorAuthorizationFlow): unknown
  begin(request: {
    key: string
    method?: string
    interaction: CursorSignInInteraction
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }>
}

/** One question the authorization seam can put to the human. */
export interface AuthorizationPrompt {
  readonly kind: 'text' | 'secret' | 'manual-code' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { id: string; label: string; description?: string }[]
  readonly signal?: AbortSignal
}

/** What a running flow is given, narrowed to what these flows call. */
export interface CursorAuthorizationSession {
  readonly method: string
  /** Aborted when the caller withdraws the attempt. */
  readonly signal: AbortSignal
  /** Report the page the human must open, or what is happening. */
  notify(notice: { message: string; url?: string; code?: string }): void
  /** Ask the human for a value; Cursor's flow never needs it, Devin's paste does. */
  prompt(prompt: AuthorizationPrompt): Promise<string>
  /** Commit the grant; the seam rejects an attempt that was cancelled meanwhile. */
  commit(record: { kind: 'grant'; payload: unknown }): Promise<void>
}

/** One registered flow, as the seam declares it. */
export interface CursorAuthorizationFlow {
  readonly key: string
  readonly label: string
  readonly methods: readonly [{ id: string; label: string }, ...{ id: string; label: string }[]]
  run(session: CursorAuthorizationSession): Promise<void>
}

/** The interaction a {@link beginCursorSignIn} caller supplies (shape of `AuthorizationInteraction`). */
export interface CursorSignInInteraction {
  notify(notice: { message: string; url?: string; code?: string }): void
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/** Test seams for the flow; the plugin uses the real network and timers. */
export interface CursorFlowOptions {
  readonly fetch?: CursorFetch
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * The `llm-omp-transports/cursor` sign-in flow.
 *
 * @remarks
 * Cursor's sign-in is one browser page plus a poll: there is no loopback
 * callback and no device code, so the flow only ever *notifies* — it never
 * needs `session.prompt`. `session.signal` stops the poll and the profile read.
 */
export function cursorAuthorizationFlow(options: CursorFlowOptions = {}): CursorAuthorizationFlow {
  return {
    key: CURSOR_CREDENTIAL_KEY,
    label: 'Cursor',
    methods: [{ id: 'oauth', label: 'Sign in with Cursor' }],
    async run(session) {
      const grant = await loginCursor({
        fetch: options.fetch,
        sleep: options.sleep,
        signal: session.signal,
        onAuthUrl: url =>
          session.notify({ message: 'Open this page to sign in to Cursor, then come back; this window waits.', url }),
      })
      await session.commit({
        kind: 'grant',
        payload: {
          access: grant.access,
          refresh: grant.refresh,
          expires: grant.expires,
          // The seam validates the payload as a JSON value, so an absent
          // identity field must be absent, not `undefined`.
          ...(grant.email === undefined ? {} : { email: grant.email }),
          ...(grant.accountId === undefined ? {} : { accountId: grant.accountId }),
        },
      })
    },
  }
}

/**
 * Start the Cursor sign-in for a host-side surface.
 *
 * @remarks
 * `ctx.authorization.begin` owns the one-attempt-per-key rule and checks that
 * the flow committed; this wrapper only fixes the key. The keys-manager Web
 * page is the first caller.
 */
export function beginCursorSignIn(
  ctx: Context,
  interaction: CursorSignInInteraction,
  signal?: AbortSignal,
): Promise<{ status: 'authorized' | 'cancelled' }> {
  const { authorization } = ctx as Context & { authorization: AuthorizationLike }
  return authorization.begin({ key: CURSOR_CREDENTIAL_KEY, interaction, signal })
}

/** Test seams for the Devin flow; the plugin uses the real network and clock. */
export interface DevinFlowOptions {
  readonly fetch?: DevinFetch
  readonly now?: () => number
}

/**
 * The `llm-omp-transports/devin` sign-in flow.
 *
 * @remarks
 * omp completes this login with a loopback listener on `127.0.0.1:59653`, but
 * that listener is Bun-only and the browser half is not verifiable offline, so
 * this flow asks the human to paste the address the browser landed on instead.
 * The page cannot load (nothing listens there), and only a code plus an
 * optional state travel back through `session.prompt`.
 */
export function devinAuthorizationFlow(options: DevinFlowOptions = {}): CursorAuthorizationFlow {
  return {
    key: DEVIN_CREDENTIAL_KEY,
    label: 'Devin',
    methods: [{ id: 'oauth', label: 'Sign in with Devin' }],
    async run(session) {
      let grant: DevinGrant
      try {
        grant = await loginDevin({
          fetch: options.fetch,
          now: options.now,
          signal: session.signal,
          onAuthUrl: url => session.notify({ message: 'Open this page to sign in to Devin.', url }),
          prompt: () =>
            session.prompt({
              // The pasted callback carries the authorization code, so the
              // shared dialog must mask it and offer the paste hint.
              kind: 'manual-code',
              message:
                'Your browser will land on a 127.0.0.1:59653 page that cannot load. Paste the whole address (or just the code) here.',
              placeholder: 'http://127.0.0.1:59653/callback?code=…&state=…',
              signal: session.signal,
            }),
        })
      } catch (cause) {
        // An abort is the caller withdrawing; the seam turns it into a cancelled attempt.
        if (session.signal.aborted) throw cause
        if (cause instanceof DevinAuthError) {
          throw new LlmError(`llm-omp-transports: Devin sign-in failed — ${cause.message}`, 'AUTH_FAILED', { cause })
        }
        throw cause
      }
      await session.commit({ kind: 'grant', payload: { access: grant.access, expires: grant.expires } })
    },
  }
}

/**
 * Load one bundled omp transport on first use.
 *
 * @remarks
 * `apply()` must not fail when a build artifact is missing (a partial install,
 * a source checkout without `pnpm build`): the import starts at the first
 * request and its failure reaches that request as a typed `LlmError`.
 */
function bundledTransport<Model, Options>(
  artifact: 'cursor' | 'devin',
  exportName: 'streamCursor' | 'streamDevin',
  label: string,
): OmpTransportOf<Model, Options> {
  return (model, context, options) =>
    (async function* () {
      let stream: OmpTransportOf<Model, Options>
      try {
        const loaded = (await import(new URL(`./omp/${artifact}.mjs`, import.meta.url).href)) as Record<string, unknown>
        const candidate = loaded[exportName]
        if (typeof candidate !== 'function') throw new Error(`the artifact exports no ${exportName}`)
        stream = candidate as OmpTransportOf<Model, Options>
      } catch (cause) {
        throw new LlmError(
          `llm-omp-transports: the bundled ${label} transport is unavailable; run \`pnpm build\` in the transports package`,
          TRANSPORT_UNAVAILABLE,
          { cause },
        )
      }
      yield* stream(model, context, options)
    })()
}

/**
 * Build the Cursor adapter this plugin registers.
 *
 * @remarks
 * Exported so a host-side surface can reach the route and its catalog without
 * going through registration, and so the wiring is testable with a fake
 * credential store. The transport is the bundled artifact, still loaded only on
 * the first request.
 */
export function createCursorAdapter(credentials: CredentialRecordsLike, models?: () => readonly string[] | undefined): OmpCursorAdapter {
  return new OmpCursorAdapter({
    access: createCursorAccess(credentials),
    transport: bundledTransport('cursor', 'streamCursor', 'Cursor'),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * Build the Devin adapter this plugin registers.
 *
 * @remarks
 * The twin of {@link createCursorAdapter}: the record resolver only reads (the
 * rule has no refresh), and the bundled artifact still loads on the first
 * request.
 */
export function createDevinAdapter(credentials: CredentialRecordsLike, models?: () => readonly string[] | undefined): OmpDevinAdapter {
  return new OmpDevinAdapter({
    access: createDevinAccess(credentials),
    transport: bundledTransport('devin', 'streamDevin', 'Devin'),
    ...(models === undefined ? {} : { models }),
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const host = ctx as Context & {
    credentials: CredentialRecordsLike
    authorization: AuthorizationLike
  }

  const providers = config.providers
  // A settings file is user input: drop a malformed row instead of throwing
  // from `listModels`/`stream`, which would take the whole route down.
  const models = (route: 'cursor' | 'devin') => (): readonly string[] | undefined =>
    providers?.get()[route]?.models?.flatMap(row => (typeof row?.id === 'string' ? [row.id] : []))
  ctx.llm.registerAdapter([CURSOR_ROUTE], createCursorAdapter(host.credentials, models('cursor')))
  ctx.llm.registerAdapter([DEVIN_ROUTE], createDevinAdapter(host.credentials, models('devin')))
  ctx.llm.registerConfigurableProviders([CURSOR_PROVIDER, DEVIN_PROVIDER])
  host.authorization.registerFlow(cursorAuthorizationFlow())
  host.authorization.registerFlow(devinAuthorizationFlow())
}

export { CURSOR_ROUTE, DEVIN_ROUTE } from './adapter.js'
export { CURSOR_CREDENTIAL_KEY } from './cursor/credentials.js'
export { DEVIN_CREDENTIAL_KEY } from './devin/credentials.js'
