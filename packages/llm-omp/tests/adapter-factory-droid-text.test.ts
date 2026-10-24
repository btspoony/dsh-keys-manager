/**
 * Adapter-level tests: the DSH seam contract over a scripted Factory Droid turn.
 *
 * The transport is a scripted fake replaying the JSONL fixture, so every
 * assertion is about the adapter's own translation: the projected request (token,
 * signal, session, knobs, fetch wrapper), the exact `StreamChunk` sequence, the
 * catalog answers and the typed failures. No network is involved.
 */
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  FACTORY_DROID_CREDENTIAL_KEY,
  FACTORY_DROID_TRANSPORT_ROUTE,
  OmpFactoryDroidAdapter,
  UNKNOWN_MODEL,
  UNKNOWN_PROVIDER,
} from '../src/adapter.js'
import { FACTORY_DROID_MODELS } from '../src/catalog/factory-droid.js'
import { CONTENT_UNSUPPORTED, STREAM_CLOSED } from '../src/projection.js'
import { attributionPreservingFetch } from '../src/transport/fetch.js'
import { scriptedFactoryDroidTransport } from './replay.js'

const ROW = FACTORY_DROID_MODELS.find(row => row.id === 'claude-fable-5.1')
if (ROW === undefined) throw new Error('the generated catalog lost claude-fable-5.1')
/** Narrowed once, so the helpers below see a row rather than `Row | undefined`. */
const MODEL = ROW.id
/** A second row, for the allow-list narrowing test. */
const OTHER = FACTORY_DROID_MODELS.find(row => row.id !== ROW.id)!

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'factory-droid',
    model: MODEL,
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
  adapter: OmpFactoryDroidAdapter
  calls: ReturnType<typeof scriptedFactoryDroidTransport>['calls']
} {
  const { transport, calls } = scriptedFactoryDroidTransport(fixture)
  return { adapter: new OmpFactoryDroidAdapter({ access: async () => 'test-token', transport }), calls }
}

describe('OmpFactoryDroidAdapter text streaming', () => {
  it('streams reasoning and text chunks with terminal usage and stop', async () => {
    const { adapter } = adapterFor('factory-droid-text.jsonl')
    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user ' },
      { type: 'reasoning-delta', index: 0, text: 'greets me.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user greets me.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello ' },
      { type: 'text-delta', index: 1, text: 'from Factory' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from Factory' } },
      {
        type: 'usage',
        usage: { inputTokens: 900, outputTokens: 20, totalTokens: 1020, cacheReadTokens: 100, reasoningTokens: 8 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands the transport the registry row, history, token, signal and forwarded knobs', async () => {
    const { adapter, calls } = adapterFor('factory-droid-text.jsonl')
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
    expect(model).toMatchObject({ id: ROW.id, api: 'factory-droid-agent', provider: 'factory-droid' })
    expect(context.systemPrompt).toEqual(['You are terse.', 'recorded prompt'])
    expect(context.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }])
    expect(options.apiKey).toBe('test-token')
    expect(options.signal).toBe(controller.signal)
    expect(options.sessionId).toBe('session-1')
    expect(options.maxTokens).toBe(512)
    expect(options.temperature).toBe(0.2)
    expect(options.stopSequences).toEqual(['END'])
    // The wire keeps its own factory-cli identity headers; attribution only
    // fills what a request left absent.
    expect(options.fetch).toBe(attributionPreservingFetch)
    expect(options).not.toHaveProperty('externalToolExecutor')
    expect(options).not.toHaveProperty('wireModelId')
    expect(options).not.toHaveProperty('headers')
  })

  it('refuses a blank credential before touching the transport', async () => {
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    const adapter = new OmpFactoryDroidAdapter({ access: async () => '   ', transport })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
      message: expect.stringMatching(new RegExp(`llm-omp-transports/\\s*factory-droid|${FACTORY_DROID_CREDENTIAL_KEY}`)),
    })
    expect(calls).toHaveLength(0)
  })

  it('does not read the credential for a request the projection refuses', async () => {
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    let reads = 0
    const adapter = new OmpFactoryDroidAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })
    const image = {
      type: 'image',
      attachment: { attachmentId: 'img', mediaType: 'image/png' },
    } as unknown as ContentBlock

    await expect(
      collect(adapter.stream(request({ messages: [createUserMessage({ content: [image], source: { kind: 'user' } })] }))),
    ).rejects.toMatchObject({ code: CONTENT_UNSUPPORTED })
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('refuses a reasoning effort before reading the credential', async () => {
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    let reads = 0
    const adapter = new OmpFactoryDroidAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })

    await expect(
      collect(adapter.stream(request({ reasoningEffort: 'high' as never }))),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('finishes an already-cancelled turn without reading the credential', async () => {
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    let reads = 0
    const adapter = new OmpFactoryDroidAdapter({
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
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    const adapter = new OmpFactoryDroidAdapter({
      access: async () => {
        throw Object.assign(new Error('no sign-in'), { code: 'MISSING_CREDENTIAL' })
      },
      transport,
    })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a script that ends without a terminal event', async () => {
    const { adapter, calls } = adapterFor('factory-droid-open-stream.jsonl')

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: STREAM_CLOSED })
    expect(calls).toHaveLength(1)
  })
})

describe('OmpFactoryDroidAdapter catalog', () => {
  it('lists every registry-seed row with text-only modalities', async () => {
    const { adapter } = adapterFor('factory-droid-text.jsonl')

    expect(adapter.providerInfo('factory-droid')).toEqual({ id: 'factory-droid', name: 'Factory Droid' })
    const models = await adapter.listModels('factory-droid')
    expect(models.map(row => row.id)).toEqual(FACTORY_DROID_MODELS.map(row => row.id))
    expect(models).toHaveLength(62)
    for (const row of models) expect(row.inputModalities).toEqual(['text'])
  })

  it('resolves context without a reasoning selector or a default output cap', async () => {
    const { adapter } = adapterFor('factory-droid-text.jsonl')

    const info = await adapter.resolveModel('factory-droid', MODEL)

    expect(info).toMatchObject({
      provider: 'factory-droid',
      id: MODEL,
      name: ROW.name,
      inputModalities: ['text'],
      context: { contextWindow: ROW.contextWindow },
    })
    // No ladder at this pin: advertising efforts the projection refuses would
    // offer the user a switch that always fails.
    expect(info).not.toHaveProperty('reasoning')
    expect(info).not.toHaveProperty('defaultMaxTokens')
  })

  it('narrows the catalog to a configured allow-list', async () => {
    const { transport } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    const adapter = new OmpFactoryDroidAdapter({
      access: async () => 'test-token',
      transport,
      models: () => [MODEL],
    })

    expect((await adapter.listModels('factory-droid')).map(row => row.id)).toEqual([MODEL])
    await expect(adapter.resolveModel('factory-droid', OTHER.id)).rejects.toMatchObject({ code: UNKNOWN_MODEL })
  })

  it('refuses unlisted models and foreign routes', async () => {
    const { adapter } = adapterFor('factory-droid-text.jsonl')

    await expect(adapter.resolveModel('factory-droid', 'not-a-model')).rejects.toMatchObject({ code: UNKNOWN_MODEL })
    await expect(adapter.listModels('openai')).rejects.toMatchObject({ code: UNKNOWN_PROVIDER })
  })

  it('forwards the stored account scope as the transport oauthIdentity', async () => {
    const { transport, calls } = scriptedFactoryDroidTransport('factory-droid-text.jsonl')
    const adapter = new OmpFactoryDroidAdapter({
      access: async () => 'test-token',
      transport,
      identity: async () => ({ oauthIdentity: { orgId: 'org-1', region: 'eu', inferenceRegion: 'eu' } }),
    })

    await collect(adapter.stream(request()))

    // The transport reads this to pick the EU host; without it the route falls
    // back to the token's `external_org_id` claim and the global base URL.
    expect(calls[0]!.options).toHaveProperty('oauthIdentity', {
      orgId: 'org-1',
      region: 'eu',
      inferenceRegion: 'eu',
    })
  })

  it('merges no identity for a route that has none', async () => {
    const { adapter, calls } = adapterFor('factory-droid-text.jsonl')

    await collect(adapter.stream(request()))

    expect(calls[0]!.options).not.toHaveProperty('oauthIdentity')
  })

  it('names its credential record in the route facts', () => {
    expect(FACTORY_DROID_TRANSPORT_ROUTE.credentialKey).toBe('llm-omp-transports/factory-droid')
    expect(FACTORY_DROID_CREDENTIAL_KEY).toBe(FACTORY_DROID_TRANSPORT_ROUTE.credentialKey)
  })
})
