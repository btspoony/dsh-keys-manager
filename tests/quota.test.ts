import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from '../src/quota/model'
import {
  fractionFromRemaining,
  fractionFromUsed,
  resetFrom,
  resetFromIso,
  resetFromMs,
  resetFromSeconds,
} from '../src/quota/model'
import { QuotaCache } from '../src/quota/cache'
import type { QuotaFetch } from '../src/quota/fetch'
import { claudeQuotaProbe, codexQuotaProbe, quotaProbe, resolveQuota } from '../src/quota/providers'

const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage'

interface Captured {
  url?: string
  headers?: Record<string, string>
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Fake fetch that records the request; every test stays offline. */
function fakeFetch(respond: Response | (() => Promise<Response>), captured: Captured = {}): QuotaFetch {
  const impl = async (input: Parameters<QuotaFetch>[0], init?: Parameters<QuotaFetch>[1]) => {
    captured.url = String(input)
    captured.headers = init?.headers as Record<string, string> | undefined
    return typeof respond === 'function' ? respond() : respond
  }
  return impl as QuotaFetch
}

const SESSION: QuotaWindow = { id: 'session', usedFraction: 0.25, resetsAt: 1_800_000_000_000 }
const WEEK: QuotaWindow = { id: 'week', usedFraction: 0.5, resetsAt: 1_800_600_000_000 }

function okSnapshot(windows: QuotaWindow[] = [SESSION]): QuotaSnapshot {
  return { status: 'ok', fetchedAt: 0, windows }
}

function failing(status: QuotaStatus, reason = 'boom'): () => Promise<QuotaSnapshot> {
  return async () => ({ status, fetchedAt: 0, windows: [], reason })
}

function near(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`)
}

test('fraction normalizers invert used and remaining percentages', () => {
  assert.equal(fractionFromUsed(0), 0)
  near(fractionFromUsed(32), 0.32)
  assert.equal(fractionFromUsed(100), 1)
  assert.equal(fractionFromUsed(140), 1)
  assert.equal(fractionFromUsed(Number.NaN), undefined)

  assert.equal(fractionFromRemaining(100), 0)
  near(fractionFromRemaining(58), 0.42)
  assert.equal(fractionFromRemaining(0), 1)
  assert.equal(fractionFromRemaining(-20), 1)
})

test('reset normalizers accept epoch seconds, epoch milliseconds and ISO strings', () => {
  assert.equal(resetFromSeconds(1_700_000_000), 1_700_000_000_000)
  assert.equal(resetFromMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(resetFromIso('2023-11-14T22:13:20.000Z'), 1_700_000_000_000)
  assert.equal(resetFromIso('not a date'), undefined)

  assert.equal(resetFrom(1_700_000_000), 1_700_000_000_000)
  assert.equal(resetFrom(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(resetFrom('2023-11-14T22:13:20.000Z'), 1_700_000_000_000)
  assert.equal(resetFrom(undefined), undefined)
  assert.equal(resetFrom({}), undefined)
})

test('claude probe maps five_hour to session and seven_day to week', async () => {
  const captured: Captured = {}
  const snapshot = await claudeQuotaProbe({
    token: 'tok-1',
    fetch: fakeFetch(
      jsonResponse(200, {
        five_hour: { utilization: 32, resets_at: '2023-11-14T23:00:00.000Z' },
        seven_day: { utilization: 71.5, resets_at: '2023-11-20T00:00:00.000Z' },
      }),
      captured,
    ),
  })

  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.32)
  assert.equal(session.resetsAt, Date.parse('2023-11-14T23:00:00.000Z'))
  near(week.usedFraction, 0.715)
  assert.equal(week.resetsAt, Date.parse('2023-11-20T00:00:00.000Z'))

  assert.equal(captured.url, CLAUDE_URL)
  assert.equal(captured.headers?.Authorization, 'Bearer tok-1')
  assert.equal(captured.headers?.['anthropic-beta'], 'oauth-2025-04-20')
})

test('claude probe classifies http failures instead of throwing', async () => {
  const cases: Array<[number, QuotaStatus]> = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'absent'],
    [429, 'error'],
    [500, 'error'],
  ]
  for (const [status, expected] of cases) {
    const snapshot = await claudeQuotaProbe({ token: 'tok', fetch: fakeFetch(jsonResponse(status, {})) })
    assert.equal(snapshot.status, expected, `http ${status}`)
  }
})

test('claude probe degrades network, parse and payload failures to error', async () => {
  const network = await claudeQuotaProbe({
    token: 'tok',
    fetch: (async () => {
      throw new Error('boom')
    }) as QuotaFetch,
  })
  assert.equal(network.status, 'error')

  const parse = await claudeQuotaProbe({ token: 'tok', fetch: fakeFetch(new Response('nope', { status: 200 })) })
  assert.equal(parse.status, 'error')

  const payload = await claudeQuotaProbe({ token: 'tok', fetch: fakeFetch(jsonResponse(200, { hello: 'world' })) })
  assert.equal(payload.status, 'error')
  assert.equal(payload.reason, 'unrecognized usage payload')
})

test('claude probe tolerates missing reset stamps and partial windows', async () => {
  const snapshot = await claudeQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(jsonResponse(200, { five_hour: { utilization: 10 } })),
  })
  assert.equal(snapshot.status, 'error')
  const withWeekOnly = await claudeQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(
      jsonResponse(200, {
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20, resets_at: '2023-11-20T00:00:00.000Z' },
      }),
    ),
  })
  assert.equal(withWeekOnly.status, 'ok')
  assert.deepEqual(
    withWeekOnly.windows.map((window) => window.id),
    ['week'],
  )
})

test('codex probe classifies windows by limit_window_seconds', async () => {
  const captured: Captured = {}
  const snapshot = await codexQuotaProbe({
    token: 'tok-2',
    accountId: 'acct-9',
    fetch: fakeFetch(
      jsonResponse(200, {
        rate_limit: {
          primary_window: { used_percent: 45, limit_window_seconds: 18000, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 80, limit_window_seconds: 604800, resets_at: 1_700_600_000 },
        },
      }),
      captured,
    ),
  })

  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.45)
  assert.equal(session.resetsAt, 1_700_000_000_000)
  near(week.usedFraction, 0.8)
  assert.equal(week.resetsAt, 1_700_600_000_000)

  assert.equal(captured.url, CODEX_URL)
  assert.equal(captured.headers?.Authorization, 'Bearer tok-2')
  assert.equal(captured.headers?.['chatgpt-account-id'], 'acct-9')
})

test('codex probe reads duration before slot name and omits a missing account header', async () => {
  const captured: Captured = {}
  const snapshot = await codexQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(
      jsonResponse(200, {
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1_700_100_000 },
        },
      }),
      captured,
    ),
  })
  assert.deepEqual(
    snapshot.windows.map((window) => window.id),
    ['week', 'session'],
  )
  assert.equal(captured.headers?.['chatgpt-account-id'], undefined)
})

test('codex probe derives the reset time from reset_after_seconds', async () => {
  const before = Date.now()
  const snapshot = await codexQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(
      jsonResponse(200, {
        rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 } },
      }),
    ),
  })
  const reset = snapshot.windows[0]?.resetsAt
  assert.ok(reset !== undefined)
  assert.ok(reset >= before + 3_600_000 && reset <= Date.now() + 3_600_000 + 1_000)
})

test('unknown route ids have no probe and resolve to absent', async () => {
  assert.equal(quotaProbe('kimi'), undefined)
  assert.notEqual(quotaProbe('claude'), undefined)
  const snapshot = await resolveQuota('kimi', { token: 'tok' })
  assert.equal(snapshot.status, 'absent')
  assert.deepEqual(snapshot.windows, [])
})

test('cache serves one snapshot for the whole TTL window', async () => {
  let now = 0
  const cache = new QuotaCache({ now: () => now, random: () => 0.5 })
  let calls = 0
  const load = async (): Promise<QuotaSnapshot> => {
    calls += 1
    return okSnapshot()
  }
  const first = await cache.get('claude', 'k1', load)
  assert.equal(first.stale, false)
  assert.equal(first.fetchedAt, 0)

  now = 299_999
  const second = await cache.get('claude', 'k1', load)
  assert.equal(calls, 1)
  assert.equal(second, first)

  now = 300_000
  await cache.get('claude', 'k1', load)
  assert.equal(calls, 2)
})

test('cache applies symmetric TTL jitter', async () => {
  const cases: Array<[() => number, number]> = [
    [() => 0, 225_000],
    [() => 1, 375_000],
  ]
  for (const [random, expiresAt] of cases) {
    let now = 0
    const cache = new QuotaCache({ now: () => now, random })
    let calls = 0
    const load = async (): Promise<QuotaSnapshot> => {
      calls += 1
      return okSnapshot()
    }
    await cache.get('claude', 'k', load)
    now = expiresAt - 1
    await cache.get('claude', 'k', load)
    assert.equal(calls, 1)
    now = expiresAt
    await cache.get('claude', 'k', load)
    assert.equal(calls, 2)
  }
})

test('cache backs off failures for 10 s and unauthorized for 60 s', async () => {
  const cases: Array<[QuotaStatus, number]> = [
    ['error', 10_000],
    ['absent', 10_000],
    ['unauthorized', 60_000],
  ]
  for (const [status, backoff] of cases) {
    let now = 0
    const cache = new QuotaCache({ now: () => now })
    let calls = 0
    const load = async (): Promise<QuotaSnapshot> => {
      calls += 1
      return { status, fetchedAt: 0, windows: [], reason: 'probe failed' }
    }
    const first = await cache.get('claude', 'k', load)
    assert.equal(first.status, status)
    now = backoff - 1
    await cache.get('claude', 'k', load)
    assert.equal(calls, 1, `${status} inside backoff`)
    now = backoff
    await cache.get('claude', 'k', load)
    assert.equal(calls, 2, `${status} after backoff`)
  }
})

test('cache single-flights concurrent loads per account', async () => {
  const cache = new QuotaCache({ now: () => 0 })
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const load = async (): Promise<QuotaSnapshot> => {
    calls += 1
    await gate
    return okSnapshot()
  }
  const first = cache.get('claude', 'a', load)
  const second = cache.get('claude', 'a', load)
  const other = cache.get('codex', 'a', load)
  release()
  const [one, two] = await Promise.all([first, second])
  assert.equal(calls, 2)
  assert.equal(one, two)
  await other
})

test('cache keeps last good data as stale through failures, then drops it after 24 h', async () => {
  let now = 0
  const cache = new QuotaCache({ now: () => now, random: () => 0.5 })
  const first = await cache.get('claude', 'k', async () => okSnapshot([WEEK]))
  assert.equal(first.stale, false)

  now = 86_400_000
  const stale = await cache.get('claude', 'k', failing('error'))
  assert.equal(stale.status, 'ok')
  assert.equal(stale.stale, true)
  assert.deepEqual(stale.windows, [WEEK])

  now = 86_410_000
  const gone = await cache.get('claude', 'k', failing('error'))
  assert.equal(gone.status, 'error')
  assert.equal(gone.stale, false)
})

test('cache turns a throwing loader into an error snapshot', async () => {
  const cache = new QuotaCache({ now: () => 0 })
  const served = await cache.get('claude', 'k', async () => {
    throw new Error('boom')
  })
  assert.equal(served.status, 'error')
  assert.equal(served.reason, 'boom')
})
