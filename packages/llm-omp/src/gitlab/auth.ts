/**
 * GitLab Duo agent sign-in: the authorize page, PKCE, the pasted `vscode://`
 * callback and the token exchange.
 *
 * omp's pinned rule (`compat/rules/auth/gitlab-duo-agent.kdl`) is an
 * `oauth-code` login with **`pkce #true`**, the `api` scope, GitLab's official
 * VS Code OAuth client and `callback port=0 redirect-uri="vscode://…"
 * manual-only #true`: there is no loopback listener at all. The browser lands in
 * VS Code, so the human copies the full
 * `vscode://gitlab.gitlab-workflow/authentication?code=…&state=…` URL back — the
 * same paste shape the Devin route uses. The module copies the rule's facts
 * because the published plugin may not import `@oh-my-pi/*` at runtime.
 *
 * Stored expiry is the rule's `expires "seconds" path=expires_in from=created_at
 * skew-ms=300000`, i.e. `created_at + expires_in − 5 min`; a token without those
 * fields falls back to an hour.
 *
 * @module dsh-llm-omp-transports/gitlab/auth
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { startCallbackListener } from '../google/callback-listener.js'

/** The endpoints, client and redirect the pinned rule declares. */
export const GITLAB_DUO_AGENT_AUTH = {
  authorizeUrl: 'https://gitlab.com/oauth/authorize',
  tokenUrl: 'https://gitlab.com/oauth/token',
  /** GitLab's official VS Code OAuth application. */
  clientId: '36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5',
  scopes: 'api',
  /** The rule's exact registered redirect: it must be echoed on exchange *and* refresh. */
  redirectUri: 'vscode://gitlab.gitlab-workflow/authentication',
} as const

/** The Duo proxy's loopback callback: registered exactly, with no port fallback (D13). */
export const GITLAB_DUO_AUTH = {
  authorizeUrl: 'https://gitlab.com/oauth/authorize',
  tokenUrl: 'https://gitlab.com/oauth/token',
  /** The rule's bundled client; `GITLAB_CLIENT_ID` overrides it for a custom app. */
  clientId: 'da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b',
  scopes: 'api',
  /** Registered exactly: the rule declares no port fallback (D13). */
  redirectUri: 'http://localhost:8080/callback',
  callback: { hostname: 'localhost', port: 8080, path: '/callback' },
} as const

/** How long the duo flow waits for the browser before failing the attempt. */
const DUO_CALLBACK_WAIT_MS = 300_000

/** The rule's `skew-ms=300000` on `expires_in`. */
const TOKEN_SKEW_MS = 5 * 60 * 1000
/** Fallback when a token response names no `expires_in`. */
const TOKEN_FALLBACK_LIFETIME_MS = 60 * 60 * 1000

/** A sign-in step that failed in a way the flow reports as `AUTH_FAILED`. */
export class GitLabAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitLabAuthError'
  }
}

/** The `fetch` this module uses; narrower than the global so a stub fits. */
export type GitLabFetch = (url: string, init?: RequestInit) => Promise<Response>

/** PKCE material plus the page the human must open. */
export interface GitLabAuthParams {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
  readonly authorizeUrl: string
}

/** What a completed exchange minted; `expires` is epoch ms. */
export interface GitLabGrant {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly email?: string
}

/** The code and state recovered from a pasted callback. */
export interface GitLabCallback {
  readonly code: string
  readonly state?: string
}

/** PKCE: 32 random bytes base64url, challenge = S256. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * Build the authorize URL the human opens.
 *
 * @param overrides - fixed state/verifier, so a test can script the pasted callback.
 * @returns the PKCE material and the page.
 */
export function generateGitLabAuthParams(overrides: { state?: string; verifier?: string } = {}): GitLabAuthParams {
  const { verifier, challenge } = overrides.verifier === undefined
    ? pkce()
    : {
        verifier: overrides.verifier,
        challenge: createHash('sha256').update(overrides.verifier).digest('base64url'),
      }
  const state = overrides.state ?? randomUUID()
  const url = new URL(GITLAB_DUO_AGENT_AUTH.authorizeUrl)
  url.searchParams.set('client_id', GITLAB_DUO_AGENT_AUTH.clientId)
  url.searchParams.set('redirect_uri', GITLAB_DUO_AGENT_AUTH.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GITLAB_DUO_AGENT_AUTH.scopes)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return { verifier, challenge, state, authorizeUrl: url.toString() }
}

/**
 * Parse the pasted `vscode://` callback, a bare code, or `code#state`.
 *
 * The rule's manual-only callback means the text arrives with a custom scheme,
 * so the URL branch accepts any scheme (`new URL` handles `vscode:` the same
 * way), and a bare code keeps the Devin paste convenience.
 *
 * @param text - the pasted callback.
 * @returns the code and, when the text carried one, the state it claimed.
 * @throws GitLabAuthError when the text names no code.
 */
export function parseGitLabCallback(text: string): GitLabCallback {
  const trimmed = text.trim()
  if (trimmed === '') throw new GitLabAuthError('the pasted callback is empty')

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new GitLabAuthError('the pasted callback URL is malformed')
    }
    const code = url.searchParams.get('code')?.trim()
    if (code === undefined || code === '') throw new GitLabAuthError('the pasted callback URL names no code')
    const state = url.searchParams.get('state')?.trim()
    return { code, ...(state === undefined || state === '' ? {} : { state }) }
  }

  const hash = trimmed.indexOf('#')
  const code = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim()
  const state = hash === -1 ? '' : trimmed.slice(hash + 1).trim()
  if (code === '') throw new GitLabAuthError('the pasted callback names no code')
  return { code, ...(state === '' ? {} : { state }) }
}

/** Read one string field from an unknown JSON body, trimmed. */
function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** POST one form body to the token endpoint; shared by the exchange and the refresh. */
async function postForm(
  params: Record<string, string>,
  options: { fetch?: GitLabFetch; signal?: AbortSignal },
): Promise<unknown> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const timeout = AbortSignal.timeout(15_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(GITLAB_DUO_AGENT_AUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal,
    })
  } catch (cause) {
    // A withdrawn attempt stays a cancellation; the flow rethrows it.
    if (options.signal?.aborted === true) throw cause
    throw new GitLabAuthError(`the GitLab token request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new GitLabAuthError(
      `the GitLab token request failed with HTTP ${response.status}${field(body, 'error_description') === undefined ? '' : `: ${field(body, 'error_description')}`}`,
    )
  }
  return body
}

/** Project one token body onto the grant, per the rule's `credential` block. */
function mapToken(body: unknown, now: () => number, previousRefresh?: string): GitLabGrant {
  const access = field(body, 'access_token')
  if (access === undefined) throw new GitLabAuthError('the GitLab token response names no access token')
  const refresh = field(body, 'refresh_token') ?? previousRefresh
  if (refresh === undefined) throw new GitLabAuthError('the GitLab token response names no refresh token')
  const seconds = (body as { expires_in?: unknown }).expires_in
  const created = (body as { created_at?: unknown }).created_at
  const base = typeof created === 'number' && Number.isFinite(created) ? created * 1000 : now()
  const expires =
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? base + seconds * 1000 - TOKEN_SKEW_MS
      : now() + TOKEN_FALLBACK_LIFETIME_MS
  const email = field(body, 'email')
  return { access, refresh, expires, ...(email === undefined ? {} : { email }) }
}

/** Options for {@link exchangeGitLabCode}. */
export interface GitLabExchangeOptions {
  readonly fetch?: GitLabFetch
  readonly now?: () => number
  readonly signal?: AbortSignal
}

/**
 * Exchange one authorization code (with its PKCE verifier) for a grant.
 *
 * @param code - the pasted `code`.
 * @param verifier - the PKCE verifier minted with the authorize URL.
 * @param options - fetch, clock and abort seams.
 * @returns the grant, expiry derived per the rule.
 * @throws GitLabAuthError for a transport failure, a non-2xx answer or a body
 *   missing a required field.
 */
export async function exchangeGitLabCode(
  code: string,
  verifier: string,
  options: GitLabExchangeOptions = {},
): Promise<GitLabGrant> {
  const body = await postForm(
    {
      client_id: GITLAB_DUO_AGENT_AUTH.clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GITLAB_DUO_AGENT_AUTH.redirectUri,
      code_verifier: verifier,
    },
    options,
  )
  return mapToken(body, options.now ?? Date.now)
}

/** Options for {@link refreshGitLabToken}. */
export interface GitLabRefreshOptions extends GitLabExchangeOptions {}

/**
 * Refresh a stored grant.
 *
 * @remarks
 * The rule's `refresh.token.params` declares `redirect_uri "{redirect_uri}"`: a
 * refresh **must echo the vscode redirect**, or GitLab rejects it. That is the one
 * way this refresh differs from a plain `grant_type=refresh_token` exchange.
 *
 * @param refresh - the stored refresh token.
 * @param options - fetch, clock and abort seams.
 * @returns the grant, keeping the stored refresh token when the answer omits one.
 */
export async function refreshGitLabToken(
  refresh: string,
  options: GitLabRefreshOptions = {},
): Promise<GitLabGrant> {
  const body = await postForm(
    {
      client_id: GITLAB_DUO_AGENT_AUTH.clientId,
      grant_type: 'refresh_token',
      refresh_token: refresh,
      redirect_uri: GITLAB_DUO_AGENT_AUTH.redirectUri,
    },
    options,
  )
  return mapToken(body, options.now ?? Date.now, refresh)
}

/** Options for {@link loginGitLab}. */
export interface GitLabLoginOptions extends GitLabExchangeOptions {
  /** Report the authorize page; the flow wraps `session.notify`. */
  readonly onAuthUrl?: (url: string) => void
  /** Ask for the pasted callback; the flow wraps `session.prompt`. */
  readonly prompt: () => Promise<string>
  /** Fixed state/verifier, so a test can script the paste. */
  readonly state?: string
  readonly verifier?: string
}

/**
 * Run one sign-in: authorize page, pasted callback, exchange.
 *
 * @param options - fetch, clock, abort seams plus the notify/prompt callbacks.
 * @returns the grant to commit.
 * @throws GitLabAuthError for a state mismatch, an empty paste, a transport
 *   failure or a body missing a required field.
 */
export async function loginGitLab(options: GitLabLoginOptions): Promise<GitLabGrant> {
  const params = generateGitLabAuthParams({
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
  })
  options.onAuthUrl?.(params.authorizeUrl)
  const callback = parseGitLabCallback(await options.prompt())
  // The listener-free flow is the weaker door if it skips this: the state is the
  // only thing tying the pasted code to this attempt.
  if (callback.state === undefined) {
    throw new GitLabAuthError(
      'the pasted callback carries no state; paste the full vscode:// callback URL (it contains state=…)',
    )
  }
  if (callback.state !== params.state) {
    throw new GitLabAuthError('the pasted callback state does not match this sign-in attempt')
  }
  return await exchangeGitLabCode(callback.code, params.verifier, options)
}

/** Options the environment can override, as the rule's `env=` attributes declare. */
export interface GitLabDuoAuthEnv {
  readonly GITLAB_CLIENT_ID?: string | undefined
  readonly GITLAB_REDIRECT_URI?: string | undefined
}

/** The client and redirect this attempt uses: the rule's, unless the env overrides them. */
export function gitlabDuoClient(env: GitLabDuoAuthEnv = process.env): {
  clientId: string
  redirectUri: string
} {
  return {
    clientId: env.GITLAB_CLIENT_ID?.trim() || GITLAB_DUO_AUTH.clientId,
    redirectUri: env.GITLAB_REDIRECT_URI?.trim() || GITLAB_DUO_AUTH.redirectUri,
  }
}

/** Options for {@link loginGitLabDuo}. */
export interface GitLabDuoLoginOptions extends GitLabExchangeOptions {
  /** Report the authorize page; the flow wraps `session.notify`. */
  readonly onAuthUrl?: (url: string) => void
  /** Ask for the pasted callback; the flow wraps `session.prompt`. */
  readonly prompt: () => Promise<string>
  /** Report why the browser half is unavailable (a busy 8080); the flow notifies. */
  readonly onListenerError?: (message: string) => void
  /** Loopback port; defaults to the rule's 8080 and never falls back (D13). */
  readonly port?: number
  /** How long to wait for the browser before failing; defaults to five minutes. */
  readonly waitMs?: number
  /** Test seams: fixed PKCE state, clock and sleep. */
  readonly state?: string
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly env?: GitLabDuoAuthEnv
}

/** Build one attempt's authorize URL with PKCE and the configured client/redirect. */
export function generateGitLabDuoAuthParams(
  env: GitLabDuoAuthEnv = process.env,
  overrides: { state?: string; verifier?: string } = {},
): { params: GitLabAuthParams; verifier: string; clientId: string; redirectUri: string } {
  const { clientId, redirectUri } = gitlabDuoClient(env)
  const params = generateGitLabAuthParams(overrides)
  const url = new URL(params.authorizeUrl)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  return { params: { ...params, authorizeUrl: url.toString() }, verifier: params.verifier, clientId, redirectUri }
}

/**
 * Run one Duo sign-in: loopback listener **or** a pasted callback, whichever the
 * human produces first.
 *
 * @remarks
 * The rule's callback is `localhost:8080/callback` with **no port fallback**: the
 * OAuth client is registered against that exact URI, so falling back to an
 * ephemeral port would send the browser nowhere. A taken 8080 therefore surfaces
 * the rule's instructions (register your own app or use a PAT) and leaves the
 * paste prompt as the only path — never a silent port change.
 *
 * @param options - fetch, clock, listener/prompt and abort seams.
 * @returns the grant to commit.
 * @throws GitLabAuthError for a state mismatch, an empty paste, a transport
 *   failure or a body missing a required field.
 */
export async function loginGitLabDuo(options: GitLabDuoLoginOptions): Promise<GitLabGrant> {
  const { params, verifier, clientId, redirectUri } = generateGitLabDuoAuthParams(options.env, {
    ...(options.state === undefined ? {} : { state: options.state }),
  })
  options.onAuthUrl?.(params.authorizeUrl)

  let listener: Awaited<ReturnType<typeof startCallbackListener>> | undefined
  try {
    listener = await startCallbackListener({
      facts: { callback: GITLAB_DUO_AUTH.callback },
      expectedState: params.state,
      port: options.port ?? GITLAB_DUO_AUTH.callback.port,
      // D13: no ephemeral fallback — the redirect URI is registered exactly.
      portFallback: false,
      redirectUri,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    options.onListenerError?.(cause instanceof Error ? cause.message : String(cause))
  }

  const pasted = options.prompt().then(text => {
    const callback = parseGitLabCallback(text)
    if (callback.state === undefined) {
      throw new GitLabAuthError(
        'the pasted callback carries no state; paste the full callback URL (it contains state=…)',
      )
    }
    if (callback.state !== params.state) {
      throw new GitLabAuthError('the pasted callback state does not match this sign-in attempt')
    }
    return callback
  })
  // The loser of the race must not surface later as an unhandled rejection.
  pasted.catch(() => {})

  let code: string
  try {
    if (listener === undefined) {
      code = (await pasted).code
    } else {
      const raced = await withDeadline(listener.callback, pasted, options.waitMs ?? DUO_CALLBACK_WAIT_MS, options.signal)
      code = raced.code
    }
  } finally {
    await listener?.close()
  }

  const body = await postForm(
    {
      client_id: clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    options,
  )
  return mapToken(body, options.now ?? Date.now)
}

/** Race the listener against the paste and a wait budget, cancelling the timer. */
async function withDeadline<T>(
  fromListener: Promise<T>,
  fromPaste: Promise<T>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new GitLabAuthError(
          signal?.aborted === true
            ? 'the sign-in attempt was cancelled'
            : `no GitLab callback arrived within ${Math.round(waitMs / 1000)}s; start the sign-in again`,
        ),
      )
    }, waitMs)
  })
  timeout.catch(() => {})
  try {
    return await Promise.race([fromListener, fromPaste, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
