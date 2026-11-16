/**
 * The Antigravity ACP route's credential resolver: the envelope the transport
 * parses, the refresh-on-expiry path, and the two refusals.
 */
import { describe, expect, it } from 'vitest'

import {
  ANTIGRAVITY_CLI_CREDENTIAL_KEY,
  antigravityCliEnvelope,
  createAntigravityCliAccess,
  readAntigravityCliGrant,
} from '../src/antigravity/credentials.js'
import type { AntigravityCliGrant } from '../src/antigravity/credentials.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../src/cursor/credentials.js'

const NOW = 1_700_000_000_000

function grant(overrides: Partial<AntigravityCliGrant> = {}): AntigravityCliGrant {
  return { access: 'access-1', refresh: 'refresh-1', expires: NOW + 3_600_000, ...overrides }
}

function store(initial?: StoredCredentialRecord): {
  credentials: CredentialRecordsLike
  written: () => number
} {
  let record = initial
  let writes = 0
  return {
    credentials: {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        writes += 1
        record = await mutate(record)
        return record
      },
    },
    written: () => writes,
  }
}

describe('antigravity credential record', () => {
  it('reads the consumer grant and refuses a payload without a refresh token', () => {
    const record = { kind: 'grant', payload: { access: 'a', refresh: 'r', expires: NOW, email: 'e@example.com' } }
    expect(readAntigravityCliGrant(record as StoredCredentialRecord)).toEqual({
      access: 'a',
      refresh: 'r',
      expires: NOW,
      email: 'e@example.com',
    })
    expect(readAntigravityCliGrant({ kind: 'grant', payload: { access: 'a', expires: NOW } } as StoredCredentialRecord)).toBeUndefined()
    expect(readAntigravityCliGrant(undefined)).toBeUndefined()
  })

  it('emits the four fields the transport parses', () => {
    expect(JSON.parse(antigravityCliEnvelope(grant({ email: 'e@example.com' })))).toEqual({
      token: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_600_000,
      email: 'e@example.com',
    })
  })
})

describe('antigravity credential resolver', () => {
  it('returns the stored grant without a refresh while it is live', async () => {
    const fake = store({ kind: 'grant', payload: grant() })
    let refreshes = 0
    const access = createAntigravityCliAccess(fake.credentials, async () => {
      refreshes += 1
      return grant()
    }, { now: () => NOW })

    await expect(access()).resolves.toContain('"token":"access-1"')
    expect(refreshes).toBe(0)
    expect(fake.written()).toBe(0)
  })

  it('refreshes once under the lock and stores the rotated grant', async () => {
    const expiring = grant({ expires: NOW + 1_000 })
    const fake = store({ kind: 'grant', payload: expiring })
    const rotated = grant({ access: 'access-2', refresh: 'refresh-2', expires: NOW + 7_200_000, accountId: 'sub-1' })
    let refreshes = 0
    const access = createAntigravityCliAccess(fake.credentials, async () => {
      refreshes += 1
      return rotated
    }, { now: () => NOW })

    await expect(access()).resolves.toContain('"token":"access-2"')
    expect(refreshes).toBe(1)
    expect(fake.written()).toBe(1)
  })

  it('refuses a missing sign-in and a resolve that lost its record', async () => {
    const empty = store()
    await expect(createAntigravityCliAccess(empty.credentials, async () => grant())( )).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })

    const gone = store({ kind: 'grant', payload: grant({ expires: NOW + 1 }) })
    await expect(
      createAntigravityCliAccess(gone.credentials, async () => {
        throw new Error('refused')
      }, { now: () => NOW })(),
    ).rejects.toThrowError('refused')

    // The record disappears while this turn waits for the lock: `modifyRecord`
    // yields undefined and the resolver must report a reauth, not a credential.
    const lost: CredentialRecordsLike = {
      readRecord: async () => ({ kind: 'grant', payload: grant({ expires: NOW + 1 }) }),
      modifyRecord: async () => undefined,
    }
    await expect(createAntigravityCliAccess(lost, async () => grant(), { now: () => NOW })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
  })
})
