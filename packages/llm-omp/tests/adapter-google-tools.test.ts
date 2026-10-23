/**
 * Adapter-level tool-handoff tests for the two Google routes.
 *
 * Every `toolCall` the Cloud Code Assist transports emit is DSH's to execute,
 * so the adapter finishes the turn `tool-calls` and hands the projected call
 * over. Both routes share the transport and the projection, so each assertion
 * runs twice — once per route — with its own catalog row. No network is
 * involved: the transport is the scripted fake from `./replay.ts`.
 */
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  GOOGLE_ANTIGRAVITY_ROUTE,
  GOOGLE_GEMINI_CLI_ROUTE,
  OmpGoogleAntigravityAdapter,
  OmpGoogleGeminiCliAdapter,
} from '../src/adapter.js'
import { scriptedGoogleTransport } from './replay.js'

/** The two routes, as the wiring registers them. */
const ROUTES = [
  {
    id: GOOGLE_GEMINI_CLI_ROUTE,
    model: 'gemini-2.5-flash',
    adapter: OmpGoogleGeminiCliAdapter,
  },
  {
    id: GOOGLE_ANTIGRAVITY_ROUTE,
    model: 'claude-opus-4-5',
    adapter: OmpGoogleAntigravityAdapter,
  },
] as const

/** The declaration the transport must see as a function tool. */
const LOOKUP: ToolSchema = {
  name: 'lookup_doc',
  description: 'Look up a document',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

function request(route: (typeof ROUTES)[number], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: route.id,
    model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.each(ROUTES)('OmpGoogleAdapter tool handoff on $id', route => {
  function adapterFor(fixture: string): {
    adapter: OmpGoogleGeminiCliAdapter | OmpGoogleAntigravityAdapter
    calls: ReturnType<typeof scriptedGoogleTransport>['calls']
  } {
    const { transport, calls } = scriptedGoogleTransport(fixture)
    return { adapter: new route.adapter({ access: async () => 'test-token', transport }), calls }
  }

  it('streams the call and finishes the turn as tool-calls', async () => {
    const { adapter } = adapterFor('google-tools.jsonl')

    const chunks = await collect(adapter.stream(request(route)))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-google-1', name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 800, outputTokens: 14, totalTokens: 814 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('advertises the declarations without claiming an external executor', async () => {
    const { adapter, calls } = adapterFor('google-text.jsonl')

    await collect(adapter.stream(request(route, { tools: [LOOKUP] })))

    expect(calls[0]!.context.tools).toEqual([LOOKUP])
    // DSH's own tool loop is the executor: the transport advertises the
    // declarations and never receives an `externalToolExecutor` flag.
    expect(calls[0]!.options).not.toHaveProperty('externalToolExecutor')
  })

  it('replays a completed call and its result as paired history', async () => {
    const { adapter, calls } = adapterFor('google-text.jsonl')
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-google-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' }],
        source: { provider: route.id, model: route.model },
      }),
      createToolResultMessage({
        callId: ToolCallId('call-google-1'),
        content: [{ type: 'text', text: 'document body' }],
        isError: false,
      }),
    ]

    await collect(adapter.stream(request(route, { messages: history })))

    const messages = calls[0]!.context.messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look it up' }], timestamp: 0 })
    // A replayed assistant turn keeps the fields the transport re-reads (model,
    // stopReason, usage) beside the Cloud Code Assist identity.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      api: 'google-gemini-cli',
      provider: route.id,
      model: route.model,
      content: [{ type: 'toolCall', id: 'call-google-1', name: 'lookup_doc', arguments: { query: 'hello' } }],
      timestamp: 0,
    })
    expect(messages[2]).toEqual({
      role: 'toolResult',
      toolCallId: 'call-google-1',
      toolName: 'lookup_doc',
      content: [{ type: 'text', text: 'document body' }],
      isError: false,
      timestamp: 0,
    })
  })
})
