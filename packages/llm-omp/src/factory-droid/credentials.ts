/**
 * The `llm-omp-transports/factory-droid` credential: record shape and access resolution.
 *
 * The record is a WorkOS grant — `{ access, refresh?, expires?, email?,
 * accountId?, orgId?, region?, inferenceRegion? }`: the tokens the flow commits
 * plus the account scope the transport needs for its API host. This module owns
 * both halves — the flow writes the record, the adapter reads it through
 * {@link createFactoryDroidAccess} and forwards the scope as `oauthIdentity`. The pinned rule *has* a refresh
 * (`refresh { after-refresh hook="factory-droid-region" }`), so the resolver is
 * Cursor-shaped rather than Devin-shaped: a fresh grant answers without touching
 * the write path, an expiring one is renewed once under the store's per-key lock,
 * and a failure is fail-loud (`REAUTH_REQUIRED` / `MISSING_CREDENTIAL`), never a
 * silent retry with another identity.
 *
 * @module dsh-llm-omp-transports/factory-droid/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import { FACTORY_DROID_CREDENTIAL_KEY } from '../adapter.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'
import {
  FACTORY_DROID_CLIENT_ID,
  FACTORY_DROID_TOKEN_URL,
  FactoryDroidAuthError,
  mapRefreshedToken,
  resolveFactoryDroidIdentity,
} from './auth.js'
import type { FactoryDroidFetch, FactoryDroidGrant, FactoryDroidIdentity } from './auth.js'

/** The record this plugin owns; re-exported from the adapter where the route names it. */
export { FACTORY_DROID_CREDENTIAL_KEY }

/** How early a grant is renewed: enough for one in-flight turn, like Cursor's window. */
const REFRESH_WINDOW_MS = 60_000

/** The payload this plugin writes into its grant record. */
export interface FactoryDroidGrantPayload extends FactoryDroidIdentity {
  /** WorkOS access token; the transport sends it as the bearer. */
  readonly access: string
  /** WorkOS refresh token; absent means the record cannot be renewed. */
  readonly refresh?: string
  /** Epoch ms after which the access token is dead. */
  readonly expires?: number
  readonly email?: string
  readonly accountId?: string
}

/** Options for {@link createFactoryDroidAccess}; `fetch` and `now` are the test seams. */
export interface FactoryDroidAccessOptions {
  readonly fetch?: FactoryDroidFetch
  readonly now?: () => number
}

/** The grant payload of one record, or undefined when it is not a usable grant. */
export function readFactoryDroidGrant(
  record: StoredCredentialRecord | undefined,
): FactoryDroidGrantPayload | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  if (typeof fields.access !== 'string' || fields.access === '') return undefined
  return {
    access: fields.access,
    ...(typeof fields.refresh === 'string' && fields.refresh !== '' ? { refresh: fields.refresh } : {}),
    ...(typeof fields.expires === 'number' && Number.isFinite(fields.expires) ? { expires: fields.expires } : {}),
    ...(typeof fields.email === 'string' && fields.email !== '' ? { email: fields.email } : {}),
    ...(typeof fields.accountId === 'string' && fields.accountId !== '' ? { accountId: fields.accountId } : {}),
    ...(typeof fields.orgId === 'string' && fields.orgId !== '' ? { orgId: fields.orgId } : {}),
    ...(typeof fields.region === 'string' && fields.region !== '' ? { region: fields.region } : {}),
    ...(fields.inferenceRegion === 'global' || fields.inferenceRegion === 'us' || fields.inferenceRegion === 'eu'
      ? { inferenceRegion: fields.inferenceRegion }
      : {}),
  }
}

/** The raw payload object, so a refresh keeps fields this module does not name. */
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
 * A grant inside the refresh window is renewed under `modifyRecord`: `mutate`
 * re-reads the record it is handed, so a grant another writer already refreshed
 * (or one removed while this turn waited for the lock) is left alone. The
 * refreshed record keeps every identity field — a token response carries no
 * organization, and losing it would send the next turn to the wrong API host —
 * and the post-refresh whoami is **non-fatal**: on failure the stored identity
 * stands, exactly as the pinned `factory-droid-region` hook behaves on the
 * refresh phase.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - fetch and clock seams.
 * @returns a resolver that answers the stored (or refreshed) bearer.
 */
export function createFactoryDroidAccess(
  credentials: CredentialRecordsLike,
  options: FactoryDroidAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now

  return async signal => {
    const grant = readFactoryDroidGrant(await credentials.readRecord(FACTORY_DROID_CREDENTIAL_KEY))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no Factory Droid sign-in is stored at ${FACTORY_DROID_CREDENTIAL_KEY}; run the Factory Droid authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expires === undefined || grant.expires - REFRESH_WINDOW_MS > now()) return grant.access

    const stored = await withCredentialErrors(() =>
      credentials.modifyRecord(FACTORY_DROID_CREDENTIAL_KEY, async current => {
        const live = readFactoryDroidGrant(current)
        // Removed or replaced while this turn waited for the lock: leave it alone.
        if (live === undefined) return undefined
        // Another writer refreshed it between the read and the lock.
        if (live.expires === undefined || live.expires - REFRESH_WINDOW_MS > now()) return undefined
        if (live.refresh === undefined) {
          throw new LlmError(
            `llm-omp-transports: the Factory Droid grant stored at ${FACTORY_DROID_CREDENTIAL_KEY} has no refresh token; sign in again`,
            'REAUTH_REQUIRED',
          )
        }
        const refreshed = await refreshFactoryDroidToken(live, { ...options, signal })
        return {
          kind: 'grant',
          payload: {
            ...(payloadOf(current) ?? {}),
            access: refreshed.access,
            // A refresh that does not rotate the token keeps the stored one.
            refresh: refreshed.refresh ?? live.refresh,
            expires: refreshed.expires,
            // The identity is not part of a token response; a refresh must not erase it.
            ...(live.orgId === undefined ? {} : { orgId: live.orgId }),
            ...(live.region === undefined ? {} : { region: live.region }),
            ...(live.inferenceRegion === undefined ? {} : { inferenceRegion: live.inferenceRegion }),
          },
        }
      }),
    )

    // The record is committed before the cancellation is reported: a rotated
    // refresh token must not be discarded with the turn that rotated it.
    throwIfAborted(signal)
    const resolved = readFactoryDroidGrant(stored)
    if (resolved === undefined) {
      throw new LlmError(
        `llm-omp-transports: the Factory Droid sign-in stored at ${FACTORY_DROID_CREDENTIAL_KEY} disappeared while it was refreshed; sign in again`,
        'MISSING_CREDENTIAL',
      )
    }
    return resolved.access
  }
}

/** Exchange the stored refresh token, as the rule's `refresh` block does. */
async function refreshFactoryDroidToken(
  grant: FactoryDroidGrantPayload,
  options: FactoryDroidAccessOptions & { readonly signal?: AbortSignal },
): Promise<FactoryDroidGrant> {
  const live = grant
  const refreshToken = live.refresh
  if (refreshToken === undefined) {
    // The caller refuses this case before locking; keep the invariant local too.
    throw new FactoryDroidAuthError('the stored grant has no refresh token')
  }
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const timeout = AbortSignal.timeout(15_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(FACTORY_DROID_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: FACTORY_DROID_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
      signal,
    })
  } catch (cause) {
    // A cancelled turn keeps its cancellation: the caller re-reports it as such.
    if (options.signal?.aborted === true) throw cause
    throw new FactoryDroidAuthError(
      `the WorkOS refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new FactoryDroidAuthError(`the Factory token refresh failed with HTTP ${response.status}`)
  }
  const mapped = mapRefreshedToken(body, options, refreshToken)
  // A refresh keeps the stored identity when whoami cannot answer.
  return await resolveFactoryDroidIdentity(
    { ...mapped, ...(live.orgId === undefined ? {} : { orgId: live.orgId }), ...(live.region === undefined ? {} : { region: live.region }), ...(live.inferenceRegion === undefined ? {} : { inferenceRegion: live.inferenceRegion }) },
    'refresh',
    options,
  )
}

/** Reject an aborted signal, so a cancelled turn cannot look like a slow refresh. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LlmError('llm-omp-transports: the turn was cancelled while the Factory Droid sign-in was refreshed', 'ABORTED')
  }
}

/** Map the auth module's failures onto the seam's stable codes. */
async function withCredentialErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (cause) {
    if (cause instanceof LlmError) throw cause
    if (cause instanceof FactoryDroidAuthError) {
      throw new LlmError(`llm-omp-transports: Factory Droid sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
        cause,
      })
    }
    throw cause
  }
}
