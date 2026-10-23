/**
 * Google projection tests: the two Cloud Code Assist routes' request and event
 * mapping.
 *
 * These pin what the Google wire adds over the shipped routes — the structured
 * credential envelope, thinking-effort routing to a wire model id plus a
 * `thinkingConfig`, the per-request Antigravity endpoint state, and the
 * `requiresEffort` refusal — plus the profile-level facts both Google routes
 * share: the `PROVIDER_ERROR` fallback, no Cursor exec marker, no
 * external-executor claim and no caller attribution headers.
 *
 * The Cursor and Devin behaviour itself stays pinned in `tests/projection.test.ts`
 * and `tests/projection-devin.test.ts`, which this task leaves unmodified.
 */
import {
  EMPTY_RESPONSE_CODE,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE,
  GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE,
} from '../src/adapter.js'
import { GOOGLE_ANTIGRAVITY_MODELS } from '../src/catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_MODELS } from '../src/catalog/google-gemini-cli.js'
import type { OmpAssistantMessage, OmpAssistantMessageEvent, OmpUsage } from '../src/omp.js'
import type { GoogleRouteProfile } from '../src/projection.js'
import {
  CONTENT_UNSUPPORTED,
  GOOGLE_ANTIGRAVITY_PROFILE,
  GOOGLE_GEMINI_CLI_PROFILE,
  MALFORMED_TOOL_CALL,
  STREAM_CLOSED,
  UNKNOWN_EVENT,
  UNSUPPORTED_REASONING_EFFORT,
  projectEvents,
  projectGoogleRequest,
} from '../src/projection.js'

function row<T extends { id: string }>(rows: readonly T[], id: string): T {
  const found = rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the generated catalog lost ${id}`)
  return found
}

const FLASH = row(GOOGLE_GEMINI_CLI_MODELS, 'gemini-2.5-flash')
const GEMINI_3_PRO = row(GOOGLE_GEMINI_CLI_MODELS, 'gemini-3-pro-preview')
const PLAIN = row(GOOGLE_GEMINI_CLI_MODELS, 'gemini-2.0-flash')
const ANTIGRAVITY_PRO = row(GOOGLE_ANTIGRAVITY_MODELS, 'gemini-3-pro')
const ANTIGRAVITY_31_PRO = row(GOOGLE_ANTIGRAVITY_MODELS, 'gemini-3.1-pro')
const OPUS = row(GOOGLE_ANTIGRAVITY_MODELS, 'claude-opus-4-5')
const GPT_OSS = row(GOOGLE_ANTIGRAVITY_MODELS, 'gpt-oss-120b')

/** The structured credential envelope omp's `parseGeminiCliCredentials` reads. */
const CREDENTIAL = JSON.stringify({
  token: 'access-token',
  projectId: 'project-1',
  refreshToken: 'refresh-token',
  expiresAt: 1_700_000_000_000,
})

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'google-gemini-cli', model: 'gemini-2.5-flash', messages: [], ...extra }
}

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...overrides }
}

function doneEvent(message: Partial<OmpAssistantMessage> & Pick<OmpAssistantMessage, 'content'>): OmpAssistantMessageEvent {
  return {
    type: 'done',
    reason: 'stop',
    message: { role: 'assistant', model: 'gemini-2.5-flash', stopReason: 'stop', usage: usage(), ...message },
  }
}

async function collect(
  events: readonly OmpAssistantMessageEvent[],
  profile: GoogleRouteProfile = GOOGLE_GEMINI_CLI_PROFILE,
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of projectEvents(
    (async function* () {
      yield* events
    })(),
    signal,
    profile,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('google route facts', () => {
  it('serves the two routes from the generated catalogs over one transport identity', () => {
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.id).toBe('google-gemini-cli')
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.id).toBe('google-antigravity')
    // Both credential records are namespaced under the package, as cursor/devin are.
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.credentialKey).toBe('llm-omp-transports/google-gemini-cli')
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.credentialKey).toBe('llm-omp-transports/google-antigravity')
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.profile.api).toBe('google-gemini-cli')
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.profile.api).toBe('google-gemini-cli')
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.profile.fallbackErrorCode).toBe('PROVIDER_ERROR')
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.profile.fallbackErrorCode).toBe('PROVIDER_ERROR')
    // No transport-resolved marker: every Google tool call belongs to DSH's loop.
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.profile).not.toHaveProperty('transportResolvedMarker')
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.models).toBe(GOOGLE_ANTIGRAVITY_MODELS)
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.models).toBe(GOOGLE_GEMINI_CLI_MODELS)
  })

  it('advertises each row’s own effort ladder', () => {
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.efforts?.(FLASH)).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.efforts?.(GEMINI_3_PRO)).toEqual(['low', 'high'])
    expect(GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE.efforts?.(PLAIN)).toBeUndefined()
    expect(GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE.efforts?.(OPUS)).toEqual(['minimal', 'low', 'medium', 'high'])
  })
})

describe('projectGoogleRequest', () => {
  it('sends the structured credential envelope and the transport identity', () => {
    const projected = projectGoogleRequest(FLASH, GOOGLE_GEMINI_CLI_PROFILE, request(), CREDENTIAL)

    expect(projected.model).toMatchObject({
      id: 'gemini-2.5-flash',
      api: 'google-gemini-cli',
      provider: 'google-gemini-cli',
    })
    // omp parses `apiKey` as JSON and refuses a missing `token`/`projectId`, so
    // the record travels verbatim rather than being split across options.
    expect(projected.options.apiKey).toBe(CREDENTIAL)
    expect(JSON.parse(projected.options.apiKey!)).toMatchObject({ projectId: 'project-1' })
  })

  it('claims no external executor and passes no caller attribution headers', () => {
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({ tools: [{ name: 'lookup_doc', description: 'Look it up', parameters: {} }] }),
      CREDENTIAL,
    )

    // Cloud Code Assist function calls are DSH's tool loop, not a handoff.
    expect(projected.context.tools).toEqual([{ name: 'lookup_doc', description: 'Look it up', parameters: {} }])
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
    // `headers` would merge last and destroy the vendor `user-agent`; the
    // fill-absent wrapper carries attribution instead.
    expect(projected.options).not.toHaveProperty('headers')
    expect(typeof projected.options.fetch).toBe('function')
  })

  it('routes an effort to its wire model id and thinking level on a google-level row', () => {
    const projected = projectGoogleRequest(
      ANTIGRAVITY_PRO,
      GOOGLE_ANTIGRAVITY_PROFILE,
      request({ reasoningEffort: 'high' as never }),
      CREDENTIAL,
    )

    expect(projected.options.requestModelId).toBe('gemini-3-pro-high')
    expect(projected.options.thinking).toEqual({ enabled: true, level: 'HIGH' })
    // The row's own cap stays untouched on the level-mode path, as in omp.
    expect(projected.options.maxTokens).toBeUndefined()
  })

  it('sends LOW for a collapsed minimal tier that shares the low wire id', () => {
    // `gemini-3.6-flash` routes both `minimal` and `low` onto `-low`; CCA
    // rejects `MINIMAL` on those SKUs.
    const flash36 = row(GOOGLE_ANTIGRAVITY_MODELS, 'gemini-3.6-flash')
    const projected = projectGoogleRequest(
      flash36,
      GOOGLE_ANTIGRAVITY_PROFILE,
      request({ reasoningEffort: 'minimal' as never }),
      CREDENTIAL,
    )

    expect(projected.options.requestModelId).toBe('gemini-3.6-flash-low')
    expect(projected.options.thinking).toEqual({ enabled: true, level: 'LOW' })
  })

  it('routes a budget-row effort to its routed id and a token budget', () => {
    const projected = projectGoogleRequest(
      OPUS,
      GOOGLE_ANTIGRAVITY_PROFILE,
      request({ reasoningEffort: 'medium' as never }),
      CREDENTIAL,
    )

    expect(projected.options.requestModelId).toBe('claude-opus-4-5-thinking')
    expect(projected.options.thinking).toEqual({ enabled: true, budgetTokens: 8192 })
  })

  it('uses the row’s pinned budget when it has one', () => {
    const projected = projectGoogleRequest(
      ANTIGRAVITY_31_PRO,
      GOOGLE_ANTIGRAVITY_PROFILE,
      request({ reasoningEffort: 'high' as never }),
      CREDENTIAL,
    )

    expect(projected.options.requestModelId).toBe('gemini-pro-agent')
    expect(projected.options.thinking).toEqual({ enabled: true, budgetTokens: 10001 })
  })

  it('grows the output cap by the thinking budget and clamps it to the row', () => {
    // Cloud Code Assist counts thinking inside `maxOutputTokens`; forwarding the
    // caller's 1024 unchanged would leave nothing for the answer.
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({ reasoningEffort: 'low' as never, maxTokens: 1024, temperature: 0.3 }),
      CREDENTIAL,
    )

    expect(projected.options.maxTokens).toBe(1024 + 4096)
    expect(projected.options.temperature).toBe(0.3)
    expect(projected.options.thinking).toEqual({ enabled: true, budgetTokens: 4096 })
  })

  it('sends thinking off with the routed default id when no effort is selected', () => {
    const projected = projectGoogleRequest(FLASH, GOOGLE_GEMINI_CLI_PROFILE, request(), CREDENTIAL)

    // `effortRouting.off` names the plain (non-thinking) SKU.
    expect(projected.options.requestModelId).toBe('gemini-2.5-flash')
    expect(projected.options.thinking).toEqual({ enabled: false })
  })

  it('forwards the caller’s output cap on a thinking-off request', () => {
    // Thinking off must not become capping off: the budget the caller set still
    // travels, untouched because there is no thinking budget to grow it by.
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({ maxTokens: 1024 }),
      CREDENTIAL,
    )

    expect(projected.options.thinking).toEqual({ enabled: false })
    expect(projected.options.maxTokens).toBe(1024)
  })

  it('spells out the suppression on a suppressWhenOff row', () => {
    // CCA re-applies the baked default when `thinkingConfig` is omitted, so the
    // off switch only takes effect explicitly. Both shapes are pinned on
    // synthetic rows: every `suppressWhenOff` row at this pin also sets
    // `requiresEffort`, so its off path is reachable only through the budget
    // fallback below.
    const budgetRow = {
      ...OPUS,
      thinking: { ...OPUS.thinking!, suppressWhenOff: true, mode: 'budget' },
    }
    expect(
      projectGoogleRequest(budgetRow, GOOGLE_ANTIGRAVITY_PROFILE, request(), CREDENTIAL).options.thinking,
    ).toEqual({ enabled: false, suppress: { budget: 0 } })

    const levelRow = {
      ...ANTIGRAVITY_PRO,
      thinking: { ...ANTIGRAVITY_PRO.thinking!, suppressWhenOff: true, mode: 'google-level', requiresEffort: false },
    }
    expect(
      projectGoogleRequest(levelRow, GOOGLE_ANTIGRAVITY_PROFILE, request(), CREDENTIAL).options.thinking,
    ).toEqual({ enabled: false, suppress: { level: 'MINIMAL' } })
  })

  it('refuses a request that selects no effort on a requiresEffort row', () => {
    // No thinking-off wire form exists for a mandatory-reasoning row.
    expect(() => projectGoogleRequest(GEMINI_3_PRO, GOOGLE_GEMINI_CLI_PROFILE, request(), CREDENTIAL)).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }),
    )
  })

  it('refuses an effort the row does not advertise, and any effort on a non-reasoning row', () => {
    for (const [candidate, effort] of [
      [GEMINI_3_PRO, 'minimal'],
      [FLASH, 'max'],
      [PLAIN, 'low'],
    ] as const) {
      expect(
        () =>
          projectGoogleRequest(candidate, GOOGLE_GEMINI_CLI_PROFILE, request({ reasoningEffort: effort as never }), 't'),
        `${candidate.id}/${effort}`,
      ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }))
    }
  })

  it('gives Antigravity a fresh endpoint-state map per request, and Gemini CLI none', () => {
    const first = projectGoogleRequest(OPUS, GOOGLE_ANTIGRAVITY_PROFILE, request(), CREDENTIAL)
    const second = projectGoogleRequest(OPUS, GOOGLE_ANTIGRAVITY_PROFILE, request(), CREDENTIAL)

    // The provider caches its last-good endpoint in this map; sharing one would
    // carry a previous turn's (or another route's) endpoint into this request.
    expect(first.options.providerSessionState).toBeInstanceOf(Map)
    expect(first.options.providerSessionState).not.toBe(second.options.providerSessionState)
    expect(first.options.providerSessionState?.size).toBe(0)
    expect(projectGoogleRequest(FLASH, GOOGLE_GEMINI_CLI_PROFILE, request(), CREDENTIAL).options).not.toHaveProperty(
      'providerSessionState',
    )
  })

  it('forwards the session id and the caller signal', () => {
    const controller = new AbortController()
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({ sessionId: 'session-1' as never, signal: controller.signal }),
      CREDENTIAL,
    )

    expect(projected.options.sessionId).toBe('session-1')
    expect(projected.options.signal).toBe(controller.signal)
  })

  it('projects the conversation and the system prompt like the shipped routes', () => {
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({
        system: 'one-shot prompt',
        messages: [
          createSystemMessage('recorded prompt'),
          createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
        ],
      }),
      CREDENTIAL,
    )

    expect(projected.context.systemPrompt).toEqual(['one-shot prompt', 'recorded prompt'])
    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 },
    ])
  })

  it('replays google-sourced reasoning under the route identity and drops a foreign one', () => {
    const projected = projectGoogleRequest(
      FLASH,
      GOOGLE_GEMINI_CLI_PROFILE,
      request({
        messages: [
          createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'native thought' },
              { type: 'text', text: 'Hello' },
            ],
            source: { provider: 'google-gemini-cli', model: 'gemini-2.5-flash' },
          }),
          createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'foreign thought' },
              { type: 'text', text: 'Again' },
            ],
            source: { provider: 'openai', model: 'gemini-2.5-flash' },
          }),
        ],
      }),
      CREDENTIAL,
    )

    expect(projected.context.messages[0]).toMatchObject({
      api: 'google-gemini-cli',
      provider: 'google-gemini-cli',
      content: [{ type: 'thinking', thinking: 'native thought' }, { type: 'text', text: 'Hello' }],
    })
    expect(projected.context.messages[1]).toMatchObject({
      api: 'openai',
      provider: 'openai',
      content: [{ type: 'text', text: 'Again' }],
    })
  })

  it('refuses images and a historical call whose arguments are not a JSON object', () => {
    const IMAGE = {
      type: 'image' as const,
      attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
    }
    expect(() =>
      projectGoogleRequest(
        FLASH,
        GOOGLE_GEMINI_CLI_PROFILE,
        request({ messages: [createUserMessage({ content: [IMAGE], source: { kind: 'user' } })] }),
        CREDENTIAL,
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    expect(() =>
      projectGoogleRequest(
        FLASH,
        GOOGLE_GEMINI_CLI_PROFILE,
        request({
          messages: [
            createAssistantMessage({
              content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '[1]' }],
              source: { provider: 'google-gemini-cli', model: 'gemini-2.5-flash' },
            }),
          ],
        }),
        CREDENTIAL,
      ),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }))
  })
})

describe('projectEvents with a google profile', () => {
  it('maps a tool call for DSH’s own loop', async () => {
    const call = { type: 'toolCall' as const, id: 'call-1', name: 'lookup_doc', arguments: { query: 'hi' } }
    const partial = {
      role: 'assistant',
      model: 'gemini-2.5-flash',
      stopReason: 'stop',
      usage: usage(),
      content: [call],
    } as const
    const chunks = await collect([
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"query":"hi"}', partial },
      { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial },
      doneEvent({ content: [call] }),
    ])

    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('falls back to PROVIDER_ERROR when the failure carries no status or known name', async () => {
    const chunks = await collect([
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          model: 'gemini-2.5-flash',
          stopReason: 'error',
          content: [],
          usage: usage(),
          errorMessage: 'upstream failed',
        },
      },
    ])

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'upstream failed', code: 'PROVIDER_ERROR' } },
    })
  })

  it('still classifies the status and the provider names the transport derived', async () => {
    const failed = async (errorStatus?: number, errorMessage = 'Google PROVIDER_ERROR: upstream failed') =>
      collect([
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            model: 'gemini-2.5-flash',
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage,
            ...(errorStatus !== undefined ? { errorStatus } : {}),
          },
        },
      ])

    expect((await failed(429)).at(-1)).toMatchObject({ reason: { failure: { code: 'RATE_LIMIT', status: 429 } } })
    expect((await failed(503)).at(-1)).toMatchObject({ reason: { failure: { code: 'SERVER', status: 503 } } })
    expect((await failed(401)).at(-1)).toMatchObject({ reason: { failure: { code: 'AUTH', status: 401 } } })
    expect((await failed(undefined, 'RESOURCE_EXHAUSTED')).at(-1)).toMatchObject({
      reason: { failure: { code: 'RATE_LIMIT' } },
    })
  })

  it('classifies an aborted provider error as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(
      [
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            model: 'gemini-2.5-flash',
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage: 'transport closed',
          },
        },
      ],
      GOOGLE_GEMINI_CLI_PROFILE,
      controller.signal,
    )

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
  })

  it('classifies an empty successful turn as EMPTY_RESPONSE and names the route', async () => {
    const chunks = await collect([doneEvent({ content: [] })], GOOGLE_ANTIGRAVITY_PROFILE)

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'llm-omp-transports: google-antigravity model "gemini-2.5-flash" completed the turn with no content',
          code: EMPTY_RESPONSE_CODE,
        },
      },
    })
  })

  it('refuses an image block, an unknown event and a stream that ends without a terminal event', async () => {
    await expect(collect([{ type: 'image_end', contentIndex: 0 }])).rejects.toMatchObject({
      code: CONTENT_UNSUPPORTED,
    })
    await expect(collect([{ type: 'mystery' } as never])).rejects.toMatchObject({ code: UNKNOWN_EVENT })
    await expect(collect([{ type: 'start' }])).rejects.toMatchObject({ code: STREAM_CLOSED })
  })

  it('refuses a tool-call event without its call block', async () => {
    await expect(collect([{ type: 'toolcall_start', contentIndex: 0 }])).rejects.toMatchObject({
      code: MALFORMED_TOOL_CALL,
    })
  })
})
