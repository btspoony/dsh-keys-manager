/**
 * Drive one omp sign-in flow on top of the manager's existing attempt surface.
 *
 * A Keys Manager attempt already exposes exactly what an omp flow needs: a
 * notice sink (`notify`), a prompt that parks the UI (`prompt`), and an
 * `AbortSignal` that is released when the attempt finishes or is pruned. This
 * module maps omp's `OAuthController` onto that surface and returns the minted
 * credential; it owns no storage, no network and no policy — the host commits
 * the result (`src/index.ts` `commitSignIn`).
 *
 * Cancellation is translated rather than swallowed: omp throws its own
 * `LoginCancelledError`, the host needs its own named error so a cancelled
 * attempt is never mistaken for a provider failure. Every other error is
 * rethrown untouched, because the attempt view renders the provider's text.
 *
 * @module dsh-keys-manager/oauth/signin
 */
import type { AuthorizationInteractionLike } from '../host-types.js'

import { ompOAuthAdapter, type OmpOAuthAdapter, type OmpOAuthController, type OmpOAuthCredentials } from './adapter.js'
import { signInProvider, type SignInProvider } from './providers.js'

/** The wording omp's paste flow needs; the redirect is a `zcode://` URL. */
const MANUAL_CODE_PROMPT = 'Paste the final redirect URL or the authorization code'

export interface SignInRequest {
  /** The attempt's notify/prompt surface. */
  interaction: AuthorizationInteractionLike
  /** The attempt's abort signal; cancellation reaches the omp controller. */
  signal?: AbortSignal
  /** Injectable fetch for tests and for a host that owns its fetch layer. */
  fetch?: typeof fetch
  /**
   * The bundled drivers. Production callers leave this unset and the lazy
   * artifact load answers; tests inject a double so no test ever imports the
   * real bundle.
   */
  adapter?: OmpOAuthAdapter
}

/** What a successful sign-in yields: a static credential, ready for the pool. */
export interface MintedCredential {
  /** The bearer / `id.secret` key string. */
  access: string
  /** Epoch ms of the credential's expiry (a far-future value for durable keys). */
  expires: number
}

/** The attempt was cancelled; the host records `cancelled`, not `failed`. */
export class SignInCancelledError extends Error {
  constructor(provider: string) {
    super(`The ${provider} sign-in was cancelled`)
    this.name = 'SignInCancelledError'
  }
}

/** The provider has no sign-in driver in this plugin. */
export class SignInUnavailableError extends Error {
  constructor(provider: string) {
    super(`Provider "${provider}" offers no in-process sign-in`)
    this.name = 'SignInUnavailableError'
  }
}

/** Aborted-signal predicate; a function call so a live signal is re-read. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Whether a driver failure is the attempt's cancellation. */
function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (isAborted(signal)) return true
  return error instanceof Error && error.name === 'LoginCancelledError'
}

/** The controller one attempt hands to omp. */
function controllerOf(provider: string, signIn: SignInProvider, request: SignInRequest): OmpOAuthController {
  return {
    onAuth: info => {
      // Kilo's user code travels inside `instructions` ("Enter code: …"), so
      // the notice is a verbatim copy — no parsing, no extra field.
      request.interaction.notify({
        message: info.instructions ?? signIn.label,
        ...(info.url === undefined ? {} : { url: info.url }),
      })
    },
    onProgress: message => request.interaction.notify({ message }),
    // Neither batch-1 flow prompts today; wiring it keeps parity with the seam
    // path and means a future flow cannot silently drop a prompt.
    onPrompt: async prompt =>
      request.interaction.prompt({
        kind: prompt.secret === true ? 'secret' : 'text',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    // zai only: the browser lands on `zcode://…`, which the user pastes back.
    // omp re-asks when the input yields no code, so this must tolerate repeats.
    onManualCodeInput: async signal =>
      request.interaction.prompt({
        kind: 'manual-code',
        message: MANUAL_CODE_PROMPT,
        ...(signal === undefined && request.signal === undefined
          ? {}
          : { signal: signal ?? request.signal }),
      }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
  }
}

/** Run the provider's bundled driver. */
async function drive(
  provider: string,
  adapter: OmpOAuthAdapter,
  controller: OmpOAuthController,
  signIn: SignInProvider,
): Promise<OmpOAuthCredentials> {
  switch (signIn.driver) {
    case 'kilo':
      return adapter.loginKilo(controller)
    case 'zai-coding-plan':
      return adapter.loginZaiCodingPlan(controller)
    default: {
      // Exhaustiveness: a new driver must be wired here before it can ship.
      const unreachable: never = signIn.driver
      throw new SignInUnavailableError(`${provider} (${String(unreachable)})`)
    }
  }
}

/**
 * Run one provider's sign-in to completion.
 *
 * @param provider - the route id (`kilo` / `zai`).
 * @param request - the attempt surface plus the optional test seams.
 * @returns the minted static credential.
 * @throws SignInUnavailableError when the route has no driver.
 * @throws SignInCancelledError when the attempt's signal released the flow.
 */
export async function runSignIn(provider: string, request: SignInRequest): Promise<MintedCredential> {
  const signIn = signInProvider(provider)
  if (signIn === undefined) throw new SignInUnavailableError(provider)
  if (request.signal?.aborted === true) throw new SignInCancelledError(provider)
  const adapter = request.adapter ?? (await ompOAuthAdapter())
  const controller = controllerOf(provider, signIn, request)
  let credentials: OmpOAuthCredentials
  try {
    credentials = await drive(provider, adapter, controller, signIn)
  } catch (error) {
    if (isCancellation(error, request.signal)) throw new SignInCancelledError(provider)
    throw error
  }
  // A flow can resolve after the attempt's signal released it (an abort that
  // lands between the driver's last await and its return); the credential of a
  // cancelled attempt must never reach the pool.
  if (isAborted(request.signal)) throw new SignInCancelledError(provider)
  if (typeof credentials?.access !== 'string' || credentials.access.length === 0) {
    throw new Error(`The ${signIn.label} sign-in returned no credential`)
  }
  return { access: credentials.access, expires: credentials.expires }
}
