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
  UNKNOWN_FINISH,
  UNSUPPORTED_REASONING_EFFORT,
  projectEvents,
  projectRequest,
} from '../src/projection.js'

const SONNET = CURSOR_MODELS.find(row => row.id === 'claude-4.5-sonnet')
if (SONNET === undefined) throw new Error('the generated catalog lost claude-4.5-sonnet')
const PLAIN = CURSOR_MODELS.find(row => row.thinking === undefined)
if (PLAIN === undefined) throw new Error('the generated catalog lost a non-reasoning row')
/** An advertised-effort row with no routing entries; omp resolves it to its own id. */
const UNROUTED = CURSOR_MODELS.find(row => row.id === 'gpt-5.2')
if (UNROUTED === undefined) throw new Error('the generated catalog lost gpt-5.2')
if (UNROUTED.thinking?.effortRouting !== undefined) {
  throw new Error('gpt-5.2 gained effort routing; pick another unrouted row for the fallback case')
}
/** A routed K3 row: the family whose thinking the transport replays. */
const K3 = CURSOR_MODELS.find(row => row.id === 'kimi-k3-high')
if (K3 === undefined) throw new Error('the generated catalog lost kimi-k3-high')

const IMAGE = {
  type: 'image' as const,
  attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
}

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

  it('keeps a foreign provider identity and drops its reasoning on same-id K3 history', () => {
    // `canReplayCursorThinking` keys on `api`/`provider`/`model`, and the
    // transport refuses a K3 target whose history names another model. A turn
    // produced by another route that happens to share the id must therefore
    // keep its own provider, and its reasoning must not be forwarded as
    // Cursor-native thinking.
    const projected = projectRequest(
      K3,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'foreign chain of thought' },
            { type: 'text', text: 'Hi there' },
          ],
          source: { provider: 'openai', model: 'kimi-k3-high' },
        }),
      ]),
      'token',
    )

    const assistant = projected.context.messages[1] as OmpAssistantMessage
    expect(assistant).toMatchObject({
      role: 'assistant',
      api: 'openai',
      provider: 'openai',
      model: 'kimi-k3-high',
      content: [{ type: 'text', text: 'Hi there' }],
    })
  })

  it('routes a reasoning effort to its wire model id', () => {
    const routed = projectRequest(SONNET, request([], { reasoningEffort: 'high' as never }), 'token')
    expect(routed.options.wireModelId).toBe('claude-4.5-sonnet-thinking')

    const unrouted = projectRequest(SONNET, request([]), 'token')
    expect(unrouted.options.wireModelId).toBeUndefined()
  })

  it('sends the row\'s own wire id for an advertised effort with no routing entry', () => {
    // omp's own resolution falls back to `requestModelId ?? id` for an effort
    // without a route, so the projection omits `wireModelId` and the transport
    // sends gpt-5.2 itself. This is the fallback the 19 unrouted catalog rows
    // depend on: without it, every effort they advertise throws.
    const projected = projectRequest(UNROUTED, request([], { reasoningEffort: 'high' as never }), 'token')

    expect(projected.options.wireModelId).toBeUndefined()
    expect(projected.model.id).toBe('gpt-5.2')
  })

  it('refuses an effort the model does not advertise', () => {
    expect(() => projectRequest(SONNET, request([], { reasoningEffort: 'xhigh' as never }), 'token')).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }),
    )
    expect(() => projectRequest(PLAIN, request([], { reasoningEffort: 'high' as never }), 'token')).toThrowError(
      expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }),
    )
  })

  it('refuses an inherited object key as a reasoning effort', () => {
    // `effortRouting` is a plain object: without an own-property check,
    // `toString` would be accepted as a wire model id.
    expect(() =>
      projectRequest(SONNET, request([], { reasoningEffort: 'toString' as never }), 'token'),
    ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }))
  })

  it('sends no wire model override when no effort is selected', () => {
    // No effort selected stays the transport's own default on every row.
    expect(projectRequest(PLAIN, request([]), 'token').options.wireModelId).toBeUndefined()
  })

  it('ignores advisory request fields the Cursor wire cannot carry', () => {
    // `maxTokens`, `temperature`, `stop` and `purpose` have no field on Cursor's
    // agent protocol, so they are advisory here: never forwarded, never a throw.
    const projected = projectRequest(
      SONNET,
      request([], { maxTokens: 1024, temperature: 0.2, stop: ['\n\nUser:'], purpose: 'compaction' }),
      't',
    )

    expect(projected.options).toEqual({ apiKey: 't', headers: attributionHeaders() })
  })

  it('projects a compaction-shaped request instead of refusing its purpose and cap', () => {
    // DSH's compaction producer (`dsh-compaction-basic`) always sets `purpose`
    // and forwards a configured `maxTokens`; refusing either would kill every
    // compaction before the transport. Both are ignored, so the compacted
    // history projects exactly like any other turn. The projection is
    // knob-compatible but not tool-history-compatible: real compaction also
    // sends `toolHistory` (Task 2), which still throws `TOOLS_UNSUPPORTED`.
    const projected = projectRequest(
      SONNET,
      request(
        [
          createSystemMessage('Summarize the conversation.'),
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createAssistantMessage({
            content: [{ type: 'text', text: 'Hello' }],
            source: { provider: 'cursor', model: 'claude-4.5-sonnet' },
          }),
          createUserMessage({ content: [{ type: 'text', text: 'Now' }], source: { kind: 'user' } }),
        ],
        { purpose: 'compaction', maxTokens: 8192, sessionId: 'session-1' as never },
      ),
      'token',
    )

    expect(projected.model.id).toBe('claude-4.5-sonnet')
    expect(projected.context.systemPrompt).toEqual(['Summarize the conversation.'])
    expect(projected.context.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    // Neither the cap nor the purpose may reappear in the transport call.
    expect(projected.options).toEqual({
      apiKey: 'token',
      sessionId: 'session-1',
      headers: attributionHeaders(),
    })
  })

  it('still refuses the tool history real compaction carries', () => {
    // The knobs above are accepted, but `dsh-compaction-basic` also sends the
    // session's `toolHistory`, so compaction stays Task-2-gated: this assertion
    // documents the limit instead of claiming the turn works.
    expect(() =>
      projectRequest(
        SONNET,
        request(
          [createUserMessage({ content: [{ type: 'text', text: 'Summarize' }], source: { kind: 'user' } })],
          {
            purpose: 'compaction',
            maxTokens: 8192,
            toolHistory: { tools: [{ name: 'read', description: 'read', parameters: {} }], updates: [] },
          },
        ),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOLS_UNSUPPORTED }))
  })

  it('projects a session-title-shaped request', () => {
    // `dsh-session-title-llm` sets `purpose: 'session-title'` and always carries
    // `maxTokens`, which the projection ignores like every other knob.
    const projected = projectRequest(
      SONNET,
      request(
        [createUserMessage({ content: [{ type: 'text', text: 'Name this session' }], source: { kind: 'user' } })],
        { purpose: 'session-title', maxTokens: 256 },
      ),
      'token',
    )

    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Name this session' }], timestamp: 0 },
    ])
    expect(projected.options).toEqual({ apiKey: 'token', headers: attributionHeaders() })
  })

  it('carries the token, signal, session and headers', () => {
    const controller = new AbortController()
    const projected = projectRequest(
      SONNET,
      request([], { sessionId: 'session-1' as never, signal: controller.signal }),
      'the-token',
    )

    // No `externalToolExecutor`: this task refuses every tool frame, so the turn
    // advertises no executor to the transport (Task 2 turns it on with tools).
    expect(projected.options).toEqual({
      apiKey: 'the-token',
      signal: controller.signal,
      sessionId: 'session-1',
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
    expect(() =>
      projectRequest(SONNET, request([createUserMessage({ content: [IMAGE], source: { kind: 'user' } })]), 't'),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })

  it('refuses non-text content in assistant history', () => {
    expect(() =>
      projectRequest(
        SONNET,
        request([
          createAssistantMessage({
            content: [IMAGE],
            source: { provider: 'cursor', model: 'claude-4.5-sonnet' },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })

  it('refuses non-text content in a system message', () => {
    const systemWithImage = { ...createSystemMessage('prompt'), content: [IMAGE] }
    expect(() => projectRequest(SONNET, request([systemWithImage]), 't')).toThrowError(
      expect.objectContaining({ code: CONTENT_UNSUPPORTED }),
    )
  })

  it('refuses a system message that follows a non-system message', () => {
    // The transport carries system text only as a prompt prefix, so a later
    // system message can only be sent by reordering the conversation.
    expect(() =>
      projectRequest(
        SONNET,
        request([
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createSystemMessage('late instructions'),
        ]),
        't',
      ),
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

  it('refuses an unrecognized stop reason instead of guessing a finish', async () => {
    const chunks: OmpAssistantMessageEvent[] = [
      {
        type: 'done',
        reason: 'mystery' as never,
        message: {
          role: 'assistant',
          model: 'claude-4.5-sonnet',
          stopReason: 'mystery',
          content: [{ type: 'text' }],
          usage: usage(),
        },
      },
    ]

    await expect(collect(chunks)).rejects.toMatchObject({ code: UNKNOWN_FINISH })
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
