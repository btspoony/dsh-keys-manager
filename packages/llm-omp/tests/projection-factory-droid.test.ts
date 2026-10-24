/**
 * Factory Droid projection tests: the fourth route's request and event mapping.
 *
 * These pin what is specific to this route — the registry-run model row (no wire
 * field: the artifact multiplexes by id), the forwarded `StreamOptions` knobs,
 * the absence of an external-executor claim, the refusal of any reasoning effort
 * (the pin exposes no ladder for this provider) and the `PROVIDER_ERROR`
 * fallback — plus the refusals every route shares. The shared behaviour itself
 * stays pinned in `tests/projection.test.ts` / `projection-devin.test.ts`.
 */
import {
  EMPTY_RESPONSE_CODE,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { FACTORY_DROID_MODELS } from '../src/catalog/factory-droid.js'
import type { OmpAssistantMessage, OmpAssistantMessageEvent, OmpUsage } from '../src/omp.js'
import type { RouteProfile } from '../src/projection.js'
import {
  CONTENT_UNSUPPORTED,
  STREAM_CLOSED,
  TOOL_ARGUMENTS_INVALID,
  UNSUPPORTED_REASONING_EFFORT,
  projectEvents,
  projectFactoryDroidRequest,
} from '../src/projection.js'

const ROW = FACTORY_DROID_MODELS.find(row => row.id === 'claude-fable-5.1')
if (ROW === undefined) throw new Error('the generated catalog lost claude-fable-5.1')

/** Every row is a zero-cost Factory credit on the same wire family. */
const IMAGE = {
  type: 'image' as const,
  attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
}

/**
 * The route facts the adapter hands `projectEvents`, kept local on purpose: the
 * projection exports the `RouteProfile` type, so a second copy here proves the
 * profile is data, not a privileged constant.
 */
const FACTORY_DROID_PROFILE = {
  provider: 'factory-droid',
  api: 'factory-droid-agent',
  fallbackErrorCode: 'PROVIDER_ERROR',
} as const satisfies RouteProfile

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...overrides }
}

function request(messages: GenerateOptions['messages'], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'factory-droid', model: 'claude-fable-5.1', messages, ...extra }
}

/** A terminal `done` event carrying an assembled message. */
function doneEvent(
  message: Partial<OmpAssistantMessage> & Pick<OmpAssistantMessage, 'content'>,
): OmpAssistantMessageEvent {
  return {
    type: 'done',
    reason: 'stop',
    message: { role: 'assistant', model: 'claude-fable-5.1', stopReason: 'stop', usage: usage(), ...message },
  }
}

async function collect(events: readonly OmpAssistantMessageEvent[], signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of projectEvents(
    (async function* () {
      yield* events
    })(),
    signal,
    FACTORY_DROID_PROFILE,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('projectFactoryDroidRequest', () => {
  it('sends the registry row as the model and keeps the user turns in order', () => {
    const projected = projectFactoryDroidRequest(
      ROW,
      request([
        createSystemMessage('You are terse.'),
        createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
      ]),
      'token',
    )

    // The row *is* the model: the transport resolves the wire (four protocols) and
    // the upstream rotation from the id inside the artifact, so nothing here adds
    // a `wireModelId` or a route field.
    expect(projected.model).toMatchObject({
      id: 'claude-fable-5.1',
      api: 'factory-droid-agent',
      provider: 'factory-droid',
      baseUrl: ROW.baseUrl,
    })
    expect(projected.context.systemPrompt).toEqual(['You are terse.'])
    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 },
    ])
  })

  it('sends only the credential and the attribution-safe fetch by default', () => {
    const projected = projectFactoryDroidRequest(ROW, request([]), 'token')

    // No `externalToolExecutor` (no exec channel) and no `headers` (caller headers
    // merge last and would overwrite the vendor identity). `purpose` stays
    // advisory, as on the other chat wires.
    expect(Object.keys(projected.options).sort()).toEqual(['apiKey', 'fetch'])
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
    expect(projected.options).not.toHaveProperty('headers')
  })

  it('forwards the request knobs every wire carries', () => {
    const projected = projectFactoryDroidRequest(
      ROW,
      request([], {
        maxTokens: 1024,
        temperature: 0.2,
        stop: ['\n\nUser:'],
        sessionId: 'session-1' as never,
      }),
      't',
    )

    expect(projected.options).toMatchObject({
      apiKey: 't',
      sessionId: 'session-1',
      maxTokens: 1024,
      temperature: 0.2,
      stopSequences: ['\n\nUser:'],
    })
  })

  it('projects tool declarations without claiming an external executor', () => {
    const projected = projectFactoryDroidRequest(
      ROW,
      request([], { tools: [{ name: 'lookup_doc', description: 'Look it up', parameters: {} }] }),
      't',
    )

    expect(projected.context.tools).toEqual([{ name: 'lookup_doc', description: 'Look it up', parameters: {} }])
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
  })

  it('refuses any reasoning effort: the pin declares no ladder for this provider', () => {
    for (const effort of ['minimal', 'high', 'max']) {
      expect(
        () => projectFactoryDroidRequest(ROW, request([], { reasoningEffort: effort as never }), 't'),
        effort,
      ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }))
    }
  })

  it('refuses images even though the row advertises image input', () => {
    // The route advertises text-only (the DSH seam's `INPUT_MODALITIES`), so a
    // turn carrying an image fails by name instead of being sent as text.
    expect(() =>
      projectFactoryDroidRequest(
        ROW,
        request([createUserMessage({ content: [IMAGE], source: { kind: 'user' } })]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
    expect(ROW.input).toContain('image')
  })

  it('refuses a system message that follows a non-system message', () => {
    expect(() =>
      projectFactoryDroidRequest(
        ROW,
        request([
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createSystemMessage('late instructions'),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })

  it('refuses a historical tool call whose arguments are not a JSON object', () => {
    expect(() =>
      projectFactoryDroidRequest(
        ROW,
        request([
          createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '[1]' }],
            source: { provider: 'factory-droid', model: 'claude-fable-5.1' },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOL_ARGUMENTS_INVALID }))
  })

  it('replays a tool call and its result as paired history steps', () => {
    const projected = projectFactoryDroidRequest(
      ROW,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Read it' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":"hi"}' }],
          source: { provider: 'factory-droid', model: 'claude-fable-5.1' },
        }),
        createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'document body' }],
          isError: false,
        }),
      ]),
      't',
    )

    expect(projected.context.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'lookup_doc', arguments: { query: 'hi' } }],
    })
    expect(projected.context.messages[2]).toEqual({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup_doc',
      content: [{ type: 'text', text: 'document body' }],
      isError: false,
      timestamp: 0,
    })
  })
})

describe('projectEvents with the factory-droid profile', () => {
  it('maps reasoning and text blocks with omp content indexes', async () => {
    const chunks = await collect([
      { type: 'start' },
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_end', contentIndex: 0, content: 'Let me think.' },
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: 'Hello' },
      { type: 'text_end', contentIndex: 1, content: 'Hello' },
      doneEvent({
        content: [{ type: 'thinking' }, { type: 'text' }],
        usage: usage({ input: 10, output: 2, totalTokens: 12 }),
      }),
    ])

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands a tool call to DSH as a toolUse finish without filtering it', async () => {
    const call = { type: 'toolCall', id: 'call-1', name: 'lookup_doc', arguments: { query: 'hello' } } as const
    const partial = { role: 'assistant', model: 'claude-fable-5.1', stopReason: 'stop', usage: usage(), content: [call] } as const
    const chunks = await collect([
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial },
      doneEvent({ content: [call] }),
    ])

    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('classifies the HTTP status the transport folded in', async () => {
    const status = async (errorStatus: number): Promise<StreamChunk[]> =>
      collect([
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            model: 'claude-fable-5.1',
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage: 'Factory Droid PROVIDER_ERROR: upstream failed',
            errorStatus,
          },
        },
      ])

    expect((await status(429)).at(-1)).toMatchObject({ reason: { failure: { code: 'RATE_LIMIT', status: 429 } } })
    expect((await status(403)).at(-1)).toMatchObject({ reason: { failure: { code: 'AUTH', status: 403 } } })
    expect((await status(503)).at(-1)).toMatchObject({ reason: { failure: { code: 'SERVER', status: 503 } } })
  })

  it('falls back to PROVIDER_ERROR without a status or a known name', async () => {
    const chunks = await collect([
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          model: 'claude-fable-5.1',
          stopReason: 'error',
          content: [],
          usage: usage(),
          errorMessage: 'not available in this region',
        },
      },
    ])

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'not available in this region', code: 'PROVIDER_ERROR' } },
    })
  })

  it('classifies an empty successful turn as EMPTY_RESPONSE and names the route', async () => {
    const chunks = await collect([doneEvent({ content: [] })])

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'llm-omp-transports: factory-droid model "claude-fable-5.1" completed the turn with no content',
          code: EMPTY_RESPONSE_CODE,
        },
      },
    })
  })

  it('refuses a stream that ends without a terminal event', async () => {
    // The projection rejects rather than finishing: a truncated turn is a
    // transport fault, not a turn that completed with no content.
    await expect(collect([{ type: 'start' }, { type: 'text_end', contentIndex: 0, content: 'Hello' }])).rejects.toMatchObject(
      { code: STREAM_CLOSED },
    )
  })
})
