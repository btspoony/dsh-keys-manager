/**
 * GitLab Duo agent projection tests: the workflow route's request mapping.
 *
 * The transport builds the wire payload itself — the inline ambient flow config,
 * the `{{goal}}` transcript and the `mcpTools`/`preapproved_tools` pair — so the
 * projection's obligations are the shared context, the session, and the fresh
 * per-request state map. These tests pin exactly that, plus the route's refusals
 * and the event projection under its profile.
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

import { GITLAB_DUO_MODELS } from '../src/catalog/gitlab-duo.js'
import { GITLAB_DUO_AGENT_MODELS } from '../src/catalog/gitlab-duo-agent.js'
import type { OmpAssistantMessage, OmpAssistantMessageEvent, OmpUsage } from '../src/omp.js'
import type { RouteProfile } from '../src/projection.js'
import {
  CONTENT_UNSUPPORTED,
  STREAM_CLOSED,
  TOOL_ARGUMENTS_INVALID,
  UNSUPPORTED_REASONING_EFFORT,
  projectEvents,
  projectGitLabDuoAgentRequest,
  projectGitLabDuoRequest,
} from '../src/projection.js'

const ROW = GITLAB_DUO_AGENT_MODELS[0]!
/** The row's id, narrowed once for the helpers below. */
const MODEL = ROW.id

const IMAGE = {
  type: 'image' as const,
  attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 },
}

/** The route facts the adapter hands `projectEvents`, kept local on purpose. */
const GITLAB_DUO_AGENT_PROFILE = {
  provider: 'gitlab-duo-agent',
  api: 'gitlab-duo-agent',
  fallbackErrorCode: 'PROVIDER_ERROR',
} as const satisfies RouteProfile

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...overrides }
}

function request(messages: GenerateOptions['messages'], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'gitlab-duo-agent', model: MODEL, messages, ...extra }
}

function doneEvent(
  message: Partial<OmpAssistantMessage> & Pick<OmpAssistantMessage, 'content'>,
): OmpAssistantMessageEvent {
  return {
    type: 'done',
    reason: 'stop',
    message: { role: 'assistant', model: MODEL, stopReason: 'stop', usage: usage(), ...message },
  }
}

async function collect(events: readonly OmpAssistantMessageEvent[], signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of projectEvents(
    (async function* () {
      yield* events
    })(),
    signal,
    GITLAB_DUO_AGENT_PROFILE,
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('projectGitLabDuoAgentRequest', () => {
  it('carries the whole history and the system prompt the flow config inlines', () => {
    const projected = projectGitLabDuoAgentRequest(
      ROW,
      request([
        createSystemMessage('You are terse.'),
        createUserMessage({ content: [{ type: 'text', text: 'Fix the bug' }], source: { kind: 'user' } }),
      ]),
      'token',
    )

    expect(projected.model).toMatchObject({ id: MODEL, baseUrl: 'https://gitlab.com' })
    expect(projected.context.systemPrompt).toEqual(['You are terse.'])
    expect(projected.context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }], timestamp: 0 },
    ])
  })

  it('sends a fresh state map, the session and no headers or executor claim', () => {
    const projected = projectGitLabDuoAgentRequest(
      ROW,
      request([], { sessionId: 'session-1' as never }),
      'token',
    )

    expect(projected.options.apiKey).toBe('token')
    expect(projected.options.sessionId).toBe('session-1')
    // Plan A6: a fresh map per request makes the transport re-seed a workflow
    // whose goal transcript replays the history instead of resuming another
    // turn's socket state.
    expect(projected.options.providerSessionState).toBeInstanceOf(Map)
    expect((projected.options.providerSessionState as Map<string, unknown>).size).toBe(0)
    // The transport owns its REST/WebSocket requests: no attribution headers, no
    // fetch wrapper, no external executor, no wire model id.
    expect(projected.options).not.toHaveProperty('headers')
    expect(projected.options).not.toHaveProperty('fetch')
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
    expect(projected.options).not.toHaveProperty('wireModelId')
    // The workflow definition stays the transport default unless a caller names one.
    expect(projected.options).not.toHaveProperty('workflowDefinition')
  })

  it('gives each request its own state map', () => {
    const first = projectGitLabDuoAgentRequest(ROW, request([]), 't')
    const second = projectGitLabDuoAgentRequest(ROW, request([]), 't')

    expect(first.options.providerSessionState).not.toBe(second.options.providerSessionState)
  })

  it('projects the tool declarations the transport turns into mcpTools', () => {
    const projected = projectGitLabDuoAgentRequest(
      ROW,
      request([], { tools: [{ name: 'lookup_doc', description: 'Look it up', parameters: { type: 'object' } }] }),
      't',
    )

    expect(projected.context.tools).toEqual([
      { name: 'lookup_doc', description: 'Look it up', parameters: { type: 'object' } },
    ])
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
  })

  it('refuses a reasoning effort: the one pinned row advertises none', () => {
    expect(() =>
      projectGitLabDuoAgentRequest(ROW, request([], { reasoningEffort: 'high' as never }), 't'),
    ).toThrowError(expect.objectContaining({ code: UNSUPPORTED_REASONING_EFFORT }))
  })

  it('refuses images and a late system message', () => {
    expect(() =>
      projectGitLabDuoAgentRequest(
        ROW,
        request([createUserMessage({ content: [IMAGE], source: { kind: 'user' } })]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    expect(() =>
      projectGitLabDuoAgentRequest(
        ROW,
        request([
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createSystemMessage('late instructions'),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))
  })

  it('replays tool calls and results, which is the transcript the goal replays', () => {
    const projected = projectGitLabDuoAgentRequest(
      ROW,
      request([
        createUserMessage({ content: [{ type: 'text', text: 'Read it' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":"hi"}' }],
          source: { provider: 'gitlab-duo-agent', model: MODEL },
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
      api: 'gitlab-duo-agent',
      provider: 'gitlab-duo-agent',
      content: [{ type: 'toolCall', id: 'call-1', name: 'lookup_doc', arguments: { query: 'hi' } }],
    })
    expect(projected.context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup_doc',
      content: [{ type: 'text', text: 'document body' }],
    })
  })

  it('refuses a historical tool call whose arguments are not a JSON object', () => {
    expect(() =>
      projectGitLabDuoAgentRequest(
        ROW,
        request([
          createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '[1]' }],
            source: { provider: 'gitlab-duo-agent', model: MODEL },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOL_ARGUMENTS_INVALID }))
  })
})

describe('projectEvents with the gitlab-duo-agent profile', () => {
  it('maps text and reasoning blocks with omp content indexes', async () => {
    const chunks = await collect([
      { type: 'start' },
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_end', contentIndex: 0, content: 'Plan the fix.' },
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: 'Fixed' },
      { type: 'text_end', contentIndex: 1, content: 'Fixed' },
      doneEvent({
        content: [{ type: 'thinking' }, { type: 'text' }],
        usage: usage({ input: 10, output: 2, totalTokens: 12 }),
      }),
    ])

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Plan the fix.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Fixed' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Fixed' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands a runMCPTool action to DSH as a toolUse finish', async () => {
    const call = { type: 'toolCall', id: 'call-1', name: 'runMCPTool', arguments: { tool: 'lookup_doc' } } as const
    const partial = { role: 'assistant', model: MODEL, stopReason: 'stop', usage: usage(), content: [call] } as const
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
            model: MODEL,
            stopReason: 'error',
            content: [],
            usage: usage(),
            errorMessage: 'GitLab PROVIDER_ERROR: upstream failed',
            errorStatus,
          },
        },
      ])

    expect((await status(401)).at(-1)).toMatchObject({ reason: { failure: { code: 'AUTH', status: 401 } } })
    expect((await status(429)).at(-1)).toMatchObject({ reason: { failure: { code: 'RATE_LIMIT', status: 429 } } })
    expect((await status(502)).at(-1)).toMatchObject({ reason: { failure: { code: 'SERVER', status: 502 } } })
  })

  it('falls back to PROVIDER_ERROR and refuses a truncated stream', async () => {
    const chunks = await collect([
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          model: MODEL,
          stopReason: 'error',
          content: [],
          usage: usage(),
          errorMessage: 'workflow abandoned',
        },
      },
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'workflow abandoned', code: 'PROVIDER_ERROR' } },
    })

    await expect(collect([{ type: 'start' }])).rejects.toMatchObject({ code: STREAM_CLOSED })
  })

  it('classifies an empty successful turn as EMPTY_RESPONSE', async () => {
    const chunks = await collect([doneEvent({ content: [] })])

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `llm-omp-transports: gitlab-duo-agent model "${MODEL}" completed the turn with no content`,
          code: EMPTY_RESPONSE_CODE,
        },
      },
    })
  })
})

describe('projectGitLabDuoRequest', () => {
  const PROXY_ROW = GITLAB_DUO_MODELS.find(row => row.id === 'duo-chat-opus-4-6')!
  const OPENAI_ROW = GITLAB_DUO_MODELS.find(row => row.id === 'duo-chat-gpt-5-2-codex')!

  const PROXY_PROFILE = {
    provider: 'gitlab-duo',
    api: 'gitlab-duo',
    fallbackErrorCode: 'PROVIDER_ERROR',
  } as const satisfies RouteProfile

  function proxyRequest(
    messages: GenerateOptions['messages'],
    extra: Partial<GenerateOptions> = {},
  ): GenerateOptions {
    return { provider: 'gitlab-duo', model: PROXY_ROW.id, messages, ...extra }
  }

  it('carries the row with its upstream id, wire and compat for the transport to use', () => {
    const projected = projectGitLabDuoRequest(PROXY_ROW, proxyRequest([]), 'token')

    // The transport substitutes the upstream id, picks the wire from `apiRoute`
    // and hands `compat` to `buildModel`; the projection must not pre-empt it.
    expect(projected.model).toMatchObject({
      id: 'duo-chat-opus-4-6',
      api: 'gitlab-duo',
      provider: 'gitlab-duo',
      upstreamModelId: 'claude-opus-4-6',
      apiRoute: 'anthropic-messages',
    })
    expect(projected.model.compat).toEqual(PROXY_ROW.compat)
    // A copy, not the catalog object: the transport mutates what it builds.
    expect(projected.model.compat).not.toBe(PROXY_ROW.compat)
    expect(projected.options).not.toHaveProperty('wireModelId')
    expect(projected.options).not.toHaveProperty('headers')
    expect(projected.options).not.toHaveProperty('externalToolExecutor')
  })

  it('forwards the token, session, knobs and the effort the Anthropic wire folds', () => {
    const projected = projectGitLabDuoRequest(
      PROXY_ROW,
      proxyRequest([], {
        sessionId: 'session-1' as never,
        maxTokens: 2048,
        temperature: 0.2,
        reasoningEffort: 'high' as never,
      }),
      'gitlab-token',
    )

    expect(projected.options).toMatchObject({
      apiKey: 'gitlab-token',
      sessionId: 'session-1',
      maxTokens: 2048,
      temperature: 0.2,
      reasoning: 'high',
    })
    // The gateway's own headers merge under the caller's, so attribution travels
    // through the fill-absent wrapper instead.
    expect(typeof projected.options.fetch).toBe('function')
  })

  it('routes an OpenAI row without inventing a wire of its own', () => {
    const projected = projectGitLabDuoRequest(OPENAI_ROW, proxyRequest([], { model: OPENAI_ROW.id }), 't')

    expect(projected.model).toMatchObject({ upstreamModelId: 'gpt-5.2-codex', apiRoute: 'openai-responses' })
  })

  it('projects the shared context and refuses images, a late system prompt and bad tool arguments', () => {
    const projected = projectGitLabDuoRequest(
      PROXY_ROW,
      proxyRequest(
        [createSystemMessage('You are terse.'), createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
        { tools: [{ name: 'lookup_doc', description: 'Look it up', parameters: {} }] },
      ),
      't',
    )
    expect(projected.context.systemPrompt).toEqual(['You are terse.'])
    expect(projected.context.tools).toHaveLength(1)

    expect(() =>
      projectGitLabDuoRequest(PROXY_ROW, proxyRequest([createUserMessage({ content: [IMAGE], source: { kind: 'user' } })]), 't'),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    expect(() =>
      projectGitLabDuoRequest(
        PROXY_ROW,
        proxyRequest([
          createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }),
          createSystemMessage('late'),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: CONTENT_UNSUPPORTED }))

    expect(() =>
      projectGitLabDuoRequest(
        PROXY_ROW,
        proxyRequest([
          createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '[1]' }],
            source: { provider: 'gitlab-duo', model: PROXY_ROW.id },
          }),
        ]),
        't',
      ),
    ).toThrowError(expect.objectContaining({ code: TOOL_ARGUMENTS_INVALID }))
  })

  it('maps the proxy wire events with the Duo profile', async () => {
    const chunks: StreamChunk[] = []
    const events: OmpAssistantMessageEvent[] = [
      { type: 'start' },
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'Hi' },
      { type: 'text_end', contentIndex: 0, content: 'Hi' },
      {
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          model: PROXY_ROW.id,
          stopReason: 'stop',
          usage: usage({ input: 3, output: 1, totalTokens: 4 }),
          content: [{ type: 'text' }],
        },
      },
    ]
    for await (const chunk of projectEvents(
      (async function* () {
        yield* events
      })(),
      undefined,
      PROXY_PROFILE,
    )) {
      chunks.push(chunk)
    }

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hi' })
  })
})
