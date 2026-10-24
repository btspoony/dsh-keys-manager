/**
 * The `llm-omp-transports/factory-droid` sign-in: WorkOS device authorization
 * (RFC 8628) plus the Factory identity lookup.
 *
 * omp's pinned rule (`compat/rules/auth/factory-droid.kdl`) declares a
 * `login "device-code"` with a public client id, a 15 s budget on both token
 * calls, `authorization_pending`/`slow_down`/`expired_token`/`access_denied`
 * classification and a `jwt`-derived expiry with a one-day fallback. The plugin
 * cannot execute that engine (it lives in the artifact's build-time dependency),
 * so this module copies the rule's behaviour the same way `src/google/*.ts`
 * copies the Google rules: form bodies, cadence and error mapping are the rule's,
 * driven through an injected `fetch` and `sleep` so every test is offline.
 *
 * The browser half needs no listener and no paste: the human approves on
 * Factory's page, and the poll completes the grant. Only the authorization
 * seam's `notify` is used.
 *
 * @module dsh-llm-omp-transports/factory-droid/auth
 */
import { randomUUID } from 'node:crypto'

import { jwtExpiry, readJwtPayload } from '../jwt.js'

/** The rule's WorkOS client: a public device-code client, no secret. */
export const FACTORY_DROID_CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB'
/** The rule's device-authorization endpoint (`timeout-ms=15000`). */
export const FACTORY_DROID_DEVICE_URL = 'https://api.workos.com/user_management/authorize/device'
/** The rule's token endpoint, used by both the poll and the refresh. */
export const FACTORY_DROID_TOKEN_URL = 'https://api.workos.com/user_management/authenticate'
/** Factory's API host per residency; EU accounts are served from the EU region. */
export const FACTORY_DROID_API_URL = 'https://api.factory.ai'
/** The EU residency host, for accounts whose whoami resolves `region: 'eu'`. */
export const FACTORY_DROID_EU_API_URL = 'https://api.eu.factory.ai'

/** The rule's `timeout-ms` on both token calls. */
const TOKEN_TIMEOUT_MS = 15_000
/** `expires "jwt" skew-ms=0 fallback-ms=86400000`: no skew, one day. */
const TOKEN_FALLBACK_LIFETIME_MS = 86_400_000
/** RFC 8628 floor; the rule's default cadence is 5 s. */
const MIN_POLL_INTERVAL_MS = 1_000
const DEFAULT_POLL_INTERVAL_SECONDS = 5
/** `slow_down` answers widen the interval by the engine's 5 s step. */
const SLOW_DOWN_INCREMENT_MS = 5_000

/** A sign-in step that failed in a way the flow reports as `AUTH_FAILED`. */
export class FactoryDroidAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FactoryDroidAuthError'
  }
}

/** The `fetch` this module uses; narrower than the global so a stub fits. */
export type FactoryDroidFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Account identity Factory resolves for one grant. */
export interface FactoryDroidIdentity {
  /** Factory organization id (`external_org_id` claim, or the whoami body). */
  readonly orgId?: string
  /** API residency: `eu` gets its own host, `global` the default one. */
  readonly region?: string
  /** Inference scope, independent of residency. */
  readonly inferenceRegion?: 'global' | 'us' | 'eu'
}

/** The grant the flow commits: the documented payload, nothing else. */
export interface FactoryDroidGrant extends FactoryDroidIdentity {
  readonly access: string
  readonly refresh: string
  /** Epoch ms; the rule's `jwt` expiry with a one-day fallback. */
  readonly expires: number
  readonly email?: string
  readonly accountId?: string
}

/** Options shared by the two token calls. */
export interface FactoryDroidTokenOptions {
  readonly fetch?: FactoryDroidFetch
  readonly now?: () => number
  readonly signal?: AbortSignal
}

/** The device authorization one attempt receives from WorkOS. */
export interface FactoryDroidDeviceAuthorization {
  readonly userCode: string
  readonly deviceCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  /** Provider cadence in seconds; absent means RFC 8628's five. */
  readonly intervalSeconds?: number
  /** Provider window in seconds; absent means no deadline but the caller's signal. */
  readonly expiresInSeconds?: number
}

/** POST one form body and read the JSON answer under the rule's timeout. */
async function postForm(url: string, params: Record<string, string>, options: FactoryDroidTokenOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal,
    })
  } catch (cause) {
    // A withdrawn attempt must surface as the cancellation it is, not as a
    // transport failure: the flow rethrows it and the seam reports "cancelled".
    if (options.signal?.aborted === true) throw cause
    throw new FactoryDroidAuthError(
      `the WorkOS request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/** Read one JSON field from an unknown body, trimmed. */
function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Request one device authorization.
 *
 * @param options - fetch and abort seams.
 * @returns the codes, the verification page and the rule's cadence/window.
 * @throws FactoryDroidAuthError for a transport failure, a non-2xx answer or a
 *   body missing a required field.
 */
export async function requestDeviceAuthorization(
  options: FactoryDroidTokenOptions = {},
): Promise<FactoryDroidDeviceAuthorization> {
  const response = await postForm(FACTORY_DROID_DEVICE_URL, { client_id: FACTORY_DROID_CLIENT_ID }, options)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new FactoryDroidAuthError(
      `the Factory device authorization failed with HTTP ${response.status}${describeError(body)}`,
    )
  }
  const userCode = field(body, 'user_code')
  const deviceCode = field(body, 'device_code')
  const verificationUri = field(body, 'verification_uri')
  if (userCode === undefined || deviceCode === undefined || verificationUri === undefined) {
    throw new FactoryDroidAuthError('the Factory device authorization response is missing a required field')
  }
  const interval = typeof body === 'object' && body !== null ? (body as { interval?: unknown }).interval : undefined
  const expiresIn = typeof body === 'object' && body !== null ? (body as { expires_in?: unknown }).expires_in : undefined
  return {
    userCode,
    deviceCode,
    verificationUri,
    ...(field(body, 'verification_uri_complete') === undefined
      ? {}
      : { verificationUriComplete: field(body, 'verification_uri_complete')! }),
    ...(typeof interval === 'number' && Number.isFinite(interval) ? { intervalSeconds: interval } : {}),
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? { expiresInSeconds: expiresIn } : {}),
  }
}

/** Append the server's own error text, when it sent one. */
function describeError(body: unknown): string {
  const description = field(body, 'error_description') ?? field(body, 'error') ?? field(body, 'message')
  return description === undefined ? '' : `: ${description}`
}

/** The rule's credential map: what one token response becomes. */
export interface TokenResponse {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly email?: string
  readonly accountId?: string
  readonly orgId?: string
}

/** Project one token response onto the grant, as the rule's `credential` block does. */
function mapTokenResponse(body: unknown, options: FactoryDroidTokenOptions, previousRefresh?: string): TokenResponse {
  const access = field(body, 'access_token')
  if (access === undefined) {
    throw new FactoryDroidAuthError(`the Factory token response names no access token${describeError(body)}`)
  }
  const claims = readJwtPayload(access)
  const user =
    typeof body === 'object' && body !== null ? (body as { user?: unknown }).user : undefined
  const email = field(user, 'email') ?? claimString(claims, 'email')
  const accountId = field(user, 'id') ?? claimString(claims, 'sub')
  const orgId = claimString(claims, 'external_org_id')
  const refresh = field(body, 'refresh_token') ?? previousRefresh
  if (refresh === undefined || refresh === '') {
    throw new FactoryDroidAuthError('the Factory token response names no refresh token')
  }
  return {
    access,
    refresh,
    // `skew-ms=0 fallback-ms=86400000`: a JWT expiry, else one day from now.
    expires: jwtExpiry(access, {
      skewMs: 0,
      fallbackMs: TOKEN_FALLBACK_LIFETIME_MS,
      now: options.now,
    }),
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(orgId === undefined ? {} : { orgId }),
  }
}

/**
 * Project a refresh token response onto a grant.
 *
 * The refresh response is the same shape as the poll completion, minus the
 * possibility of a missing refresh token: a refresh that does not rotate keeps
 * the stored one (`previousRefresh`).
 *
 * @param body - the token endpoint's JSON body.
 * @param options - clock seam.
 * @param previousRefresh - the stored refresh token.
 * @returns the mapped grant, identity fields excluded.
 * @throws FactoryDroidAuthError when the body names no access token.
 */
export function mapRefreshedToken(
  body: unknown,
  options: FactoryDroidTokenOptions,
  previousRefresh: string,
): TokenResponse {
  return mapTokenResponse(body, options, previousRefresh)
}

/** One string claim, when the token carried it. */
function claimString(claims: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = claims?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The API host for one residency. */
export function factoryDroidApiUrl(region: string | undefined): string {
  return region === 'eu' ? FACTORY_DROID_EU_API_URL : FACTORY_DROID_API_URL
}

/** Inference scope for one account: explicit wins, EU residency infers EU. */
export function resolveInferenceRegion(identity: FactoryDroidIdentity): 'global' | 'us' | 'eu' {
  return identity.inferenceRegion ?? (identity.region === 'eu' ? 'eu' : 'global')
}

/**
 * Resolve the account identity through Factory's whoami.
 *
 * Mirrors the pinned hook: the bearer plus `X-Factory-Org-Id` (when known), a
 * 15 s budget, `region`/`inferenceRegion` validated against the wire vocabulary,
 * and a real organization required at login. The same call runs after a refresh,
 * where a failure is **non-fatal** (the stored identity stands) — the caller
 * decides that by `phase`.
 *
 * @param grant - the mapped token response.
 * @param phase - `login` fails loudly; `refresh` falls back to the stored fields.
 * @param options - fetch, clock and abort seams.
 * @returns the grant with whatever identity the server resolved.
 * @throws FactoryDroidAuthError at login for a non-2xx answer or a missing org.
 */
export async function resolveFactoryDroidIdentity(
  grant: FactoryDroidGrant,
  phase: 'login' | 'refresh',
  options: FactoryDroidTokenOptions = {},
): Promise<FactoryDroidGrant> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const url = `${factoryDroidApiUrl(grant.region)}/api/cli/whoami`
  try {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${grant.access}`,
        accept: 'application/json',
        ...(grant.orgId === undefined ? {} : { 'x-factory-org-id': grant.orgId }),
      },
      signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (phase === 'login') {
        throw new FactoryDroidAuthError(`the Factory identity check failed with HTTP ${response.status}: ${body}`)
      }
      return grant
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return finish(grant, phase)
    const orgId = field(body, 'orgId') ?? grant.orgId
    if (phase === 'login' && orgId === undefined) {
      throw new FactoryDroidAuthError('the Factory sign-in did not resolve an organization')
    }
    // A different organization must not inherit the stored scope.
    const sameOrg = orgId === undefined || grant.orgId === undefined || orgId === grant.orgId
    const rawRegion = field(body, 'region')
    const rawInference = field(body, 'inferenceRegion')
    const region = rawRegion === 'eu' || rawRegion === 'global' ? rawRegion : sameOrg ? grant.region : undefined
    const inferenceRegion =
      rawInference === 'global' || rawInference === 'eu' || rawInference === 'us'
        ? rawInference
        : resolveInferenceRegion({ region, inferenceRegion: sameOrg ? grant.inferenceRegion : undefined })
    return finish({ ...grant, ...(orgId === undefined ? {} : { orgId }), ...(region === undefined ? {} : { region }), inferenceRegion }, phase)
  } catch (cause) {
    if (options.signal?.aborted === true) throw cause
    if (phase === 'login') throw cause
    // A refresh keeps the stored identity when whoami cannot answer.
    return finish(grant, phase)
  }
}

/** Enforce the login-phase organization requirement after a silent whoami. */
function finish(grant: FactoryDroidGrant, phase: 'login' | 'refresh'): FactoryDroidGrant {
  if (phase === 'login' && grant.orgId === undefined) {
    throw new FactoryDroidAuthError('the Factory sign-in did not resolve an organization')
  }
  return { ...grant, inferenceRegion: resolveInferenceRegion(grant) }
}

/** Sleep that an abort interrupts, as the rule's poll does. */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    function onAbort(): void {
      clearTimeout(timer)
      reject(new FactoryDroidAuthError('the sign-in attempt was cancelled'))
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

/** One poll's verdict. */
type PollOutcome = { readonly status: 'complete'; readonly body: unknown } | { readonly status: 'pending' | 'slow_down' }

/** Options for {@link loginFactoryDroid}. */
export interface FactoryDroidLoginOptions extends FactoryDroidTokenOptions {
  /** Report the verification page and the user code; the flow wraps `session.notify`. */
  readonly onDevice: (device: FactoryDroidDeviceAuthorization) => void
  /** Poll sleep, so a test does not wait real seconds. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Test seam for the codes, so a scripted attempt is deterministic. */
  readonly deviceCode?: string
}

/**
 * Run one full device-code sign-in.
 *
 * @param options - fetch, sleep, clock and abort seams plus the notify callback.
 * @returns the committed grant, identity included.
 * @throws FactoryDroidAuthError for a denial, an expiry, a timeout, a transport
 *   failure or a response missing a required field.
 */
export async function loginFactoryDroid(options: FactoryDroidLoginOptions): Promise<FactoryDroidGrant> {
  const sleep = options.sleep ?? defaultSleep
  const device = await requestDeviceAuthorization(options)
  options.onDevice(device)

  const intervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.floor((device.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
  )
  const deadline =
    device.expiresInSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + device.expiresInSeconds * 1000
  let nextIntervalMs = intervalMs
  let slowedDown = false

  for (;;) {
    if (options.signal?.aborted === true) throw new FactoryDroidAuthError('the sign-in attempt was cancelled')
    const outcome = await pollDeviceToken(device.deviceCode, options)
    if (outcome.status === 'complete') {
      const mapped = mapTokenResponse(outcome.body, options)
      const identity = await resolveFactoryDroidIdentity(mapped, 'login', options)
      return identity
    }
    if (outcome.status === 'slow_down') {
      slowedDown = true
      nextIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, nextIntervalMs + SLOW_DOWN_INCREMENT_MS)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    // The sleep itself rejects on abort, so the loop needs no second check here.
    await sleep(Math.min(nextIntervalMs, remaining), options.signal)
  }
  throw new FactoryDroidAuthError(
    slowedDown
      ? 'the Factory device code expired after repeated slow_down answers; start the sign-in again'
      : 'the Factory device code expired before the sign-in completed; start the sign-in again',
  )
}

/** One token-endpoint poll, classified as the rule's engine does. */
async function pollDeviceToken(
  deviceCode: string,
  options: FactoryDroidLoginOptions,
): Promise<PollOutcome> {
  const response = await postForm(
    FACTORY_DROID_TOKEN_URL,
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: FACTORY_DROID_CLIENT_ID,
      device_code: deviceCode,
    },
    options,
  )
  const body: unknown = await response.json().catch(() => undefined)
  const error = field(body, 'error')
  if (response.ok && error === undefined) return { status: 'complete', body }
  switch (error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'expired_token':
      throw new FactoryDroidAuthError('the Factory device code expired; start the sign-in again')
    case 'access_denied':
      throw new FactoryDroidAuthError('the Factory device authorization was denied')
    default:
      throw new FactoryDroidAuthError(
        `the Factory token request failed with HTTP ${response.status}${describeError(body)}`,
      )
  }
}

/** A deterministic device code for a scripted attempt. */
export function scriptedDeviceCode(): string {
  return randomUUID()
}
