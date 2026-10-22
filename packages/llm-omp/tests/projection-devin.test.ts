/**
 * Devin projection tests: the second route's request and event mapping.
 *
 * These pin the places where the Devin wire differs from Cursor's — forwarded
 * request knobs, no external-executor claim, the `PROVIDER_ERROR` fallback and
 * the absence of the Cursor exec marker — plus the refusals both routes share.
 * The Cursor behaviour itself stays pinned in `tests/projection.test.ts`.
 */
import {
  EMPTY_RESPONSE_CODE,
  ToolCallId,
  attributionHeaders,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

import { DEVIN_MODELS } from '../src/catalog/devin.js'
import { attributionPreservingFetch } from '../src/devin/transport.js'
import type { OmpAssistantMessage, OmpAssistantMessageEvent, OmpToolCallBlock, OmpUsage } from '../src/omp.js'
import type { RouteProfile } from '../src/projection.js'
import {
  CONTENT_UNSUPPORTED,
  MALFORMED_TOOL_CALL,
  STREAM_CLOSED,
  TOOL_ARGUMENTS_INVALID,
  UNKNOWN_EVENT,
  UNSUPPORTED_REASONING_EFFORT,
  projectDevinRequest,
  projectEvents,
} from '../src/projection.js'

const SWE = DEVIN_MODELS.find(row => row.id === 'swe-1-6')
if (SWE === undefined) throw new Error('the generated catalog lost swe-1-6')

/**
 * The route facts the adapter will hand `projectEvents`. Kept local on purpose:
 * the projection module exports only the `RouteProfile` type, so a second copy
 * here proves the profile is data, not a privileged constant.
 */
const DEVIN_PROFILE = {
  provider: 'devin',
  api: 'devin-agent',
  fallbackErrorCode: 'PROVIDER_ERROR',
} as const satisfies RouteProfile

const IMAGE = {
  type: 'image' as const,
  attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
}

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...overrides }
}

function request(messages: GenerateOptions['messages'], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'devin', model: 'swe-1-6', messages, ...extra }
}

/** A terminal `done` event carrying an assembled message. */
function doneEvent(message: Partial<OmpAssistantMessage> & Pick<OmpAssistantMessage, 'content'>): OmpAssistantMessageEvent {
  return {
    type: 'done',
    reason: 'stop',
    message: { role: 'assistant', model: 'swe-1-6', stopReason: 'stop', usage: usage(), ...message },
  }
}

async function collect(events: readonly OmpAssistantMessageEvent[], signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of projectEvents(
    (async function* () {
      yield* events
    })(),
    signal,
    DEVIN_PROFILE,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('projectDevinRequest', () => {
  it('moves the system prompt to the rule slot and keeps user turns in order', () => {
    const projected = projectDevinRequest(
      SWE,
      request([
        createSystemMessage('You are terse.'),
        createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
      ]),
      'token',
    )

    expect(projected.model).toMatchObject({ id: 'swe-1-6', api: 'devin-agent', provider: 'devin' })
    expect(projected.context.systemPrompt).toEqual(['You are terse.'])
    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 },
    ])
  })

  it('places a one-shot system argument ahead of system messages', () => {
    const projected = projectDevinRequest(
      SWE,
      request([createSystemMessage('recorded prompt'), createUserMessage({ content: [], source: { kind: 'user' } })], {
        system: 'one-shot prompt',
      }),
      'token',
    )

    expect(projected.context.systemPrompt).toEqual(['one-shot prompt', 'recorded prompt'])
  })

  it('sends only the credential and the attribution-safe fetch by default', () => {
    const projected = projectDevinRequest(SWE, request([]), 'token')

    // No `externalToolExecutor` and no `wireModelId`: Devin's chat wire has
    // neither, and DSH's tool loop is the native mode.
    expect(projected.options).toEqual({ apiKey: 'token', fetch: attributionPreservingFetch })
  })

  it('forwards maxTokens, temperature and stop as the wire fields it has', () => {
    // Unlike Cursor, the Cascade request carries all three; `purpose` stays
    // advisory because the wire has no field for it.
    const projected = projectDevinRequest(
      SWE,
      request([], {
        maxTokens: 1024,
        temperature: 0.2,
        stop: ['\n\nUser:'],
        purpose: 'compaction',
        sessionId: 'session-1' as never,
      }),
      't',
    )

    expect(projected.options).toEqual({
      apiKey: 't',
      sessionId: 'session-1',
      maxTokens: 1024,
      temperature: 0.2,
      stopSequences: ['\n\nUser:'],
      fetch: attributionPreservingFetch,
    })
  })

  it('advertises tools without claiming an external executor', () => {
    const projected = projectDevinRequest(
      SWE,
      request([], { tools: [{ name: 'lookup_doc', description: 'Look it up', parameters: {} }] }),
      't',
    )

    expect(projected.context.tools).toEqual([{ name: 'lookup_doc', description: 'Look it up', parameters: {} }])
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
  })

  it('replays devin-sourced reasoning and drops a foreign route\'s reasoning', () => {
    const projected = projectDevinRequest(
      SWE,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'devin-native chain of thought' },
            { type: 'text', text: 'Hello' },
          ],
          source: { provider: 'devin', model: 'swe-1-6' },
        }),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'foreign chain of thought' },
            { type: 'text', text: 'Again' },
          ],
          source: { provider: 'openai', model: 'swe-1-6' },
        }),
      ]),
      'token',
    )

    expect(projected.context.messages[1]).toMatchObject({
      api: 'devin-agent',
      provider: 'devin',
      content: [{ type: 'thinking', thinking: 'devin-native chain of thought' }, { type: 'text', text: 'Hello' }],
    })
    expect(projected.context.messages[2]).toMatchObject({
      api: 'openai',
      provider: 'openai',
      content: [{ type: 'text', text: 'Again' }],
    })
  })

  it('replays tool calls and their results as paired history steps', () => {
    const projected = projectDevinRequest(
      SWE,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Read it' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":"hi"}' }],
          source: { provider: 'devin', model: 'swe-1-6' },
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

  it('refuses any reasoning effort: no pinned row advertises one', () => {
    for (const effort of ['minimal', 'high', 'max']) {
      expect(
        () => projectDevinRequest(SWE, request([], { reasoningEffort: effort as never }), 't'),
        effort,
      ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }))
    }
  })

  it('refuses images and other non-text content with the route named', () => {
    expect(() =>
      projectDevinRequest(
        SWE,
        request([createUserMessage({ content: [IMAGE], source: { kind: 'user' } })]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    expect(() =>
      projectDevinRequest(
        SWE,
        request([
          createAssistantMessage({
            content: [{ type: 'reasoning', text: 'x' }, IMAGE],
            source: { provider: 'devin', model: 'swe-1-6' },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    const systemWithImage = { ...createSystemMessage('prompt'), content: [IMAGE] }
    expect(() =>
      projectDevinRequest(SWE, request([systemWithImage]), 't'),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })

  it('refuses a system message that follows a non-system message', () => {
    expect(() =>
      projectDevinRequest(
        SWE,
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
      projectDevinRequest(
        SWE,
        request([
          createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '[1]' }],
            source: { provider: 'devin', model: 'swe-1-6' },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOL_ARGUMENTS_INVALID }))
  })

  it('drops a developer message that carried only tool updates', () => {
    const projected = projectDevinRequest(
      SWE,
      request([
        createDeveloperMessage({
          content: [{ type: 'tool-addition', toolName: 'lookup_doc' }],
          source: { kind: 'user' },
        }),
      ]),
      't',
    )

    expect(projected.context.messages).toEqual([])
    expect(projected.context.tools).toBeUndefined()
  })
})

describe('attribution-preserving fetch', () => {
  it('fills the attribution header the handshake left absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      await attributionPreservingFetch('https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
      const headers = new Headers(init.headers)
      expect(headers.get('user-agent')).toBe(attributionHeaders()['user-agent'])
      expect(headers.get('content-type')).toBe('application/json')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('leaves the transport\'s own client identity on the chat request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      await attributionPreservingFetch('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/connect+proto', 'user-agent': 'connect-go/1.19.1 (go1.24.4)' },
      })
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
      expect(new Headers(init.headers).get('user-agent')).toBe('connect-go/1.19.1 (go1.24.4)')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('passes the original init through when every header is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      const init = { headers: { ...attributionHeaders() } }
      await attributionPreservingFetch('https://server.codeium.com/', init)
      expect(fetchSpy.mock.calls[0]?.[1]).toBe(init)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('projectEvents with the devin profile', () => {
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

  it('never filters a tool call: Devin has no transport-resolved marker', async () => {
    // A marker with Cursor's description is meaningless on this route; if the
    // devin profile ever inherited it, this call would vanish and DSH would
    // never run it.
    const marker = Symbol('provider.block.cursorExecResolved')
    const call = { type: 'toolCall', id: 'call-1', name: 'read', arguments: {}, [marker]: true } as OmpToolCallBlock
    const partial = { role: 'assistant', model: 'swe-1-6', stopReason: 'stop', usage: usage(), content: [call] } as const
    const chunks = await collect([
      { type: 'toolcall_start', contentIndex: 0, partial },
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
          model: 'swe-1-6',
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

  it('still classifies the HTTP status the transport derived', async () => {
    const status = async (errorStatus: number): Promise<StreamChunk[]> =>
      collect([
        {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            model: 'swe-1-6',
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage: 'Devin PROVIDER_ERROR: upstream failed',
            errorStatus,
          },
        },
      ])

    expect((await status(429)).at(-1)).toMatchObject({ reason: { failure: { code: 'RATE_LIMIT', status: 429 } } })
    expect((await status(503)).at(-1)).toMatchObject({ reason: { failure: { code: 'SERVER', status: 503 } } })
    expect((await status(401)).at(-1)).toMatchObject({ reason: { failure: { code: 'AUTH', status: 401 } } })
  })

  it('classifies an empty successful turn as EMPTY_RESPONSE and names devin', async () => {
    const chunks = await collect([doneEvent({ content: [] })])

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'llm-omp-transports: devin model "swe-1-6" completed the turn with no content', code: EMPTY_RESPONSE_CODE },
      },
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
            model: 'swe-1-6',
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

  it('refuses an unrecognized devin event and a stream that ends without a terminal event', async () => {
    await expect(collect([{ type: 'mystery' } as never])).rejects.toMatchObject({ code: UNKNOWN_EVENT })
    await expect(collect([{ type: 'start' }])).rejects.toMatchObject({ code: STREAM_CLOSED })
  })

  it('refuses a tool-call event without its call block', async () => {
    await expect(collect([{ type: 'toolcall_start', contentIndex: 0 }])).rejects.toMatchObject({
      code: MALFORMED_TOOL_CALL,
    })
  })
})
