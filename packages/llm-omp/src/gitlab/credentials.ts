/**
 * The `llm-omp-transports/gitlab-duo-agent` credential: record shape and access resolution.
 *
 * The record is a GitLab OAuth grant — `{ access, refresh, expires, email? }` —
 * and this module owns both halves: the flow writes it, the adapter reads it
 * through {@link createGitLabDuoAgentAccess}. The pinned rule *has* a refresh
 * (`refresh.token.params { redirect_uri }`), so the resolver is Cursor-shaped:
 * a fresh grant answers without touching the write path, an expiring one is
 * renewed once under the store's per-key lock, and a failure is fail-loud
 * (`REAUTH_REQUIRED` / `MISSING_CREDENTIAL`), never a silent retry.
 *
 * The route's instance is fixed: the rule pins `gitlab.com` for both the
 * authorize and the token URL, so the record carries no base URL (self-managed
 * GitLab is a non-goal for this slice).
 *
 * @module dsh-llm-omp-transports/gitlab/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import { GITLAB_DUO_AGENT_CREDENTIAL_KEY, GITLAB_DUO_CREDENTIAL_KEY } from '../adapter.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'
import { GitLabAuthError, refreshGitLabToken } from './auth.js'
import type { GitLabFetch } from './auth.js'

/** The records this plugin owns; re-exported from the adapter where the routes name them. */
export { GITLAB_DUO_AGENT_CREDENTIAL_KEY, GITLAB_DUO_CREDENTIAL_KEY }

/** How early a grant is renewed: enough for one in-flight turn, like the other routes. */
const REFRESH_WINDOW_MS = 60_000

/** The payload this plugin writes into its grant record. */
export interface GitLabGrantPayload {
  /** GitLab OAuth access token (or `GITLAB_TOKEN`, written by a manual record). */
  readonly access: string
  /** GitLab refresh token; absent means the record cannot be renewed. */
  readonly refresh?: string
  /** Epoch ms after which the access token is dead. */
  readonly expires?: number
  readonly email?: string
}

/** Options for {@link createGitLabDuoAgentAccess}; `fetch` and `now` are the test seams. */
export interface GitLabAccessOptions {
  readonly fetch?: GitLabFetch
  readonly now?: () => number
}

/** The grant payload of one record, or undefined when it is not a usable grant. */
export function readGitLabGrant(record: StoredCredentialRecord | undefined): GitLabGrantPayload | undefined {
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
 * refreshed record keeps an un-rotated refresh token and the email, and it is
 * committed before a cancellation is reported — a rotated token is never lost
 * with the cancelled turn.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - fetch and clock seams.
 * @returns a resolver that answers the stored (or refreshed) bearer.
 */
export function createGitLabDuoAgentAccess(
  credentials: CredentialRecordsLike,
  options: GitLabAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  return resolveWith(credentials, GITLAB_DUO_AGENT_CREDENTIAL_KEY, 'GitLab Duo Agent', options)
}


/** Reject an aborted signal, so a cancelled turn cannot look like a slow refresh. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LlmError(
      'llm-omp-transports: the turn was cancelled while the GitLab sign-in was refreshed',
      'ABORTED',
    )
  }
}

/** Map the auth module's failures onto the seam's stable codes. */
async function withCredentialErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (cause) {
    if (cause instanceof LlmError) throw cause
    if (cause instanceof GitLabAuthError) {
      throw new LlmError(`llm-omp-transports: the GitLab sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
        cause,
      })
    }
    throw cause
  }
}

/**
 * Build the Duo **proxy** route's per-request access resolver.
 *
 * @remarks
 * Same CAS shape as {@link createGitLabDuoAgentAccess}, with the route's own
 * record. The rule's `after-refresh hook="gitlab-duo-clear-cache"` has a natural
 * plugin equivalent here: the proxy transport caches its 25-minute direct-access
 * token **inside the artifact, keyed by the GitLab access token**, so a refresh
 * that rotates `access` misses that cache by construction (A9). Nothing else is
 * cached in the plugin, so no cache can go stale across a refresh.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - fetch and clock seams.
 * @returns a resolver that answers the stored (or refreshed) GitLab token.
 */
export function createGitLabDuoAccess(
  credentials: CredentialRecordsLike,
  options: GitLabAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  return resolveWith(credentials, GITLAB_DUO_CREDENTIAL_KEY, 'GitLab Duo', options)
}

/** The shared resolver body: both GitLab routes differ only in their record key. */
function resolveWith(
  credentials: CredentialRecordsLike,
  key: string,
  label: string,
  options: GitLabAccessOptions,
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now
  return async signal => {
    const grant = readGitLabGrant(await credentials.readRecord(key))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no ${label} sign-in is stored at ${key}; run the ${label} authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expires === undefined || grant.expires - REFRESH_WINDOW_MS > now()) return grant.access

    const stored = await withCredentialErrors(() =>
      credentials.modifyRecord(key, async current => {
        const live = readGitLabGrant(current)
        if (live === undefined) return undefined
        if (live.expires === undefined || live.expires - REFRESH_WINDOW_MS > now()) return undefined
        if (live.refresh === undefined) {
          throw new LlmError(
            `llm-omp-transports: the ${label} grant stored at ${key} has no refresh token; sign in again`,
            'REAUTH_REQUIRED',
          )
        }
        const refreshed = await refreshGitLabToken(live.refresh, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(signal === undefined ? {} : { signal }),
        })
        return {
          kind: 'grant',
          payload: {
            ...(payloadOf(current) ?? {}),
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
            ...(live.email === undefined ? {} : { email: live.email }),
          },
        }
      }),
    )

    // Committed before the cancellation is reported: a rotated token is never lost.
    throwIfAborted(signal)
    const resolved = readGitLabGrant(stored)
    if (resolved === undefined) {
      throw new LlmError(
        `llm-omp-transports: the ${label} sign-in stored at ${key} disappeared while it was refreshed; sign in again`,
        'MISSING_CREDENTIAL',
      )
    }
    return resolved.access
  }
}
