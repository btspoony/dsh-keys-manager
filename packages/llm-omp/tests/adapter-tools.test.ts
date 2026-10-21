/**
 * Adapter-level tool-handoff tests: one recorded two-step Cursor turn.
 *
 * Step one is a tool-call turn (a server `mcpArgs` frame the transport hands
 * off unresolved), step two is the follow-up request after DSH executed the
 * tool. The transport is scripted at the event level, so every assertion is
 * about the adapter's own translation: the exact `StreamChunk` sequence, the
 * projected `tools` / `toolHistory`, `externalToolExecutor` ownership, and the
 * replayed `toolResult` step. The wire-level proof that the real transport
 * answers the server frame lives in `adapter-wire.test.ts`.
 */
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { CURSOR_ROUTE, OmpCursorAdapter } from '../src/adapter.js'
import { CURSOR_MODELS } from '../src/catalog/cursor.js'
import { TOOL_ARGUMENTS_INVALID, projectRequest } from '../src/projection.js'
import { scriptedTransport } from './replay.js'
import type { TransportCall } from './replay.js'

const SONNET = CURSOR_MODELS.find(row => row.id === 'claude-4.5-sonnet')
if (SONNET === undefined) throw new Error('the generated catalog lost claude-4.5-sonnet')

/** The declaration Cursor must see as an MCP tool for the recorded handoff. */
const LOOKUP: ToolSchema = {
  name: 'lookup_doc',
  description: 'Look up a document',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

/** History-only declarations, as a session's folded tool history would carry them. */
const TOOL_HISTORY: GenerateOptions['toolHistory'] = {
  tools: [LOOKUP],
  updates: [{ messageId: 'update-1' as never, additions: [LOOKUP] }],
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CURSOR_ROUTE,
    model: 'claude-4.5-sonnet',
    system: 'You are terse.',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Read the document' }], source: { kind: 'user' } })],
    ...extra,
  }
}

/** The second request DSH sends after executing the handed-off call. */
function followUp(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return request({
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'Read the document' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' }],
        source: { provider: CURSOR_ROUTE, model: 'claude-4.5-sonnet' },
      }),
      createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'hello from the document' }],
        isError: false,
      }),
      createUserMessage({ content: [{ type: 'text', text: 'What does it say?' }], source: { kind: 'user' } }),
    ],
    ...extra,
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function adapterFor(fixture: string): { adapter: OmpCursorAdapter; calls: TransportCall[] } {
  const { transport, calls } = scriptedTransport(fixture)
  return { adapter: new OmpCursorAdapter({ access: async () => 'test-token', transport }), calls }
}

describe('OmpCursorAdapter tool handoff', () => {
  it('turns the handoff into unresolved tool-call chunks and a follow-up text answer', async () => {
    const { adapter, calls } = adapterFor('cursor-tools-call.jsonl')

    const first = await collect(adapter.stream(request({ tools: [LOOKUP], toolHistory: TOOL_HISTORY })))

    expect(first).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), name: 'lookup_doc', argumentsDelta: '{"query":' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), name: 'lookup_doc', argumentsDelta: '"hello"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 90, outputTokens: 12, totalTokens: 112, cacheReadTokens: 10 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])

    // The declaration and the handoff owner reached the transport; the adapter
    // itself never executed the call.
    expect(calls[0].context).toMatchObject({
      tools: [{ name: 'lookup_doc', description: 'Look up a document', parameters: LOOKUP.parameters }],
    })
    expect(calls[0].options.externalToolExecutor).toBe(true)

    const follow = adapterFor('cursor-tools-result.jsonl')
    const second = await collect(follow.adapter.stream(followUp({ tools: [LOOKUP] })))

    expect(second).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The document ' },
      { type: 'text-delta', index: 0, text: 'says hello.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The document says hello.' } },
      { type: 'usage', usage: { inputTokens: 140, outputTokens: 8, totalTokens: 168, cacheReadTokens: 20 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('replays the assistant call and its result as paired transport history', async () => {
    const { adapter, calls } = adapterFor('cursor-tools-result.jsonl')

    await collect(adapter.stream(followUp({ tools: [LOOKUP] })))

    expect(calls[0].context).toMatchObject({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read the document' }], timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'lookup_doc', arguments: { query: 'hello' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup_doc',
          content: [{ type: 'text', text: 'hello from the document' }],
          isError: false,
          timestamp: 0,
        },
        { role: 'user', content: [{ type: 'text', text: 'What does it say?' }], timestamp: 0 },
      ],
    })
    expect(calls[0].context.tools).toEqual([
      { name: 'lookup_doc', description: 'Look up a document', parameters: LOOKUP.parameters },
    ])
  })

  it('projects tools and folded tool history without refusing either', () => {
    const projected = projectRequest(SONNET, request({ tools: [LOOKUP], toolHistory: TOOL_HISTORY }), 't')

    expect(projected.context.tools).toEqual([
      { name: 'lookup_doc', description: 'Look up a document', parameters: LOOKUP.parameters },
    ])
    expect(projected.options.externalToolExecutor).toBe(true)
  })

  it('keeps the external executor off a tool-less turn', async () => {
    const { adapter, calls } = adapterFor('cursor-tools-result.jsonl')

    await collect(adapter.stream(followUp()))

    expect(calls[0].context).not.toHaveProperty('tools')
    expect(calls[0].options).not.toHaveProperty('externalToolExecutor')
  })

  it('streams an exec-frame handoff (start + end, no deltas) as a tool-call turn', async () => {
    const { adapter } = adapterFor('cursor-tools-handoff.jsonl')

    const chunks = await collect(adapter.stream(request({ tools: [LOOKUP] })))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('call-wire-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 6, totalTokens: 106 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('refuses malformed replayed arguments before reading the credential', async () => {
    let reads = 0
    const adapter = new OmpCursorAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport: async function* () {
        yield { type: 'start' }
      },
    })

    await expect(
      collect(
        adapter.stream(
          request({
            messages: [
              createAssistantMessage({
                content: [
                  { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup_doc', arguments: '{"query":' },
                ],
                source: { provider: CURSOR_ROUTE, model: 'claude-4.5-sonnet' },
              }),
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: TOOL_ARGUMENTS_INVALID })
    expect(reads).toBe(0)
  })
})
