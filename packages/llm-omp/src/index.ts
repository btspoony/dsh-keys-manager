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

import { CURSOR_ROUTE, OmpCursorAdapter } from './adapter.js'
import { loginCursor } from './cursor/auth.js'
import type { CursorFetch } from './cursor/auth.js'
import { CURSOR_CREDENTIAL_KEY, createCursorAccess } from './cursor/credentials.js'
import type { CredentialRecordsLike } from './cursor/credentials.js'
import type { OmpCursorTransport } from './omp.js'

/** Machine code for a transport artifact that cannot be loaded. */
export const TRANSPORT_UNAVAILABLE = 'TRANSPORT_UNAVAILABLE'

/**
 * Plugin configuration.
 *
 * @remarks
 * Empty on purpose: a transport declares its endpoints and its pinned
 * client identity in code, so there is nothing for a profile to configure
 * yet. The runtime schema below keeps that contract explicit and gives the
 * loader a validated (empty) surface.
 */
export interface Config {}

/** Runtime schema for {@link Config}. */
export const Config = z.object({})

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

/** What a running flow is given, narrowed to what this flow calls. */
export interface CursorAuthorizationSession {
  readonly method: string
  /** Aborted when the caller withdraws the attempt. */
  readonly signal: AbortSignal
  /** Report the page the human must open, or what is happening. */
  notify(notice: { message: string; url?: string; code?: string }): void
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
  prompt(prompt: {
    kind: 'text' | 'secret' | 'select'
    message: string
    placeholder?: string
    options?: readonly { id: string; label: string; description?: string }[]
    signal?: AbortSignal
  }): Promise<string>
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
          email: grant.email,
          accountId: grant.accountId,
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

/**
 * Load the bundled omp transport on first use.
 *
 * @remarks
 * `apply()` must not fail when the build artifact is missing (a partial
 * install, a source checkout without `pnpm build`): the import starts at the
 * first request and its failure reaches that request as a typed `LlmError`.
 */
function bundledCursorTransport(): OmpCursorTransport {
  return (model, context, options) =>
    (async function* () {
      let streamCursor: OmpCursorTransport
      try {
        const artifact = (await import(new URL('./omp/cursor.mjs', import.meta.url).href)) as {
          streamCursor?: OmpCursorTransport
        }
        if (typeof artifact.streamCursor !== 'function') {
          throw new Error('the artifact exports no streamCursor')
        }
        streamCursor = artifact.streamCursor
      } catch (cause) {
        throw new LlmError(
          'llm-omp: the bundled Cursor transport is unavailable; run `pnpm build` in the transports package',
          TRANSPORT_UNAVAILABLE,
          { cause },
        )
      }
      yield* streamCursor(model, context, options)
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
export function createCursorAdapter(credentials: CredentialRecordsLike): OmpCursorAdapter {
  return new OmpCursorAdapter({
    access: createCursorAccess(credentials),
    transport: bundledCursorTransport(),
  })
}

export function apply(ctx: Context, _config: Config = {}): void {
  const host = ctx as Context & {
    credentials: CredentialRecordsLike
    authorization: AuthorizationLike
  }

  ctx.llm.registerAdapter([CURSOR_ROUTE], createCursorAdapter(host.credentials))
  ctx.llm.registerConfigurableProviders([CURSOR_PROVIDER])
  host.authorization.registerFlow(cursorAuthorizationFlow())
}

export { CURSOR_ROUTE } from './adapter.js'
export { CURSOR_CREDENTIAL_KEY } from './cursor/credentials.js'
