/**
 * The `llm-omp-transports/devin` credential: record shape and access resolution.
 *
 * Devin's pinned auth rule declares `refresh "none"`, so this resolver is a
 * reader, not a refresher: a missing record is `MISSING_CREDENTIAL`, a record
 * past `expires` is `REAUTH_REQUIRED`, and a live one answers `access` without
 * ever touching the store's write path. Inventing a rotation would contradict
 * the rule the transport was built from.
 *
 * The payload is `{ access, expires }`; `expires` is mandatory in practice
 * because the root keys-manager derives a transport account's status from it,
 * but a payload without one is served indefinitely: neither this flow nor the
 * pinned rule can produce one, and refusing it would break a hand-written
 * static bearer for no gain.
 *
 * @module dsh-llm-omp-transports/devin/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'

/** The record this plugin owns: scope `<plugin name>`, id the provider route. */
export const DEVIN_CREDENTIAL_KEY = 'llm-omp-transports/devin'

/** The payload this plugin writes into its grant record. */
export interface DevinGrantPayload {
  /** Session token for the Devin API; the transport mints its per-turn JWT from it. */
  readonly access: string
  /** Epoch ms after which the bearer is dead; absent means a static bearer. */
  readonly expires?: number
  /**
   * The record carried an `expires` field that is not a finite number.
   *
   * Only an *absent* expiry is a static bearer (§6.3); a present but corrupt one
   * means the record cannot be trusted, so the resolver demands a re-sign-in.
   */
  readonly expiresInvalid?: boolean
}

/** Options for {@link createDevinAccess}; the clock is the test seam. */
export interface DevinAccessOptions {
  readonly now?: () => number
}

/** The grant payload of one record, or undefined when it is not a usable Devin grant. */
export function readDevinGrant(record: StoredCredentialRecord | undefined): DevinGrantPayload | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  if (typeof fields.access !== 'string' || fields.access === '') return undefined
  if (!('expires' in fields)) return { access: fields.access }
  if (typeof fields.expires !== 'number' || !Number.isFinite(fields.expires)) {
    return { access: fields.access, expiresInvalid: true }
  }
  return { access: fields.access, expires: fields.expires }
}

/**
 * Build the adapter's per-request access resolver.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - clock, for tests that cross the expiry.
 * @returns a resolver that answers the stored bearer or throws a typed `LlmError`.
 */
export function createDevinAccess(
  credentials: CredentialRecordsLike,
  options: DevinAccessOptions = {},
): () => Promise<string> {
  const now = options.now ?? Date.now

  return async () => {
    const grant = readDevinGrant(await credentials.readRecord(DEVIN_CREDENTIAL_KEY))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no Devin sign-in is stored at ${DEVIN_CREDENTIAL_KEY}; run the Devin authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expiresInvalid === true) {
      throw new LlmError(
        `llm-omp-transports: the Devin sign-in stored at ${DEVIN_CREDENTIAL_KEY} has an unreadable expiry; sign in again`,
        'REAUTH_REQUIRED',
      )
    }
    if (grant.expires !== undefined && grant.expires <= now()) {
      throw new LlmError(
        `llm-omp-transports: the Devin sign-in stored at ${DEVIN_CREDENTIAL_KEY} has expired; there is no refresh token, so sign in again`,
        'REAUTH_REQUIRED',
      )
    }
    return grant.access
  }
}
