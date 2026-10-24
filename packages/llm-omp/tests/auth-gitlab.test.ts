/**
 * GitLab Duo agent sign-in and credential resolution — offline.
 *
 * The flow copies the pinned rule: PKCE S256, the `api` scope, GitLab's VS Code
 * OAuth client and a **manual-only** `vscode://` callback (no listener, the human
 * pastes the URL), with the `expires_in`/`created_at` arithmetic and the 5-minute
 * skew. The resolver is Cursor-shaped, and its one route-specific obligation is
 * that a refresh **echoes the `vscode` redirect** — the rule's `refresh` params
 * declare it, and GitLab rejects a refresh without it.
 *
 * Every network call is a stubbed `fetch`, so the bodies are exact assertions.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { StoredCredentialRecord } from '../src/cursor/credentials.js'
import {
  GITLAB_DUO_AGENT_AUTH,
  GitLabAuthError,
  exchangeGitLabCode,
  generateGitLabAuthParams,
  loginGitLab,
  parseGitLabCallback,
  refreshGitLabToken,
} from '../src/gitlab/auth.js'
import type { GitLabFetch } from '../src/gitlab/auth.js'
import {
  GITLAB_DUO_AGENT_CREDENTIAL_KEY,
  createGitLabDuoAgentAccess,
  readGitLabGrant,
} from '../src/gitlab/credentials.js'
import { gitlabDuoAgentAuthorizationFlow } from '../src/index.js'
import type { CredentialRecordsLike } from '../src/cursor/credentials.js'

const NOW = 1_700_000_000_000

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetch: GitLabFetch
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

const now = (): number => NOW

describe('gitlab authorize params', () => {
  it('mints PKCE and the rule’s parameters, including the vscode redirect', () => {
    const params = generateGitLabAuthParams({ state: 'state-1', verifier: 'verifier-1' })
    const url = new URL(params.authorizeUrl)

    expect(`${url.origin}${url.pathname}`).toBe(GITLAB_DUO_AGENT_AUTH.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(GITLAB_DUO_AGENT_AUTH.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe('vscode://gitlab.gitlab-workflow/authentication')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('api')
    expect(url.searchParams.get('state')).toBe('state-1')
    // `pkce #true`: the challenge is the S256 digest of the verifier.
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update('verifier-1').digest('base64url'),
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('mints a random state and verifier when none is supplied', () => {
    const first = generateGitLabAuthParams()
    const second = generateGitLabAuthParams()

    expect(first.state).not.toBe(second.state)
    expect(first.verifier).not.toBe(second.verifier)
  })
})

describe('parseGitLabCallback', () => {
  it('reads the code and state out of a vscode:// callback', () => {
    expect(parseGitLabCallback('vscode://gitlab.gitlab-workflow/authentication?code=abc&state=s1')).toEqual({
      code: 'abc',
      state: 's1',
    })
  })

  it('accepts a bare code with an optional #state', () => {
    expect(parseGitLabCallback('abc')).toEqual({ code: 'abc' })
    expect(parseGitLabCallback('abc#s1')).toEqual({ code: 'abc', state: 's1' })
  })

  it('refuses an empty paste and one without a code', () => {
    expect(() => parseGitLabCallback('  ')).toThrowError(GitLabAuthError)
    expect(() => parseGitLabCallback('vscode://gitlab.gitlab-workflow/authentication?state=s1')).toThrowError(
      /names no code/,
    )
  })
})

describe('gitlab token exchange', () => {
  it('posts the rule body with the vscode redirect and derives expiry from created_at', async () => {
    const { fetch, calls } = stubFetch(() =>
      json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 7200,
        created_at: 1_699_999_000,
        email: 'human@example.com',
      }),
    )

    const grant = await exchangeGitLabCode('code-1', 'verifier-1', { fetch, now })

    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect(calls[0]!.url).toBe(GITLAB_DUO_AGENT_AUTH.tokenUrl)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(GITLAB_DUO_AGENT_AUTH.clientId)
    expect(body.get('code')).toBe('code-1')
    expect(body.get('code_verifier')).toBe('verifier-1')
    expect(body.get('redirect_uri')).toBe('vscode://gitlab.gitlab-workflow/authentication')
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe('application/json')

    // `expires "seconds" path=expires_in from=created_at skew-ms=300000`.
    expect(grant).toEqual({
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 1_699_999_000_000 + 7_200_000 - 5 * 60 * 1000,
      email: 'human@example.com',
    })
  })

  it('falls back to an hour when the body names no expiry', async () => {
    const { fetch } = stubFetch(() => json({ access_token: 'a', refresh_token: 'r' }))

    const grant = await exchangeGitLabCode('c', 'v', { fetch, now })

    expect(grant.expires).toBe(NOW + 3_600_000)
  })

  it('refuses a non-2xx answer and a body missing a token or a refresh token', async () => {
    const rejected = stubFetch(() => json({ error_description: 'invalid_grant' }, 400))
    await expect(exchangeGitLabCode('c', 'v', { fetch: rejected.fetch })).rejects.toThrowError(/invalid_grant/)

    const noAccess = stubFetch(() => json({ refresh_token: 'r' }))
    await expect(exchangeGitLabCode('c', 'v', { fetch: noAccess.fetch })).rejects.toThrowError(/no access token/)

    const noRefresh = stubFetch(() => json({ access_token: 'a' }))
    await expect(exchangeGitLabCode('c', 'v', { fetch: noRefresh.fetch })).rejects.toThrowError(/no refresh token/)
  })

  it('echoes the vscode redirect_uri on refresh (the rule’s params block)', async () => {
    const { fetch, calls } = stubFetch(() => json({ access_token: 'new', expires_in: 3600, created_at: 1_700_000_000 }))

    const grant = await refreshGitLabToken('refresh-1', { fetch, now })

    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-1')
    // Without this GitLab rejects the refresh: it is the route's one delta.
    expect(body.get('redirect_uri')).toBe('vscode://gitlab.gitlab-workflow/authentication')
    // A refresh that does not rotate the token keeps the stored one.
    expect(grant.refresh).toBe('refresh-1')
    expect(grant.access).toBe('new')
  })
})

describe('gitlab login', () => {
  it('notifies the authorize page and exchanges the pasted callback', async () => {
    const { fetch } = stubFetch(() => json({ access_token: 'a', refresh_token: 'r' }))
    const params = generateGitLabAuthParams({ state: 'state-1', verifier: 'verifier-1' })
    const urls: string[] = []

    const grant = await loginGitLab({
      fetch,
      now,
      state: params.state,
      verifier: params.verifier,
      onAuthUrl: url => urls.push(url),
      prompt: async () =>
        `vscode://gitlab.gitlab-workflow/authentication?code=code-1&state=${encodeURIComponent('state-1')}`,
    })

    expect(urls).toHaveLength(1)
    expect(grant.access).toBe('a')
  })

  it('refuses a paste with no state, and one from another attempt', async () => {
    await expect(
      loginGitLab({ state: 'state-1', verifier: 'v', prompt: async () => 'bare-code' }),
    ).rejects.toThrowError(/carries no state/)

    await expect(
      loginGitLab({
        state: 'state-1',
        verifier: 'v',
        prompt: async () => 'vscode://gitlab.gitlab-workflow/authentication?code=c&state=other',
      }),
    ).rejects.toThrowError(/state does not match/)
  })
})

describe('gitlab credential resolver', () => {
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
    payload: { access: 'stored-access', refresh: 'stored-refresh', expires: NOW + 3_600_000, ...overrides },
  })

  it('serves a fresh grant without touching the write path', async () => {
    const handle = store(fresh())

    expect(await createGitLabDuoAgentAccess(handle.credentials, { now })()).toBe('stored-access')
    expect(handle.writes()).toBe(0)
  })

  it('refreshes inside the window, once, echoing the redirect', async () => {
    const handle = store(fresh({ expires: NOW + 30_000 }))
    const { fetch, calls } = stubFetch(() => json({ access_token: 'new', refresh_token: 'rotated' }))

    expect(await createGitLabDuoAgentAccess(handle.credentials, { now, fetch })()).toBe('new')
    expect(handle.writes()).toBe(1)
    expect(new URLSearchParams(String(calls[0]!.init?.body)).get('redirect_uri')).toBe(
      'vscode://gitlab.gitlab-workflow/authentication',
    )
    expect(readGitLabGrant(handle.record())).toMatchObject({ access: 'new', refresh: 'rotated' })
  })

  it('skips the refresh when another writer already renewed the record', async () => {
    let record: StoredCredentialRecord | undefined = fresh({ expires: NOW - 1 })
    const credentials: CredentialRecordsLike = {
      readRecord: async () => record,
      modifyRecord: async (_key, mutate) => {
        record = fresh()
        return (await mutate(record)) ?? record
      },
    }
    const { fetch, calls } = stubFetch(() => json({ access_token: 'new' }))

    expect(await createGitLabDuoAgentAccess(credentials, { now, fetch })()).toBe('stored-access')
    expect(calls).toEqual([])
  })

  it('reports a grant without a refresh token, a rejected refresh and a missing record', async () => {
    const noRefresh = store({ kind: 'grant', payload: { access: 'a', expires: NOW - 1 } })
    await expect(createGitLabDuoAgentAccess(noRefresh.credentials, { now })()).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })

    const rejected = store(fresh({ expires: NOW - 1 }))
    const { fetch } = stubFetch(() => json({ error: 'invalid_grant' }, 400))
    await expect(createGitLabDuoAgentAccess(rejected.credentials, { now, fetch })()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })

    const missing = store(undefined)
    await expect(createGitLabDuoAgentAccess(missing.credentials, { now })()).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
      message: expect.stringContaining(GITLAB_DUO_AGENT_CREDENTIAL_KEY),
    })
  })

  it('commits a rotated token even when the turn is cancelled mid-refresh', async () => {
    const controller = new AbortController()
    const handle = store(fresh({ expires: NOW - 1 }))
    const { fetch } = stubFetch(() => {
      controller.abort()
      return json({ access_token: 'new', refresh_token: 'rotated' })
    })

    await expect(
      createGitLabDuoAgentAccess(handle.credentials, { now, fetch })(controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(readGitLabGrant(handle.record())).toMatchObject({ access: 'new', refresh: 'rotated' })
  })
})

describe('gitlab authorization flow', () => {
  function fakeSession(): {
    session: {
      method: string
      signal: AbortSignal
      notify: (notice: { message: string; url?: string; code?: string }) => void
      prompt: (prompt: { kind: string; message: string; placeholder?: string }) => Promise<string>
      commit: (record: { kind: 'grant'; payload: unknown }) => Promise<void>
    }
    notices: { message: string; url?: string }[]
    prompts: { kind: string; message: string; placeholder?: string }[]
    committed: { kind: string; payload: Record<string, unknown> }[]
  } {
    const notices: { message: string; url?: string }[] = []
    const prompts: { kind: string; message: string; placeholder?: string }[] = []
    const committed: { kind: string; payload: Record<string, unknown> }[] = []
    return {
      notices,
      prompts,
      committed,
      session: {
        method: 'oauth',
        signal: new AbortController().signal,
        notify: notice => notices.push(notice),
        prompt: async prompt => {
          prompts.push(prompt)
          return 'bare-code'
        },
        commit: async record => {
          committed.push({ kind: record.kind, payload: record.payload as Record<string, unknown> })
        },
      },
    }
  }

  it('notifies the page, asks for a masked paste, and maps a bare code to AUTH_FAILED', async () => {
    const { session, notices, prompts, committed } = fakeSession()

    // A bare code carries no state, and this route has no listener to fall back on.
    await expect(gitlabDuoAgentAuthorizationFlow({ state: 's', verifier: 'v' }).run(session)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]!.url).toContain('gitlab.com/oauth/authorize')
    expect(prompts[0]!.kind).toBe('manual-code')
    expect(prompts[0]!.placeholder).toContain('vscode://gitlab.gitlab-workflow/authentication')
    expect(committed).toEqual([])
  })

  it('commits the documented payload when the full callback is pasted', async () => {
    const { fetch } = stubFetch(() =>
      json({ access_token: 'a', refresh_token: 'r', email: 'human@example.com', expires_in: 3600, created_at: 1_700_000_000 }),
    )
    const committed: { kind: string; payload: Record<string, unknown> }[] = []
    const session = {
      method: 'oauth',
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async () => 'vscode://gitlab.gitlab-workflow/authentication?code=c&state=state-1',
      commit: async (record: { kind: 'grant'; payload: unknown }) => {
        committed.push({ kind: record.kind, payload: record.payload as Record<string, unknown> })
      },
    }

    await gitlabDuoAgentAuthorizationFlow({ fetch, state: 'state-1', verifier: 'v', now }).run(session)

    expect(committed).toEqual([
      {
        kind: 'grant',
        payload: {
          access: 'a',
          refresh: 'r',
          expires: NOW + 3_600_000 - 5 * 60 * 1000,
          email: 'human@example.com',
        },
      },
    ])
  })

  it('names the route on its flow entry and pins the copied facts', () => {
    const flow = gitlabDuoAgentAuthorizationFlow()

    expect(flow.key).toBe(GITLAB_DUO_AGENT_CREDENTIAL_KEY)
    expect(flow.label).toBe('GitLab Duo Agent')
    expect(flow.methods).toEqual([{ id: 'oauth', label: 'Sign in with GitLab Duo Agent' }])
    expect(GITLAB_DUO_AGENT_AUTH.redirectUri).toBe('vscode://gitlab.gitlab-workflow/authentication')
  })
})
