/**
 * Devin sign-in, the static-bearer resolver and the paste flow — all offline.
 *
 * The protocol functions are driven by a stubbed `fetch`, so the PKCE mint, the
 * callback parser, the token exchange and the expiry derivation are exact
 * assertions rather than wall-clock scripts. The flow half is driven by a fake
 * authorization session (`notify`/`prompt`/`commit`), mirroring Cursor's flow
 * tests.
 *
 * The copied endpoint facts are pinned against the installed omp sources in
 * `tests/build-devin.test.ts`; this file pins what the plugin itself sends.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DEVIN_AUTH,
  DevinAuthError,
  exchangeDevinCode,
  generateDevinAuthParams,
  loginDevin,
  parseDevinCallback,
} from '../src/devin/auth.js'
import type { DevinFetch } from '../src/devin/auth.js'
import { DEVIN_CREDENTIAL_KEY, createDevinAccess } from '../src/devin/credentials.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../src/cursor/credentials.js'
import { devinAuthorizationFlow } from '../src/index.js'
import type { AuthorizationPrompt } from '../src/index.js'

const FAR_FUTURE = 2_000_000_000_000

/** Encode an unsigned JWT-shaped token; only the payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

/** A `fetch` that records its calls and answers from `respond`. */
function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: DevinFetch
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

/** One read-only credential store: `modifyRecord` counts as a write and would fail the resolver tests. */
function fakeStore(initial?: StoredCredentialRecord): {
  credentials: CredentialRecordsLike
  reads: () => number
  writes: () => number
} {
  let reads = 0
  let writes = 0
  return {
    credentials: {
      readRecord: async () => {
        reads += 1
        return initial
      },
      modifyRecord: async (_key, mutate) => {
        writes += 1
        return mutate(initial)
      },
    },
    reads: () => reads,
    writes: () => writes,
  }
}

/** A fake authorization session recording what the flow said, asked and committed. */
function fakeSession(paste: string): {
  session: {
    method: string
    signal: AbortSignal
    notify: (notice: { message: string; url?: string }) => void
    prompt: (prompt: AuthorizationPrompt) => Promise<string>
    commit: (record: { kind: 'grant'; payload: unknown }) => Promise<void>
  }
  notices: { message: string; url?: string }[]
  prompts: AuthorizationPrompt[]
  committed: { kind: string; payload: Record<string, unknown> }[]
} {
  const notices: { message: string; url?: string }[] = []
  const prompts: AuthorizationPrompt[] = []
  const committed: { kind: string; payload: Record<string, unknown> }[] = []
  return {
    notices,
    prompts,
    committed,
    session: {
      method: 'oauth',
      signal: new AbortController().signal,
      notify: notice => {
        notices.push(notice)
      },
      prompt: async prompt => {
        prompts.push(prompt)
        return paste
      },
      commit: async record => {
        committed.push({ kind: record.kind, payload: record.payload as Record<string, unknown> })
      },
    },
  }
}

describe('devin authorize params', () => {
  it('mints S256 PKCE and the rule\'s standard authorize parameters', () => {
    const params = generateDevinAuthParams({ state: 'state-1', verifier: 'v'.repeat(64) })

    const url = new URL(params.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe(DEVIN_AUTH.authorizeUrl)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(DEVIN_AUTH.callbackUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(params.verifier).digest('base64url'),
    )
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    // The rule declares no client and the engine only sets one when declared.
    expect(url.searchParams.has('client_id')).toBe(false)
  })

  it('mints a fresh verifier and state when none is supplied', () => {
    const params = generateDevinAuthParams()

    expect(params.verifier.length).toBeGreaterThanOrEqual(43)
    expect(params.verifier.length).toBeLessThanOrEqual(128)
    expect(params.state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(params.authorizeUrl).toContain(`state=${params.state}`)
  })
})

describe('devin callback parser', () => {
  it('reads a full callback URL, a bare code and code#state', () => {
    expect(parseDevinCallback('http://127.0.0.1:59653/callback?code=abc&state=s1')).toEqual({ code: 'abc', state: 's1' })
    expect(parseDevinCallback('abc')).toEqual({ code: 'abc' })
    expect(parseDevinCallback('abc#s1')).toEqual({ code: 'abc', state: 's1' })
    // A URL without a state is a bare code with extra shape.
    expect(parseDevinCallback('http://127.0.0.1:59653/callback?code=abc')).toEqual({ code: 'abc' })
  })

  it('refuses an empty paste or one without a code', () => {
    expect(() => parseDevinCallback('   ')).toThrowError(DevinAuthError)
    expect(() => parseDevinCallback('http://127.0.0.1:59653/callback?state=s1')).toThrowError(DevinAuthError)
  })
})

describe('devin token exchange', () => {
  it('posts the rule\'s JSON body and derives the JWT expiry with the skew', async () => {
    const token = jwt({ exp: 2_000_000_000 })
    const { fetch, calls } = stubFetch(() => json({ token }))

    const grant = await exchangeDevinCode('code-1', 'verifier-1', { fetch })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(DEVIN_AUTH.tokenUrl)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe('application/json')
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ code: 'code-1', code_verifier: 'verifier-1' })
    expect(grant).toEqual({ access: token, expires: 2_000_000_000_000 - 5 * 60 * 1000 })
  })

  it('assumes one year for a token that is not a readable JWT', async () => {
    const now = 1_000_000
    const { fetch } = stubFetch(() => json({ token: 'opaque-session-token' }))

    const grant = await exchangeDevinCode('code-1', 'verifier-1', { fetch, now: () => now })

    expect(grant).toEqual({ access: 'opaque-session-token', expires: now + 365 * 24 * 60 * 60 * 1000 })
  })

  it('maps an HTTP failure, a non-JSON body and a missing token to DevinAuthError', async () => {
    const failed = stubFetch(() => new Response('nope', { status: 403 }))
    await expect(exchangeDevinCode('c', 'v', { fetch: failed.fetch })).rejects.toThrowError(DevinAuthError)

    const notJson = stubFetch(() => new Response('not json'))
    await expect(exchangeDevinCode('c', 'v', { fetch: notJson.fetch })).rejects.toThrowError(DevinAuthError)

    const noToken = stubFetch(() => json({}))
    await expect(exchangeDevinCode('c', 'v', { fetch: noToken.fetch })).rejects.toThrowError(DevinAuthError)
  })
})

describe('loginDevin', () => {
  it('reports the page, takes the paste and exchanges it in that order', async () => {
    const events: string[] = []
    const { fetch, calls } = stubFetch(() => {
      events.push('fetch')
      return json({ token: 'devin-session-token' })
    })
    const pasted = `http://127.0.0.1:59653/callback?code=code-1&state=state-1`

    const grant = await loginDevin({
      fetch,
      state: 'state-1',
      verifier: 'v'.repeat(64),
      onAuthUrl: () => events.push('notify'),
      prompt: async () => {
        events.push('prompt')
        return pasted
      },
    })

    expect(events).toEqual(['notify', 'prompt', 'fetch'])
    expect(calls).toHaveLength(1)
    expect(grant.access).toBe('devin-session-token')
    expect(grant.expires).toBeGreaterThan(Date.now())
  })

  it('refuses a state that belongs to another attempt before any exchange', async () => {
    const { fetch, calls } = stubFetch(() => json({ token: 'token' }))

    await expect(
      loginDevin({
        fetch,
        state: 'minted-state',
        prompt: async () => 'http://127.0.0.1:59653/callback?code=code-1&state=other',
      }),
    ).rejects.toThrowError(DevinAuthError)
    expect(calls).toEqual([])
  })

  it('lets an abort escape without a grant', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch } = stubFetch((_url, init) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    await expect(
      loginDevin({
        fetch,
        signal: controller.signal,
        prompt: async () => 'code-1',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('devin access resolver', () => {
  it('serves a live grant and never writes', async () => {
    const store = fakeStore({ kind: 'grant', payload: { access: 'devin-session-token', expires: FAR_FUTURE } })

    await expect(createDevinAccess(store.credentials)()).resolves.toBe('devin-session-token')
    expect(store.reads()).toBe(1)
    expect(store.writes()).toBe(0)
  })

  it('refuses a missing sign-in with MISSING_CREDENTIAL', async () => {
    const store = fakeStore()

    await expect(createDevinAccess(store.credentials)()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(store.writes()).toBe(0)
  })

  it('refuses an expired grant with REAUTH_REQUIRED and never writes', async () => {
    const now = 1_000_000
    const store = fakeStore({ kind: 'grant', payload: { access: 'devin-session-token', expires: now } })

    await expect(createDevinAccess(store.credentials, { now: () => now })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
    expect(store.writes()).toBe(0)
  })

  it('refuses a present but unreadable expires as REAUTH_REQUIRED', async () => {
    // A corrupt expiry is not a static bearer: only an absent field means that.
    const store = fakeStore({ kind: 'grant', payload: { access: 'devin-session-token', expires: 'soon' } })

    await expect(createDevinAccess(store.credentials)()).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' })
    expect(store.writes()).toBe(0)
  })

  it('serves a payload without expires as a static bearer', async () => {
    // Neither the flow nor the pinned rule produces one, but a hand-written
    // record must not be refused on a field the resolver can live without.
    const store = fakeStore({ kind: 'grant', payload: { access: 'static-token' } })

    await expect(createDevinAccess(store.credentials)()).resolves.toBe('static-token')
    expect(store.writes()).toBe(0)
  })

  it('refuses a grant payload that names no access token', async () => {
    const store = fakeStore({ kind: 'grant', payload: { expires: FAR_FUTURE } })

    await expect(createDevinAccess(store.credentials)()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('devin authorization flow', () => {
  it('notifies the page, prompts for the paste and commits access plus expires only', async () => {
    const token = jwt({ exp: 2_000_000_000 })
    const events: string[] = []
    const { fetch } = stubFetch(() => {
      events.push('fetch')
      return json({ token })
    })
    const notices: { message: string; url?: string }[] = []
    const prompts: AuthorizationPrompt[] = []
    const committed: { kind: string; payload: Record<string, unknown> }[] = []
    const session = {
      method: 'oauth',
      signal: new AbortController().signal,
      notify: (notice: { message: string; url?: string }) => {
        events.push('notify')
        notices.push(notice)
      },
      prompt: async (prompt: AuthorizationPrompt) => {
        events.push('prompt')
        prompts.push(prompt)
        // A bare code skips the state check; the flow mints a random state.
        return 'code-1'
      },
      commit: async (record: { kind: 'grant'; payload: unknown }) => {
        events.push('commit')
        committed.push({ kind: record.kind, payload: record.payload as Record<string, unknown> })
      },
    }

    await devinAuthorizationFlow({ fetch }).run(session)

    expect(events).toEqual(['notify', 'prompt', 'fetch', 'commit'])
    expect(notices).toHaveLength(1)
    const url = new URL(notices[0]!.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(DEVIN_AUTH.authorizeUrl)
    expect(prompts).toHaveLength(1)
    // The pasted callback carries the code, so the dialog must mask it: the
    // shared renderer treats `manual-code` as a secret with a reveal toggle.
    expect(prompts[0]!.kind).toBe('manual-code')
    expect(prompts[0]!.placeholder).toContain('127.0.0.1:59653')
    expect(committed).toEqual([
      { kind: 'grant', payload: { access: token, expires: 2_000_000_000_000 - 5 * 60 * 1000 } },
    ])
    // `refresh "none"`: the record must not advertise a renewal path.
    expect(Object.keys(committed[0]!.payload)).toEqual(['access', 'expires'])
  })

  it('names the route on its flow entry', () => {
    const flow = devinAuthorizationFlow()

    expect(flow.key).toBe(DEVIN_CREDENTIAL_KEY)
    expect(flow.label).toBe('Devin')
    expect(flow.methods).toEqual([{ id: 'oauth', label: 'Sign in with Devin' }])
  })

  it('maps a token-exchange failure to AUTH_FAILED and commits nothing', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 500 }))
    const { session, committed } = fakeSession('code-1')

    await expect(devinAuthorizationFlow({ fetch }).run(session)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(committed).toEqual([])
  })

  it('forwards the flow signal into the exchange and commits nothing on abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = stubFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const { session, committed } = fakeSession('code-1')

    await expect(devinAuthorizationFlow({ fetch }).run({ ...session, signal: controller.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    // The exchange is reachable by the seam's cancellation, not just the prompt.
    expect(calls[0]!.init?.signal).toBe(controller.signal)
    expect(calls[0]!.init?.signal?.aborted).toBe(true)
    expect(committed).toEqual([])
  })

  it('pins the copied endpoints', () => {
    expect(DEVIN_AUTH).toEqual({
      authorizeUrl: 'https://app.devin.ai/auth/cli/continue',
      tokenUrl: 'https://api.devin.ai/auth/cli/token',
      callbackUrl: 'http://127.0.0.1:59653/callback',
    })
  })
})
