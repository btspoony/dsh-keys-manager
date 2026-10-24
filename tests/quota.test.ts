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
import {
  claudeQuotaProbe,
  codexQuotaProbe,
  commandcodeQuotaProbe,
  kimiQuotaProbe,
  minimaxQuotaProbe,
  opencodeGoQuotaProbe,
  quotaProbe,
  resolveQuota,
  xaiQuotaProbe,
  zaiQuotaProbe,
} from '../src/quota/providers'

const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage'
const COMMANDCODE_URL = 'https://api.commandcode.ai/alpha/billing/credits'
const XAI_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

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
  // A negative count is not "0% used": it yields no window at all.
  assert.equal(fractionFromUsed(-5), undefined)

  assert.equal(fractionFromRemaining(100), 0)
  near(fractionFromRemaining(58), 0.42)
  assert.equal(fractionFromRemaining(0), 1)
  assert.equal(fractionFromRemaining(-20), undefined)
  assert.equal(fractionFromRemaining(120), undefined)
})

test('a negative used count drops the window instead of rendering 0%', async () => {
  const rejected = await claudeQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(jsonResponse(200, { five_hour: { utilization: -5, resets_at: '2026-01-01T00:00:00.000Z' } })),
  })
  assert.equal(rejected.status, 'error')
  assert.deepEqual(rejected.windows, [])

  // The valid sibling window still renders.
  const partial = await claudeQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(
      jsonResponse(200, {
        five_hour: { utilization: -5, resets_at: '2026-01-01T00:00:00.000Z' },
        seven_day: { utilization: 20, resets_at: '2026-01-05T00:00:00.000Z' },
      }),
    ),
  })
  assert.equal(partial.status, 'ok')
  assert.deepEqual(partial.windows.map(window => window.id), ['week'])

  const zai = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(
      jsonResponse(200, {
        success: true,
        data: { limits: [{ type: 'TOKENS_LIMIT', percentage: -10, unit: 3, number: 5, nextResetTime: 1_700_000_000_000 }] },
      }),
    ),
  })
  assert.equal(zai.status, 'error')

  // remaining above the limit means the counters contradict each other.
  const minimax = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 100,
            current_interval_remaining_count: 130,
            end_time: 1_700_000_000_000,
          },
        ],
      }),
    ),
  })
  assert.equal(minimax.status, 'error')
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

test('zai probe sends the bare key and classifies windows by unit', async () => {
  const captured: Captured = {}
  const snapshot = await zaiQuotaProbe({
    token: 'zhipu-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 40, unit: 3, number: 5, nextResetTime: 1_700_000_000_000 },
            { type: 'TIME_LIMIT', percentage: 75, unit: 6, number: 1, nextResetTime: 1_700_600_000_000 },
            { type: 'TIME_LIMIT', percentage: 90, unit: 5, number: 1, nextResetTime: 1_700_900_000_000 },
          ],
        },
      }),
      captured,
    ),
  })

  assert.equal(captured.headers?.Authorization, 'zhipu-key')
  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.4)
  assert.equal(session.resetsAt, 1_700_000_000_000)
  near(week.usedFraction, 0.75)
  assert.deepEqual(
    snapshot.windows.map((window) => window.id),
    ['session', 'week'],
  )
})

test('zai probe prefers exact counters over the rounded percentage', async () => {
  const snapshot = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(
      jsonResponse(200, {
        success: true,
        data: {
          limits: [
            {
              type: 'CREDIT_LIMIT',
              percentage: 11,
              currentValue: 1438,
              usage: 12000,
              unit: 3,
              number: 5,
              nextResetTime: 1_700_000_000_000,
            },
          ],
        },
      }),
    ),
  })
  assert.equal(snapshot.status, 'ok')
  near(snapshot.windows[0]?.usedFraction, 1438 / 12000)
})

test('zai probe treats an explicit rejection or empty limits as error', async () => {
  const rejected = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(jsonResponse(200, { success: false, code: 401 })),
  })
  assert.equal(rejected.status, 'error')
  assert.equal(rejected.reason, 'usage request rejected')

  const noWindows = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(jsonResponse(200, { success: true, data: { limits: [{ unit: 5, percentage: 10 }] } })),
  })
  assert.equal(noWindows.status, 'error')
})

test('kimi probe reads string counters and classifies window durations', async () => {
  const captured: Captured = {}
  const snapshot = await kimiQuotaProbe({
    token: 'kimi-token',
    fetch: fakeFetch(
      jsonResponse(200, {
        usage: { limit: '1000', remaining: '250', resetTime: '2023-11-20T00:00:00.000Z' },
        limits: [
          { window: { duration: 300, time_unit: 'minute' }, detail: { limit: '100', remaining: '70', resetTime: 1_700_000_000 } },
          { window: { duration: 168, timeUnit: 'hour' }, detail: { limit: '1000', remaining: '900' } },
        ],
      }),
      captured,
    ),
  })

  assert.equal(captured.headers?.Authorization, 'Bearer kimi-token')
  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.3)
  assert.equal(session.resetsAt, 1_700_000_000_000)
  // The aggregate usage row (75% used) outrank the 168h limits row (10% used).
  near(week.usedFraction, 0.75)
  assert.equal(week.resetsAt, Date.parse('2023-11-20T00:00:00.000Z'))
})

test('minimax probe derives both windows from the plan buckets and keeps the tightest', async () => {
  const captured: Captured = {}
  const snapshot = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 100,
            current_interval_usage_count: 30,
            current_interval_remaining_count: 70,
            end_time: 1_700_000_000_000,
            remains_time: 3_600_000,
            current_weekly_total_count: 1000,
            current_weekly_usage_count: 400,
            weekly_end_time: 1_700_600_000_000,
          },
          {
            model_name: 'video',
            current_interval_total_count: 100,
            current_interval_usage_count: 80,
            current_interval_remaining_count: 20,
            end_time: 1_700_000_500_000,
            current_weekly_total_count: 1000,
            current_weekly_usage_count: 500,
            weekly_end_time: 1_700_600_500_000,
          },
        ],
      }),
      captured,
    ),
  })

  assert.equal(captured.headers?.Authorization, 'Bearer mm-key')
  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.8)
  assert.equal(session.resetsAt, 1_700_000_500_000)
  near(week.usedFraction, 0.5)
  assert.equal(week.resetsAt, 1_700_600_500_000)
})

test('minimax probe treats a non-zero base_resp as error and falls back to remains_time', async () => {
  const rejected = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(jsonResponse(200, { base_resp: { status_code: 1004 } })),
  })
  assert.equal(rejected.status, 'error')

  const before = Date.now()
  const relative = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 100,
            current_interval_remaining_count: 60,
            remains_time: 7_200_000,
          },
        ],
      }),
    ),
  })
  assert.equal(relative.status, 'ok')
  near(relative.windows[0]?.usedFraction, 0.4)
  const resetsAt = relative.windows[0]?.resetsAt ?? 0
  assert.ok(resetsAt >= before + 7_200_000 && resetsAt <= Date.now() + 7_200_000 + 1_000)
})

test('opencode-go probe maps rolling and weekly windows and honours rate-limited', async () => {
  const captured: Captured = {}
  const snapshot = await opencodeGoQuotaProbe({
    token: 'oc-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        usage: {
          rolling: { status: 'ok', percent: 25, resetsAt: '2023-11-14T23:00:00.000Z' },
          weekly: { status: 'rate-limited', percent: 80, resets_at: '2023-11-20T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 99, resetsAt: '2023-12-01T00:00:00.000Z' },
        },
      }),
      captured,
    ),
  })

  assert.equal(captured.headers?.Authorization, 'Bearer oc-key')
  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.25)
  assert.equal(session.resetsAt, Date.parse('2023-11-14T23:00:00.000Z'))
  assert.equal(week.usedFraction, 1)
  assert.equal(week.resetsAt, Date.parse('2023-11-20T00:00:00.000Z'))
  assert.deepEqual(
    snapshot.windows.map((window) => window.id),
    ['session', 'week'],
  )
})

test('commandcode probe maps fiveHour and weekly window limits', async () => {
  const captured: Captured = {}
  const snapshot = await commandcodeQuotaProbe({
    token: 'cc-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        data: {
          credits: { monthlyCredits: 5, purchasedCredits: 10, freeCredits: 2, planId: 'pro' },
          windowLimits: {
            fiveHour: { used: 30, cap: 100, resetAt: 1_800_000_000 },
            weekly: { used: 250, cap: 500, resetAt: 1_800_600_000 },
          },
        },
      }),
      captured,
    ),
  })

  assert.equal(captured.url, COMMANDCODE_URL)
  assert.equal(captured.headers?.Authorization, 'Bearer cc-key')
  assert.equal(snapshot.status, 'ok')
  const session = snapshot.windows.find((window) => window.id === 'session')
  const week = snapshot.windows.find((window) => window.id === 'week')
  assert.ok(session !== undefined && week !== undefined)
  near(session.usedFraction, 0.3)
  // Epoch seconds are normalized to milliseconds by the shared reset reader.
  assert.equal(session.resetsAt, 1_800_000_000_000)
  near(week.usedFraction, 0.5)
  assert.equal(week.resetsAt, 1_800_600_000_000)
})

test('commandcode probe accepts an unwrapped body and drops unusable windows', async () => {
  // No `data` envelope, one ISO reset, and a second window with no reset.
  const snapshot = await commandcodeQuotaProbe({
    token: 'cc-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        windowLimits: {
          fiveHour: { used: 12, cap: 48, resetAt: '2023-11-14T23:00:00.000Z' },
          weekly: { used: 10, cap: 100 },
        },
      }),
    ),
  })
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(
    snapshot.windows.map((window) => window.id),
    ['session'],
  )
  assert.equal(snapshot.windows[0]?.resetsAt, Date.parse('2023-11-14T23:00:00.000Z'))
})

test('commandcode probe refuses a credit balance that carries no window', async () => {
  // Pay-as-you-go accounts report only credits; there is no window to render,
  // so this is `error` rather than an invented 0% usage.
  const snapshot = await commandcodeQuotaProbe({
    token: 'cc-key',
    fetch: fakeFetch(jsonResponse(200, { data: { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } } })),
  })
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.reason, 'credit balance carries no usage window')
  assert.deepEqual(snapshot.windows, [])
})

test('commandcode probe classifies http failures instead of throwing', async () => {
  const cases: Array<[number, QuotaStatus]> = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'absent'],
    [500, 'error'],
  ]
  for (const [status, expected] of cases) {
    const snapshot = await commandcodeQuotaProbe({ token: 'cc-key', fetch: fakeFetch(jsonResponse(status, {})) })
    assert.equal(snapshot.status, expected, `http ${status}`)
  }
})

test('xai probe sends the CLI product gate headers and maps the weekly period', async () => {
  const captured: Captured = {}
  const end = '2099-11-20T00:00:00.000Z'
  const snapshot = await xaiQuotaProbe({
    token: 'xai-token',
    fetch: fakeFetch(
      jsonResponse(200, {
        config: {
          currentPeriod: { start: '2099-11-13T00:00:00.000Z', end, type: 'WEEKLY' },
          creditUsagePercent: 61,
          productUsage: [{ product: 'Api', usagePercent: 61 }],
        },
      }),
      captured,
    ),
  })

  assert.equal(captured.url, XAI_URL)
  assert.equal(captured.headers?.Authorization, 'Bearer xai-token')
  // Plan risk R2: without these two the endpoint answers an auth error.
  assert.equal(captured.headers?.['X-XAI-Token-Auth'], 'xai-grok-cli')
  assert.ok((captured.headers?.['User-Agent'] ?? '').length > 0)
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(
    snapshot.windows.map((window) => window.id),
    ['week'],
  )
  near(snapshot.windows[0]?.usedFraction, 0.61)
  assert.equal(snapshot.windows[0]?.resetsAt, Date.parse(end))
})

test('xai probe reads an omitted percent on an open period as zero used', async () => {
  const snapshot = await xaiQuotaProbe({
    token: 'xai-token',
    fetch: fakeFetch(
      jsonResponse(200, {
        config: { currentPeriod: { start: '2099-11-13T00:00:00.000Z', end: '2099-11-20T00:00:00.000Z', type: 'WEEKLY' } },
      }),
    ),
  })
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.windows[0]?.usedFraction, 0)

  // The same payload with an already-ended period has no usable percent.
  const ended = await xaiQuotaProbe({
    token: 'xai-token',
    fetch: fakeFetch(
      jsonResponse(200, {
        config: { currentPeriod: { start: '2020-11-13T00:00:00.000Z', end: '2020-11-20T00:00:00.000Z', type: 'WEEKLY' } },
      }),
    ),
  })
  assert.equal(ended.status, 'error')
  assert.equal(ended.reason, 'no usable weekly credits percent')
})

test('xai probe refuses a non-weekly billing period instead of mislabelling it', async () => {
  // Unified billing reports a monthly included quota; the UI has session/week
  // windows only, so a month must not be rendered as a week.
  const snapshot = await xaiQuotaProbe({
    token: 'xai-token',
    fetch: fakeFetch(
      jsonResponse(200, {
        config: {
          currentPeriod: { start: '2099-11-01T00:00:00.000Z', end: '2099-12-01T00:00:00.000Z', type: 'MONTHLY' },
          creditUsagePercent: 20,
        },
      }),
    ),
  })
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.reason, 'unsupported billing period (MONTHLY)')

  const noPeriod = await xaiQuotaProbe({
    token: 'xai-token',
    fetch: fakeFetch(jsonResponse(200, { config: { monthlyLimit: { val: 100 }, used: { val: 20 } } })),
  })
  assert.equal(noPeriod.status, 'error')
  assert.equal(noPeriod.reason, 'no weekly credits period')
})

test('new routes resolve and unprobed routes stay absent', async () => {
  assert.equal(quotaProbe('commandcode'), commandcodeQuotaProbe)
  assert.equal(quotaProbe('xai'), xaiQuotaProbe)
  // Ollama exposes no standalone quota endpoint in the pinned reference, so it
  // stays `absent` rather than shipping a probe with an invented payload.
  assert.equal(quotaProbe('ollama-cloud'), undefined)
  const absent = await resolveQuota('ollama-cloud', { token: 'tok' })
  assert.equal(absent.status, 'absent')
  assert.deepEqual(absent.windows, [])
})

test('a counter fallback fires only when the used field is absent', async () => {
  // Z.AI: no counter pair at all -> the rounded percentage is the read.
  const zaiFallback = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(
      jsonResponse(200, {
        success: true,
        data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 40, unit: 3, number: 5, nextResetTime: 1_700_000_000_000 }] },
      }),
    ),
  })
  assert.equal(zaiFallback.status, 'ok')
  near(zaiFallback.windows[0]?.usedFraction, 0.4)

  // Z.AI: the counters are present but corrupt (negative spend). Falling back
  // to `percentage: 0` would print a healthy 0% bar from an unusable payload.
  const zaiCorrupt = await zaiQuotaProbe({
    token: 'key',
    fetch: fakeFetch(
      jsonResponse(200, {
        success: true,
        data: {
          limits: [
            {
              type: 'CREDIT_LIMIT',
              currentValue: -1,
              usage: 100,
              percentage: 0,
              unit: 3,
              number: 5,
              nextResetTime: 1_700_000_000_000,
            },
          ],
        },
      }),
    ),
  })
  assert.equal(zaiCorrupt.status, 'error')

  // MiniMax: no usage counter -> remaining still derives the window.
  const minimaxFallback = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 100,
            current_interval_remaining_count: 70,
            end_time: 1_700_000_000_000,
          },
        ],
      }),
    ),
  })
  assert.equal(minimaxFallback.status, 'ok')
  near(minimaxFallback.windows[0]?.usedFraction, 0.3)

  // MiniMax: negative usage with a pristine `remaining` must not become 0%.
  const minimaxCorrupt = await minimaxQuotaProbe({
    token: 'mm-key',
    fetch: fakeFetch(
      jsonResponse(200, {
        base_resp: { status_code: 0 },
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 100,
            current_interval_usage_count: -1,
            current_interval_remaining_count: 100,
            end_time: 1_700_000_000_000,
          },
        ],
      }),
    ),
  })
  assert.equal(minimaxCorrupt.status, 'error')
  assert.deepEqual(minimaxCorrupt.windows, [])
})

test('codex probe collapses two same-length windows onto the tighter one', async () => {
  const snapshot = await codexQuotaProbe({
    token: 'tok',
    fetch: fakeFetch(
      jsonResponse(200, {
        rate_limit: {
          primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 80, limit_window_seconds: 18000, resets_at: 1_700_100_000 },
        },
      }),
    ),
  })
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.windows.map(window => window.id), ['session'])
  near(snapshot.windows[0]?.usedFraction, 0.8)
  assert.equal(snapshot.windows[0]?.resetsAt, 1_700_100_000_000)
})

test('unknown route ids have no probe and resolve to absent', async () => {
  assert.equal(quotaProbe('no-such-provider'), undefined)
  assert.notEqual(quotaProbe('claude'), undefined)
  const snapshot = await resolveQuota('no-such-provider', { token: 'tok' })
  assert.equal(snapshot.status, 'absent')
  assert.deepEqual(snapshot.windows, [])
})

test('prototype keys never resolve to a probe', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(quotaProbe(key), undefined, key)
  }
})

test('route id variants resolve to their provider probe', () => {
  const variants: Array<[string, string]> = [
    ['claude', 'claude'],
    ['anthropic', 'claude'],
    ['codex', 'codex'],
    ['openai-codex', 'codex'],
    ['zai', 'zai'],
    ['zai-coding-cn', 'zai'],
    ['zhipu-coding-plan', 'zai'],
    ['kimi', 'kimi'],
    ['kimi-code', 'kimi'],
    ['kimi-coding', 'kimi'],
    ['minimax', 'minimax'],
    ['minimax-code', 'minimax'],
    ['minimax-code-cn', 'minimax'],
    ['opencode-go', 'opencode-go'],
  ]
  for (const [route, canonical] of variants) {
    assert.equal(quotaProbe(route), quotaProbe(canonical), `${route} → ${canonical}`)
  }
  assert.equal(quotaProbe('opencode'), undefined)
  assert.equal(quotaProbe('github-copilot'), undefined)
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
