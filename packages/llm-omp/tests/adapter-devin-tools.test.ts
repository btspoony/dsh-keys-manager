/**
 * Adapter-level tests: Devin's tool handoff over recorded turns.
 *
 * Unlike Cursor, the Devin transport keeps no private marker on a call it
 * answered itself: every `toolCall` it emits is DSH's to execute. The adapter
 * therefore finishes the turn `tool-calls` and hands over the projected call;
 * these tests pin that, the advertised declarations, and the replayed history.
 */
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { DEVIN_ROUTE, OmpDevinAdapter } from '../src/adapter.js'
import { scriptedDevinTransport } from './replay.js'

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: DEVIN_ROUTE,
    model: 'swe-1-6',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function adapterFor(fixture: string): {
  adapter: OmpDevinAdapter
  calls: ReturnType<typeof scriptedDevinTransport>['calls']
} {
  const { transport, calls } = scriptedDevinTransport(fixture)
  return { adapter: new OmpDevinAdapter({ access: async () => 'test-token', transport }), calls }
}

describe('OmpDevinAdapter tool handoff', () => {
  it('streams the call and finishes the turn as tool-calls', async () => {
    const { adapter } = adapterFor('devin-tools.jsonl')

    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-devin-1', name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 700, outputTokens: 12, totalTokens: 712 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('advertises the declarations without claiming an external executor', async () => {
    const { adapter, calls } = adapterFor('devin-text.jsonl')

    await collect(
      adapter.stream(
        request({
          tools: [{ name: 'lookup_doc', description: 'Look a document up', parameters: { type: 'object' } }],
        }),
      ),
    )

    expect(calls[0]!.context.tools).toEqual([
      { name: 'lookup_doc', description: 'Look a document up', parameters: { type: 'object' } },
    ])
    // DSH's own tool loop is the executor: the transport advertises the
    // declarations and never receives an `externalToolExecutor` flag.
    expect(calls[0]!.options).not.toHaveProperty('externalToolExecutor')
  })

  it('replays a completed call and its result as paired history', async () => {
    const { adapter, calls } = adapterFor('devin-text.jsonl')
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-devin-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' }],
        source: { provider: 'devin', model: 'swe-1-6' },
      }),
      createToolResultMessage({
        callId: ToolCallId('call-devin-1'),
        content: [{ type: 'text', text: 'document body' }],
        isError: false,
      }),
    ]

    await collect(adapter.stream(request({ messages: history })))

    const messages = calls[0]!.context.messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look it up' }], timestamp: 0 })
    // A replayed assistant turn keeps the fields the transport re-reads
    // (model, stopReason, usage) beside the route identity.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      api: 'devin-agent',
      provider: 'devin',
      content: [{ type: 'toolCall', id: 'call-devin-1', name: 'lookup_doc', arguments: { query: 'hello' } }],
      timestamp: 0,
    })
    expect(messages[2]).toEqual({
      role: 'toolResult',
      toolCallId: 'call-devin-1',
      toolName: 'lookup_doc',
      content: [{ type: 'text', text: 'document body' }],
      isError: false,
      timestamp: 0,
    })
  })
})
