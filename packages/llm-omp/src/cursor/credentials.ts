/**
 * The `llm-omp-transports/cursor` credential: record shape, access resolution
 * and refresh under the store's lock.
 *
 * `ctx.credentials` hands a plugin opaque grant payloads, so this module owns
 * the only reader and writer of the Cursor payload. The adapter asks for an
 * access token once per request; when the stored grant is already past its
 * `expires` margin the resolver refreshes it inside `modifyRecord`, the seam's
 * serialized read-modify-write and the only write path. Two processes rotating
 * one refresh token would otherwise lose whichever wrote first.
 *
 * `ctx.credentials` is consumed structurally (the sibling keys-manager does the
 * same): the published package declares the seam as a peer, and the plugin only
 * calls the two record methods below.
 *
 * @module dsh-llm-omp-transports/cursor/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import { CursorAuthError, refreshCursorToken, throwIfAborted } from './auth.js'
import type { CursorFetch } from './auth.js'

/** The record this plugin owns: scope `<plugin name>`, id the provider route. */
export const CURSOR_CREDENTIAL_KEY = 'llm-omp-transports/cursor'

/** One stored grant record; the payload is written and read only by this plugin. */
export interface StoredGrantRecord {
  readonly kind: 'grant'
  readonly payload: unknown
}

/** Any stored credential record, as the seam hands it back. */
export type StoredCredentialRecord =
  | StoredGrantRecord
  | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }

/** The record half of `ctx.credentials` this plugin calls. */
export interface CredentialRecordsLike {
  readRecord(key: string): Promise<StoredCredentialRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: StoredCredentialRecord | undefined) => Promise<StoredCredentialRecord | undefined>,
  ): Promise<StoredCredentialRecord | undefined>
}

/** The payload this plugin writes into its grant record. */
export interface CursorGrantPayload {
  /** Bearer token for `api2.cursor.sh`. */
  readonly access: string
  /** Refresh token; absent on a grant that cannot be renewed. */
  readonly refresh?: string
  /** Epoch ms, JWT `exp` minus the five-minute skew; the skew is the refresh margin. */
  readonly expires: number
  /** Account email, when cursor.com named one. */
  readonly email?: string
  /** Account user id (JWT `sub` after `|`), when the token named one. */
  readonly accountId?: string
}

/** Options for {@link createCursorAccess}; `fetch` and `now` are the test seams. */
export interface CursorAccessOptions {
  readonly fetch?: CursorFetch
  /** Clock, for tests that cross the refresh window. */
  readonly now?: () => number
}

/** The grant payload of one record, or undefined when it is not a usable Cursor grant. */
export function readCursorGrant(record: StoredCredentialRecord | undefined): CursorGrantPayload | undefined {
  const payload = payloadOf(record)
  if (payload === undefined) return undefined
  const { access, expires, refresh, email, accountId } = payload
  if (typeof access !== 'string' || access === '') return undefined
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return undefined
  return {
    access,
    expires,
    ...(typeof refresh === 'string' && refresh !== '' ? { refresh } : {}),
    ...(typeof email === 'string' ? { email } : {}),
    ...(typeof accountId === 'string' ? { accountId } : {}),
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
 * A fresh grant answers without touching the store's write path. A grant past
 * its `expires` margin is renewed under `modifyRecord`: `mutate` re-reads the
 * record it is handed, so a grant another writer already refreshed (or one
 * removed while this turn waited for the lock) is left alone. A `shouldLogout`
 * answer surfaces as `REAUTH_REQUIRED`, which is a dead sign-in rather than a
 * transient failure.
 */
export function createCursorAccess(
  credentials: CredentialRecordsLike,
  options: CursorAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now

  return async signal => {
    const grant = readCursorGrant(await credentials.readRecord(CURSOR_CREDENTIAL_KEY))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no Cursor sign-in is stored at ${CURSOR_CREDENTIAL_KEY}; run the Cursor authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expires > now()) return grant.access

    const stored = await withCredentialErrors(() =>
      credentials.modifyRecord(CURSOR_CREDENTIAL_KEY, async current => {
        const live = readCursorGrant(current)
        // Removed or replaced while this turn waited for the lock: leave it alone.
        if (live === undefined) return undefined
        // Another process refreshed it between the read and the lock.
        if (live.expires > now()) return undefined
        if (live.refresh === undefined) {
          throw new LlmError(
            `llm-omp-transports: the Cursor grant stored at ${CURSOR_CREDENTIAL_KEY} has no refresh token; sign in again`,
            'REAUTH_REQUIRED',
          )
        }
        const refreshed = await refreshCursorToken(live.refresh, { fetch: options.fetch, signal })
        // A turn cancelled while the exchange ran must not commit the token it
        // will never use; the refresh already happened, so the next turn simply
        // refreshes again.
        throwIfAborted(signal)
        return {
          kind: 'grant',
          payload: { ...(payloadOf(current) ?? {}), access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires },
        }
      }),
    )

    const resolved = readCursorGrant(stored)
    if (resolved === undefined) {
      throw new LlmError(
        `llm-omp-transports: the Cursor sign-in stored at ${CURSOR_CREDENTIAL_KEY} disappeared while it was refreshed; sign in again`,
        'MISSING_CREDENTIAL',
      )
    }
    return resolved.access
  }
}

/** Map the auth module's failures onto the seam's stable codes. */
async function withCredentialErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (cause) {
    if (cause instanceof LlmError) throw cause
    if (cause instanceof CursorAuthError) {
      throw new LlmError(
        `llm-omp-transports: Cursor sign-in failed — ${cause.message}`,
        cause.failure === 'reauth' ? 'REAUTH_REQUIRED' : 'AUTH_FAILED',
        { cause },
      )
    }
    throw cause
  }
}
