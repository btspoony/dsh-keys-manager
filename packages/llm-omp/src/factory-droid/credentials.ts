/**
 * The `llm-omp-transports/factory-droid` credential: record shape and access resolution.
 *
 * The record is a WorkOS grant: `{ access, refresh?, expires?, orgId?, region?,
 * email? }`. This module owns the **reader** half — the read-only path the
 * adapter needs on every turn. The device-code flow that writes the record and
 * the single-window refresh live in the auth task; until it lands a missing
 * record is `MISSING_CREDENTIAL` and an expired one is `REAUTH_REQUIRED` (never a
 * silent retry), which is the same fail-loud posture the other routes take when
 * their grant cannot be used.
 *
 * @module dsh-llm-omp-transports/factory-droid/credentials
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

import { FACTORY_DROID_CREDENTIAL_KEY } from '../adapter.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../cursor/credentials.js'

/** The record this plugin owns; re-exported from the adapter where the route names it. */
export { FACTORY_DROID_CREDENTIAL_KEY }

/** The payload this plugin writes into its grant record. */
export interface FactoryDroidGrantPayload {
  /** WorkOS access token; the transport sends it as the bearer. */
  readonly access: string
  /** WorkOS refresh token; absent means the record cannot be renewed. */
  readonly refresh?: string
  /** Epoch ms after which the access token is dead. */
  readonly expires?: number
}

/** Options for {@link createFactoryDroidAccess}; the clock is the test seam. */
export interface FactoryDroidAccessOptions {
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
  }
}

/**
 * Build the adapter's per-request access resolver.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - clock, for tests that cross the expiry.
 * @returns a resolver that answers the stored bearer or throws a typed `LlmError`.
 */
export function createFactoryDroidAccess(
  credentials: CredentialRecordsLike,
  options: FactoryDroidAccessOptions = {},
): () => Promise<string> {
  const now = options.now ?? Date.now

  return async () => {
    const grant = readFactoryDroidGrant(await credentials.readRecord(FACTORY_DROID_CREDENTIAL_KEY))
    if (grant === undefined) {
      throw new LlmError(
        `llm-omp-transports: no Factory Droid sign-in is stored at ${FACTORY_DROID_CREDENTIAL_KEY}; run the Factory Droid authorization flow`,
        'MISSING_CREDENTIAL',
      )
    }
    if (grant.expires !== undefined && grant.expires <= now()) {
      throw new LlmError(
        `llm-omp-transports: the Factory Droid sign-in stored at ${FACTORY_DROID_CREDENTIAL_KEY} has expired; sign in again`,
        'REAUTH_REQUIRED',
      )
    }
    return grant.access
  }
}
