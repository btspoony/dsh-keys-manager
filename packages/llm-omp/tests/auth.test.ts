/**
 * Sign-in, refresh, credential resolution and route registration — all offline.
 *
 * The protocol functions are driven by a stubbed `fetch` and a no-op `sleep`, so
 * a 404→200 poll and a token rotation are instant scripts rather than wall
 * clock. The plugin half is driven by a fake `ctx` (`llm`, `credentials`,
 * `authorization`) and asserts the exact registration calls a host receives.
 *
 * The client identity drift gate lives in `tests/build.test.ts` beside the
 * other pinned-source checks.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { CURSOR_ROUTE, OmpCursorAdapter } from '../src/adapter.js'
import {
  CURSOR_AUTH,
  CursorAuthError,
  fetchCursorAccountEmail,
  generateCursorAuthParams,
  loginCursor,
  pollCursorAuth,
  refreshCursorToken,
} from '../src/cursor/auth.js'
import type { CursorFetch } from '../src/cursor/auth.js'
import { CURSOR_CREDENTIAL_KEY, createCursorAccess } from '../src/cursor/credentials.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../src/cursor/credentials.js'
import {
  TRANSPORT_UNAVAILABLE,
  apply,
  beginCursorSignIn,
  createCursorAdapter,
  cursorAuthorizationFlow,
} from '../src/index.js'
import type { CursorAuthorizationFlow, CursorSignInInteraction } from '../src/index.js'

const noSleep = async (): Promise<void> => {}

/** Encode an unsigned JWT-shaped token; only the payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function empty(status: number): Response {
  return new Response(null, { status })
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

/** A `fetch` that records its calls and answers from `respond`. */
function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: CursorFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) })
      return respond(url, init)
    },
  }
}

/** One in-memory credential store implementing the two record methods the resolver calls. */
function fakeStore(initial?: StoredCredentialRecord): {
  credentials: CredentialRecordsLike
  reads: () => number
  writes: () => number
  record: () => StoredCredentialRecord | undefined
} {
  let record = initial
  let reads = 0
  let writes = 0
  return {
    credentials: {
      readRecord: async () => {
        reads += 1
        return record
      },
      modifyRecord: async (_key, mutate) => {
        writes += 1
        record = await mutate(record)
        return record
      },
    },
    reads: () => reads,
    writes: () => writes,
    record: () => record,
  }
}

const FAR_FUTURE = 2_000_000_000_000
const AUTH_TOKEN = jwt({ sub: 'workos|acct-9', exp: 2_000_000_000 })

describe('cursor PKCE login URL', () => {
  it('points at the loginDeepControl page with the CLI redirect and a PKCE challenge', async () => {
    const params = await generateCursorAuthParams()
    expect(params.verifier).toHaveLength(128)
    expect(params.challenge).not.toBe(params.verifier)
    expect(params.uuid).toMatch(/^[0-9a-f-]{36}$/)

    const url = new URL(params.loginUrl)
    expect(`${url.origin}${url.pathname}`).toBe(CURSOR_AUTH.loginUrl)
    expect(url.searchParams.get('challenge')).toBe(params.challenge)
    expect(url.searchParams.get('uuid')).toBe(params.uuid)
    expect(url.searchParams.get('mode')).toBe('login')
    expect(url.searchParams.get('redirectTarget')).toBe('cli')
  })
})

describe('cursor auth polling', () => {
  it('treats 404 as pending and returns the tokens of the first authorized poll', async () => {
    let polls = 0
    const { fetch, calls } = stubFetch(() => {
      polls += 1
      return polls === 1 ? empty(404) : json({ accessToken: AUTH_TOKEN, refreshToken: 'refresh-1' })
    })

    await expect(pollCursorAuth('uuid-1', 'verifier-1', { fetch, sleep: noSleep })).resolves.toEqual({
      access: AUTH_TOKEN,
      refresh: 'refresh-1',
    })
    expect(calls.map(call => call.url)).toEqual([
      'https://api2.cursor.sh/auth/poll?uuid=uuid-1&verifier=verifier-1',
      'https://api2.cursor.sh/auth/poll?uuid=uuid-1&verifier=verifier-1',
    ])
  })

  it('gives up after three consecutive non-404 failures', async () => {
    const { fetch, calls } = stubFetch(() => empty(503))

    await expect(pollCursorAuth('uuid', 'verifier', { fetch, sleep: noSleep })).rejects.toMatchObject({
      name: 'CursorAuthError',
      failure: 'poll',
      status: 503,
    })
    expect(calls).toHaveLength(3)
  })

  it('times out after the pinned attempt budget', async () => {
    const { fetch, calls } = stubFetch(() => empty(404))

    await expect(pollCursorAuth('uuid', 'verifier', { fetch, sleep: noSleep })).rejects.toMatchObject({
      name: 'CursorAuthError',
      failure: 'timeout',
    })
    expect(calls).toHaveLength(150)
  })

  it('stops on an aborted attempt instead of counting it as a poll error', async () => {
    const controller = new AbortController()
    const { fetch } = stubFetch(() => empty(404))

    await expect(
      pollCursorAuth('uuid', 'verifier', {
        fetch,
        signal: controller.signal,
        sleep: async () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('cursor token refresh', () => {
  it('exchanges the refresh token and derives expiry from the JWT exp minus five minutes', async () => {
    const rotated = jwt({ sub: 'workos|acct-9', exp: 2_000_000_000 })
    const { fetch, calls } = stubFetch(() =>
      json({ access_token: rotated, refresh_token: 'refresh-2' }),
    )

    await expect(refreshCursorToken('refresh-1', { fetch })).resolves.toEqual({
      access: rotated,
      refresh: 'refresh-2',
      expires: 2_000_000_000_000 - 5 * 60 * 1000,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(CURSOR_AUTH.refreshUrl)
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: CURSOR_AUTH.clientId,
      refresh_token: 'refresh-1',
    })
  })

  it('keeps the stored refresh token when the exchange does not rotate it', async () => {
    const { fetch } = stubFetch(() => json({ access_token: AUTH_TOKEN }))

    const refreshed = await refreshCursorToken('refresh-1', { fetch })
    expect(refreshed.refresh).toBe('refresh-1')
  })

  it('treats shouldLogout as a dead session rather than a retryable failure', async () => {
    const { fetch } = stubFetch(() => json({ shouldLogout: true }))

    await expect(refreshCursorToken('refresh-1', { fetch })).rejects.toMatchObject({
      name: 'CursorAuthError',
      failure: 'reauth',
    })
    await expect(refreshCursorToken('refresh-1', { fetch })).rejects.toBeInstanceOf(CursorAuthError)
  })

  it('reports a rejected exchange and a response without an access token', async () => {
    const rejected = stubFetch(() => new Response('invalid_client', { status: 401 }))
    await expect(refreshCursorToken('refresh-1', { fetch: rejected.fetch })).rejects.toMatchObject({
      failure: 'refresh',
      status: 401,
    })

    const blank = stubFetch(() => json({}))
    await expect(refreshCursorToken('refresh-1', { fetch: blank.fetch })).rejects.toMatchObject({
      failure: 'refresh',
    })
  })

  it('forwards the caller signal to the exchange', async () => {
    const controller = new AbortController()
    const { fetch, calls } = stubFetch(() => json({ access_token: AUTH_TOKEN }))

    await refreshCursorToken('refresh-1', { fetch, signal: controller.signal })
    expect(calls[0].init?.signal).toBe(controller.signal)
  })
})

describe('cursor account identity', () => {
  it('reads the email from the profile of the account named by the token', async () => {
    const { fetch, calls } = stubFetch(() => json({ sub: 'acct-9', email: ' dev@example.com ' }))

    await expect(fetchCursorAccountEmail(AUTH_TOKEN, { fetch })).resolves.toBe('dev@example.com')
    expect(calls[0].url).toBe(CURSOR_AUTH.profileUrl)
    expect(calls[0].init?.headers).toMatchObject({
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`acct-9::${AUTH_TOKEN}`)}`,
    })
  })

  it('returns undefined for a token with no readable user and for a mismatched profile', async () => {
    const anonymous = stubFetch(() => json({}))
    await expect(fetchCursorAccountEmail('not-a-jwt', { fetch: anonymous.fetch })).resolves.toBeUndefined()
    expect(anonymous.calls).toHaveLength(0)

    const other = stubFetch(() => json({ sub: 'someone-else', email: 'x@example.com' }))
    await expect(fetchCursorAccountEmail(AUTH_TOKEN, { fetch: other.fetch })).resolves.toBeUndefined()
  })
})

describe('cursor sign-in flow', () => {
  it('names the URL, polls, profiles the account and commits the grant', async () => {
    let polls = 0
    const { fetch, calls } = stubFetch(url => {
      if (url.startsWith(CURSOR_AUTH.pollUrl)) {
        polls += 1
        return polls === 1 ? empty(404) : json({ accessToken: AUTH_TOKEN, refreshToken: 'refresh-1' })
      }
      if (url === CURSOR_AUTH.profileUrl) return json({ sub: 'acct-9', email: 'dev@example.com' })
      throw new Error(`unexpected request ${url}`)
    })

    const flow = cursorAuthorizationFlow({ fetch, sleep: noSleep })
    const notices: { message: string; url?: string }[] = []
    const committed: unknown[] = []
    const session = {
      method: 'oauth',
      signal: new AbortController().signal,
      notify: (notice: { message: string; url?: string }) => notices.push(notice),
      commit: async (record: unknown) => {
        committed.push(record)
      },
    }

    await flow.run(session)

    expect(flow.key).toBe(CURSOR_CREDENTIAL_KEY)
    expect(flow.label).toBe('Cursor')
    expect(flow.methods).toEqual([{ id: 'oauth', label: 'Sign in with Cursor' }])

    expect(notices).toHaveLength(1)
    const url = new URL(notices[0].url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(CURSOR_AUTH.loginUrl)
    expect(url.searchParams.get('redirectTarget')).toBe('cli')
    expect(url.searchParams.get('challenge')).toBeTruthy()

    expect(committed).toEqual([
      {
        kind: 'grant',
        payload: {
          access: AUTH_TOKEN,
          refresh: 'refresh-1',
          expires: 2_000_000_000_000 - 5 * 60 * 1000,
          email: 'dev@example.com',
          accountId: 'acct-9',
        },
      },
    ])
    expect(calls).toHaveLength(3)
  })

  it('commits without an email when the profile lookup fails', async () => {
    const { fetch } = stubFetch(url => {
      if (url.startsWith(CURSOR_AUTH.pollUrl)) return json({ accessToken: AUTH_TOKEN, refreshToken: 'refresh-1' })
      return new Response('boom', { status: 500 })
    })

    const grant = await loginCursor({ fetch, sleep: noSleep })
    expect(grant).toEqual({
      access: AUTH_TOKEN,
      refresh: 'refresh-1',
      expires: 2_000_000_000_000 - 5 * 60 * 1000,
      accountId: 'acct-9',
    })
  })

  it('stops when the caller withdraws during the profile read', async () => {
    const controller = new AbortController()
    const { fetch } = stubFetch(url => {
      if (url.startsWith(CURSOR_AUTH.pollUrl)) return json({ accessToken: AUTH_TOKEN, refreshToken: 'refresh-1' })
      controller.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    })

    await expect(
      loginCursor({ fetch, sleep: noSleep, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('cursor access resolver', () => {
  it('answers a fresh grant without touching the write path', async () => {
    const store = fakeStore({
      kind: 'grant',
      payload: { access: 'fresh-token', refresh: 'refresh-1', expires: FAR_FUTURE },
    })

    await expect(createCursorAccess(store.credentials)()).resolves.toBe('fresh-token')
    expect(store.reads()).toBe(1)
    expect(store.writes()).toBe(0)
  })

  it('refreshes a grant inside the five-minute window under modifyRecord', async () => {
    const now = 1_000_000
    const rotated = jwt({ sub: 'workos|acct-9', exp: 2_000_000_000 })
    const { fetch } = stubFetch(() => json({ access_token: rotated }))
    const store = fakeStore({
      kind: 'grant',
      payload: { access: 'stale-token', refresh: 'refresh-1', expires: now + 60_000, email: 'dev@example.com' },
    })

    await expect(createCursorAccess(store.credentials, { fetch, now: () => now })()).resolves.toBe(rotated)
    expect(store.writes()).toBe(1)
    expect(store.record()).toEqual({
      kind: 'grant',
      payload: {
        access: rotated,
        refresh: 'refresh-1',
        expires: 2_000_000_000_000 - 5 * 60 * 1000,
        email: 'dev@example.com',
      },
    })
  })

  it('leaves a grant another writer refreshed while it waited for the lock', async () => {
    const now = 1_000_000
    const refreshed: StoredCredentialRecord = {
      kind: 'grant',
      payload: { access: 'other-writer-token', refresh: 'refresh-1', expires: now + 3_600_000 },
    }
    let record: StoredCredentialRecord | undefined = {
      kind: 'grant',
      payload: { access: 'stale-token', refresh: 'refresh-1', expires: now + 60_000 },
    }
    const credentials: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        // The competing writer commits between this turn's read and its lock.
        record = refreshed
        return (await mutate(record)) ?? record
      },
    }
    const { fetch, calls } = stubFetch(() => json({ access_token: AUTH_TOKEN }))

    await expect(createCursorAccess(credentials, { fetch, now: () => now })()).resolves.toBe('other-writer-token')
    expect(calls).toHaveLength(0)
  })

  it('reports a grant removed while it waited for the lock', async () => {
    const now = 1_000_000
    const credentials: CredentialRecordsLike = {
      readRecord: async () => ({
        kind: 'grant',
        payload: { access: 'stale-token', refresh: 'refresh-1', expires: now + 60_000 },
      }),
      modifyRecord: async (_key, mutate) => mutate(undefined),
    }
    const { fetch } = stubFetch(() => json({ access_token: AUTH_TOKEN }))

    await expect(createCursorAccess(credentials, { fetch, now: () => now })()).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })
  })

  it('turns shouldLogout into REAUTH_REQUIRED', async () => {
    const now = 1_000_000
    const { fetch } = stubFetch(() => json({ shouldLogout: true }))
    const store = fakeStore({
      kind: 'grant',
      payload: { access: 'stale-token', refresh: 'refresh-1', expires: now + 60_000 },
    })

    await expect(createCursorAccess(store.credentials, { fetch, now: () => now })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
  })

  it('refuses to renew a grant that stored no refresh token', async () => {
    const now = 1_000_000
    const { fetch, calls } = stubFetch(() => json({ access_token: AUTH_TOKEN }))
    const store = fakeStore({
      kind: 'grant',
      payload: { access: 'stale-token', expires: now + 60_000 },
    })

    await expect(createCursorAccess(store.credentials, { fetch, now: () => now })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
    expect(calls).toHaveLength(0)
  })

  it('reports a missing sign-in without a network call', async () => {
    const { fetch, calls } = stubFetch(() => json({}))
    const store = fakeStore()

    await expect(createCursorAccess(store.credentials, { fetch })()).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })
    expect(calls).toHaveLength(0)
  })

  it('forwards the request signal to the refresh exchange', async () => {
    const now = 1_000_000
    const { fetch, calls } = stubFetch(() => json({ access_token: AUTH_TOKEN }))
    const store = fakeStore({
      kind: 'grant',
      payload: { access: 'stale-token', refresh: 'refresh-1', expires: now + 60_000 },
    })
    const controller = new AbortController()

    await createCursorAccess(store.credentials, { fetch, now: () => now })(controller.signal)
    expect(calls[0].init?.signal).toBe(controller.signal)
  })
})

describe('llm-omp-transports registration', () => {
  function fakeHost(): {
    ctx: Context
    adapters: { providers: string[]; adapter: unknown }[]
    directories: unknown[]
    flow: () => CursorAuthorizationFlow | undefined
    reads: () => number
  } {
    let flow: CursorAuthorizationFlow | undefined
    const adapters: { providers: string[]; adapter: unknown }[] = []
    const directories: unknown[] = []
    let reads = 0
    const ctx = {
      llm: {
        registerAdapter(providers: string[], adapter: unknown) {
          adapters.push({ providers, adapter })
          return Object.assign(() => {}, { replace() {} })
        },
        registerConfigurableProviders(entries: unknown[]) {
          directories.push(entries)
          return Object.assign(() => {}, { replace() {} })
        },
      },
      credentials: {
        readRecord: async () => {
          reads += 1
          return undefined
        },
        modifyRecord: async () => undefined,
      },
      authorization: {
        registerFlow(registered: CursorAuthorizationFlow) {
          flow = registered
          return () => {}
        },
      },
    }
    return {
      ctx: ctx as unknown as Context,
      adapters,
      directories,
      flow: () => flow,
      reads: () => reads,
    }
  }

  it('registers the cursor adapter, its Models-page entry and the flow', () => {
    const host = fakeHost()
    apply(host.ctx)

    expect(host.adapters).toHaveLength(1)
    expect(host.adapters[0].providers).toEqual([CURSOR_ROUTE])
    expect(host.adapters[0].adapter).toBeInstanceOf(OmpCursorAdapter)
    expect(host.directories).toEqual([
      [
        {
          provider: 'cursor',
          displayName: 'Cursor',
          settingsNs: 'llm-omp-transports',
          settingsPath: ['providers', 'cursor'],
          declared: false,
        },
      ],
    ])
    expect(host.flow()).toMatchObject({
      key: 'llm-omp-transports/cursor',
      label: 'Cursor',
      methods: [{ id: 'oauth', label: 'Sign in with Cursor' }],
    })
    // Registration is start-up safe: no credential is read and no bundle is imported.
    expect(host.reads()).toBe(0)
  })

  it('starts the sign-in through the authorization seam under the cursor key', async () => {
    const beginCalls: unknown[] = []
    const interaction: CursorSignInInteraction = {
      notify: () => {},
      prompt: async () => '',
    }
    const controller = new AbortController()
    const ctx = {
      authorization: {
        begin: async (request: unknown) => {
          beginCalls.push(request)
          return { status: 'authorized' as const }
        },
      },
    } as unknown as Context

    await expect(beginCursorSignIn(ctx, interaction, controller.signal)).resolves.toEqual({ status: 'authorized' })
    expect(beginCalls).toEqual([
      { key: 'llm-omp-transports/cursor', interaction, signal: controller.signal },
    ])
  })

  it('exposes the registered adapter and its catalog through the plugin', async () => {
    const adapter = createCursorAdapter(fakeStore().credentials)

    expect(adapter).toBeInstanceOf(OmpCursorAdapter)
    expect(adapter.providerInfo(CURSOR_ROUTE)).toEqual({ id: 'cursor', name: 'Cursor' })
    expect(await adapter.listModels(CURSOR_ROUTE)).toHaveLength(123)
  })

  it('surfaces a missing bundle at request time as TRANSPORT_UNAVAILABLE', async () => {
    // The source tree has no `src/omp/cursor.mjs`; the build writes it to `lib/`.
    // The failure must reach the request, not registration.
    const adapter = createCursorAdapter(
      fakeStore({ kind: 'grant', payload: { access: 'fresh-token', expires: FAR_FUTURE } }).credentials,
    )
    const options: GenerateOptions = {
      provider: CURSOR_ROUTE,
      model: 'claude-4.5-sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
    }

    const chunks: StreamChunk[] = []
    await expect(
      (async () => {
        for await (const chunk of adapter.stream(options)) chunks.push(chunk)
      })(),
    ).rejects.toMatchObject({ code: TRANSPORT_UNAVAILABLE })
    expect(chunks).toEqual([])
  })
})
