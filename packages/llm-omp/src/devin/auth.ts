/**
 * Devin sign-in: authorize URL, PKCE, the pasted callback and the token exchange.
 *
 * Devin's login is a declarative `login "oauth-code"` rule in the pinned omp
 * catalog (`compat/rules/auth/devin.kdl`), executed by omp's generic engine:
 * S256 PKCE plus a uuid state, a browser page that redirects to a loopback
 * callback the CLI is expected to host, and a JSON token exchange that returns
 * one `token` field. This module copies the rule's facts because the published
 * plugin may not import `@oh-my-pi/*` at runtime; `tests/build-devin.test.ts`
 * fails when the installed rule moves one.
 *
 * There is no refresh: the rule says `refresh "none"`, so the grant this mints
 * is a static bearer with a derived `expires`.
 *
 * @module dsh-llm-omp-transports/devin/auth
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { parseCallbackUrl } from '../google/callback-listener.js'
import { jwtExpiry } from '../jwt.js'

/**
 * The endpoints and callback the pinned rule declares.
 *
 * - `authorizeUrl` / `tokenUrl` from `devin.kdl:4,12`;
 * - `callbackUrl` from `devin.kdl:11` — the omp CLI hosts this listener with a
 *   Bun server, which the plugin cannot port; the flow asks the human to paste
 *   the address instead. The port is part of the authorize request, so it must
 *   match the page Devin redirects to.
 */
export const DEVIN_AUTH = {
  authorizeUrl: 'https://app.devin.ai/auth/cli/continue',
  tokenUrl: 'https://api.devin.ai/auth/cli/token',
  callbackUrl: 'http://127.0.0.1:59653/callback',
} as const

/** Token expiry is read from the JWT with this skew, matching the pinned rule. */
const TOKEN_SKEW_MS = 5 * 60 * 1000
/** `fallback-ms=31536000000` from the rule: one year for a token that is not a readable JWT. */
const TOKEN_FALLBACK_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

/**
 * The `fetch` this module calls. Narrower than the global so a stub can accept
 * a plain URL string; the global `fetch` is assignable to it.
 */
export type DevinFetch = (url: string, init?: RequestInit) => Promise<Response>

/** PKCE material and the page the human must open. */
export interface DevinAuthParams {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
  readonly authorizeUrl: string
}

/** What the token exchange minted; `expires` is epoch ms, JWT exp minus the skew. */
export interface DevinGrant {
  readonly access: string
  readonly expires: number
}

/** A sign-in step that failed in a way the flow reports as `AUTH_FAILED`. */
export class DevinAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevinAuthError'
  }
}

/**
 * Mint the verifier/challenge/state and the authorize URL.
 *
 * @param overrides - fixed state/verifier, so a test can drive the paste step.
 * @returns the PKCE material and the page to open.
 */
export function generateDevinAuthParams(overrides: { state?: string; verifier?: string } = {}): DevinAuthParams {
  const verifier = overrides.verifier ?? randomBytes(96).toString('base64url')
  const state = overrides.state ?? randomUUID()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  // The rule's `standardAuthorizeParams`: no `client_id` (it declares none) and
  // `prompt=select_account`, in the engine's own order.
  const query = new URLSearchParams({
    response_type: 'code',
    redirect_uri: DEVIN_AUTH.callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  })
  return { verifier, challenge, state, authorizeUrl: `${DEVIN_AUTH.authorizeUrl}?${query.toString()}` }
}

/** The code and optional state recovered from what the human pasted. */
export interface DevinCallback {
  readonly code: string
  readonly state?: string
}

/**
 * Parse a pasted callback URL, a bare code, or `code#state`.
 *
 * The parser itself is shared with the Google routes
 * (`src/google/callback-listener.ts`), which take the same code and state
 * through a loopback listener; this wrapper keeps Devin's own error type, so a
 * failed paste still reaches the flow as a {@link DevinAuthError}.
 *
 * @param text - exactly what the prompt returned.
 * @returns the code and, when the paste carried one, the state it claimed.
 * @throws DevinAuthError when the paste names no code.
 */
export function parseDevinCallback(text: string): DevinCallback {
  try {
    return parseCallbackUrl(text)
  } catch (cause) {
    throw new DevinAuthError(cause instanceof Error ? cause.message : String(cause))
  }
}

/** Options for {@link exchangeDevinCode}; `fetch` and `now` are the test seams. */
export interface DevinExchangeOptions {
  readonly fetch?: DevinFetch
  readonly now?: () => number
  readonly signal?: AbortSignal
}

/**
 * Exchange an authorization code for the static bearer.
 *
 * @param code - the code from the callback.
 * @param verifier - the PKCE verifier minted with the challenge.
 * @param options - fetch, clock and abort seams.
 * @returns the bearer and its derived expiry.
 */
export async function exchangeDevinCode(
  code: string,
  verifier: string,
  options: DevinExchangeOptions = {},
): Promise<DevinGrant> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(DEVIN_AUTH.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    // The rule's non-standard field naming: `code_verifier`, not `codeVerifier`.
    body: JSON.stringify({ code, code_verifier: verifier }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) throw new DevinAuthError(`the Devin token exchange failed with HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new DevinAuthError('the Devin token exchange returned a non-JSON body')
  }
  const token = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined
  if (typeof token !== 'string' || token === '') {
    throw new DevinAuthError('the Devin token exchange returned no token')
  }

  return {
    access: token,
    expires: jwtExpiry(token, {
      skewMs: TOKEN_SKEW_MS,
      fallbackMs: TOKEN_FALLBACK_LIFETIME_MS,
      now: options.now,
    }),
  }
}

/** Options for {@link loginDevin}. */
export interface DevinLoginOptions extends DevinExchangeOptions {
  /** Ask the human for the callback; the flow wraps `session.prompt`. */
  readonly prompt: () => Promise<string>
  /** Report the authorize page before the prompt; the flow wraps `session.notify`. */
  readonly onAuthUrl?: (url: string) => void
  /** Fixed state, so a test can script the paste. */
  readonly state?: string
  /** Fixed verifier, so a test can assert the exchange body. */
  readonly verifier?: string
}

/**
 * Run the paste-based sign-in: mint PKCE, report the page, take the paste and
 * exchange it.
 *
 * @param options - prompt/notify callbacks and the fetch/clock/state seams.
 * @returns the grant to commit.
 */
export async function loginDevin(options: DevinLoginOptions): Promise<DevinGrant> {
  const params = generateDevinAuthParams({ state: options.state, verifier: options.verifier })
  options.onAuthUrl?.(params.authorizeUrl)

  const callback = parseDevinCallback(await options.prompt())
  // A bare code skips the check (the page is the only place the state could
  // travel); a paste that carries a state must match this attempt.
  if (callback.state !== undefined && callback.state !== params.state) {
    throw new DevinAuthError('the pasted callback state does not match this sign-in attempt')
  }

  return exchangeDevinCode(callback.code, params.verifier, options)
}
