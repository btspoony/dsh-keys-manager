/**
 * Adapter-level tests for the two Google routes: the DSH seam contract over
 * recorded Cloud Code Assist turns.
 *
 * Both routes run through the same adapter base and the same projected
 * request shape, so each assertion is made twice — once per route — with the
 * differences the routes actually have: their own catalog size, display name and
 * provider id. The transport is the scripted fake from `./replay.ts`, so nothing
 * leaves the machine.
 */
import { LlmError, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  GOOGLE_ANTIGRAVITY_ROUTE,
  GOOGLE_GEMINI_CLI_ROUTE,
  OmpGoogleAntigravityAdapter,
  OmpGoogleGeminiCliAdapter,
  UNKNOWN_MODEL,
  UNKNOWN_PROVIDER,
} from '../src/adapter.js'
import { GOOGLE_ANTIGRAVITY_MODELS } from '../src/catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_MODELS } from '../src/catalog/google-gemini-cli.js'
import { attributionPreservingFetch } from '../src/transport/fetch.js'
import { CONTENT_UNSUPPORTED, STREAM_CLOSED } from '../src/projection.js'
import { scriptedGoogleTransport } from './replay.js'

/** The two routes, as the wiring registers them. */
const ROUTES = [
  {
    id: GOOGLE_GEMINI_CLI_ROUTE,
    label: 'Google Gemini CLI',
    rowCount: 7,
    models: GOOGLE_GEMINI_CLI_MODELS,
    model: 'gemini-2.5-flash',
    reasoningRow: 'gemini-3-pro-preview',
    adapter: OmpGoogleGeminiCliAdapter,
    providerState: false,
    // A budget-mode row: the wire takes a token budget and the cap grows by it.
    thinking: { enabled: true, budgetTokens: 4096 },
    growsCap: true,
  },
  {
    id: GOOGLE_ANTIGRAVITY_ROUTE,
    label: 'Google Antigravity',
    rowCount: 22,
    models: GOOGLE_ANTIGRAVITY_MODELS,
    // A budget-mode row whose effort is optional, so a plain turn is servable.
    model: 'claude-opus-4-5',
    reasoningRow: 'gemini-3-pro',
    adapter: OmpGoogleAntigravityAdapter,
    providerState: true,
    thinking: { enabled: true, budgetTokens: 4096 },
    growsCap: true,
  },
] as const

function rowOf<T extends { id: string }>(rows: readonly T[], id: string): T {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`the generated catalog lost ${id}`)
  return row
}

function request(route: (typeof ROUTES)[number], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: route.id,
    model: route.model,
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

describe.each(ROUTES)('OmpGoogleAdapter on $label', route => {
  function adapterFor(fixture = 'google-text.jsonl'): {
    adapter: OmpGoogleGeminiCliAdapter | OmpGoogleAntigravityAdapter
    calls: ReturnType<typeof scriptedGoogleTransport>['calls']
  } {
    const { transport, calls } = scriptedGoogleTransport(fixture)
    return { adapter: new route.adapter({ access: async () => 'test-token', transport }), calls }
  }

  it('streams reasoning and text chunks with terminal usage and stop', async () => {
    const { adapter } = adapterFor()
    const chunks = await collect(adapter.stream(request(route)))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user ' },
      { type: 'reasoning-delta', index: 0, text: 'greets me.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user greets me.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello ' },
      { type: 'text-delta', index: 1, text: 'from Gemini' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from Gemini' } },
      {
        type: 'usage',
        usage: { inputTokens: 1100, outputTokens: 22, totalTokens: 1122, reasoningTokens: 9 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands the transport the route identity, the envelope, the wire id and the thinking config', async () => {
    const { adapter, calls } = adapterFor()
    const controller = new AbortController()
    await collect(
      adapter.stream(
        request(route, {
          signal: controller.signal,
          sessionId: 'session-1' as never,
          maxTokens: 512,
          temperature: 0.2,
          reasoningEffort: 'low' as never,
        }),
      ),
    )

    const { model, context, options } = calls[0]!
    expect(model).toMatchObject({ id: route.model, api: 'google-gemini-cli', provider: route.id })
    expect(context.systemPrompt).toEqual(['You are terse.', 'recorded prompt'])
    expect(context.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }])
    // The adapter validates the structured envelope as opaque text and passes it
    // through; the transport parses the JSON.
    expect(options.apiKey).toBe('test-token')
    expect(options.signal).toBe(controller.signal)
    expect(options.sessionId).toBe('session-1')
    expect(options.temperature).toBe(0.2)
    // A budget-mode row grows the caller's cap by the budget; a level-mode row
    // forwards the cap untouched, as omp does.
    expect(options.maxTokens).toBe(route.growsCap ? 512 + 4096 : 512)
    const routedRow = rowOf(route.models, route.model)
    expect(options.requestModelId).toBe(routedRow.thinking?.effortRouting?.low ?? route.model)
    expect(options.thinking).toEqual(route.thinking)
    // The vendor `user-agent` identifies the client; attribution rides the
    // fill-absent wrapper instead of a caller header.
    expect(options.fetch).toBe(attributionPreservingFetch)
    expect(options).not.toHaveProperty('headers')
    expect(options).not.toHaveProperty('externalToolExecutor')
    // The Antigravity provider caches its last-good endpoint per request.
    expect(options.providerSessionState instanceof Map).toBe(route.providerState)
  })

  it('refuses a blank credential before touching the transport', async () => {
    const { transport, calls } = scriptedGoogleTransport('google-text.jsonl')
    const adapter = new route.adapter({ access: async () => '   ', transport })

    await expect(collect(adapter.stream(request(route)))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
      message: expect.stringMatching(
        new RegExp(`^llm-omp-transports: .* llm-omp-transports/${route.id} is blank`),
      ),
    })
    expect(calls).toHaveLength(0)
  })

  it('does not read the credential for a request the projection refuses', async () => {
    const { transport, calls } = scriptedGoogleTransport('google-text.jsonl')
    let reads = 0
    const adapter = new route.adapter({
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
      collect(
        adapter.stream(request(route, { messages: [createUserMessage({ content: [image], source: { kind: 'user' } })] })),
      ),
    ).rejects.toMatchObject({ code: CONTENT_UNSUPPORTED })
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('finishes an already-cancelled turn without reading the credential', async () => {
    const { transport, calls } = scriptedGoogleTransport('google-text.jsonl')
    let reads = 0
    const adapter = new route.adapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(adapter.stream(request(route, { signal: controller.signal })))

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'aborted', failure: expect.anything() } }])
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('propagates a missing sign-in instead of opening a stream', async () => {
    const { transport, calls } = scriptedGoogleTransport('google-text.jsonl')
    const adapter = new route.adapter({
      access: async () => {
        throw new LlmError('llm-omp-transports: no sign-in is stored', 'MISSING_CREDENTIAL')
      },
      transport,
    })

    await expect(collect(adapter.stream(request(route)))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(calls).toHaveLength(0)
  })

  it('describes the route and lists its whole catalog with text-only modalities', async () => {
    const { adapter } = adapterFor()

    expect(adapter.providerInfo(route.id)).toEqual({ id: route.id, name: route.label })
    const models = await adapter.listModels(route.id)
    expect(models).toHaveLength(route.rowCount)
    expect(models.map(model => model.id)).toEqual(route.models.map(model => model.id))
    for (const model of models) expect(model.inputModalities).toEqual(['text'])
  })

  it('resolves context and the row’s own effort ladder, without a default output cap', async () => {
    const { adapter } = adapterFor()
    const reasoningRow = rowOf(route.models, route.reasoningRow)

    const info = await adapter.resolveModel(route.id, reasoningRow.id)

    expect(info).toMatchObject({
      provider: route.id,
      id: reasoningRow.id,
      name: reasoningRow.name,
      inputModalities: ['text'],
      context: { contextWindow: reasoningRow.contextWindow },
    })
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(reasoningRow.thinking?.efforts)
    expect(info).not.toHaveProperty('defaultMaxTokens')
  })

  it('omits reasoning for a row without thinking', async () => {
    const plain = route.models.find(row => row.thinking === undefined)
    if (plain === undefined) throw new Error(`${route.id} lost its non-reasoning rows`)
    const { adapter } = adapterFor()

    expect((await adapter.resolveModel(route.id, plain.id)).reasoning).toBeUndefined()
  })

  it('narrows the catalog to a configured allow-list and refuses the rest', async () => {
    const { transport } = scriptedGoogleTransport('google-text.jsonl')
    const blocked = rowOf(route.models, route.models[route.models.length - 1]!.id)
    const adapter = new route.adapter({
      access: async () => 'test-token',
      transport,
      models: () => [route.model],
    })

    expect((await adapter.listModels(route.id)).map(row => row.id)).toEqual([route.model])
    if (blocked.id !== route.model) {
      await expect(adapter.resolveModel(route.id, blocked.id)).rejects.toMatchObject({ code: UNKNOWN_MODEL })
    }
    // An empty allow-list advertises the full catalog, as the schema default does.
    const open = new route.adapter({
      access: async () => 'test-token',
      transport: scriptedGoogleTransport('google-text.jsonl').transport,
      models: () => [],
    })
    expect(await open.listModels(route.id)).toEqual(await adapterFor().adapter.listModels(route.id))
  })

  it('refuses unlisted models and foreign routes', async () => {
    const { adapter } = adapterFor()

    await expect(adapter.resolveModel(route.id, 'not-a-model')).rejects.toMatchObject({ code: UNKNOWN_MODEL })
    await expect(adapter.listModels('openai')).rejects.toMatchObject({ code: UNKNOWN_PROVIDER })
    expect(() => adapter.providerInfo('openai')).toThrow(expect.objectContaining({ code: UNKNOWN_PROVIDER }))
    // The other Google route is not this adapter's provider either.
    const foreign = route.id === GOOGLE_GEMINI_CLI_ROUTE ? GOOGLE_ANTIGRAVITY_ROUTE : GOOGLE_GEMINI_CLI_ROUTE
    await expect(adapter.listModels(foreign)).rejects.toMatchObject({ code: UNKNOWN_PROVIDER })
    await expect(collect(adapter.stream(request(route, { model: 'not-a-model' })))).rejects.toMatchObject({
      code: UNKNOWN_MODEL,
    })
  })

  it('refuses a script that ends without a terminal event', async () => {
    const { adapter } = adapterFor('cursor-open-stream.jsonl')

    await expect(collect(adapter.stream(request(route)))).rejects.toMatchObject({ code: STREAM_CLOSED })
  })
})

/** Antigravity is the route with level-mode rows; the wire takes the level, not a budget. */
describe('OmpGoogleAdapter level-mode thinking', () => {
  const route = ROUTES[1]

  it('forwards an explicit level and leaves the caller’s cap alone', async () => {
    const { transport, calls } = scriptedGoogleTransport('google-text.jsonl')
    const adapter = new OmpGoogleAntigravityAdapter({ access: async () => 'test-token', transport })
    const row = rowOf(GOOGLE_ANTIGRAVITY_MODELS, 'gemini-3.6-flash')

    await collect(
      adapter.stream(
        request(route, { model: row.id, maxTokens: 512, reasoningEffort: 'low' as never }),
      ),
    )

    expect(calls[0]!.options.thinking).toEqual({ enabled: true, level: 'LOW' })
    expect(calls[0]!.options.maxTokens).toBe(512)
    expect(calls[0]!.options.requestModelId).toBe(row.thinking?.effortRouting?.low ?? row.id)
  })
})
