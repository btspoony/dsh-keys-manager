/**
 * The two Google routes' sign-in: authorize URL, form token exchange, userinfo,
 * project discovery and the login that ties them together.
 *
 * All of it is copied from the pinned omp rules and the hooks they name
 * (`compat/rules/auth/google-*.kdl`, `pi-ai/src/registry/oauth/google-*.ts`),
 * because the published plugin may not import `@oh-my-pi/*` at runtime. What the
 * plugin sends is pinned by `tests/auth-google.test.ts`; the copy's fidelity to
 * the pin is a review question, not a mechanical gate.
 *
 * The one deliberate deviation is how the code arrives: omp hosts a Bun loopback
 * server, the plugin hosts a Node one (`./callback-listener.ts`) **and** races it
 * against a paste prompt, so a remote session whose browser cannot reach
 * `127.0.0.1` still completes the sign-in.
 *
 * @module dsh-llm-omp-transports/google/auth
 */
import { randomBytes } from 'node:crypto'

import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, googleRedirectUri } from './route.js'
import type { GoogleRouteFacts } from './route.js'
import { GoogleAuthError, parseCallbackUrl, refusedSignIn, startCallbackListener } from './callback-listener.js'
import type { CallbackListener, GoogleCallback } from './callback-listener.js'

/** The `fetch` these calls use; narrower than the global so a stub fits. */
export type GoogleFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Access-token lifetime the rules ask for, less their 300 s skew. */
const TOKEN_SKEW_MS = 5 * 60 * 1000

/** Per-request deadline for the provisioning calls, as omp's `oauthFetch` bounds them. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long the flow waits for the browser, as omp's callback server bounds its
 * own wait (`DEFAULT_TIMEOUT`, 300 s). Without a bound a sign-in whose browser
 * never returns — a closed tab, a rejected consent screen — would hold the
 * attempt open until the process exits.
 */
const CALLBACK_WAIT_MS = 300_000

/** Antigravity's free-tier onboarding budget and poll cadence. */
const ONBOARD_TIMEOUT_MS = 30_000
const ONBOARD_POLL_INTERVAL_MS = 1_000
/** Gemini CLI's project-provisioning poll cadence and attempt cap. */
const LOAD_CODE_ASSIST_POLL_INTERVAL_MS = 5_000
const POLL_MAX_ATTEMPTS = 24

const FREE_TIER_ID = 'free-tier'
const LEGACY_TIER_ID = 'legacy-tier'
const STANDARD_TIER_ID = 'standard-tier'

/** What the authorize URL request carries: the state and the page to open. */
export interface GoogleAuthParams {
  readonly state: string
  readonly redirectUri: string
  readonly authorizeUrl: string
}

/**
 * Mint the state and the authorize URL.
 *
 * @remarks
 * The rule sets `pkce: false`, so there is no challenge; it also sets
 * `standardAuthorizeParams: true`, which expands to `client_id`,
 * `response_type=code`, `redirect_uri`, the space-joined scopes and `state`,
 * with the rule's own `access_type=offline` and `prompt=consent` after them.
 *
 * @param facts - the route's client identity, scopes and callback.
 * @param options - a fixed state for tests, and the port the listener got.
 * @returns the state, the redirect URI and the page to open.
 */
export function googleAuthParams(
  facts: GoogleRouteFacts,
  options: { state?: string; port?: number } = {},
): GoogleAuthParams {
  // The rule declares `state "hex"`: 16 random bytes, hex-encoded.
  const state = options.state ?? randomBytes(16).toString('hex')
  const redirectUri = googleRedirectUri(facts, options.port ?? facts.callback.port)
  const query = new URLSearchParams({
    client_id: facts.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: facts.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  return { state, redirectUri, authorizeUrl: `${GOOGLE_AUTHORIZE_URL}?${query.toString()}` }
}

/** One token response, mapped the way the rules' `credential` blocks map it. */
export interface GoogleTokenGrant {
  readonly access: string
  /** Absent when the response did not rotate it (a refresh that returns none). */
  readonly refresh?: string
  /** Epoch ms: response time plus `expires_in`, less the rule's 300 s skew. */
  readonly expires: number
  readonly email?: string
}

/** Options shared by the token calls; `fetch` and `now` are the test seams. */
export interface GoogleTokenOptions {
  readonly fetch?: GoogleFetch
  readonly now?: () => number
  readonly signal?: AbortSignal
}

/**
 * Exchange an authorization code for a grant.
 *
 * @param facts - the route's client identity and callback.
 * @param code - the code the listener or the paste delivered.
 * @param redirectUri - the redirect URI used in the authorize request; Google
 *   compares it on the exchange.
 * @param options - fetch, clock and abort seams.
 * @returns the mapped grant.
 * @throws GoogleAuthError when Google rejects the exchange, or when it returns
 *   no `refresh_token`: without one the grant cannot outlive the access token,
 *   and the rules' hooks refuse it for the same reason.
 */
export async function exchangeGoogleCode(
  facts: GoogleRouteFacts,
  code: string,
  redirectUri: string,
  options: GoogleTokenOptions = {},
): Promise<GoogleTokenGrant> {
  const body = await postForm(
    GOOGLE_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      client_id: facts.clientId,
      client_secret: facts.clientSecret,
      code,
      redirect_uri: redirectUri,
    },
    options,
  )
  const grant = mapGrant(body, options.now)
  if (grant.refresh === undefined) {
    throw new GoogleAuthError('Google returned no refresh token; sign in again from scratch')
  }
  return grant
}

/**
 * Refresh an access token.
 *
 * @param facts - the route's client identity.
 * @param refresh - the stored refresh token.
 * @param options - fetch, clock and abort seams.
 * @returns the new grant; `refresh` is absent when Google did not rotate it.
 */
export async function refreshGoogleToken(
  facts: GoogleRouteFacts,
  refresh: string,
  options: GoogleTokenOptions = {},
): Promise<GoogleTokenGrant> {
  const body = await postForm(
    GOOGLE_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: facts.clientId,
      client_secret: facts.clientSecret,
      refresh_token: refresh,
    },
    options,
  )
  return mapGrant(body, options.now)
}

/**
 * Read the account email from the userinfo endpoint.
 *
 * @param access - the access token to identify with.
 * @param options - fetch, clock and abort seams.
 * @returns the email, or undefined when userinfo failed (as omp's mapping does).
 */
export async function fetchGoogleEmail(
  access: string,
  options: GoogleTokenOptions = {},
): Promise<string | undefined> {
  const response = await request(
    GOOGLE_USERINFO_URL,
    { headers: { authorization: `Bearer ${access}` } },
    options,
  )
  if (!response.ok) return undefined
  try {
    const body = (await response.json()) as { email?: unknown }
    return typeof body.email === 'string' && body.email !== '' ? body.email : undefined
  } catch {
    return undefined
  }
}

/** Options for {@link discoverGoogleProject}. */
export interface GoogleDiscoveryOptions extends GoogleTokenOptions {
  /** Environment the discovery scripts read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Poll sleep, so a test does not wait real seconds. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Progress narration; the flow forwards it to `session.notify`. */
  readonly onProgress?: (message: string) => void
}

/**
 * Resolve the Cloud Code Assist project behind an access token.
 *
 * @param facts - which route's discovery script to run.
 * @param access - the access token from the exchange.
 * @param options - fetch, clock, env, sleep and abort seams.
 * @returns the `cloudaicompanionProject` id.
 * @throws GoogleAuthError when Google refuses the account, needs
 *   `GOOGLE_CLOUD_PROJECT`, or answers without a project.
 */
export async function discoverGoogleProject(
  facts: GoogleRouteFacts,
  access: string,
  options: GoogleDiscoveryOptions = {},
): Promise<string> {
  return facts.discovery.kind === 'antigravity'
    ? discoverAntigravityProject(facts, access, options)
    : discoverGeminiCliProject(facts, access, options)
}

/** The headers the discovery calls carry, as the pinned rules send them. */
function discoveryHeaders(facts: GoogleRouteFacts, access: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    'content-type': 'application/json',
    'user-agent': facts.discovery.userAgent,
    ...(facts.discovery.clientMetadata === undefined ? {} : { 'client-metadata': facts.discovery.clientMetadata }),
  }
}

/** A Cloud Code Assist response body, read leniently: the scripts test fields, not schemas. */
type JsonBody = Record<string, unknown>

/** `loadCodeAssist` → tiers → `onboardUser` → LRO poll, the Gemini CLI script. */
async function discoverGeminiCliProject(
  facts: GoogleRouteFacts,
  access: string,
  options: GoogleDiscoveryOptions,
): Promise<string> {
  const env = options.env ?? process.env
  const envProjectId = env.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT_ID
  const headers = discoveryHeaders(facts, access)
  const endpoint = facts.discovery.endpoint
  const metadata = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    duetProject: envProjectId,
  }

  options.onProgress?.('Checking for an existing Cloud Code Assist project…')
  const load = await request(
    `${endpoint}/v1internal:loadCodeAssist`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ cloudaicompanionProject: envProjectId, metadata }),
    },
    options,
  )

  let data: JsonBody
  if (!load.ok) {
    const errorPayload = await readJson(load.clone())
    // A VPC-SC-guarded account cannot read projects but can use them; the
    // Gemini CLI script treats it as a standard-tier account and moves on.
    if (isVpcScAffectedUser(errorPayload)) {
      data = { currentTier: { id: STANDARD_TIER_ID } }
    } else {
      throw new GoogleAuthError(`loadCodeAssist failed: ${load.status} ${await errorText(load)}`)
    }
  } else {
    data = ((await readJson(load)) ?? {}) as JsonBody
  }

  if (data.currentTier !== undefined && data.currentTier !== null) {
    const project = stringField(data, 'cloudaicompanionProject')
    if (project !== undefined) return project
    if (envProjectId !== undefined) return envProjectId
    throw new GoogleAuthError(envProjectIdRequired())
  }

  const tierId = defaultTierId(data.allowedTiers) ?? FREE_TIER_ID
  if (tierId !== FREE_TIER_ID && envProjectId === undefined) {
    throw new GoogleAuthError(envProjectIdRequired())
  }

  options.onProgress?.('Provisioning a Cloud Code Assist project (this may take a moment)…')
  const onboardBody: JsonBody = { tierId, metadata }
  if (tierId !== FREE_TIER_ID && envProjectId !== undefined) {
    onboardBody.cloudaicompanionProject = envProjectId
    onboardBody.metadata = { ...metadata, duetProject: envProjectId }
  }
  const onboard = await request(
    `${endpoint}/v1internal:onboardUser`,
    { method: 'POST', headers, body: JSON.stringify(onboardBody) },
    options,
  )
  if (!onboard.ok) {
    throw new GoogleAuthError(`onboardUser failed: ${onboard.status} ${await errorText(onboard)}`)
  }

  let operation = ((await readJson(onboard)) ?? {}) as JsonBody
  const operationName = stringField(operation, 'name')
  if (operation.done !== true && operationName !== undefined) {
    operation = await pollGeminiCliOperation(endpoint, operationName, headers, options)
  }

  const project = nestedProjectId(operation)
  if (project !== undefined) return project
  if (envProjectId !== undefined) return envProjectId
  throw new GoogleAuthError(
    'could not discover or provision a Google Cloud project; set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID',
  )
}

/** Poll one provisioning operation until it reports `done`. */
async function pollGeminiCliOperation(
  endpoint: string,
  name: string,
  headers: Record<string, string>,
  options: GoogleDiscoveryOptions,
): Promise<JsonBody> {
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      options.onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})…`)
      await sleep(LOAD_CODE_ASSIST_POLL_INTERVAL_MS, options.signal)
    }
    const response = await request(`${endpoint}/v1internal/${name}`, { headers }, options)
    if (!response.ok) {
      throw new GoogleAuthError(`project provisioning poll failed: ${response.status} ${response.statusText}`)
    }
    const payload = ((await readJson(response)) ?? {}) as JsonBody
    if (payload.done === true) return payload
  }
  throw new GoogleAuthError(`project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`)
}

/** The Antigravity script: read status, onboard the free tier, re-read the project. */
async function discoverAntigravityProject(
  facts: GoogleRouteFacts,
  access: string,
  options: GoogleDiscoveryOptions,
): Promise<string> {
  const headers = discoveryHeaders(facts, access)
  const endpoint = facts.discovery.endpoint
  const loadCodeAssist = async (body: JsonBody): Promise<JsonBody> => {
    const response = await request(`${endpoint}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, options)
    if (!response.ok) {
      throw new GoogleAuthError(`loadCodeAssist failed: ${response.status} ${await errorText(response)}`)
    }
    return ((await readJson(response)) ?? {}) as JsonBody
  }

  options.onProgress?.('Checking the Cloud Code Assist account…')
  let status = await loadCodeAssist({ metadata: { ideType: 'ANTIGRAVITY' } })
  // A project but no paid tier means the account has a free-tier project to
  // report; the second read names it.
  const firstProject = stringField(status, 'cloudaicompanionProject')
  if (status.paidTier === undefined && firstProject !== undefined) {
    status = await loadCodeAssist({
      cloudaicompanionProject: firstProject,
      metadata: { ideType: 'ANTIGRAVITY' },
    })
  }
  assertAntigravityFreeTierEligible(status)

  if (status.currentTier === undefined || status.currentTier === null) {
    options.onProgress?.('Provisioning the Antigravity free tier…')
    await onboardAntigravityUser(endpoint, headers, options)
  }

  options.onProgress?.('Reading the Cloud Code Assist project…')
  const refreshed = await loadCodeAssist({ metadata: { ideType: 'ANTIGRAVITY' } })
  const project = stringField(refreshed, 'cloudaicompanionProject')
  if (project !== undefined) return project
  throw new GoogleAuthError('loadCodeAssist did not name a cloudaicompanionProject')
}

/** Onboard the Antigravity free tier, polling the operation inside its budget. */
async function onboardAntigravityUser(
  endpoint: string,
  headers: Record<string, string>,
  options: GoogleDiscoveryOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep
  const deadline = nowMs(options) + ONBOARD_TIMEOUT_MS
  const remaining = (): number => {
    const left = deadline - nowMs(options)
    if (left > 0) return left
    throw new GoogleAuthError(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`)
  }
  const call = async (url: string, method: 'GET' | 'POST'): Promise<JsonBody> => {
    const response = await request(
      url,
      {
        method,
        headers,
        ...(method === 'POST'
          ? { body: JSON.stringify({ tierId: FREE_TIER_ID, metadata: { ideType: 'ANTIGRAVITY' } }) }
          : {}),
      },
      options,
    )
    if (response.status !== 200) {
      throw new GoogleAuthError(`onboardUser failed: ${response.status} ${await errorText(response)}`)
    }
    return ((await readJson(response)) ?? {}) as JsonBody
  }

  let operation = await call(`${endpoint}/v1internal:onboardUser`, 'POST')
  while (operation.done !== true) {
    await sleep(Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()), options.signal)
    const name = stringField(operation, 'name')
    if (name === undefined) throw new GoogleAuthError('onboardUser returned an operation without a name')
    operation = await call(`${endpoint}/v1internal/${name}`, 'GET')
  }
  const error = operation.error
  if (error !== undefined && error !== null) {
    const message = typeof error === 'object' && error !== null ? stringField(error as JsonBody, 'message') : undefined
    throw new GoogleAuthError(`the onboarding operation failed: ${message ?? JSON.stringify(error)}`)
  }
  if (operation.response === undefined || operation.response === null) {
    throw new GoogleAuthError('onboardUser returned no provisioning result')
  }
}

/** Refuse an account whose free tier is explicitly unavailable. */
function assertAntigravityFreeTierEligible(status: JsonBody): void {
  const allowed = status.allowedTiers
  if (Array.isArray(allowed) && allowed.some(tier => tierIdOf(tier) === FREE_TIER_ID)) return
  const ineligible = status.ineligibleTiers
  if (!Array.isArray(ineligible)) return
  const tier = ineligible.find(candidate => tierIdOf(candidate, 'tierId') === FREE_TIER_ID)
  if (typeof tier !== 'object' || tier === null) return
  const reason = stringField(tier as JsonBody, 'reasonMessage')
  if (reason === undefined) return
  const validationUrl = stringField(tier as JsonBody, 'validationUrl')
  throw new GoogleAuthError(`${reason}${validationUrl === undefined ? '' : `\n${validationUrl}`}`)
}

/** The id of one tier object in either shape the scripts read. */
function tierIdOf(tier: unknown, field = 'id'): string | undefined {
  return typeof tier === 'object' && tier !== null ? stringField(tier as JsonBody, field) : undefined
}

/** The rule's error text for an account that must name its own project. */
function envProjectIdRequired(): string {
  return (
    'this account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable; ' +
    'see https://goo.gle/gemini-cli-auth-docs#workspace-gca'
  )
}

/** The default tier of a `loadCodeAssist` answer: the flagged one, else legacy. */
function defaultTierId(allowedTiers: unknown): string | undefined {
  if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) return LEGACY_TIER_ID
  const flagged = allowedTiers.find(tier => typeof tier === 'object' && tier !== null && (tier as JsonBody).isDefault === true)
  return tierIdOf(flagged) ?? LEGACY_TIER_ID
}

/** The project id inside a completed operation's response. */
function nestedProjectId(operation: JsonBody): string | undefined {
  const response = operation.response
  if (typeof response !== 'object' || response === null) return undefined
  const project = (response as JsonBody).cloudaicompanionProject
  if (typeof project === 'string') return project === '' ? undefined : project
  return typeof project === 'object' && project !== null ? stringField(project as JsonBody, 'id') : undefined
}

/** A VPC-SC-guarded account: the only `loadCodeAssist` failure the script tolerates. */
function isVpcScAffectedUser(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const error = (payload as JsonBody).error
  if (typeof error !== 'object' || error === null) return false
  const details = (error as JsonBody).details
  if (!Array.isArray(details)) return false
  return details.some(detail => typeof detail === 'object' && detail !== null && (detail as JsonBody).reason === 'SECURITY_POLICY_VIOLATED')
}

/** One string field of a JSON object, or undefined when absent/empty/wrong type. */
function stringField(body: JsonBody, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a response body as JSON, tolerating an empty or malformed one. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** The response text, for an error message; never throws. */
async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return response.statusText
  }
}

/** Options for {@link loginGoogle}. */
export interface GoogleLoginOptions extends GoogleDiscoveryOptions {
  /**
   * Ask for the callback text; the flow wraps `session.prompt`. The signal
   * withdraws the question once the listener already has the code.
   */
  readonly prompt: (signal: AbortSignal) => Promise<string>
  /** Report the authorize page before waiting; the flow wraps `session.notify`. */
  readonly onAuthUrl?: (url: string) => void
  /** Fixed state, so a test can script both the listener and the paste. */
  readonly state?: string
  /** Preferred loopback port; `0` binds an ephemeral one. */
  readonly port?: number
  /** How long to wait for the browser before failing the attempt; defaults to five minutes. */
  readonly waitMs?: number
}

/** What a completed sign-in yields: the token grant plus the discovered project. */
export interface GoogleLoginResult extends GoogleTokenGrant {
  readonly projectId: string
}

/**
 * Run the sign-in end to end: authorize page, callback (listener or paste), token
 * exchange, userinfo and project discovery.
 *
 * @remarks
 * The listener and the paste prompt race: whichever delivers a callback first
 * wins, the loser is withdrawn. That is what makes one flow work both on a local
 * desktop (the browser redirects into the listener, the prompt is cancelled) and
 * over SSH (the browser cannot reach the loopback, so the human pastes the
 * address). omp reaches the same two modes through its Bun listener plus a manual
 * input channel; this is the same shape without Bun.
 *
 * @param facts - the route's client identity, callback and discovery script.
 * @param options - prompt/notify callbacks and the fetch/clock/state seams.
 * @returns the grant to commit.
 * @throws GoogleAuthError for every failed step; the flow maps it to `AUTH_FAILED`.
 */
export async function loginGoogle(
  facts: GoogleRouteFacts,
  options: GoogleLoginOptions,
): Promise<GoogleLoginResult> {
  const state = options.state ?? randomBytes(16).toString('hex')
  const listener = await startCallbackListener({
    facts,
    expectedState: state,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const params = googleAuthParams(facts, { state, port: listener.port })
  options.onAuthUrl?.(params.authorizeUrl)

  const answering = new AbortController()
  const pasted = options.prompt(answering.signal).then(text => {
    // A consent screen that returned an error has no grant to exchange; the
    // parser deliberately stays provider-agnostic (it also serves Devin's paste).
    const refusal = refusedSignIn(text)
    if (refusal !== undefined) throw new GoogleAuthError(`Google refused the sign-in: ${refusal}`)
    const callback = parseCallbackUrl(text)
    if (callback.state !== undefined && callback.state !== state) {
      throw new GoogleAuthError('the pasted callback state does not match this sign-in attempt')
    }
    return callback
  })
  // The loser of the race must not surface later as an unhandled rejection.
  pasted.catch(() => {})

  const waitMs = options.waitMs ?? CALLBACK_WAIT_MS
  const deadline = withDeadline(listener.callback, pasted, waitMs, options.signal)

  let callback: GoogleCallback
  try {
    callback = await deadline.promise
  } finally {
    deadline.cancel()
    answering.abort()
    await listener.close()
  }
  if (callback.state !== undefined && callback.state !== state) {
    throw new GoogleAuthError('the callback state does not match this sign-in attempt')
  }

  const grant = await exchangeGoogleCode(facts, callback.code, params.redirectUri, options)
  const email = await fetchGoogleEmail(grant.access, options)
  const projectId = await discoverGoogleProject(facts, grant.access, options)
  return { ...grant, ...(email === undefined ? {} : { email }), projectId }
}

/**
 * POST a form body to a token endpoint and read the JSON answer.
 *
 * @param url - the endpoint.
 * @param params - the form fields, in the rule's order.
 * @param options - fetch, clock and abort seams.
 * @returns the parsed body.
 * @throws GoogleAuthError for a transport failure, a timeout, an abort or a
 *   non-2xx answer.
 */
async function postForm(url: string, params: Record<string, string>, options: GoogleTokenOptions): Promise<unknown> {
  const response = await request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    options,
  )
  if (!response.ok) {
    throw new GoogleAuthError(`the Google token request failed: ${response.status} ${await errorText(response)}`)
  }
  const body = await readJson(response)
  if (typeof body !== 'object' || body === null) {
    throw new GoogleAuthError('the Google token request returned a non-JSON body')
  }
  return body
}

/** Map one token response onto the grant, as the rules' `credential` block does. */
function mapGrant(body: unknown, now: (() => number) | undefined): GoogleTokenGrant {
  const payload = (typeof body === 'object' && body !== null ? body : {}) as JsonBody
  const access = stringField(payload, 'access_token')
  if (access === undefined) {
    throw new GoogleAuthError(
      `the Google token response carried no access_token: ${JSON.stringify(payload).slice(0, 200)}`,
    )
  }
  const expiresIn = payload.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new GoogleAuthError('the Google token response carried no expires_in')
  }
  const refresh = stringField(payload, 'refresh_token')
  const clock = now ?? Date.now
  return {
    access,
    expires: clock() + expiresIn * 1000 - TOKEN_SKEW_MS,
    ...(refresh === undefined ? {} : { refresh }),
  }
}

/**
 * One provisioning call, bounded like omp's `oauthFetch`.
 *
 * @remarks
 * The attempt's signal and a per-request deadline are composed, so a stalled
 * endpoint fails the sign-in instead of hanging it, and a cancelled attempt
 * reports the cancellation.
 */
async function request(url: string, init: RequestInit, options: GoogleTokenOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const doFetch = options.fetch ?? fetch
  try {
    return await doFetch(url, { ...init, signal })
  } catch (cause) {
    if (options.signal?.aborted) throw new GoogleAuthError('the sign-in attempt was cancelled')
    if (timeout.aborted) throw new GoogleAuthError(`the Google request to ${url} timed out`)
    throw new GoogleAuthError(
      `the Google request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/**
 * Race the two ways a callback can arrive against the wait budget.
 *
 * @param fromListener - the loopback listener's callback.
 * @param fromPaste - the prompt's callback.
 * @param waitMs - how long the browser may take.
 * @param signal - the attempt's signal, so an abort reads as a cancellation
 *   rather than a timeout.
 * @returns the race, plus a `cancel` that clears the pending timer.
 */
function withDeadline<T>(
  fromListener: Promise<T>,
  fromPaste: Promise<T>,
  waitMs: number,
  signal: AbortSignal | undefined,
): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new GoogleAuthError(
          signal?.aborted === true
            ? 'the sign-in attempt was cancelled'
            : `no browser callback arrived within ${Math.round(waitMs / 1000)}s; start the sign-in again`,
        ),
      )
    }, waitMs)
  })
  // A settled race leaves whichever half lost; neither may surface later.
  timeout.catch(() => {})
  return {
    promise: Promise.race([fromListener, fromPaste, timeout]),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** Clock read that a test can pin. */
function nowMs(options: GoogleTokenOptions): number {
  return (options.now ?? Date.now)()
}

/** Default poll sleep, interruptible by the attempt signal. */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    function onAbort(): void {
      clearTimeout(timer)
      reject(new GoogleAuthError('the sign-in attempt was cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
