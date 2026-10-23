/**
 * The two Google routes' credential records: shape, the refreshing access
 * resolver, and the structured envelope the transport reads.
 *
 * The payload is the plugin's own (`ctx.credentials` hands it back opaquely), and
 * it carries one field the shipped routes do not: `projectId`. Every Cloud Code
 * Assist request names a project, so a refresh that dropped it would leave a
 * valid token with nowhere to send it — the pinned rule says `require
 * "projectId"` for exactly this reason, and this resolver preserves it.
 *
 * The transport wants a JSON string, not a bare token: omp's
 * `parseGeminiCliCredentials` reads `{token, projectId, refreshToken, expiresAt,
 * email}`. {@link createGoogleAccess} is therefore where the record becomes that
 * envelope, once per request.
 *
 * @module dsh-llm-omp-transports/google/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import { refreshGoogleToken } from './auth.js'
import type { GoogleFetch } from './auth.js'
import { GoogleAuthError } from './callback-listener.js'
import { throwIfAborted } from '../cursor/auth.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'
import type { GoogleRouteFacts, GoogleRouteId } from './route.js'

/** The record key one Google route owns: scope `<plugin name>`, id the route. */
export function googleCredentialKey(id: GoogleRouteId): string {
  return `llm-omp-transports/${id}`
}

/** The Gemini CLI route's credential record. */
export const GOOGLE_GEMINI_CLI_CREDENTIAL_KEY = googleCredentialKey('google-gemini-cli')
/** The Antigravity route's credential record. */
export const GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY = googleCredentialKey('google-antigravity')

/**
 * How long before `expires` the resolver refreshes.
 *
 * Matches the transport's own skew (`shouldRefreshGeminiCliCredentials`), so the
 * envelope it is handed never lands expired.
 */
const REFRESH_WINDOW_MS = 60_000

/** The payload this plugin writes into its Google grant record. */
export interface GoogleGrantPayload {
  /** Bearer token for Cloud Code Assist. */
  readonly access: string
  /** Refresh token; absent only if a record was written without one. */
  readonly refresh?: string
  /** Epoch ms, the token response time plus `expires_in` less the rule's 300 s skew. */
  readonly expires: number
  /** The Cloud Code Assist project every request names. */
  readonly projectId: string
  /** Account email, when userinfo named one. */
  readonly email?: string
}

/** Options for {@link createGoogleAccess}; `fetch` and `now` are the test seams. */
export interface GoogleAccessOptions {
  readonly fetch?: GoogleFetch
  /** Clock, for tests that cross the refresh window. */
  readonly now?: () => number
}

/** The grant payload of one record, or undefined when it is not a usable Google grant. */
export function readGoogleGrant(record: StoredCredentialRecord | undefined): GoogleGrantPayload | undefined {
  const payload = payloadOf(record)
  if (payload === undefined) return undefined
  const { access, expires, refresh, projectId, email } = payload
  if (typeof access !== 'string' || access === '') return undefined
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return undefined
  if (typeof projectId !== 'string' || projectId === '') return undefined
  return {
    access,
    expires,
    projectId,
    ...(typeof refresh === 'string' && refresh !== '' ? { refresh } : {}),
    ...(typeof email === 'string' ? { email } : {}),
  }
}

/** The raw grant payload object, so a refresh keeps fields this module does not name. */
function payloadOf(record: StoredCredentialRecord | undefined): Record<string, unknown> | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  return payload as Record<string, unknown>
}

/**
 * Build the adapter's per-request access resolver.
 *
 * @remarks
 * The resolver answers the structured envelope omp parses, not a bare token. A
 * grant outside the refresh window is renewed under `modifyRecord` — the seam's
 * serialized read-modify-write and the only write path — so two processes
 * rotating one refresh token cannot lose whichever wrote first: the loser sees a
 * live grant on its re-read and returns without writing.
 *
 * A missing refresh token or a rejected refresh is `REAUTH_REQUIRED`, not a
 * transient failure: the sign-in is dead until the human runs the flow again.
 *
 * @param credentials - the record half of `ctx.credentials`.
 * @param facts - the route's client identity and credential key.
 * @param options - fetch and clock seams.
 * @returns a resolver from the caller's abort signal to the JSON envelope.
 */
export function createGoogleAccess(
  credentials: CredentialRecordsLike,
  facts: GoogleRouteFacts,
  options: GoogleAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now
  const key = googleCredentialKey(facts.id)

  return async signal => {
    const grant = readGoogleGrant(await credentials.readRecord(key))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no ${facts.label} sign-in is stored at ${key}; run the ${facts.label} authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (!needsRefresh(grant, now())) return envelope(grant)

    const stored = await withCredentialErrors(facts, () =>
      credentials.modifyRecord(key, async current => {
        const live = readGoogleGrant(current)
        // Removed or replaced while this turn waited for the lock: leave it alone.
        if (live === undefined) return undefined
        // Another process refreshed it between the read and the lock.
        if (!needsRefresh(live, now())) return undefined
        if (live.refresh === undefined) {
          throw new LlmError(
            `llm-omp-transports: the ${facts.label} grant stored at ${key} has no refresh token; sign in again`,
            'REAUTH_REQUIRED',
          )
        }
        const refreshed = await refreshGoogleToken(facts, live.refresh, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(signal === undefined ? {} : { signal }),
        })
        // A turn cancelled while the exchange ran must not commit a token it will
        // never use; the refresh already happened, so the next turn refreshes again.
        throwIfAborted(signal)
        return {
          kind: 'grant',
          payload: {
            ...(payloadOf(current) ?? {}),
            access: refreshed.access,
            // A refresh that does not rotate the token keeps the stored one.
            refresh: refreshed.refresh ?? live.refresh,
            expires: refreshed.expires,
            // The project is not part of a token response; a refresh must not erase it.
            projectId: live.projectId,
            ...(live.email === undefined ? {} : { email: live.email }),
          },
        }
      }),
    )

    const resolved = readGoogleGrant(stored)
    if (resolved === undefined) {
      throw new LlmError(
        `llm-omp-transports: the ${facts.label} sign-in stored at ${key} disappeared while it was refreshed; sign in again`,
        'MISSING_CREDENTIAL',
      )
    }
    return envelope(resolved)
  }
}

/** Whether a grant is inside the refresh window. */
function needsRefresh(grant: GoogleGrantPayload, nowMs: number): boolean {
  return grant.expires - REFRESH_WINDOW_MS <= nowMs
}

/** The JSON envelope omp's `parseGeminiCliCredentials` reads. */
function envelope(grant: GoogleGrantPayload): string {
  return JSON.stringify({
    token: grant.access,
    projectId: grant.projectId,
    ...(grant.refresh === undefined ? {} : { refreshToken: grant.refresh }),
    expiresAt: grant.expires,
    ...(grant.email === undefined ? {} : { email: grant.email }),
  })
}

/** Map the auth module's failures onto the seam's stable codes. */
async function withCredentialErrors<T>(facts: GoogleRouteFacts, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (cause) {
    if (cause instanceof LlmError) throw cause
    if (cause instanceof GoogleAuthError) {
      // A rejected refresh means the stored grant can never be renewed; the human
      // has to start the sign-in again.
      throw new LlmError(`llm-omp-transports: ${facts.label} sign-in failed — ${cause.message}`, 'REAUTH_REQUIRED', {
        cause,
      })
    }
    throw cause
  }
}
