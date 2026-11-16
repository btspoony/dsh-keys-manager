/**
 * The Antigravity ACP route's credential record.
 *
 * The record is the consumer grant agy exported during sign-in
 * (`{access, refresh, expires, email?, accountId?}`) — no `projectId`, because the
 * CLI owns the endpoint. The transport parses it as its "structured" api-key
 * envelope, so the adapter hands over `{token, refreshToken, expiresAt, email}`.
 *
 * @module dsh-llm-omp-transports/antigravity/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'

/** The credential record this route reads and writes. */
export const ANTIGRAVITY_CLI_CREDENTIAL_KEY = 'llm-omp-transports/antigravity-cli'

/** The consumer grant agy exported: what the CLI refresh call consumes and returns. */
export interface AntigravityCliGrant {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly email?: string
  readonly accountId?: string
}

/** Refresh one stored grant through the route's own refresh call. */
export type AntigravityCliRefresher = (
  grant: AntigravityCliGrant,
  signal?: AbortSignal,
) => Promise<AntigravityCliGrant>

/** Refresh this long before the recorded expiry, as the Google routes do. */
const SKEW_MS = 60_000

/**
 * Read the route's grant from one credential record.
 *
 * @param record - the stored record, as the credentials seam returned it.
 * @returns the grant, or undefined when the record is absent or malformed.
 */
export function readAntigravityCliGrant(record: StoredCredentialRecord | undefined): AntigravityCliGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = payload as Record<string, unknown>
  const access = value['access']
  const refresh = value['refresh']
  const expires = value['expires']
  if (typeof access !== 'string' || access === '') return undefined
  if (typeof refresh !== 'string' || refresh === '') return undefined
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return undefined
  return {
    access,
    refresh,
    expires,
    ...(typeof value['email'] === 'string' ? { email: value['email'] } : {}),
    ...(typeof value['accountId'] === 'string' ? { accountId: value['accountId'] } : {}),
  }
}

/** The transport's api-key envelope: it reads these four fields and nothing else. */
export function antigravityCliEnvelope(grant: AntigravityCliGrant): string {
  return JSON.stringify({
    token: grant.access,
    refreshToken: grant.refresh,
    expiresAt: grant.expires,
    ...(grant.email === undefined ? {} : { email: grant.email }),
  })
}

/** The record one refreshed grant becomes. */
function recordOf(grant: AntigravityCliGrant): StoredCredentialRecord {
  return {
    kind: 'grant',
    payload: {
      access: grant.access,
      refresh: grant.refresh,
      expires: grant.expires,
      ...(grant.email === undefined ? {} : { email: grant.email }),
      ...(grant.accountId === undefined ? {} : { accountId: grant.accountId }),
    },
  }
}

/** Options for {@link createAntigravityCliAccess}. */
export interface AntigravityCliAccessOptions {
  readonly now?: () => number
}

/**
 * Build the route's credential resolver.
 *
 * @param credentials - the credentials seam this route reads and writes.
 * @param refreshGrant - the CLI's refresh call, injected so this module stays
 *   free of the bundled artifact.
 * @param options - clock seam.
 * @returns a resolver that returns the transport's envelope, refreshing once
 *   under the record lock when the grant is near expiry.
 */
export function createAntigravityCliAccess(
  credentials: CredentialRecordsLike,
  refreshGrant: AntigravityCliRefresher,
  options: AntigravityCliAccessOptions = {},
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now
  const live = (grant: AntigravityCliGrant): boolean => grant.expires - SKEW_MS > now()

  return async signal => {
    const stored = readAntigravityCliGrant(await credentials.readRecord(ANTIGRAVITY_CLI_CREDENTIAL_KEY))
    if (stored === undefined) {
      throw LlmError.fromFailure({
        message: `llm-omp-transports: no Antigravity sign-in is stored at ${ANTIGRAVITY_CLI_CREDENTIAL_KEY}; run the Antigravity authorization flow`,
        code: 'MISSING_CREDENTIAL',
      })
    }
    if (live(stored)) return antigravityCliEnvelope(stored)

    const refreshed = await credentials.modifyRecord(ANTIGRAVITY_CLI_CREDENTIAL_KEY, async current => {
      const currentGrant = readAntigravityCliGrant(current)
      // Removed or replaced while this turn waited for the lock: leave it alone.
      if (currentGrant === undefined) return undefined
      if (live(currentGrant)) return current
      return recordOf(await refreshGrant(currentGrant, signal))
    })
    const next = readAntigravityCliGrant(refreshed)
    if (next === undefined) {
      throw LlmError.fromFailure({
        message: `llm-omp-transports: the Antigravity sign-in at ${ANTIGRAVITY_CLI_CREDENTIAL_KEY} is gone or refused its refresh; sign in again`,
        code: 'REAUTH_REQUIRED',
      })
    }
    return antigravityCliEnvelope(next)
  }
}
