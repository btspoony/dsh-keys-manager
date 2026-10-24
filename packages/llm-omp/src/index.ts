/**
 * llm-omp-transports Host half — the transport plugin for providers whose wire protocols
 * cannot be expressed through DSH's provider *configuration* surfaces.
 *
 * The plugin registers its own routes on the `llm` seam, so nothing here depends
 * on an upstream DSH change. It serves four routes — `cursor`, `devin`,
 * `google-gemini-cli` and `google-antigravity` — and per run it:
 *
 * - registers the bundled omp adapters (`lib/omp/cursor.mjs`, `devin.mjs` and
 *   the shared `google.mjs`, imported lazily so an install without an artifact
 *   still loads), each with an access resolver that reads and refreshes its own
 *   `llm-omp-transports/<route>` grant through `ctx.credentials`;
 * - declares every route as configurable, so the Models settings page has a
 *   profile entry for each;
 * - registers one authorization flow per route: a browser sign-in plus poll for
 *   Cursor, a paste-the-callback prompt for Devin, and a Node loopback listener
 *   with a paste fallback for the Google pair.
 *
 * DSH ships no generic flow browser, so a surface that wants a "Sign in"
 * button calls the route's own begin function ({@link beginCursorSignIn} and
 * its siblings). The keys-manager Web page is that surface.
 *
 * @module dsh-llm-omp-transports
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import {
  CURSOR_ROUTE,
  DEVIN_ROUTE,
  FACTORY_DROID_CREDENTIAL_KEY,
  FACTORY_DROID_ROUTE,
  FACTORY_DROID_TRANSPORT_ROUTE,
  GITLAB_DUO_AGENT_CREDENTIAL_KEY,
  GITLAB_DUO_AGENT_ROUTE,
  GITLAB_DUO_AGENT_TRANSPORT_ROUTE,
  GITLAB_DUO_CREDENTIAL_KEY,
  GITLAB_DUO_ROUTE,
  GITLAB_DUO_TRANSPORT_ROUTE,
  GOOGLE_ANTIGRAVITY_ROUTE,
  GOOGLE_GEMINI_CLI_ROUTE,
  OmpCursorAdapter,
  OmpDevinAdapter,
  OmpFactoryDroidAdapter,
  OmpGitLabDuoAdapter,
  OmpGitLabDuoAgentAdapter,
  OmpGoogleAntigravityAdapter,
  OmpGoogleGeminiCliAdapter,
} from './adapter.js'
import type { OmpTransportOf } from './adapter.js'
import { FactoryDroidAuthError, loginFactoryDroid } from './factory-droid/auth.js'
import type { FactoryDroidFetch } from './factory-droid/auth.js'
import { createFactoryDroidAccess, readFactoryDroidGrant } from './factory-droid/credentials.js'
import { GitLabAuthError, loginGitLab, loginGitLabDuo } from './gitlab/auth.js'
import type { GitLabFetch } from './gitlab/auth.js'
import { createGitLabDuoAccess, createGitLabDuoAgentAccess } from './gitlab/credentials.js'
import { CURSOR_MODELS } from './catalog/cursor.js'
import { DEVIN_MODELS } from './catalog/devin.js'
import { FACTORY_DROID_MODELS } from './catalog/factory-droid.js'
import { GITLAB_DUO_MODELS } from './catalog/gitlab-duo.js'
import { GITLAB_DUO_AGENT_MODELS } from './catalog/gitlab-duo-agent.js'
import { GOOGLE_ANTIGRAVITY_MODELS } from './catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_MODELS } from './catalog/google-gemini-cli.js'
import { loginCursor } from './cursor/auth.js'
import type { CursorFetch } from './cursor/auth.js'
import { CURSOR_CREDENTIAL_KEY, createCursorAccess } from './cursor/credentials.js'
import type { CredentialRecordsLike } from './cursor/credentials.js'
import { DevinAuthError, loginDevin } from './devin/auth.js'
import type { DevinFetch, DevinGrant } from './devin/auth.js'
import { DEVIN_CREDENTIAL_KEY, createDevinAccess } from './devin/credentials.js'
import { loginGoogle } from './google/auth.js'
import type { GoogleFetch, GoogleLoginResult } from './google/auth.js'
import { GoogleAuthError } from './google/callback-listener.js'
import { createGoogleAccess, googleCredentialKey } from './google/credentials.js'
import { GOOGLE_ANTIGRAVITY_FACTS, GOOGLE_GEMINI_CLI_FACTS } from './google/route.js'
import type { GoogleRouteFacts } from './google/route.js'

/** Machine code for a transport artifact that cannot be loaded. */
export const TRANSPORT_UNAVAILABLE = 'TRANSPORT_UNAVAILABLE'

/**
 * One model row a transport route can advertise.
 *
 * Route-neutral: every route's `*CatalogModels()` projection returns these
 * rows, and the host renders them in that route's model picker.
 */
export interface TransportCatalogModel {
  id: string
  name: string
}

/** One configured model row beneath `providers.<route>.models`. */
export type TransportModelProfile = TransportCatalogModel

/** The configured profile of one transport route. */
export interface TransportProviderProfile {
  models: TransportModelProfile[]
}

/** The route ids this plugin registers, in registration order. */
type TransportRouteId =
  | 'cursor'
  | 'devin'
  | 'google-gemini-cli'
  | 'google-antigravity'
  | 'factory-droid'
  | 'gitlab-duo'
  | 'gitlab-duo-agent'

/** The `providers` profile a volatile config reference snapshots. */
export interface TransportProvidersProfile {
  cursor?: TransportProviderProfile
  devin?: TransportProviderProfile
  'google-gemini-cli'?: TransportProviderProfile
  'google-antigravity'?: TransportProviderProfile
  'factory-droid'?: TransportProviderProfile
  'gitlab-duo'?: TransportProviderProfile
  'gitlab-duo-agent'?: TransportProviderProfile
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
      // The two Google routes are configured like the shipped ones: an empty
      // default advertises each route's whole catalog.
      'google-gemini-cli': z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
      'google-antigravity': z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
      'gitlab-duo': z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
      'gitlab-duo-agent': z.object({
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .default([]),
      }),
      'factory-droid': z.object({
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
    .default({
      cursor: { models: [] },
      devin: { models: [] },
      'google-gemini-cli': { models: [] },
      'google-antigravity': { models: [] },
    })
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

/**
 * The full Gemini CLI catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * The twin of {@link cursorCatalogModels}. Both Google routes share one bundled
 * artifact but keep separate route ids and tables, so the picker hands the row
 * list of the route the user is configuring.
 */
export function googleGeminiCliCatalogModels(): TransportCatalogModel[] {
  return GOOGLE_GEMINI_CLI_MODELS.map(row => ({ id: row.id, name: row.name }))
}

/**
 * The full Antigravity catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * Same shape and source pin as {@link googleGeminiCliCatalogModels}; the rows
 * differ because the routes advertise different models and wire ids.
 */
export function googleAntigravityCatalogModels(): TransportCatalogModel[] {
  return GOOGLE_ANTIGRAVITY_MODELS.map(row => ({ id: row.id, name: row.name }))
}

/**
 * The full Factory Droid catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * Same shape as the other route pickers. The rows come from the KDL registry
 * seed because the pinned `models.json` has no factory-droid rows; an account's
 * feature flags can narrow what it may serve, which is why the allow-list exists.
 */
export function factoryDroidCatalogModels(): TransportCatalogModel[] {
  return FACTORY_DROID_MODELS.map(row => ({ id: row.id, name: row.name }))
}

/**
 * The full GitLab Duo proxy catalog, projected for host-side configuration surfaces.
 *
 * @remarks
 * Same shape as the other route pickers. The rows are GitLab's proxy aliases; each
 * carries the upstream id and the wire the gateway routes it to.
 */
export function gitlabDuoCatalogModels(): TransportCatalogModel[] {
  return GITLAB_DUO_MODELS.map(row => ({ id: row.id, name: row.name }))
}

/**
 * The one GitLab Duo agent row, projected for host-side configuration surfaces.
 *
 * @remarks
 * Same shape as the other route pickers. The route's roster is a single static
 * row: GitLab's live model discovery is a non-goal for this slice, so the picker
 * offers what the pinned catalog declares.
 */
export function gitlabDuoAgentCatalogModels(): TransportCatalogModel[] {
  return GITLAB_DUO_AGENT_MODELS.map(row => ({ id: row.id, name: row.name }))
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

/** The Gemini CLI route's Models-page entry, beside the two shipped routes. */
const GOOGLE_GEMINI_CLI_PROVIDER = {
  provider: GOOGLE_GEMINI_CLI_ROUTE,
  displayName: 'Google Gemini CLI',
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'google-gemini-cli'],
  declared: false,
} as const

/** The Antigravity route's Models-page entry: one artifact, its own catalog and settings path. */
const GOOGLE_ANTIGRAVITY_PROVIDER = {
  provider: GOOGLE_ANTIGRAVITY_ROUTE,
  displayName: 'Google Antigravity',
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'google-antigravity'],
  declared: false,
} as const

/** The Factory Droid route's Models-page entry, beside the Google pair. */
const FACTORY_DROID_PROVIDER = {
  provider: FACTORY_DROID_TRANSPORT_ROUTE.id,
  displayName: FACTORY_DROID_TRANSPORT_ROUTE.displayName,
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'factory-droid'],
  declared: false,
} as const

/** The GitLab Duo proxy route's Models-page entry. */
const GITLAB_DUO_PROVIDER = {
  provider: GITLAB_DUO_TRANSPORT_ROUTE.id,
  displayName: GITLAB_DUO_TRANSPORT_ROUTE.displayName,
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'gitlab-duo'],
  declared: false,
} as const

/** The GitLab Duo agent route's Models-page entry. */
const GITLAB_DUO_AGENT_PROVIDER = {
  provider: GITLAB_DUO_AGENT_TRANSPORT_ROUTE.id,
  displayName: GITLAB_DUO_AGENT_TRANSPORT_ROUTE.displayName,
  settingsNs: 'llm-omp-transports',
  settingsPath: ['providers', 'gitlab-duo-agent'],
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

/** Test seams for the Google flows; the plugin uses the real network, clock and ports. */
export interface GoogleFlowOptions {
  readonly fetch?: GoogleFetch
  readonly now?: () => number
  /** Fixed state, so a test can script the listener and the paste. */
  readonly state?: string
  /** Preferred loopback port; `0` binds an ephemeral one. */
  readonly port?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** How long to wait for the browser before failing the attempt; defaults to five minutes. */
  readonly waitMs?: number
}

/**
 * Build one Google route's sign-in flow.
 *
 * @remarks
 * Both routes share the flow: each is an authorize page, a loopback callback (or
 * a paste when the browser cannot reach it), a form token exchange, userinfo and
 * a project-discovery script. Only the facts differ, so only the {@link facts}
 * argument differs. `projectId` is committed with the grant because the transport
 * sends it on every request and a refresh must not lose it.
 */
function googleAuthorizationFlow(facts: GoogleRouteFacts, options: GoogleFlowOptions): CursorAuthorizationFlow {
  const credentialKey = googleCredentialKey(facts.id)
  const callbackPlaceholder = `http://${facts.callback.hostname}:${facts.callback.port}${facts.callback.path}?code=…&state=…`
  return {
    key: credentialKey,
    label: facts.label,
    methods: [{ id: 'oauth', label: `Sign in with ${facts.label}` }],
    async run(session) {
      let grant: GoogleLoginResult
      try {
        grant = await loginGoogle(facts, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
          signal: session.signal,
          onAuthUrl: url =>
            session.notify({ message: `Open this page to sign in to ${facts.label}.`, url }),
          onProgress: message => session.notify({ message }),
          // The paste half exists for browsers that cannot reach the loopback;
          // it is cancelled once the listener already has the code.
          prompt: signal =>
            session.prompt({
              kind: 'manual-code',
              message:
                'If the browser cannot reach this machine, paste the address it landed on (or just the code) here.',
              placeholder: callbackPlaceholder,
              signal,
            }),
        })
      } catch (cause) {
        // An abort is the caller withdrawing; the seam turns it into a cancelled attempt.
        if (session.signal.aborted) throw cause
        if (cause instanceof GoogleAuthError) {
          throw new LlmError(`llm-omp-transports: ${facts.label} sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
            cause,
          })
        }
        throw cause
      }
      await session.commit({
        kind: 'grant',
        payload: {
          access: grant.access,
          expires: grant.expires,
          projectId: grant.projectId,
          // The seam validates the payload as a JSON value, so an absent field
          // must be absent, not `undefined`.
          ...(grant.refresh === undefined ? {} : { refresh: grant.refresh }),
          ...(grant.email === undefined ? {} : { email: grant.email }),
        },
      })
    },
  }
}

/**
 * The `llm-omp-transports/google-gemini-cli` sign-in flow.
 *
 * @remarks
 * Signing in here also provisions the Cloud Code Assist project the transport
 * names on every request; a Workspace account may need `GOOGLE_CLOUD_PROJECT` set
 * for that step, which surfaces as an `AUTH_FAILED` message naming the variable.
 */
export function googleGeminiCliAuthorizationFlow(options: GoogleFlowOptions = {}): CursorAuthorizationFlow {
  return googleAuthorizationFlow(GOOGLE_GEMINI_CLI_FACTS, options)
}

/** The `llm-omp-transports/google-antigravity` sign-in flow: same shape, its own client and project. */
export function googleAntigravityAuthorizationFlow(options: GoogleFlowOptions = {}): CursorAuthorizationFlow {
  return googleAuthorizationFlow(GOOGLE_ANTIGRAVITY_FACTS, options)
}

/** Test seams for the Factory Droid flow; the plugin uses the real network and timers. */
export interface FactoryDroidFlowOptions {
  readonly fetch?: FactoryDroidFetch
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * The `llm-omp-transports/factory-droid` sign-in flow.
 *
 * @remarks
 * WorkOS device authorization: the flow reports the verification page and the
 * user code through `session.notify`, then polls until the grant completes. No
 * loopback listener and no paste — the browser half happens on Factory's page,
 * and the attempt's own signal is the only cancellation channel (every fetch and
 * every sleep is wired to it, so a withdrawn attempt surfaces as the seam's
 * cancellation). The committed payload carries the identity the transport needs
 * for its API host alongside the tokens.
 */
export function factoryDroidAuthorizationFlow(options: FactoryDroidFlowOptions = {}): CursorAuthorizationFlow {
  return {
    key: FACTORY_DROID_CREDENTIAL_KEY,
    label: 'Factory Droid',
    methods: [{ id: 'oauth', label: 'Sign in with Factory Droid' }],
    async run(session) {
      let grant
      try {
        grant = await loginFactoryDroid({
          fetch: options.fetch,
          now: options.now,
          sleep: options.sleep,
          signal: session.signal,
          onDevice: device => {
            const url = device.verificationUriComplete ?? device.verificationUri
            session.notify({
              message: 'Open this page, enter the code, and approve the Factory sign-in; this window waits.',
              url,
              code: device.userCode,
            })
          },
        })
      } catch (cause) {
        // An abort is the caller withdrawing; the seam turns it into a cancelled attempt.
        if (session.signal.aborted) throw cause
        if (cause instanceof FactoryDroidAuthError) {
          throw new LlmError(`llm-omp-transports: Factory Droid sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
            cause,
          })
        }
        throw cause
      }
      await session.commit({
        kind: 'grant',
        // The seam validates the payload as a JSON value, so an absent identity
        // field must be absent, not `undefined`.
        payload: {
          access: grant.access,
          refresh: grant.refresh,
          expires: grant.expires,
          ...(grant.email === undefined ? {} : { email: grant.email }),
          ...(grant.accountId === undefined ? {} : { accountId: grant.accountId }),
          ...(grant.orgId === undefined ? {} : { orgId: grant.orgId }),
          ...(grant.region === undefined ? {} : { region: grant.region }),
          ...(grant.inferenceRegion === undefined ? {} : { inferenceRegion: grant.inferenceRegion }),
        },
      })
    },
  }
}

/** Test seams for the GitLab Duo agent flow; the plugin uses the real network. */
export interface GitLabFlowOptions {
  readonly fetch?: GitLabFetch
  readonly now?: () => number
  /** Fixed PKCE material, so a test can script the pasted callback. */
  readonly state?: string
  readonly verifier?: string
}

/**
 * The `llm-omp-transports/gitlab-duo` sign-in flow.
 *
 * @remarks
 * The rule's callback is `localhost:8080/callback` with no port fallback: the
 * listener binds that exact port and, when it is taken, the flow surfaces the
 * rule's instructions (register your own OAuth app or use a `GITLAB_TOKEN` PAT)
 * and leaves the paste prompt as the only path — never a silent port change.
 */
export function gitlabDuoAuthorizationFlow(options: GitLabFlowOptions = {}): CursorAuthorizationFlow {
  return {
    key: GITLAB_DUO_CREDENTIAL_KEY,
    label: 'GitLab Duo',
    methods: [{ id: 'oauth', label: 'Sign in with GitLab Duo' }],
    async run(session) {
      let grant
      try {
        grant = await loginGitLabDuo({
          fetch: options.fetch,
          now: options.now,
          state: options.state,
          // A scripted PKCE verifier (tests) or the one the attempt generated.
          ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
          signal: session.signal,
          onAuthUrl: url =>
            session.notify({ message: 'Open this page and approve the GitLab Duo sign-in.', url }),
          onListenerError: () =>
            session.notify({
              message:
                'Port 8080 is busy, so GitLab cannot redirect back automatically. If GitLab rejects the redirect URI, register your own OAuth app (GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI) or use a Personal Access Token via GITLAB_TOKEN.',
            }),
          prompt: () =>
            session.prompt({
              kind: 'manual-code',
              message:
                'Paste the full callback URL GitLab sent your browser to (it starts with http://localhost:8080/callback).',
              placeholder: 'http://localhost:8080/callback?code=…&state=…',
              signal: session.signal,
            }),
        })
      } catch (cause) {
        if (session.signal.aborted) throw cause
        if (cause instanceof GitLabAuthError) {
          throw new LlmError(`llm-omp-transports: GitLab Duo sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
            cause,
          })
        }
        throw cause
      }
      await session.commit({
        kind: 'grant',
        payload: {
          access: grant.access,
          refresh: grant.refresh,
          expires: grant.expires,
          ...(grant.email === undefined ? {} : { email: grant.email }),
        },
      })
    },
  }
}

/**
 * The `llm-omp-transports/gitlab-duo-agent` sign-in flow.
 *
 * @remarks
 * GitLab's rule is `callback manual-only #true redirect-uri="vscode://…"`: the
 * browser hands the code to VS Code, so there is no loopback listener at all and
 * the human pastes the full `vscode://` URL back. The state is mandatory — with no
 * listener, it is the only thing tying the pasted code to this attempt — and the
 * exchange echoes the vscode redirect the client is registered with.
 */
export function gitlabDuoAgentAuthorizationFlow(options: GitLabFlowOptions = {}): CursorAuthorizationFlow {
  return {
    key: GITLAB_DUO_AGENT_CREDENTIAL_KEY,
    label: 'GitLab Duo Agent',
    methods: [{ id: 'oauth', label: 'Sign in with GitLab Duo Agent' }],
    async run(session) {
      let grant
      try {
        grant = await loginGitLab({
          fetch: options.fetch,
          now: options.now,
          state: options.state,
          verifier: options.verifier,
          signal: session.signal,
          onAuthUrl: url =>
            session.notify({
              message:
                'Open this page and approve the GitLab sign-in. Your browser will hand the code to VS Code; paste the full vscode:// address it lands on back here.',
              url,
            }),
          prompt: () =>
            session.prompt({
              // The pasted callback carries the authorization code, so the shared
              // dialog must mask it and offer the paste hint.
              kind: 'manual-code',
              message:
                'Paste the full callback URL from VS Code (or your browser address bar). It starts with vscode://gitlab.gitlab-workflow/authentication.',
              placeholder: 'vscode://gitlab.gitlab-workflow/authentication?code=…&state=…',
              signal: session.signal,
            }),
        })
      } catch (cause) {
        // An abort is the caller withdrawing; the seam turns it into a cancelled attempt.
        if (session.signal.aborted) throw cause
        if (cause instanceof GitLabAuthError) {
          throw new LlmError(`llm-omp-transports: GitLab Duo Agent sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
            cause,
          })
        }
        throw cause
      }
      await session.commit({
        kind: 'grant',
        // The seam validates the payload as a JSON value, so an absent field must
        // be absent rather than `undefined`.
        payload: {
          access: grant.access,
          refresh: grant.refresh,
          expires: grant.expires,
          ...(grant.email === undefined ? {} : { email: grant.email }),
        },
      })
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
  artifact: 'cursor' | 'devin' | 'google' | 'factory-droid' | 'gitlab-duo' | 'gitlab-duo-agent',
  exportName:
    | 'streamCursor'
    | 'streamDevin'
    | 'streamGoogleGeminiCli'
    | 'streamFactoryDroid'
    | 'streamGitLabDuoWorkflow'
    | 'streamGitLabDuo',
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

/**
 * Build the Gemini CLI adapter this plugin registers.
 *
 * @remarks
 * The twin of {@link createCursorAdapter}. The access resolver returns the
 * structured JSON envelope the transport parses (token, project, refresh, expiry),
 * and the bundled artifact still loads on the first request.
 */
export function createGoogleGeminiCliAdapter(
  credentials: CredentialRecordsLike,
  models?: () => readonly string[] | undefined,
): OmpGoogleGeminiCliAdapter {
  return new OmpGoogleGeminiCliAdapter({
    access: createGoogleAccess(credentials, GOOGLE_GEMINI_CLI_FACTS),
    transport: bundledTransport('google', 'streamGoogleGeminiCli', 'Google Gemini CLI'),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * Build the Antigravity adapter this plugin registers.
 *
 * @remarks
 * Same artifact as {@link createGoogleGeminiCliAdapter} — the transport dispatches
 * on `model.provider` — over its own catalog, credential record and discovery
 * facts.
 */
export function createGoogleAntigravityAdapter(
  credentials: CredentialRecordsLike,
  models?: () => readonly string[] | undefined,
): OmpGoogleAntigravityAdapter {
  return new OmpGoogleAntigravityAdapter({
    access: createGoogleAccess(credentials, GOOGLE_ANTIGRAVITY_FACTS),
    transport: bundledTransport('google', 'streamGoogleGeminiCli', 'Google Antigravity'),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * Build the GitLab Duo proxy adapter this plugin registers.
 *
 * @remarks
 * The bundled proxy transport, lazy, over the 16-row catalog and its own
 * credential record. The transport performs the direct-access POST, the upstream
 * id substitution and the wire routing itself.
 */
export function createGitLabDuoAdapter(
  credentials: CredentialRecordsLike,
  models?: () => readonly string[] | undefined,
): OmpGitLabDuoAdapter {
  return new OmpGitLabDuoAdapter({
    access: createGitLabDuoAccess(credentials),
    transport: bundledTransport('gitlab-duo', 'streamGitLabDuo', 'GitLab Duo'),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * Build the GitLab Duo agent adapter this plugin registers.
 *
 * @remarks
 * The twin of {@link createFactoryDroidAdapter}: the bundled workflow transport,
 * lazy, over the one static row and its own credential record.
 */
export function createGitLabDuoAgentAdapter(
  credentials: CredentialRecordsLike,
  models?: () => readonly string[] | undefined,
): OmpGitLabDuoAgentAdapter {
  return new OmpGitLabDuoAgentAdapter({
    access: createGitLabDuoAgentAccess(credentials),
    transport: bundledTransport('gitlab-duo-agent', 'streamGitLabDuoWorkflow', 'GitLab Duo Agent'),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * Build the Factory Droid adapter this plugin registers.
 *
 * @remarks
 * The twin of {@link createGoogleAntigravityAdapter}: the transport is the
 * bundled artifact, still loaded only on the first request, and the credential
 * is the `llm-omp-transports/factory-droid` record.
 */
export function createFactoryDroidAdapter(
  credentials: CredentialRecordsLike,
  models?: () => readonly string[] | undefined,
): OmpFactoryDroidAdapter {
  return new OmpFactoryDroidAdapter({
    access: createFactoryDroidAccess(credentials),
    // The transport needs the account scope to pick the API host; it lives in the
    // same record the token comes from, so read it beside the credential.
    identity: async () => {
      const grant = readFactoryDroidGrant(await credentials.readRecord(FACTORY_DROID_CREDENTIAL_KEY))
      const scope = {
        ...(grant?.orgId === undefined ? {} : { orgId: grant.orgId }),
        ...(grant?.region === undefined ? {} : { region: grant.region }),
        ...(grant?.inferenceRegion === undefined ? {} : { inferenceRegion: grant.inferenceRegion }),
      }
      // An empty scope is the transport's own graceful fallback (it reads the
      // token's `external_org_id` claim); only a known scope is forwarded.
      return Object.keys(scope).length === 0 ? undefined : { oauthIdentity: scope }
    },
    transport: bundledTransport('factory-droid', 'streamFactoryDroid', 'Factory Droid'),
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
  const models = (route: TransportRouteId) => (): readonly string[] | undefined =>
    providers?.get()[route]?.models?.flatMap(row => (typeof row?.id === 'string' ? [row.id] : []))
  // Stable order: the two original routes first, then the Google pair, then the
  // Factory route and both GitLab routes — the proxy before its agent (the order
  // the flow table and the registration suites pin). Every artifact stays lazy, so
  // a missing one cannot fail `apply`.
  ctx.llm.registerAdapter([CURSOR_ROUTE], createCursorAdapter(host.credentials, models('cursor')))
  ctx.llm.registerAdapter([DEVIN_ROUTE], createDevinAdapter(host.credentials, models('devin')))
  ctx.llm.registerAdapter(
    [GOOGLE_GEMINI_CLI_ROUTE],
    createGoogleGeminiCliAdapter(host.credentials, models('google-gemini-cli')),
  )
  ctx.llm.registerAdapter(
    [GOOGLE_ANTIGRAVITY_ROUTE],
    createGoogleAntigravityAdapter(host.credentials, models('google-antigravity')),
  )
  ctx.llm.registerAdapter(
    [FACTORY_DROID_TRANSPORT_ROUTE.id],
    createFactoryDroidAdapter(host.credentials, models('factory-droid')),
  )
  ctx.llm.registerAdapter([GITLAB_DUO_ROUTE], createGitLabDuoAdapter(host.credentials, models('gitlab-duo')))
  ctx.llm.registerAdapter(
    [GITLAB_DUO_AGENT_ROUTE],
    createGitLabDuoAgentAdapter(host.credentials, models('gitlab-duo-agent')),
  )
  ctx.llm.registerConfigurableProviders([
    CURSOR_PROVIDER,
    DEVIN_PROVIDER,
    GOOGLE_GEMINI_CLI_PROVIDER,
    GOOGLE_ANTIGRAVITY_PROVIDER,
    FACTORY_DROID_PROVIDER,
    GITLAB_DUO_PROVIDER,
    GITLAB_DUO_AGENT_PROVIDER,
  ])
  host.authorization.registerFlow(cursorAuthorizationFlow())
  host.authorization.registerFlow(devinAuthorizationFlow())
  host.authorization.registerFlow(googleGeminiCliAuthorizationFlow())
  host.authorization.registerFlow(googleAntigravityAuthorizationFlow())
  host.authorization.registerFlow(factoryDroidAuthorizationFlow())
  host.authorization.registerFlow(gitlabDuoAuthorizationFlow())
  host.authorization.registerFlow(gitlabDuoAgentAuthorizationFlow())
}

export {
  CURSOR_ROUTE,
  DEVIN_ROUTE,
  FACTORY_DROID_CREDENTIAL_KEY,
  FACTORY_DROID_ROUTE,
  FACTORY_DROID_TRANSPORT_ROUTE,
  GITLAB_DUO_AGENT_CREDENTIAL_KEY,
  GITLAB_DUO_AGENT_ROUTE,
  GITLAB_DUO_AGENT_TRANSPORT_ROUTE,
  GITLAB_DUO_CREDENTIAL_KEY,
  GITLAB_DUO_ROUTE,
  GITLAB_DUO_TRANSPORT_ROUTE,
  GOOGLE_ANTIGRAVITY_ROUTE,
  GOOGLE_GEMINI_CLI_ROUTE,
} from './adapter.js'
export { FACTORY_DROID_MODELS } from './catalog/factory-droid.js'
export { GITLAB_DUO_MODELS } from './catalog/gitlab-duo.js'
export { GITLAB_DUO_AGENT_MODELS } from './catalog/gitlab-duo-agent.js'
export { createGitLabDuoAccess } from './gitlab/credentials.js'
export { loginGitLabDuo } from './gitlab/auth.js'
export { GITLAB_DUO_AUTH } from './gitlab/auth.js'
export { createGitLabDuoAgentAccess } from './gitlab/credentials.js'
export { loginGitLab } from './gitlab/auth.js'
export type { GitLabGrant } from './gitlab/auth.js'
export { loginFactoryDroid } from './factory-droid/auth.js'
export type { FactoryDroidGrant, FactoryDroidIdentity } from './factory-droid/auth.js'
export { createFactoryDroidAccess } from './factory-droid/credentials.js'
export type { FactoryDroidGrantPayload } from './factory-droid/credentials.js'
export { CURSOR_CREDENTIAL_KEY } from './cursor/credentials.js'
export { DEVIN_CREDENTIAL_KEY } from './devin/credentials.js'
export { GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY, GOOGLE_GEMINI_CLI_CREDENTIAL_KEY } from './google/credentials.js'
