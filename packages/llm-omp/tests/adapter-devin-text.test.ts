/**
 * Adapter-level tests: the DSH seam contract over recorded Devin turns.
 *
 * The transport is a scripted fake replaying the JSONL fixtures, so every
 * assertion here is about the adapter's own translation: the projected request
 * (token, signal, session, knobs, fetch wrapper), the exact `StreamChunk`
 * sequence, the catalog answers, and the typed failures. No network is involved.
 */
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { DEVIN_ROUTE, OmpDevinAdapter, UNKNOWN_MODEL, UNKNOWN_PROVIDER } from '../src/adapter.js'
import { DEVIN_MODELS } from '../src/catalog/devin.js'
import { attributionPreservingFetch } from '../src/devin/transport.js'
import { CONTENT_UNSUPPORTED, STREAM_CLOSED } from '../src/projection.js'
import { scriptedDevinTransport } from './replay.js'

const SWE = DEVIN_MODELS.find(row => row.id === 'swe-1-6')
if (SWE === undefined) throw new Error('the generated catalog lost swe-1-6')

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: DEVIN_ROUTE,
    model: 'swe-1-6',
    system: 'You are terse.',
    messages: [
      createSystemMessage('recorded prompt'),
      createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
    ],
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

describe('OmpDevinAdapter text streaming', () => {
  it('streams reasoning and text chunks with terminal usage and stop', async () => {
    const { adapter } = adapterFor('devin-text.jsonl')
    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user ' },
      { type: 'reasoning-delta', index: 0, text: 'greets me.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user greets me.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello ' },
      { type: 'text-delta', index: 1, text: 'from Devin' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from Devin' } },
      {
        type: 'usage',
        usage: { inputTokens: 900, outputTokens: 20, totalTokens: 1020, cacheReadTokens: 100, reasoningTokens: 8 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands the transport the devin model, history, token, signal and forwarded knobs', async () => {
    const { adapter, calls } = adapterFor('devin-text.jsonl')
    const controller = new AbortController()
    await collect(
      adapter.stream(
        request({
          signal: controller.signal,
          sessionId: 'session-1' as never,
          maxTokens: 512,
          temperature: 0.2,
          stop: ['END'],
        }),
      ),
    )

    const { model, context, options } = calls[0]!
    expect(model).toMatchObject({ id: 'swe-1-6', api: 'devin-agent', provider: 'devin' })
    expect(context.systemPrompt).toEqual(['You are terse.', 'recorded prompt'])
    expect(context.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }])
    expect(options.apiKey).toBe('test-token')
    expect(options.signal).toBe(controller.signal)
    expect(options.sessionId).toBe('session-1')
    expect(options.maxTokens).toBe(512)
    expect(options.temperature).toBe(0.2)
    expect(options.stopSequences).toEqual(['END'])
    // The chat request keeps the transport's own connect-go identity; the
    // header-less handshake gets DSH's user-agent from this wrapper.
    expect(options.fetch).toBe(attributionPreservingFetch)
    expect(options).not.toHaveProperty('externalToolExecutor')
    expect(options).not.toHaveProperty('wireModelId')
  })

  it('refuses a blank credential before touching the transport', async () => {
    const { transport, calls } = scriptedDevinTransport('devin-text.jsonl')
    const adapter = new OmpDevinAdapter({ access: async () => '   ', transport })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
      message: expect.stringMatching(/^llm-omp-transports: .* llm-omp-transports\/devin is blank/),
    })
    expect(calls).toHaveLength(0)
  })

  it('does not read the credential for a request the projection refuses', async () => {
    const { transport, calls } = scriptedDevinTransport('devin-text.jsonl')
    let reads = 0
    const adapter = new OmpDevinAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })
    const image = { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png' } } as unknown as ContentBlock

    await expect(
      collect(
        adapter.stream(
          request({ messages: [createUserMessage({ content: [image], source: { kind: 'user' } })] }),
        ),
      ),
    ).rejects.toMatchObject({ code: CONTENT_UNSUPPORTED })
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('finishes an already-cancelled turn without reading the credential', async () => {
    const { transport, calls } = scriptedDevinTransport('devin-text.jsonl')
    let reads = 0
    const adapter = new OmpDevinAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(adapter.stream(request({ signal: controller.signal })))

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'aborted', failure: expect.anything() } }])
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('propagates a missing sign-in instead of opening a stream', async () => {
    const { transport, calls } = scriptedDevinTransport('devin-text.jsonl')
    const adapter = new OmpDevinAdapter({
      access: async () => {
        throw Object.assign(new Error('no sign-in'), { code: 'MISSING_CREDENTIAL' })
      },
      transport,
    })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a script that ends without a terminal event', async () => {
    const { adapter } = adapterFor('devin-open-stream.jsonl')

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: STREAM_CLOSED })
  })
})

describe('OmpDevinAdapter catalog', () => {
  it('lists both pinned devin models with text-only modalities', async () => {
    const { adapter } = adapterFor('devin-text.jsonl')

    expect(adapter.providerInfo(DEVIN_ROUTE)).toEqual({ id: 'devin', name: 'Devin' })
    const models = await adapter.listModels(DEVIN_ROUTE)
    expect(models.map(row => row.id)).toEqual(DEVIN_MODELS.map(row => row.id))
    expect(models).toHaveLength(2)
    for (const row of models) expect(row.inputModalities).toEqual(['text'])
  })

  it('resolves context without a reasoning selector or a default output cap', async () => {
    const { adapter } = adapterFor('devin-text.jsonl')

    const info = await adapter.resolveModel(DEVIN_ROUTE, SWE.id)

    expect(info).toMatchObject({
      provider: 'devin',
      id: 'swe-1-6',
      name: SWE.name,
      inputModalities: ['text'],
      context: { contextWindow: SWE.contextWindow },
    })
    expect(info).not.toHaveProperty('reasoning')
    expect(info).not.toHaveProperty('defaultMaxTokens')
  })

  it('narrows the catalog to a configured allow-list', async () => {
    const { transport } = scriptedDevinTransport('devin-text.jsonl')
    const adapter = new OmpDevinAdapter({
      access: async () => 'test-token',
      transport,
      models: () => ['swe-1-6'],
    })

    expect((await adapter.listModels(DEVIN_ROUTE)).map(row => row.id)).toEqual(['swe-1-6'])
    await expect(adapter.resolveModel(DEVIN_ROUTE, 'swe-1-6-fast')).rejects.toMatchObject({ code: UNKNOWN_MODEL })
  })

  it('refuses unlisted models and foreign routes', async () => {
    const { adapter } = adapterFor('devin-text.jsonl')

    await expect(adapter.resolveModel(DEVIN_ROUTE, 'not-a-model')).rejects.toMatchObject({ code: UNKNOWN_MODEL })
    await expect(adapter.listModels('openai')).rejects.toMatchObject({ code: UNKNOWN_PROVIDER })
    // A foreign name must not be described with this route's display name.
    expect(() => adapter.providerInfo('openai')).toThrow(expect.objectContaining({ code: UNKNOWN_PROVIDER }))
    await expect(collect(adapter.stream(request({ model: 'not-a-model' })))).rejects.toMatchObject({
      code: UNKNOWN_MODEL,
    })
  })
})
