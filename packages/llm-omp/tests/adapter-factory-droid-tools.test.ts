/**
 * Adapter-level tests: Factory Droid's tool handoff over a scripted turn.
 *
 * The transport keeps no private marker on a call it emitted itself: every
 * `toolCall` is DSH's to execute, so the adapter finishes the turn `tool-calls`
 * and hands the call over. No `externalToolExecutor` exists on this wire — the
 * native DSH tool loop is the only executor.
 */
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { OmpFactoryDroidAdapter } from '../src/adapter.js'
import { FACTORY_DROID_MODELS } from '../src/catalog/factory-droid.js'
import { scriptedFactoryDroidTransport } from './replay.js'

const ROW = FACTORY_DROID_MODELS.find(row => row.id === 'claude-fable-5.1')
if (ROW === undefined) throw new Error('the generated catalog lost claude-fable-5.1')
/** Narrowed once, so the helpers below see a row rather than `Row | undefined`. */
const MODEL = ROW.id

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'factory-droid',
    model: MODEL,
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
  adapter: OmpFactoryDroidAdapter
  calls: ReturnType<typeof scriptedFactoryDroidTransport>['calls']
} {
  const { transport, calls } = scriptedFactoryDroidTransport(fixture)
  return { adapter: new OmpFactoryDroidAdapter({ access: async () => 'test-token', transport }), calls }
}

describe('OmpFactoryDroidAdapter tool handoff', () => {
  it('streams the call and finishes the turn as tool-calls', async () => {
    const { adapter } = adapterFor('factory-droid-tools.jsonl')

    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-factory-1', name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 700, outputTokens: 12, totalTokens: 712 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('advertises the declarations without claiming an external executor', async () => {
    const { adapter, calls } = adapterFor('factory-droid-text.jsonl')

    await collect(
      adapter.stream(
        request({ tools: [{ name: 'lookup_doc', description: 'Look a document up', parameters: { type: 'object' } }] }),
      ),
    )

    expect(calls[0]!.context.tools).toEqual([
      { name: 'lookup_doc', description: 'Look a document up', parameters: { type: 'object' } },
    ])
    expect(calls[0]!.options).not.toHaveProperty('externalToolExecutor')
  })

  it('replays a completed call and its result as paired history', async () => {
    const { adapter, calls } = adapterFor('factory-droid-text.jsonl')
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId('call-factory-1'), name: 'lookup_doc', arguments: '{"query":"hello"}' },
        ],
        source: { provider: 'factory-droid', model: MODEL },
      }),
      createToolResultMessage({
        callId: ToolCallId('call-factory-1'),
        content: [{ type: 'text', text: 'document body' }],
        isError: false,
      }),
    ]

    await collect(adapter.stream(request({ messages: history })))

    const messages = calls[0]!.context.messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look it up' }], timestamp: 0 })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      api: 'factory-droid-agent',
      provider: 'factory-droid',
      content: [{ type: 'toolCall', id: 'call-factory-1', name: 'lookup_doc', arguments: { query: 'hello' } }],
      timestamp: 0,
    })
    expect(messages[2]).toEqual({
      role: 'toolResult',
      toolCallId: 'call-factory-1',
      toolName: 'lookup_doc',
      content: [{ type: 'text', text: 'document body' }],
      isError: false,
      timestamp: 0,
    })
  })
})
