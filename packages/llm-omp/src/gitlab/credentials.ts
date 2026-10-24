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

import { GITLAB_DUO_AGENT_CREDENTIAL_KEY } from '../adapter.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'
import { GitLabAuthError, refreshGitLabToken } from './auth.js'
import type { GitLabFetch } from './auth.js'

/** The record this plugin owns; re-exported from the adapter where the route names it. */
export { GITLAB_DUO_AGENT_CREDENTIAL_KEY }

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
  const now = options.now ?? Date.now

  return async signal => {
    const grant = readGitLabGrant(await credentials.readRecord(GITLAB_DUO_AGENT_CREDENTIAL_KEY))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no GitLab Duo Agent sign-in is stored at ${GITLAB_DUO_AGENT_CREDENTIAL_KEY}; run the GitLab Duo Agent authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expires === undefined || grant.expires - REFRESH_WINDOW_MS > now()) return grant.access

    const stored = await withCredentialErrors(() =>
      credentials.modifyRecord(GITLAB_DUO_AGENT_CREDENTIAL_KEY, async current => {
        const live = readGitLabGrant(current)
        // Removed or replaced while this turn waited for the lock: leave it alone.
        if (live === undefined) return undefined
        // Another writer refreshed it between the read and the lock.
        if (live.expires === undefined || live.expires - REFRESH_WINDOW_MS > now()) return undefined
        if (live.refresh === undefined) {
          throw new LlmError(
            `llm-omp-transports: the GitLab Duo Agent grant stored at ${GITLAB_DUO_AGENT_CREDENTIAL_KEY} has no refresh token; sign in again`,
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
            // A refresh that does not rotate the token keeps the stored one.
            refresh: refreshed.refresh,
            expires: refreshed.expires,
            ...(live.email === undefined ? {} : { email: live.email }),
          },
        }
      }),
    )

    // The record is committed before the cancellation is reported: a rotated
    // refresh token must not be discarded with the turn that rotated it.
    throwIfAborted(signal)
    const resolved = readGitLabGrant(stored)
    if (resolved === undefined) {
      throw new LlmError(
        `llm-omp-transports: the GitLab Duo Agent sign-in stored at ${GITLAB_DUO_AGENT_CREDENTIAL_KEY} disappeared while it was refreshed; sign in again`,
        'MISSING_CREDENTIAL',
      )
    }
    return resolved.access
  }
}

/** Reject an aborted signal, so a cancelled turn cannot look like a slow refresh. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LlmError(
      'llm-omp-transports: the turn was cancelled while the GitLab Duo Agent sign-in was refreshed',
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
      throw new LlmError(`llm-omp-transports: GitLab Duo Agent sign-in failed — ${cause.message}`, 'AUTH_FAILED', {
        cause,
      })
    }
    throw cause
  }
}
