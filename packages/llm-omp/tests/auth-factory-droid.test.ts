/**
 * Factory Droid sign-in and credential resolution — offline.
 *
 * The flow copies the pinned WorkOS rule: one device-authorization POST, a poll
 * with the rule's cadence (`interval` default 5 s, floor 1 s, `slow_down` +5 s,
 * `expires_in` deadline), the rule's error classification, the `jwt` expiry with a
 * one-day fallback, and the `factory-droid-region` whoami after the exchange. The
 * resolver is Cursor-shaped: read-only on the fresh path, one CAS refresh under
 * the store's lock, and a post-refresh whoami whose failure is non-fatal.
 *
 * Every network call is a stubbed `fetch` and every sleep is a stub, so the
 * cadence and the deadlines are asserted without waiting.
 */
import type { StoredCredentialRecord } from '../src/cursor/credentials.js'
import { describe, expect, it } from 'vitest'

import {
  FACTORY_DROID_API_URL,
  FACTORY_DROID_CLIENT_ID,
  FACTORY_DROID_DEVICE_URL,
  FACTORY_DROID_EU_API_URL,
  FACTORY_DROID_TOKEN_URL,
  FactoryDroidAuthError,
  loginFactoryDroid,
  resolveFactoryDroidIdentity,
} from '../src/factory-droid/auth.js'
import type { FactoryDroidFetch } from '../src/factory-droid/auth.js'
import {
  FACTORY_DROID_CREDENTIAL_KEY,
  createFactoryDroidAccess,
  readFactoryDroidGrant,
} from '../src/factory-droid/credentials.js'
import { factoryDroidAuthorizationFlow } from '../src/index.js'
import type { CredentialRecordsLike } from '../src/cursor/credentials.js'

const NOW = 1_700_000_000_000

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** A `fetch` that records calls and answers from `respond`. */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetch: FactoryDroidFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, ...(init === undefined ? {} : { init }) }
      calls.push(call)
      return respond(call)
    },
  }
}

/** An unsigned JWT with the given payload; only the payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

/** The device-authorization body WorkOS returns. */
const DEVICE = {
  user_code: 'ABCD-1234',
  device_code: 'device-code-1',
  verification_uri: 'https://factory.ai/device',
  verification_uri_complete: 'https://factory.ai/device?code=ABCD-1234',
  interval: 5,
  expires_in: 600,
}

/** A signed-in token body: the shape WorkOS answers with. */
function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const access = jwt({ exp: 2_000_000_000, email: 'human@example.com', sub: 'user-1', external_org_id: 'org-1' })
  return { access_token: access, refresh_token: 'refresh-1', user: { id: 'user-1', email: 'human@example.com' }, ...overrides }
}

/** A `fetch` that answers the device POST, `count` pending polls, then a token. */
function deviceFetch(
  body: Record<string, unknown>,
  options: { pendings?: number; pollAnswers?: (Response | Record<string, unknown>)[] } = {},
): { fetch: FactoryDroidFetch; calls: FetchCall[]; polls: () => number } {
  let polls = 0
  const inner = stubFetch(call => {
    if (call.url === FACTORY_DROID_DEVICE_URL) return json(DEVICE)
    if (call.url === FACTORY_DROID_TOKEN_URL && call.init?.body?.toString().includes('device_code')) {
      polls += 1
      const scripted = options.pollAnswers?.[polls - 1]
      if (scripted !== undefined) return scripted instanceof Response ? scripted : json(scripted)
      if (polls <= (options.pendings ?? 0)) return json({ error: 'authorization_pending' }, 400)
      return json(body)
    }
    if (call.url === `${FACTORY_DROID_API_URL}/api/cli/whoami`) return json({ orgId: 'org-1' })
    throw new Error(`unexpected url ${call.url}`)
  })
  return { ...inner, polls: () => polls }
}

/** A clock the flow and resolver read. */
const now = (): number => NOW

describe('factory droid device authorization', () => {
  it('posts the rule client id, notifies the page and the code, then commits the grant', async () => {
    const { fetch, calls } = deviceFetch(tokenBody())
    const notices: { message: string; url?: string; code?: string }[] = []
    const committed: { kind: string; payload: Record<string, unknown> }[] = []
    const sleeps: number[] = []

    const grant = await loginFactoryDroid({
      fetch,
      now,
      sleep: async ms => {
        sleeps.push(ms)
      },
      signal: new AbortController().signal,
      onDevice: device => notices.push({ message: 'approve', url: device.verificationUriComplete, code: device.userCode }),
    })

    // The device POST is a form body with the public client id, as the rule declares.
    const deviceCall = calls.find(call => call.url === FACTORY_DROID_DEVICE_URL)!
    expect(new URLSearchParams(String(deviceCall.init?.body)).get('client_id')).toBe(FACTORY_DROID_CLIENT_ID)
    expect(new Headers(deviceCall.init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(new Headers(deviceCall.init?.headers).get('accept')).toBe('application/json')

    expect(notices).toEqual([
      { message: 'approve', url: 'https://factory.ai/device?code=ABCD-1234', code: 'ABCD-1234' },
    ])
    // No pending answers: one poll, one whoami, no sleep.
    expect(sleeps).toEqual([])
    expect(committed).toEqual([])
    expect(grant).toMatchObject({
      access: jwt({ exp: 2_000_000_000, email: 'human@example.com', sub: 'user-1', external_org_id: 'org-1' }),
      refresh: 'refresh-1',
      // `expires "jwt" skew-ms=0`: no safety margin on this rule.
      expires: 2_000_000_000_000,
      email: 'human@example.com',
      accountId: 'user-1',
      orgId: 'org-1',
    })
  })

  it('polls on the rule cadence, widening it on slow_down, and waits out pending answers', async () => {
    const { fetch, polls } = deviceFetch(tokenBody(), {
      pollAnswers: [json({ error: 'authorization_pending' }, 400), json({ error: 'slow_down' }, 400)],
    })
    const sleeps: number[] = []

    await loginFactoryDroid({
      fetch,
      now,
      sleep: async ms => {
        sleeps.push(ms)
      },
      signal: new AbortController().signal,
      onDevice: () => {},
    })

    expect(polls()).toBe(3)
    // 5 s from the response, then 10 s after `slow_down`, then the completion.
    expect(sleeps).toEqual([5_000, 10_000])
  })

  it('falls back to a five-second cadence and the one-day expiry without provider hints', async () => {
    const access = jwt({ external_org_id: 'org-1' })
    const { fetch } = stubFetch(call => {
      if (call.url === FACTORY_DROID_DEVICE_URL) {
        // No `interval`/`expires_in`: RFC 8628's default cadence, no deadline.
        return json({ user_code: 'C', device_code: 'd', verification_uri: 'https://factory.ai/device' })
      }
      if (call.url === FACTORY_DROID_TOKEN_URL && call.init?.body?.toString().includes('device_code')) {
        return json({ access_token: access, refresh_token: 'r' })
      }
      if (call.url === `${FACTORY_DROID_API_URL}/api/cli/whoami`) return json({ orgId: 'org-1' })
      throw new Error(`unexpected url ${call.url}`)
    })
    const sleeps: number[] = []

    const grant = await loginFactoryDroid({
      fetch,
      now,
      sleep: async ms => {
        sleeps.push(ms)
      },
      signal: new AbortController().signal,
      onDevice: device => {
        expect(device.intervalSeconds).toBeUndefined()
        expect(device.expiresInSeconds).toBeUndefined()
      },
    })

    expect(sleeps).toEqual([])
    // A non-JWT-readable token lifetime falls back to one day from the clock.
    expect(grant.expires).toBe(NOW + 86_400_000)
    expect(grant.orgId).toBe('org-1')
  })

  it('refuses a denial, an expired code and a slow_down timeout', async () => {
    const deny = deviceFetch({}, { pollAnswers: [json({ error: 'access_denied' }, 400)] })
    await expect(
      loginFactoryDroid({ fetch: deny.fetch, now, sleep: async () => {}, signal: new AbortController().signal, onDevice: () => {} }),
    ).rejects.toThrowError(/authorization was denied/)

    const expire = deviceFetch({}, { pollAnswers: [json({ error: 'expired_token' }, 400)] })
    await expect(
      loginFactoryDroid({ fetch: expire.fetch, now, sleep: async () => {}, signal: new AbortController().signal, onDevice: () => {} }),
    ).rejects.toThrowError(/device code expired/)
  })

  it('stops at the device-code deadline instead of polling forever', async () => {
    let polls = 0
    const { fetch } = stubFetch(call => {
      if (call.url === FACTORY_DROID_DEVICE_URL) return json({ ...DEVICE, expires_in: 1 })
      polls += 1
      return json({ error: 'authorization_pending' }, 400)
    })

    await expect(
      loginFactoryDroid({
        fetch,
        now,
        sleep: async ms => {
          // Every sleep is clamped to what is left of the device-code window.
          expect(ms).toBeLessThanOrEqual(1_000)
          await new Promise(resolve => setTimeout(resolve, 300))
        },
        signal: new AbortController().signal,
        onDevice: () => {},
      }),
    ).rejects.toThrowError(/device code expired/)
    // A one-second window with a 300 ms nap: a handful of polls, never a spin.
    expect(polls).toBeGreaterThanOrEqual(1)
    expect(polls).toBeLessThanOrEqual(10)
  })

  it('wires the attempt signal into every request and sleep', async () => {
    const controller = new AbortController()
    const { fetch, calls } = deviceFetch({}, { pendings: 1 })
    controller.abort()

    await expect(
      loginFactoryDroid({
        fetch,
        now,
        sleep: async (_ms, signal) => {
          expect(signal).toBe(controller.signal)
        },
        signal: controller.signal,
        onDevice: () => {},
      }),
    ).rejects.toThrowError(/cancelled/)
    // The device POST is reachable by the seam's cancellation, and no commit happens.
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe('application/json')
    expect(calls[0]!.init?.signal?.aborted).toBe(true)
  })

  it('refuses a body without an access token or a refresh token', async () => {
    const noAccess = deviceFetch({ refresh_token: 'r' })
    await expect(
      loginFactoryDroid({ fetch: noAccess.fetch, now, sleep: async () => {}, signal: new AbortController().signal, onDevice: () => {} }),
    ).rejects.toThrowError(/names no access token/)

    const noRefresh = deviceFetch({ access_token: jwt({ external_org_id: 'org-1' }) })
    await expect(
      loginFactoryDroid({ fetch: noRefresh.fetch, now, sleep: async () => {}, signal: new AbortController().signal, onDevice: () => {} }),
    ).rejects.toThrowError(/names no refresh token/)
  })
})

describe('factory droid identity', () => {
  const grant = {
    access: 'token',
    refresh: 'refresh',
    expires: 2_000_000_000_000,
  }

  it('reads the org, the residency and the inference scope from whoami', async () => {
    const { fetch, calls } = stubFetch(() => json({ orgId: 'org-2', region: 'eu', inferenceRegion: 'us' }))

    const resolved = await resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1' }, 'login', { fetch, now })

    expect(calls[0]!.url).toBe(`${FACTORY_DROID_API_URL}/api/cli/whoami`)
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.get('x-factory-org-id')).toBe('org-1')
    expect(resolved).toMatchObject({ orgId: 'org-2', region: 'eu', inferenceRegion: 'us' })
  })

  it('serves the EU host once the region is eu', async () => {
    const { fetch, calls } = stubFetch(() => json({ orgId: 'org-1' }))

    await resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1', region: 'eu' }, 'login', { fetch, now })

    expect(calls[0]!.url).toBe(`${FACTORY_DROID_EU_API_URL}/api/cli/whoami`)
  })

  it('infers the inference scope: explicit wins, EU residency infers EU, else global', async () => {
    const explicit = await resolveFactoryDroidIdentity(
      { ...grant, orgId: 'org-1', region: 'eu', inferenceRegion: 'us' },
      'login',
      { fetch: stubFetch(() => json({})).fetch, now },
    )
    expect(explicit.inferenceRegion).toBe('us')

    const inferred = await resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1', region: 'eu' }, 'login', {
      fetch: stubFetch(() => json({})).fetch,
      now,
    })
    expect(inferred.inferenceRegion).toBe('eu')

    const global = await resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1' }, 'login', {
      fetch: stubFetch(() => json({})).fetch,
      now,
    })
    expect(global.inferenceRegion).toBe('global')
  })

  it('fails the login when no organization resolves, and shrugs on the refresh phase', async () => {
    const empty = () => stubFetch(() => json({})).fetch
    await expect(resolveFactoryDroidIdentity(grant, 'login', { fetch: empty(), now })).rejects.toThrowError(
      /did not resolve an organization/,
    )
    const refreshed = await resolveFactoryDroidIdentity(grant, 'refresh', { fetch: empty(), now })
    expect(refreshed).not.toHaveProperty('orgId')
    expect(refreshed.inferenceRegion).toBe('global')
  })

  it('fails the login on a non-2xx whoami and keeps the grant on refresh', async () => {
    const failing = () => stubFetch(() => new Response('nope', { status: 500 })).fetch
    await expect(resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1' }, 'login', { fetch: failing(), now })).rejects.toThrowError(
      /identity check failed with HTTP 500/,
    )
    await expect(
      resolveFactoryDroidIdentity({ ...grant, orgId: 'org-1' }, 'refresh', { fetch: failing(), now }),
    ).resolves.toMatchObject({ orgId: 'org-1' })
  })

  it('does not inherit the stored scope when the organization changed', async () => {
    const { fetch } = stubFetch(() => json({ orgId: 'org-2' }))

    const resolved = await resolveFactoryDroidIdentity(
      { ...grant, orgId: 'org-1', region: 'eu', inferenceRegion: 'eu' },
      'login',
      { fetch, now },
    )

    // A different organization must not keep the previous account's host.
    expect(resolved.orgId).toBe('org-2')
    expect(resolved.inferenceRegion).toBe('global')
  })
})

describe('factory droid credential resolver', () => {
  /** A store over one mutable record, counting writes. */
  function store(initial: StoredCredentialRecord | undefined): {
    credentials: CredentialRecordsLike
    record: () => StoredCredentialRecord | undefined
    writes: () => number
  } {
    let record = initial
    let writes = 0
    return {
      credentials: {
        readRecord: async () => record,
        modifyRecord: async (_key, mutate) => {
          writes += 1
          record = (await mutate(record)) ?? record
          return record
        },
      },
      record: () => record,
      writes: () => writes,
    }
  }

  const fresh = (overrides: Record<string, unknown> = {}): StoredCredentialRecord => ({
    kind: 'grant',
    payload: {
      access: 'stored-access',
      refresh: 'stored-refresh',
      expires: NOW + 3_600_000,
      orgId: 'org-1',
      region: 'eu',
      inferenceRegion: 'eu',
      ...overrides,
    },
  })

  it('serves a fresh grant without touching the write path', async () => {
    const handle = store(fresh())
    const access = createFactoryDroidAccess(handle.credentials, { now })

    expect(await access()).toBe('stored-access')
    expect(handle.writes()).toBe(0)
  })

  it('refreshes inside the 60 s window, once, keeping the identity', async () => {
    const access = jwt({ exp: 2_000_000_000, external_org_id: 'org-1' })
    const handle = store(fresh({ expires: NOW + 30_000, access: 'old' }))
    const { fetch } = stubFetch(call => {
      if (call.url === FACTORY_DROID_TOKEN_URL) return json({ access_token: access, refresh_token: 'rotated' })
      return json({ orgId: 'org-1', region: 'eu' })
    })
    const resolver = createFactoryDroidAccess(handle.credentials, { now, fetch })

    expect(await resolver()).toBe(access)
    expect(handle.writes()).toBe(1)
    const payload = readFactoryDroidGrant(handle.record())!
    expect(payload).toMatchObject({ access, refresh: 'rotated', orgId: 'org-1', region: 'eu', inferenceRegion: 'eu' })
  })

  it('skips the refresh when another writer already renewed the record', async () => {
    let record: StoredCredentialRecord | undefined = fresh({ expires: NOW - 1 })
    const credentials: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        // The competing writer commits between this turn's read and its lock.
        record = fresh()
        return (await mutate(record)) ?? record
      },
    }
    const { fetch, calls } = stubFetch(() => json({ access_token: jwt({ exp: 2_000_000_000 }) }))

    expect(await createFactoryDroidAccess(credentials, { now, fetch })()).toBe('stored-access')
    expect(calls).toEqual([])
  })

  it('serves the winner\'s grant when the store reports a no-op update as undefined', async () => {
    // Same shape as the GitLab resolver: an "unchanged" update answers `undefined`,
    // and that means another writer committed, not that the sign-in vanished.
    let record: StoredCredentialRecord | undefined = fresh({ expires: NOW - 1 })
    const credentials: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        record = { kind: 'grant', payload: { access: 'winner-access', refresh: 'winner-refresh', expires: NOW + 3_600_000 } }
        return (await mutate(record)) as StoredCredentialRecord | undefined
      },
    }
    const { fetch, calls } = stubFetch(() => json({ access_token: jwt({ exp: 2_000_000_000 }) }))

    expect(await createFactoryDroidAccess(credentials, { now, fetch })()).toBe('winner-access')
    expect(calls).toEqual([])
  })

  it('keeps the stored identity when the post-refresh whoami fails', async () => {
    const access = jwt({ exp: 2_000_000_000 })
    const handle = store(fresh({ expires: NOW - 1 }))
    const { fetch } = stubFetch(call => {
      if (call.url === FACTORY_DROID_TOKEN_URL) return json({ access_token: access })
      return new Response('down', { status: 503 })
    })

    expect(await createFactoryDroidAccess(handle.credentials, { now, fetch })()).toBe(access)
    // A refresh that does not rotate keeps the stored refresh token, and the
    // account scope survives a whoami outage.
    expect(readFactoryDroidGrant(handle.record())).toMatchObject({
      access,
      refresh: 'stored-refresh',
      orgId: 'org-1',
      region: 'eu',
      inferenceRegion: 'eu',
    })
  })

  it('reports a grant without a refresh token as a dead sign-in', async () => {
    const handle = store({ kind: 'grant', payload: { access: 'a', expires: NOW - 1 } })

    await expect(createFactoryDroidAccess(handle.credentials, { now })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
  })

  it('reports a rejected refresh as AUTH_FAILED rather than a retryable failure', async () => {
    const handle = store(fresh({ expires: NOW - 1 }))
    const { fetch } = stubFetch(() => json({ error: 'invalid_grant' }, 400))

    await expect(createFactoryDroidAccess(handle.credentials, { now, fetch })()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })
  })

  it('reports a missing record as MISSING_CREDENTIAL, naming the route', async () => {
    const handle = store(undefined)

    await expect(createFactoryDroidAccess(handle.credentials, { now })()).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
      message: expect.stringContaining(FACTORY_DROID_CREDENTIAL_KEY),
    })
  })

  it('commits a rotated refresh token even when the turn is cancelled mid-refresh', async () => {
    const controller = new AbortController()
    const access = jwt({ exp: 2_000_000_000 })
    const handle = store(fresh({ expires: NOW - 1 }))
    const { fetch } = stubFetch(call => {
      if (call.url === FACTORY_DROID_TOKEN_URL) {
        controller.abort()
        return json({ access_token: access, refresh_token: 'rotated' })
      }
      return json({ orgId: 'org-1' })
    })

    await expect(createFactoryDroidAccess(handle.credentials, { now, fetch })(controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    })
    expect(readFactoryDroidGrant(handle.record())).toMatchObject({ access, refresh: 'rotated' })
  })
})

describe('factory droid authorization flow', () => {
  function fakeSession(signal: AbortSignal = new AbortController().signal): {
    session: {
      method: string
      signal: AbortSignal
      notify: (notice: { message: string; url?: string; code?: string }) => void
      prompt: () => Promise<string>
      commit: (record: { kind: 'grant'; payload: unknown }) => Promise<void>
    }
    notices: { message: string; url?: string; code?: string }[]
    committed: { kind: string; payload: Record<string, unknown> }[]
  } {
    const notices: { message: string; url?: string; code?: string }[] = []
    const committed: { kind: string; payload: Record<string, unknown> }[] = []
    return {
      notices,
      committed,
      session: {
        method: 'oauth',
        signal,
        notify: notice => notices.push(notice),
        prompt: async () => {
          throw new Error('the device flow never prompts')
        },
        commit: async record => {
          committed.push({ kind: record.kind, payload: record.payload as Record<string, unknown> })
        },
      },
    }
  }

  it('notifies the page and the code, then commits the documented payload', async () => {
    const { fetch } = deviceFetch(tokenBody())
    const { session, notices, committed } = fakeSession()

    await factoryDroidAuthorizationFlow({ fetch, now, sleep: async () => {} }).run(session)

    expect(notices).toHaveLength(1)
    expect(notices[0]!.url).toBe('https://factory.ai/device?code=ABCD-1234')
    expect(notices[0]!.code).toBe('ABCD-1234')
    expect(committed).toEqual([
      {
        kind: 'grant',
        payload: {
          access: jwt({ exp: 2_000_000_000, email: 'human@example.com', sub: 'user-1', external_org_id: 'org-1' }),
          refresh: 'refresh-1',
          expires: 2_000_000_000_000,
          email: 'human@example.com',
          accountId: 'user-1',
          orgId: 'org-1',
          // The inference scope is always resolved (global when nothing says
          // otherwise), because the transport reads it on every request.
          inferenceRegion: 'global',
        },
      },
    ])
    // No `region`: this whoami answered with the org only, and an absent field
    // must be absent rather than `undefined`.
    expect(Object.keys(committed[0]!.payload).sort()).toEqual([
      'access',
      'accountId',
      'email',
      'expires',
      'inferenceRegion',
      'orgId',
      'refresh',
    ])
  })

  it('names the route on its flow entry', () => {
    const flow = factoryDroidAuthorizationFlow()

    expect(flow.key).toBe(FACTORY_DROID_CREDENTIAL_KEY)
    expect(flow.label).toBe('Factory Droid')
    expect(flow.methods).toEqual([{ id: 'oauth', label: 'Sign in with Factory Droid' }])
  })

  it('maps a device-authorization failure to AUTH_FAILED and commits nothing', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 500 }))
    const { session, committed } = fakeSession()

    await expect(factoryDroidAuthorizationFlow({ fetch, now }).run(session)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })
    expect(committed).toEqual([])
  })

  it('rethrows a withdrawn attempt instead of reporting a failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = stubFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const { session, committed } = fakeSession(controller.signal)

    await expect(factoryDroidAuthorizationFlow({ fetch, now }).run(session)).rejects.toMatchObject({
      name: 'AbortError',
    })
    // The request is reachable by the seam's cancellation, not just by the poll.
    expect(calls[0]!.init?.signal?.aborted).toBe(true)
    expect(committed).toEqual([])
  })

  it('pins the copied rule endpoints and client id', () => {
    expect(FACTORY_DROID_DEVICE_URL).toBe('https://api.workos.com/user_management/authorize/device')
    expect(FACTORY_DROID_TOKEN_URL).toBe('https://api.workos.com/user_management/authenticate')
    expect(FACTORY_DROID_CLIENT_ID).toBe('client_01HNM792M5G5G1A2THWPXKFMXB')
    expect(FACTORY_DROID_API_URL).toBe('https://api.factory.ai')
    expect(FactoryDroidAuthError.name).toBe('FactoryDroidAuthError')
  })
})
