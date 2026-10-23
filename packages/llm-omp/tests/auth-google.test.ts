/**
 * The two Google routes' sign-in: authorize URL, token exchange, userinfo,
 * project discovery, the login race, the refreshing resolver and the flows —
 * all offline.
 *
 * Every network call is driven by a stubbed `fetch`, so the form bodies, the
 * expiry arithmetic and the discovery scripts are exact assertions. The listener
 * half is the real one from `./callback-listener.test.ts`, bound to an ephemeral
 * loopback port.
 */
import { describe, expect, it } from 'vitest'

import {
  exchangeGoogleCode,
  fetchGoogleEmail,
  googleAuthParams,
  discoverGoogleProject,
  loginGoogle,
  refreshGoogleToken,
} from '../src/google/auth.js'
import type { GoogleFetch } from '../src/google/auth.js'
import { GoogleAuthError } from '../src/google/callback-listener.js'
import {
  GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY,
  GOOGLE_GEMINI_CLI_CREDENTIAL_KEY,
  createGoogleAccess,
  readGoogleGrant,
} from '../src/google/credentials.js'
import type { GoogleGrantPayload } from '../src/google/credentials.js'
import { GOOGLE_ANTIGRAVITY_FACTS, GOOGLE_GEMINI_CLI_FACTS } from '../src/google/route.js'
import {
  GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE,
  GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE,
} from '../src/adapter.js'
import type { CredentialRecordsLike, StoredCredentialRecord } from '../src/cursor/credentials.js'
import { googleAntigravityAuthorizationFlow, googleGeminiCliAuthorizationFlow } from '../src/index.js'
import type { AuthorizationPrompt } from '../src/index.js'

/** Wait for a value a concurrent flow fills in, without a fixed sleep. */
async function waitFor(read: () => string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (read() === '') {
    if (Date.now() > deadline) throw new Error('timed out waiting for the authorize URL')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return read()
}

const NOW = 1_700_000_000_000
const SKEW_MS = 5 * 60 * 1000

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

/** A `fetch` that records its calls and answers from `respond`. */
function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: GoogleFetch
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

/** The form fields of one recorded POST. */
function formOf(call: FetchCall | undefined): URLSearchParams {
  expect(call).toBeDefined()
  return new URLSearchParams(String(call?.init?.body))
}

/** A read-only credential store: `modifyRecord` counts as a write and would fail the fresh-path tests. */
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

function grantRecord(payload: Partial<GoogleGrantPayload> & Pick<GoogleGrantPayload, 'access' | 'expires' | 'projectId'>): StoredCredentialRecord {
  return { kind: 'grant', payload }
}

describe('google authorize params', () => {
  it('mints a hex state and the rule’s standard authorize parameters, without PKCE', () => {
    const params = googleAuthParams(GOOGLE_GEMINI_CLI_FACTS, { state: 'state-1' })

    const url = new URL(params.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_GEMINI_CLI_FACTS.clientId)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8085/oauth2callback')
    // OAuth scopes are one space-separated value, not repeated parameters.
    expect(url.searchParams.get('scope')).toBe(GOOGLE_GEMINI_CLI_FACTS.scopes.join(' '))
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    // The rules set `pkce: false`; a challenge here would fail the exchange.
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
  })

  it('mints a 32-character hex state when none is supplied, and follows the bound port', () => {
    const first = googleAuthParams(GOOGLE_GEMINI_CLI_FACTS)
    const second = googleAuthParams(GOOGLE_ANTIGRAVITY_FACTS, { port: 51122 })

    expect(first.state).toMatch(/^[0-9a-f]{32}$/)
    expect(second.state).not.toBe(first.state)
    expect(new URL(second.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51122/oauth-callback')
  })

  it('sends the Antigravity client, its extra scopes and its own callback path', () => {
    const url = new URL(googleAuthParams(GOOGLE_ANTIGRAVITY_FACTS, { state: 's' }).authorizeUrl)

    expect(url.searchParams.get('client_id')).toBe(GOOGLE_ANTIGRAVITY_FACTS.clientId)
    expect(url.searchParams.get('scope')?.split(' ')).toContain('https://www.googleapis.com/auth/cclog')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51121/oauth-callback')
  })
})

describe('google token exchange', () => {
  it('posts the rule’s form body and derives expiry from expires_in minus the skew', async () => {
    const stub = stubFetch(() =>
      json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    )
    const grant = await exchangeGoogleCode(GOOGLE_GEMINI_CLI_FACTS, 'code-1', 'http://127.0.0.1:8085/oauth2callback', {
      fetch: stub.fetch,
      now: () => NOW,
    })

    expect(grant).toEqual({ access: 'access-1', refresh: 'refresh-1', expires: NOW + 3600_000 - SKEW_MS })
    const call = stub.calls[0]
    expect(call?.url).toBe('https://oauth2.googleapis.com/token')
    expect(call?.init?.method).toBe('POST')
    expect(new Headers(call?.init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    const form = formOf(call)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('client_id')).toBe(GOOGLE_GEMINI_CLI_FACTS.clientId)
    expect(form.get('client_secret')).toBe(GOOGLE_GEMINI_CLI_FACTS.clientSecret)
    // Google compares the redirect URI on the exchange against the authorize request.
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:8085/oauth2callback')
  })

  it('refuses a grant without a refresh token, a rejected exchange and an incomplete body', async () => {
    await expect(
      exchangeGoogleCode(GOOGLE_GEMINI_CLI_FACTS, 'c', 'u', {
        fetch: stubFetch(() => json({ access_token: 'a', expires_in: 3600 })).fetch,
      }),
    ).rejects.toThrowError(/no refresh token/)

    await expect(
      exchangeGoogleCode(GOOGLE_GEMINI_CLI_FACTS, 'c', 'u', {
        fetch: stubFetch(() => json({ error: 'invalid_grant' }, 400)).fetch,
      }),
    ).rejects.toThrowError(/token request failed: 400/)

    await expect(
      exchangeGoogleCode(GOOGLE_GEMINI_CLI_FACTS, 'c', 'u', {
        fetch: stubFetch(() => json({ access_token: 'a', refresh_token: 'r' })).fetch,
      }),
    ).rejects.toThrowError(/no expires_in/)
  })
})

describe('google token refresh', () => {
  it('posts the refresh form and reports no rotation when the response omits one', async () => {
    const stub = stubFetch(() => json({ access_token: 'access-2', expires_in: 1800 }))
    const grant = await refreshGoogleToken(GOOGLE_GEMINI_CLI_FACTS, 'refresh-1', {
      fetch: stub.fetch,
      now: () => NOW,
    })

    expect(grant).toEqual({ access: 'access-2', expires: NOW + 1800_000 - SKEW_MS })
    const form = formOf(stub.calls[0])
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-1')
  })
})

describe('google userinfo', () => {
  it('reads the email with the access token and shrugs off a failed lookup', async () => {
    const stub = stubFetch(() => json({ email: 'human@example.com' }))
    await expect(fetchGoogleEmail('access-1', { fetch: stub.fetch })).resolves.toBe('human@example.com')
    expect(new Headers(stub.calls[0]?.init?.headers).get('authorization')).toBe('Bearer access-1')

    await expect(
      fetchGoogleEmail('access-1', { fetch: stubFetch(() => json({}, 401)).fetch }),
    ).resolves.toBeUndefined()
  })
})

describe('google project discovery', () => {
  it('returns the project the account already carries', async () => {
    const stub = stubFetch(() =>
      json({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'project-1' }),
    )
    await expect(
      discoverGoogleProject(GOOGLE_GEMINI_CLI_FACTS, 'access-1', { fetch: stub.fetch, env: {} }),
    ).resolves.toBe('project-1')

    const call = stub.calls[0]
    expect(call?.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
    const headers = new Headers(call?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer access-1')
    // The Gemini CLI identity the backend gates access on.
    expect(headers.get('user-agent')).toContain('GeminiCLI/0.46.0')
    expect(headers.get('client-metadata')).toContain('pluginType=GEMINI')
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>
    expect(body.metadata).toMatchObject({ pluginType: 'GEMINI' })
  })

  it('requires GOOGLE_CLOUD_PROJECT when the account names no project', async () => {
    const respond = () => json({ currentTier: { id: 'standard-tier' } })
    await expect(
      discoverGoogleProject(GOOGLE_GEMINI_CLI_FACTS, 'a', { fetch: stubFetch(respond).fetch, env: {} }),
    ).rejects.toThrowError(/GOOGLE_CLOUD_PROJECT/)

    await expect(
      discoverGoogleProject(GOOGLE_GEMINI_CLI_FACTS, 'a', {
        fetch: stubFetch(respond).fetch,
        env: { GOOGLE_CLOUD_PROJECT: 'from-env' },
      }),
    ).resolves.toBe('from-env')
  })

  it('provisions a free-tier project and polls the operation to completion', async () => {
    const answers = [
      json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      json({ name: 'operations/onboard-1', done: false }),
      json({ done: false }),
      json({ done: true, response: { cloudaicompanionProject: { id: 'provisioned-project' } } }),
    ]
    const stub = stubFetch(() => {
      const answer = answers.shift()
      if (answer === undefined) throw new Error('the discovery script made an unexpected call')
      return answer
    })
    const sleeps: number[] = []

    await expect(
      discoverGoogleProject(GOOGLE_GEMINI_CLI_FACTS, 'access-1', {
        fetch: stub.fetch,
        env: {},
        sleep: async ms => {
          sleeps.push(ms)
        },
        now: () => NOW,
      }),
    ).resolves.toBe('provisioned-project')

    expect(stub.calls.map(call => call.url)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://cloudcode-pa.googleapis.com/v1internal:onboardUser',
      'https://cloudcode-pa.googleapis.com/v1internal/operations/onboard-1',
      'https://cloudcode-pa.googleapis.com/v1internal/operations/onboard-1',
    ])
    const onboardBody = JSON.parse(String(stub.calls[1]?.init?.body)) as Record<string, unknown>
    expect(onboardBody.tierId).toBe('free-tier')
    expect(sleeps).toEqual([5000])
  })

  it('runs the Antigravity script: status, onboarding, then the project re-read', async () => {
    const answers = [
      json({}),
      json({ name: 'operations/antigravity-1', done: false }),
      json({ done: true, response: { cloudaicompanionProject: 'x' } }),
      json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'antigravity-project' }),
    ]
    const stub = stubFetch(() => {
      const answer = answers.shift()
      if (answer === undefined) throw new Error('the discovery script made an unexpected call')
      return answer
    })

    await expect(
      discoverGoogleProject(GOOGLE_ANTIGRAVITY_FACTS, 'access-1', {
        fetch: stub.fetch,
        sleep: async () => {},
      }),
    ).resolves.toBe('antigravity-project')

    expect(stub.calls.map(call => call.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
      'https://daily-cloudcode-pa.googleapis.com/v1internal/operations/antigravity-1',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ])
    const headers = new Headers(stub.calls[0]?.init?.headers)
    expect(headers.get('user-agent')).toContain('antigravity/hub/')
    expect(headers.has('client-metadata')).toBe(false)
    const onboardBody = JSON.parse(String(stub.calls[1]?.init?.body)) as Record<string, unknown>
    expect(onboardBody).toMatchObject({ tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } })
  })

  it('refuses an Antigravity account whose free tier is unavailable', async () => {
    const stub = stubFetch(() =>
      json({
        ineligibleTiers: [
          { tierId: 'free-tier', reasonMessage: 'not eligible in this country', validationUrl: 'https://example.com' },
        ],
      }),
    )
    await expect(
      discoverGoogleProject(GOOGLE_ANTIGRAVITY_FACTS, 'a', { fetch: stub.fetch }),
    ).rejects.toThrowError(/not eligible in this country/)
  })

  it('names the allowed tiers when the free tier is absent from the allow-list', async () => {
    // No ineligible reason is spelled out, but onboarding a tier the account may
    // not use is a wasted provisioning call; the error says what is on offer.
    const stub = stubFetch(() => json({ allowedTiers: [{ id: 'legacy-tier' }, { id: 'standard-tier' }] }))
    await expect(
      discoverGoogleProject(GOOGLE_ANTIGRAVITY_FACTS, 'a', { fetch: stub.fetch }),
    ).rejects.toThrowError(/allowed tiers do not include free-tier \(allowed: legacy-tier, standard-tier\)/)
    // Nothing was provisioned.
    expect(stub.calls.every(call => !call.url.includes('onboardUser'))).toBe(true)
  })
})

describe('google login', () => {
  /** A prompt that only settles when the flow withdraws it, as a live dialog would. */
  function withdrawnPrompt(): (signal: AbortSignal) => Promise<string> {
    return signal =>
      new Promise<string>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new GoogleAuthError('cancelled'))
          return
        }
        signal.addEventListener('abort', () => reject(new GoogleAuthError('cancelled')), { once: true })
      })
  }

  it('completes from the loopback listener and withdraws the paste prompt', async () => {
    const stub = stubFetch(url => {
      if (url.includes('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
      if (url.includes('userinfo')) return json({ email: 'human@example.com' })
      return json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-1' })
    })

    let authorizeUrl = ''
    let promptedSignal: AbortSignal | undefined
    const login = loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
      fetch: stub.fetch,
      state: 'state-1',
      port: 0,
      now: () => NOW,
      onAuthUrl: url => {
        authorizeUrl = url
      },
      prompt: signal => {
        promptedSignal = signal
        return withdrawnPrompt()(signal)
      },
    })

    // The authorize page advertises the port the listener actually got; poll for
    // it rather than sleeping a fixed amount and racing a slow bind.
    const advertised = await waitFor(() => authorizeUrl)
    const redirectUri = new URL(advertised).searchParams.get('redirect_uri')
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/)

    await fetch(`${redirectUri}?code=code-1&state=state-1`)
    await expect(login).resolves.toEqual({
      access: 'a',
      refresh: 'r',
      expires: NOW + 3600_000 - SKEW_MS,
      email: 'human@example.com',
      projectId: 'project-1',
    })
    expect(promptedSignal?.aborted).toBe(true)
    // The exchange used the same redirect URI the browser came back on.
    expect(formOf(stub.calls.find(call => call.url.includes('/token'))).get('redirect_uri')).toBe(redirectUri)
  })

  it('completes from a pasted callback when the browser cannot reach the loopback', async () => {
    const stub = stubFetch(url => {
      if (url.includes('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 60 })
      if (url.includes('userinfo')) return json({})
      return json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-2' })
    })

    const result = await loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
      fetch: stub.fetch,
      state: 'state-1',
      port: 0,
      now: () => NOW,
      prompt: async () => 'http://127.0.0.1:8085/oauth2callback?code=code-2&state=state-1',
    })

    expect(result).toMatchObject({ access: 'a', projectId: 'project-2' })
    expect(result.email).toBeUndefined()
  })

  it('refuses a pasted redirect that carries an OAuth error', async () => {
    await expect(
      loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
        state: 'state-1',
        port: 0,
        prompt: async () => 'http://127.0.0.1:8085/oauth2callback?error=access_denied&code=c&state=state-1',
      }),
    ).rejects.toThrowError(/Google refused the sign-in: access_denied/)
  })

  it('refuses a pasted bare code, which carries no state', async () => {
    await expect(
      loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
        state: 'state-1',
        port: 0,
        prompt: async () => 'code-without-state',
      }),
    ).rejects.toThrowError(/carries no state/)
  })

  it('refuses a pasted callback that carries another attempt’s state', async () => {
    await expect(
      loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
        state: 'state-1',
        port: 0,
        prompt: async () => 'http://127.0.0.1:8085/oauth2callback?code=c&state=other',
      }),
    ).rejects.toThrowError(/state does not match/)
  })

  it('gives up on a silent browser, closing the socket and committing nothing', async () => {
    const stub = stubFetch(() => json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'p' }))
    let redirectUri = ''
    const committed: unknown[] = []
    const flow = googleGeminiCliAuthorizationFlow({
      fetch: stub.fetch,
      port: 0,
      state: 'state-1',
      // A browser that never returns is the normal failure: the human closed the
      // tab, or refused consent and walked away.
      waitMs: 40,
    })

    await expect(
      flow.run({
        method: 'oauth',
        signal: new AbortController().signal,
        notify: notice => {
          redirectUri = notice.url === undefined ? redirectUri : new URL(notice.url).searchParams.get('redirect_uri') ?? ''
        },
        prompt: () => new Promise<string>(() => {}),
        commit: async record => {
          committed.push(record)
        },
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: expect.stringMatching(/no browser callback arrived within \d+s; start the sign-in again/),
    })

    expect(committed).toEqual([])
    // The bound is enforced by closing the listener, not by leaking the socket.
    await expect(fetch(`${redirectUri}?code=c&state=state-1`)).rejects.toThrow()
  })

  it('closes the loopback socket when the paste wins', async () => {
    const stub = stubFetch(url => {
      if (url.includes('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 60 })
      if (url.includes('userinfo')) return json({})
      return json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-3' })
    })
    let redirectUri = ''
    await loginGoogle(GOOGLE_GEMINI_CLI_FACTS, {
      fetch: stub.fetch,
      state: 'state-1',
      port: 0,
      onAuthUrl: url => {
        redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
      },
      prompt: async () => 'c#state-1',
    })

    // Nothing keeps listening on the port the authorize page named.
    await expect(fetch(`${redirectUri}?code=c&state=state-1`)).rejects.toThrow()
  })
})

describe('google credential resolver', () => {
  const fresh = (): GoogleGrantPayload => ({
    access: 'stored-access',
    refresh: 'stored-refresh',
    expires: NOW + 3600_000,
    projectId: 'project-1',
    email: 'human@example.com',
  })

  it('serves the structured envelope without touching the write path', async () => {
    const store = fakeStore(grantRecord(fresh()))
    const access = createGoogleAccess(store.credentials, GOOGLE_GEMINI_CLI_FACTS, { now: () => NOW })

    const envelope = JSON.parse(await access()) as Record<string, unknown>
    expect(envelope).toEqual({
      token: 'stored-access',
      projectId: 'project-1',
      refreshToken: 'stored-refresh',
      expiresAt: NOW + 3600_000,
      email: 'human@example.com',
    })
    expect(store.writes()).toBe(0)
  })

  it('refreshes inside the 60 s window, once, and keeps the project', async () => {
    const expiring = { ...fresh(), access: 'old', expires: NOW + 59_000, projectId: 'project-1' }
    const store = fakeStore(grantRecord(expiring))
    const stub = stubFetch(() => json({ access_token: 'new', expires_in: 3600 }))
    const access = createGoogleAccess(store.credentials, GOOGLE_GEMINI_CLI_FACTS, {
      now: () => NOW,
      fetch: stub.fetch,
    })

    const envelope = JSON.parse(await access()) as Record<string, unknown>
    expect(envelope).toMatchObject({ token: 'new', projectId: 'project-1', expiresAt: NOW + 3600_000 - SKEW_MS })
    // A refresh that does not rotate the token keeps the stored one.
    expect(envelope.refreshToken).toBe('stored-refresh')
    expect(store.writes()).toBe(1)
  })

  it('leaves a grant another writer refreshed while it waited for the lock', async () => {
    let record: StoredCredentialRecord | undefined = grantRecord({ ...fresh(), expires: NOW - 1 })
    const store: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        // The competing writer commits between this turn's read and its lock.
        record = grantRecord(fresh())
        return (await mutate(record)) ?? record
      },
    }
    const stub = stubFetch(() => json({ access_token: 'new', expires_in: 3600 }))

    const envelope = JSON.parse(
      await createGoogleAccess(store, GOOGLE_GEMINI_CLI_FACTS, { now: () => NOW, fetch: stub.fetch })(),
    ) as Record<string, unknown>
    expect(envelope.token).toBe('stored-access')
    expect(stub.calls).toHaveLength(0)
  })

  it('commits a rotated refresh token even when the turn is cancelled mid-refresh', async () => {
    const controller = new AbortController()
    let record: StoredCredentialRecord | undefined = grantRecord({ ...fresh(), expires: NOW - 1 })
    const store: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        record = (await mutate(record)) ?? record
        return record
      },
    }
    const stub = stubFetch(() => {
      // The caller goes away while the exchange is in flight.
      controller.abort()
      return json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 })
    })

    await expect(
      createGoogleAccess(store, GOOGLE_GEMINI_CLI_FACTS, { now: () => NOW, fetch: stub.fetch })(controller.signal),
    ).rejects.toThrow()

    // Losing the rotated token with the turn would force a new sign-in.
    expect(record?.kind === 'grant' ? record.payload : undefined).toMatchObject({
      access: 'new',
      refresh: 'rotated',
      projectId: 'project-1',
    })
  })

  it('reports a grant without a refresh token as a dead sign-in', async () => {
    const store = fakeStore(grantRecord({ access: 'a', expires: NOW - 1, projectId: 'p' }))
    await expect(
      createGoogleAccess(store.credentials, GOOGLE_GEMINI_CLI_FACTS, { now: () => NOW })(),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' })
  })

  it('reports a rejected refresh as REAUTH_REQUIRED rather than a retryable failure', async () => {
    const store = fakeStore(grantRecord({ ...fresh(), expires: NOW - 1 }))
    const stub = stubFetch(() => json({ error: 'invalid_grant' }, 400))
    await expect(
      createGoogleAccess(store.credentials, GOOGLE_GEMINI_CLI_FACTS, { now: () => NOW, fetch: stub.fetch })(),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' })
  })

  it('reports a missing record as MISSING_CREDENTIAL, naming the route', async () => {
    const store = fakeStore(undefined)
    await expect(
      createGoogleAccess(store.credentials, GOOGLE_ANTIGRAVITY_FACTS, { now: () => NOW })(),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('keeps the two routes’ records apart and rejects a payload without a project', () => {
    expect(GOOGLE_GEMINI_CLI_CREDENTIAL_KEY).toBe('llm-omp-transports/google-gemini-cli')
    expect(GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY).toBe('llm-omp-transports/google-antigravity')
    // The adapter registered by the next task reads the same key the flow writes.
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.credentialKey).toBe(GOOGLE_GEMINI_CLI_CREDENTIAL_KEY)
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.credentialKey).toBe(GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY)
    expect(readGoogleGrant(grantRecord({ access: 'a', expires: NOW, projectId: '' }))).toBeUndefined()
    expect(readGoogleGrant({ kind: 'api-key', key: 'k' })).toBeUndefined()
  })
})

describe('google authorization flows', () => {
  it('registers one flow per route over the same factory', () => {
    const gemini = googleGeminiCliAuthorizationFlow()
    const antigravity = googleAntigravityAuthorizationFlow()

    expect(gemini.key).toBe(GOOGLE_GEMINI_CLI_CREDENTIAL_KEY)
    expect(gemini.label).toBe('Google Gemini CLI')
    expect(gemini.methods).toEqual([{ id: 'oauth', label: 'Sign in with Google Gemini CLI' }])
    expect(antigravity.key).toBe(GOOGLE_ANTIGRAVITY_CREDENTIAL_KEY)
    expect(antigravity.label).toBe('Google Antigravity')
  })

  it('commits the grant with its project, and the email only when userinfo named one', async () => {
    const stub = stubFetch(url => {
      if (url.includes('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
      if (url.includes('userinfo')) return json({ email: 'human@example.com' })
      return json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-1' })
    })
    const committed: Record<string, unknown>[] = []
    const prompts: AuthorizationPrompt[] = []
    const notices: { message: string; url?: string }[] = []

    const flow = googleGeminiCliAuthorizationFlow({ fetch: stub.fetch, port: 0, now: () => NOW, state: 'state-1' })
    await flow.run({
      method: 'oauth',
      signal: new AbortController().signal,
      notify: notice => notices.push(notice),
      prompt: async prompt => {
        prompts.push(prompt)
        return 'code-from-paste#state-1'
      },
      commit: async record => {
        committed.push(record.payload as Record<string, unknown>)
      },
    })

    expect(notices[0]?.url).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(prompts[0]).toMatchObject({ kind: 'manual-code' })
    expect(committed).toEqual([
      {
        access: 'a',
        refresh: 'r',
        expires: NOW + 3600_000 - SKEW_MS,
        projectId: 'project-1',
        email: 'human@example.com',
      },
    ])
  })

  it('maps a failed sign-in onto AUTH_FAILED with the route’s label', async () => {
    const stub = stubFetch(() => json({ error: 'invalid_grant' }, 400))
    const flow = googleAntigravityAuthorizationFlow({ fetch: stub.fetch, port: 0 })

    await expect(
      flow.run({
        method: 'oauth',
        signal: new AbortController().signal,
        notify: () => {},
        prompt: async () => 'c#state-1',
        commit: async () => {
          throw new Error('a failed sign-in must not commit')
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })
})
