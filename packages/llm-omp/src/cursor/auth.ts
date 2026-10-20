/**
 * Cursor sign-in, token refresh and account-identity lookup.
 *
 * A dependency-free port of `@oh-my-pi/pi-ai@18.12.3`'s
 * `src/registry/oauth/cursor.ts`: the browser-completed login page (PKCE +
 * uuid, no loopback callback), the poll where `404` still means "not yet", the
 * refresh exchange, and the cursor.com profile read that names the account.
 * The published plugin may not import `@oh-my-pi/*` at runtime, so this small
 * protocol lives here; every caller takes its `fetch` and its wait as options,
 * which is what keeps the tests offline.
 *
 * @module dsh-llm-omp-transports/cursor/auth
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * The vendor identity this client presents, copied from the pinned omp
 * sources because the published package may not import them:
 *
 * - `clientId` from `@oh-my-pi/pi-ai@18.12.3` `src/registry/oauth/cursor.ts`
 *   (`CURSOR_CLIENT_ID`, the client the Cursor IDE renews its login with);
 * - `clientVersion` from `@oh-my-pi/pi-catalog@18.12.3` `src/wire/cursor.ts`
 *   (`CURSOR_CLIENT_VERSION`, the released CLI build whose protocol surface
 *   the bundled transport mirrors — it gates server features).
 *
 * `tests/build.test.ts` fails when either copy drifts from the installed pin.
 *
 * shortcut: reusing Cursor's vendor-internal OAuth client id and announcing a
 * released CLI build is not a sanctioned third-party client. The MIT licence
 * covers the code, not the service: if Cursor gates non-IDE clients (a
 * `401`/`403` on `Run` with a valid account), this transport stops until the
 * product decision the plan records as stop condition S4.
 */
export const CURSOR_AUTH = {
  loginUrl: 'https://cursor.com/loginDeepControl',
  pollUrl: 'https://api2.cursor.sh/auth/poll',
  refreshUrl: 'https://api2.cursor.sh/oauth/token',
  profileUrl: 'https://cursor.com/api/auth/me',
  clientId: 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB',
  clientVersion: 'cli-2026.09.02-c22c1a3',
} as const

/** How long one profile read may take before the login gives up on naming the account. */
const PROFILE_TIMEOUT_MS = 3_000
/**
 * Deadline for one refresh exchange. The adapter refreshes under the
 * credentials lock, so an unresponsive `api2.cursor.sh` must not hold that lock
 * (and every other request on the route) indefinitely.
 */
const REFRESH_TIMEOUT_MS = 15_000
/** Token expiry is read from the JWT with this skew, matching omp. */
const TOKEN_SKEW_MS = 5 * 60 * 1000
/** Expiry assumed for a token that is not a readable JWT. */
const TOKEN_FALLBACK_LIFETIME_MS = 60 * 60 * 1000

const POLL_MAX_ATTEMPTS = 150
const POLL_BASE_DELAY_MS = 1_000
const POLL_MAX_DELAY_MS = 10_000
const POLL_BACKOFF = 1.2
const POLL_MAX_CONSECUTIVE_ERRORS = 3

/**
 * The `fetch` this module calls. Narrower than the global so a stub can accept
 * a plain URL string; the global `fetch` is assignable to it.
 */
export type CursorFetch = (url: string, init?: RequestInit) => Promise<Response>

/** PKCE material and the page the human must open. */
export interface CursorAuthParams {
  readonly verifier: string
  readonly challenge: string
  readonly uuid: string
  readonly loginUrl: string
}

/** What the poll or refresh minted; `expires` is epoch ms, JWT exp minus the skew. */
export interface CursorGrant {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  /** Account email, when the cursor.com profile named one. */
  readonly email?: string
  /** JWT `sub` after the `|`, the account the tokens belong to. */
  readonly accountId?: string
}

/** Which stage of the sign-in failed, so the caller can say what to fix. */
export type CursorAuthFailure = 'poll' | 'timeout' | 'refresh' | 'reauth' | 'profile'

/** A sign-in or refresh failure with a machine-readable stage. */
export class CursorAuthError extends Error {
  constructor(
    message: string,
    readonly failure: CursorAuthFailure,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CursorAuthError'
  }
}

/** Wait `ms`, or reject with the signal's abort reason. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** The reason an aborted signal carries, with a DOMException fallback for bare controllers. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** Throw when the caller withdrew before the next network step. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortReason(signal)
}

/** Generate the PKCE pair and the login URL Cursor's page expects. */
export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const verifier = randomBytes(96).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const uuid = randomUUID()
  const query = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' })
  return { verifier, challenge, uuid, loginUrl: `${CURSOR_AUTH.loginUrl}?${query.toString()}` }
}

/** Options every network step takes; the test suite injects `fetch` and `sleep`. */
export interface CursorPollOptions {
  readonly fetch?: CursorFetch
  readonly signal?: AbortSignal
  /**
   * Wait between poll attempts. Defaults to an abortable timer with omp's
   * 1 s→10 s ×1.2 backoff; tests pass a no-op so a 404→200 script is instant.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Poll until the human finishes the browser sign-in.
 *
 * @remarks
 * `404` means "the page was not completed yet": the attempt resets the error
 * counter and backs off. Any other failure counts as one of three consecutive
 * errors before the poll gives up, and an abort stops it immediately. Faithful
 * to omp's loop apart from that counter being explicit rather than a thrown
 * error swallowed by the same `catch`.
 */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  options: CursorPollOptions = {},
): Promise<Pick<CursorGrant, 'access' | 'refresh'>> {
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? wait
  let delay = POLL_BASE_DELAY_MS
  let consecutiveErrors = 0

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay, options.signal)
    throwIfAborted(options.signal)

    let response: Response
    try {
      response = await fetchImpl(
        `${CURSOR_AUTH.pollUrl}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        options.signal === undefined ? undefined : { signal: options.signal },
      )
    } catch (cause) {
      if (options.signal?.aborted === true) throw cause
      consecutiveErrors += 1
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
        throw new CursorAuthError('Cursor sign-in polling failed: too many consecutive errors', 'poll')
      }
      continue
    }

    if (response.status === 404) {
      consecutiveErrors = 0
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS)
      continue
    }

    if (response.ok) {
      const data = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown }
      if (typeof data.accessToken !== 'string' || data.accessToken === '') {
        throw new CursorAuthError('Cursor sign-in returned no access token', 'poll', response.status)
      }
      return { access: data.accessToken, refresh: typeof data.refreshToken === 'string' ? data.refreshToken : '' }
    }

    consecutiveErrors += 1
    if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
      throw new CursorAuthError(
        `Cursor sign-in polling failed: HTTP ${response.status}`,
        'poll',
        response.status,
      )
    }
  }

  throw new CursorAuthError('Cursor sign-in timed out; start the sign-in again', 'timeout')
}

/** Options for one refresh exchange. */
export interface CursorRefreshOptions {
  readonly fetch?: CursorFetch
  readonly signal?: AbortSignal
  /** Deadline for the exchange itself; defaults to {@link REFRESH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * @remarks
 * Cursor rarely rotates the refresh token, so the stored one is kept unless a
 * new one is returned. A `200` carrying `shouldLogout: true` is Cursor ending
 * the session: the grant is dead, not retryable, and the caller must sign in
 * again — that distinction is the `reauth` failure kind. The exchange is
 * bounded by {@link REFRESH_TIMEOUT_MS}, because the caller runs it under the
 * credentials lock; a deadline the caller did not set is a `refresh` failure.
 */
export async function refreshCursorToken(
  refreshToken: string,
  options: CursorRefreshOptions = {},
): Promise<CursorGrant> {
  const fetchImpl = options.fetch ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REFRESH_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(CURSOR_AUTH.refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CURSOR_AUTH.clientId,
        refresh_token: refreshToken,
      }),
      signal,
    })
  } catch (cause) {
    // The caller's own abort keeps its cause; the deadline is this module's.
    if (options.signal?.aborted === true) throw cause
    if (timeout.aborted) {
      throw new CursorAuthError('Cursor token refresh timed out; retry the request', 'refresh')
    }
    throw cause
  }

  if (!response.ok) {
    throw new CursorAuthError(
      `Cursor token refresh failed: HTTP ${response.status} ${await response.text()}`,
      'refresh',
      response.status,
    )
  }

  const data = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    shouldLogout?: unknown
  }
  if (data.shouldLogout === true) {
    throw new CursorAuthError('Cursor ended this session; sign in again', 'reauth')
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new CursorAuthError('Cursor token refresh returned no access token', 'refresh')
  }

  return {
    access: data.access_token,
    refresh: typeof data.refresh_token === 'string' && data.refresh_token !== '' ? data.refresh_token : refreshToken,
    expires: cursorTokenExpiry(data.access_token),
  }
}

/** Options for one cursor.com profile read. */
export interface CursorProfileOptions {
  readonly fetch?: CursorFetch
  readonly signal?: AbortSignal
}

/**
 * Email of the Cursor account that owns `accessToken`.
 *
 * @remarks
 * cursor.com names the user in the JWT `sub`; the profile is read with the
 * access token presented as that user's web session. Undefined when the token
 * names no user, or the profile names a different one.
 */
export async function fetchCursorAccountEmail(
  accessToken: string,
  options: CursorProfileOptions = {},
): Promise<string | undefined> {
  const accountId = cursorAccountId(accessToken)
  if (accountId === undefined) return undefined
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(CURSOR_AUTH.profileUrl, {
    headers: {
      Accept: 'application/json',
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${accountId}::${accessToken}`)}`,
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    throw new CursorAuthError(`Cursor profile request failed: HTTP ${response.status}`, 'profile', response.status)
  }
  const payload = (await response.json()) as unknown
  if (typeof payload !== 'object' || payload === null) return undefined
  const { sub, email } = payload as { sub?: unknown; email?: unknown }
  if (sub !== accountId || typeof email !== 'string') return undefined
  return email.trim() || undefined
}

/** Options for the whole sign-in. */
export interface CursorLoginOptions extends CursorPollOptions {
  /** Called once, with the page the human must open. */
  readonly onAuthUrl?: (url: string) => void
}

/**
 * Run one sign-in: report the URL, poll until authorized, name the account.
 *
 * @remarks
 * The profile read is best-effort under a short deadline, exactly as in omp: a
 * slow cursor.com must not discard tokens the exchange already minted.
 */
export async function loginCursor(options: CursorLoginOptions = {}): Promise<CursorGrant> {
  const params = await generateCursorAuthParams()
  options.onAuthUrl?.(params.loginUrl)

  const tokens = await pollCursorAuth(params.uuid, params.verifier, options)
  const timeout = AbortSignal.timeout(PROFILE_TIMEOUT_MS)
  const profileSignal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const email = await fetchCursorAccountEmail(tokens.access, {
    fetch: options.fetch,
    signal: profileSignal,
  }).catch(cause => {
    // An abort is the caller withdrawing, not cursor.com being slow.
    if (options.signal?.aborted === true) throw cause
    return undefined
  })
  const accountId = cursorAccountId(tokens.access)

  return {
    access: tokens.access,
    refresh: tokens.refresh,
    expires: cursorTokenExpiry(tokens.access),
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
  }
}

/** Decode a JWT payload, undefined when the token is not a three-part JWT. */
function cursorTokenPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The account user id: the JWT `sub` after its `|`, as omp reads it. */
function cursorAccountId(accessToken: string): string | undefined {
  const sub = cursorTokenPayload(accessToken)?.sub
  if (typeof sub !== 'string') return undefined
  const parts = sub.split('|')
  const accountId = (parts.length > 1 ? parts[1] : sub).trim()
  return accountId === '' ? undefined : accountId
}

/** Expiry from the JWT, with the 5-minute skew and omp's one-hour fallback. */
function cursorTokenExpiry(accessToken: string): number {
  const exp = cursorTokenPayload(accessToken)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 - TOKEN_SKEW_MS : Date.now() + TOKEN_FALLBACK_LIFETIME_MS
}
