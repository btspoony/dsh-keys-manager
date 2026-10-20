/**
 * Projection unit tests: request mapping and event translation.
 *
 * The request cases pin the seam contract (system prompt placement, history
 * roles, effort → wire model routing, and the typed refusals this task owns);
 * the event cases pin block indexes, terminal usage/finish mapping, and the
 * deliberate failure modes for events the task cannot carry.
 */
import {
  ToolCallId,
  attributionHeaders,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { CURSOR_MODELS } from '../src/catalog/cursor.js'
import type { OmpAssistantMessage, OmpAssistantMessageEvent, OmpUsage } from '../src/omp.js'
import {
  CONTENT_UNSUPPORTED,
  STREAM_CLOSED,
  TOOLS_UNSUPPORTED,
  UNKNOWN_EVENT,
  projectEvents,
  projectRequest,
} from '../src/projection.js'

const SONNET = CURSOR_MODELS.find(row => row.id === 'claude-4.5-sonnet')
if (SONNET === undefined) throw new Error('the generated catalog lost claude-4.5-sonnet')
const PLAIN = CURSOR_MODELS.find(row => row.thinking === undefined)
if (PLAIN === undefined) throw new Error('the generated catalog lost a non-reasoning row')

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...overrides }
}

function request(messages: GenerateOptions['messages'], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'cursor', model: 'claude-4.5-sonnet', messages, ...extra }
}

async function collect(events: readonly OmpAssistantMessageEvent[], signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of projectEvents(
    (async function* () {
      yield* events
    })(),
    signal,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('projectRequest', () => {
  it('moves the system prompt to the rule slot and keeps user turns in order', () => {
    const projected = projectRequest(
      SONNET,
      request([
        createSystemMessage('You are terse.'),
        createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
      ]),
      'token',
    )

    expect(projected.model.id).toBe('claude-4.5-sonnet')
    expect(projected.model.api).toBe('cursor-agent')
    expect(projected.model.provider).toBe('cursor')
    expect(projected.context.systemPrompt).toEqual(['You are terse.'])
    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 },
    ])
  })

  it('places a one-shot system argument ahead of system messages', () => {
    const projected = projectRequest(
      SONNET,
      request([createSystemMessage('recorded prompt'), createUserMessage({ content: [], source: { kind: 'user' } })], {
        system: 'one-shot prompt',
      }),
      'token',
    )

    expect(projected.context.systemPrompt).toEqual(['one-shot prompt', 'recorded prompt'])
  })

  it('keeps assistant text and reasoning as replayable history steps', () => {
    const projected = projectRequest(
      SONNET,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'thinking it over' },
            { type: 'text', text: 'Hi there' },
          ],
          source: { provider: 'cursor', model: 'claude-4.5-sonnet' },
        }),
        createUserMessage({ content: [{ type: 'text', text: 'Again' }], source: { kind: 'user' } }),
      ]),
      'token',
    )

    const assistant = projected.context.messages[1] as OmpAssistantMessage
    expect(assistant).toMatchObject({
      role: 'assistant',
      api: 'cursor-agent',
      provider: 'cursor',
      model: 'claude-4.5-sonnet',
      content: [
        { type: 'thinking', thinking: 'thinking it over' },
        { type: 'text', text: 'Hi there' },
      ],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    })
  })

  it('routes a reasoning effort to its wire model id', () => {
    const routed = projectRequest(SONNET, request([], { reasoningEffort: 'high' as never }), 'token')
    expect(routed.options.wireModelId).toBe('claude-4.5-sonnet-thinking')

    const unrouted = projectRequest(SONNET, request([]), 'token')
    expect(unrouted.options.wireModelId).toBeUndefined()
  })

  it('refuses an effort the model does not route', () => {
    expect(() => projectRequest(PLAIN, request([], { reasoningEffort: 'high' as never }), 'token')).toThrowError(
      /does not support reasoning effort "high"/,
    )
  })

  it('carries the token, signal, session, headers and handoff mode', () => {
    const controller = new AbortController()
    const projected = projectRequest(
      SONNET,
      request([], { sessionId: 'session-1' as never, signal: controller.signal }),
      'the-token',
    )

    expect(projected.options).toEqual({
      apiKey: 'the-token',
      signal: controller.signal,
      sessionId: 'session-1',
      externalToolExecutor: true,
      headers: attributionHeaders(),
    })
  })

  it('refuses tools, tool history and tool results with a typed code', () => {
    expect(() =>
      projectRequest(SONNET, request([], { tools: [{ name: 'read', description: 'read', parameters: {} }] }), 't'),
    ).toThrowError(expect.objectContaining({ code: TOOLS_UNSUPPORTED }))
    expect(() =>
      projectRequest(SONNET, request([], { toolHistory: { tools: [], updates: [] } }), 't'),
    ).toThrowError(expect.objectContaining({ code: TOOLS_UNSUPPORTED }))
    expect(() =>
      projectRequest(
        SONNET,
        request([
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createToolResultMessage({ callId: ToolCallId('call-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOLS_UNSUPPORTED }))
  })

  it('refuses image content instead of dropping it', () => {
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
    }
    expect(() =>
      projectRequest(SONNET, request([createUserMessage({ content: [image], source: { kind: 'user' } })]), 't'),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })
})

describe('projectEvents', () => {
  const textScript: OmpAssistantMessageEvent[] = [
    { type: 'start' },
    { type: 'thinking_start', contentIndex: 0 },
    { type: 'thinking_delta', contentIndex: 0, delta: 'Let me ' },
    { type: 'thinking_delta', contentIndex: 0, delta: 'think.' },
    { type: 'thinking_end', contentIndex: 0, content: 'Let me think.' },
    { type: 'text_start', contentIndex: 1 },
    { type: 'text_delta', contentIndex: 1, delta: 'Hello ' },
    { type: 'text_delta', contentIndex: 1, delta: 'world' },
    { type: 'text_end', contentIndex: 1, content: 'Hello world' },
    {
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        model: 'claude-4.5-sonnet',
        stopReason: 'stop',
        content: [{ type: 'thinking' }, { type: 'text' }],
        usage: usage({ input: 1200, output: 34, cacheRead: 800, totalTokens: 2034, reasoningTokens: 12 }),
      },
    },
  ]

  it('maps reasoning and text blocks with omp content indexes', async () => {
    const chunks = await collect(textScript)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Let me ' },
      { type: 'reasoning-delta', index: 0, text: 'think.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello ' },
      { type: 'text-delta', index: 1, text: 'world' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } },
      {
        type: 'usage',
        usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 2034, cacheReadTokens: 800, reasoningTokens: 12 } satisfies TokenUsage,
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps length and toolUse stop reasons', async () => {
    const terminal = (reason: 'length' | 'toolUse'): OmpAssistantMessageEvent[] => [
      {
        type: 'done',
        reason,
        message: {
          role: 'assistant',
          model: 'claude-4.5-sonnet',
          stopReason: reason,
          content: [{ type: 'text' }],
          usage: usage({ output: 5 }),
        },
      },
    ]

    expect((await collect(terminal('length'))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect((await collect(terminal('toolUse'))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('classifies an empty successful turn as EMPTY_RESPONSE', async () => {
    const chunks = await collect([
      {
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          model: 'claude-4.5-sonnet',
          stopReason: 'stop',
          content: [],
          usage: usage(),
        },
      },
    ])

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('refuses tool-call and image events with a typed code', async () => {
    await expect(collect([{ type: 'toolcall_start', contentIndex: 0 }])).rejects.toMatchObject({
      code: TOOLS_UNSUPPORTED,
    })
    await expect(collect([{ type: 'image_end', contentIndex: 0 }])).rejects.toMatchObject({
      code: CONTENT_UNSUPPORTED,
    })
  })

  it('refuses an unknown event kind instead of skipping it', async () => {
    await expect(collect([{ type: 'mystery_start' } as unknown as OmpAssistantMessageEvent])).rejects.toMatchObject({
      code: UNKNOWN_EVENT,
    })
  })

  it('fails the turn when the source ends without a terminal event', async () => {
    await expect(collect([{ type: 'text_start', contentIndex: 0 }])).rejects.toMatchObject({ code: STREAM_CLOSED })
  })

  it('turns a provider error into an error finish carrying its status', async () => {
    const chunks = await collect([
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          model: 'claude-4.5-sonnet',
          stopReason: 'error',
          content: [],
          usage: usage({ input: 12, totalTokens: 12 }),
          errorMessage: 'Cursor PROVIDER_ERROR: upstream failed',
          errorStatus: 503,
        },
      },
    ])

    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'Cursor PROVIDER_ERROR: upstream failed', code: 'SERVER', status: 503 },
        },
      },
    ])
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
            model: 'claude-4.5-sonnet',
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage: 'transport closed',
          },
        },
      ],
      controller.signal,
    )

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
  })
})
