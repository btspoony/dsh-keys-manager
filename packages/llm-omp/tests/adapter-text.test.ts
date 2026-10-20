/**
 * Adapter-level tests: the DSH seam contract over recorded Cursor turns.
 *
 * The transport is a scripted fake replaying the JSONL fixtures, so every
 * assertion here is about the adapter's own translation: the projected request
 * (token, signal, session, wire model id, headers), the exact `StreamChunk`
 * sequence, the catalog answers, and the typed failures for turns this task
 * cannot carry. No network is involved.
 */
import {
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { CURSOR_ROUTE, OmpCursorAdapter, UNKNOWN_MODEL, UNKNOWN_PROVIDER } from '../src/adapter.js'
import { CURSOR_MODELS } from '../src/catalog/cursor.js'
import { CONTENT_UNSUPPORTED, STREAM_CLOSED, projectRequest } from '../src/projection.js'
import { scriptedTransport } from './replay.js'

const SONNET = CURSOR_MODELS.find(row => row.id === 'claude-4.5-sonnet')
if (SONNET === undefined) throw new Error('the generated catalog lost claude-4.5-sonnet')

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CURSOR_ROUTE,
    model: 'claude-4.5-sonnet',
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
  adapter: OmpCursorAdapter
  calls: ReturnType<typeof scriptedTransport>['calls']
} {
  const { transport, calls } = scriptedTransport(fixture)
  return { adapter: new OmpCursorAdapter({ access: async () => 'test-token', transport }), calls }
}

describe('OmpCursorAdapter text streaming', () => {
  it('streams reasoning and text chunks with terminal usage and stop', async () => {
    const { adapter } = adapterFor('cursor-text.jsonl')
    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user ' },
      { type: 'reasoning-delta', index: 0, text: 'greets me.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user greets me.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello ' },
      { type: 'text-delta', index: 1, text: 'from Cursor' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from Cursor' } },
      {
        type: 'usage',
        usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 2034, cacheReadTokens: 800, reasoningTokens: 12 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('hands the transport the catalog model, history, token, signal and routed wire id', async () => {
    const { adapter, calls } = adapterFor('cursor-text.jsonl')
    const controller = new AbortController()
    await collect(
      adapter.stream(
        request({
          reasoningEffort: ReasoningEffortId('high'),
          sessionId: 'session-1' as GenerateOptions['sessionId'],
          signal: controller.signal,
        }),
      ),
    )

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.model).toMatchObject({
      id: 'claude-4.5-sonnet',
      api: 'cursor-agent',
      provider: 'cursor',
      contextWindow: 200000,
      maxTokens: 64000,
      requiresGlyphTokenization: true,
    })
    expect(call.context).toEqual({
      systemPrompt: ['You are terse.', 'recorded prompt'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }],
    })
    expect(call.options).toEqual({
      apiKey: 'test-token',
      signal: controller.signal,
      sessionId: 'session-1',
      wireModelId: 'claude-4.5-sonnet-thinking',
      headers: attributionHeaders(),
    })
  })

  it('resolves a fresh token for every call', async () => {
    const { transport } = scriptedTransport('cursor-text.jsonl')
    let issued = 0
    const adapter = new OmpCursorAdapter({ access: async () => `token-${++issued}`, transport })
    await collect(adapter.stream(request()))
    await collect(adapter.stream(request()))

    expect(issued).toBe(2)
  })

  it('forwards the request signal to the access resolver, so a refresh can be abandoned', async () => {
    const { transport } = scriptedTransport('cursor-text.jsonl')
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const adapter = new OmpCursorAdapter({
      access: async signal => {
        received = signal
        return 'test-token'
      },
      transport,
    })

    await collect(adapter.stream(request({ signal: controller.signal })))

    expect(received).toBe(controller.signal)
  })

  it('surfaces a dead sign-in from the resolver as REAUTH_REQUIRED before the transport runs', async () => {
    const { transport, calls } = scriptedTransport('cursor-text.jsonl')
    const adapter = new OmpCursorAdapter({
      access: async () => {
        throw new LlmError('llm-omp-transports: Cursor ended this session; sign in again', 'REAUTH_REQUIRED')
      },
      transport,
    })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' })
    expect(calls).toHaveLength(0)
  })

  it('cancels an already-aborted turn without a credential read or transport call', async () => {
    const { transport, calls } = scriptedTransport('cursor-text.jsonl')
    let reads = 0
    const adapter = new OmpCursorAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(adapter.stream(request({ signal: controller.signal })))

    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'llm-omp-transports: request aborted before it was sent', code: 'ABORTED' },
        },
      },
    ])
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('cancels a turn whose signal aborts while the credential is read', async () => {
    const { transport, calls } = scriptedTransport('cursor-text.jsonl')
    const controller = new AbortController()
    let reads = 0
    const adapter = new OmpCursorAdapter({
      access: async () => {
        reads += 1
        // The race the second check owns: abort lands during the read.
        controller.abort()
        return 'test-token'
      },
      transport,
    })

    const chunks = await collect(adapter.stream(request({ signal: controller.signal })))

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED' } },
    })
    expect(reads).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('refuses a blank credential before touching the transport', async () => {
    const { transport, calls } = scriptedTransport('cursor-text.jsonl')
    const adapter = new OmpCursorAdapter({ access: async () => '   ', transport })

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(calls).toHaveLength(0)
  })

  it('labels a blank-credential refusal with the component id and the record key', async () => {
    const { transport } = scriptedTransport('cursor-text.jsonl')
    const adapter = new OmpCursorAdapter({ access: async () => '   ', transport })

    // The label is the operator's only clue which component owns the grant.
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
      message: expect.stringMatching(/^llm-omp-transports: .* llm-omp-transports\/cursor is blank/),
    })
  })

  it('does not read the credential for a request the projection refuses', async () => {
    const { transport, calls } = scriptedTransport('cursor-text.jsonl')
    let reads = 0
    const adapter = new OmpCursorAdapter({
      access: async () => {
        reads += 1
        return 'test-token'
      },
      transport,
    })

    await expect(
      collect(
        adapter.stream(
          request({
            messages: [
              createUserMessage({
                content: [{ type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png' } } as never],
                source: { kind: 'user' },
              }),
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: CONTENT_UNSUPPORTED })
    expect(reads).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe('OmpCursorAdapter catalog', () => {
  it('lists every pinned cursor model with its modalities', async () => {
    const { adapter } = adapterFor('cursor-text.jsonl')
    const models = await adapter.listModels(CURSOR_ROUTE)

    expect(models).toHaveLength(123)
    expect(models.find(model => model.id === 'claude-4.5-sonnet')).toEqual({
      provider: 'cursor',
      id: 'claude-4.5-sonnet',
      name: 'Claude Sonnet 4.5',
      inputModalities: ['text'],
    })
    expect(models.every(model => model.provider === 'cursor' && model.name.length > 0)).toBe(true)
  })

  it('resolves context and reasoning efforts from the table', async () => {
    const { adapter } = adapterFor('cursor-text.jsonl')

    await expect(adapter.resolveModel(CURSOR_ROUTE, 'claude-4.5-sonnet')).resolves.toEqual({
      provider: 'cursor',
      id: 'claude-4.5-sonnet',
      name: 'Claude Sonnet 4.5',
      inputModalities: ['text'],
      context: { contextWindow: SONNET.contextWindow },
      reasoning: {
        efforts: [
          { id: 'minimal', name: 'Minimal' },
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    })
  })

  it('advertises no output cap, because nothing enforces one', async () => {
    // The seam turns `defaultMaxTokens` into a caller-visible `maxTokens` on
    // every request, and the projection ignores that field (Cursor's wire has no
    // per-request cap; the server applies the catalog limit), so advertising a
    // default would promise a cap nothing honors.
    const { adapter } = adapterFor('cursor-text.jsonl')

    const info = await adapter.resolveModel(CURSOR_ROUTE, 'claude-4.5-sonnet')
    expect(info).not.toHaveProperty('defaultMaxTokens')
  })

  it('omits reasoning for a model without thinking', async () => {
    const plain = CURSOR_MODELS.find(row => row.thinking === undefined)
    if (plain === undefined) throw new Error('the generated catalog lost a non-reasoning row')
    const { adapter } = adapterFor('cursor-text.jsonl')

    const info = await adapter.resolveModel(CURSOR_ROUTE, plain.id)
    expect(info.reasoning).toBeUndefined()
  })

  it('advertises only input modalities the projection accepts, on every row', async () => {
    // DSH forwards an image block to a model whose metadata says `image` and
    // skips its own image->text fallback, so an advertised modality the
    // projection refuses turns a user attachment into a hard failure. Whatever
    // `resolveModel` advertises, `projectRequest` must carry.
    const { adapter } = adapterFor('cursor-text.jsonl')
    const blockFor: Record<ModelModality, ContentBlock> = {
      text: { type: 'text', text: 'Hello' },
      // The projection dispatches on `block.type` alone; the payload is never read.
      image: { type: 'image' } as unknown as ContentBlock,
    }
    let checked = 0

    for (const row of CURSOR_MODELS) {
      const info = await adapter.resolveModel(CURSOR_ROUTE, row.id)
      for (const modality of info.inputModalities ?? []) {
        const messages = [createUserMessage({ content: [blockFor[modality]], source: { kind: 'user' } })]
        expect(
          () => projectRequest(row, request({ model: row.id, messages }), 'token'),
          `${row.id}/${modality}`,
        ).not.toThrow()
        checked += 1
      }
    }

    // Keep the filter honest: the catalog does advertise `image` on most rows,
    // so advertising `row.input` verbatim fails the loop above, and an empty
    // modality list cannot pass it vacuously.
    expect(CURSOR_MODELS.some(row => row.input.includes('image'))).toBe(true)
    expect(checked).toBe(CURSOR_MODELS.length)
  })

  it('advertises only reasoning efforts the projection resolves, on every row', async () => {
    // The catalogue's public contract: whatever `resolveModel` offers must reach
    // the transport. 19 rows advertise efforts with no routing entry; those send
    // the row's own id (omp's own fallback) instead of throwing, so on each of
    // them every advertised effort is the same wire request — selection is a
    // wire-level no-op, exactly as in omp.
    const { adapter } = adapterFor('cursor-text.jsonl')
    let checked = 0

    for (const row of CURSOR_MODELS) {
      const info = await adapter.resolveModel(CURSOR_ROUTE, row.id)
      for (const effort of info.reasoning?.efforts ?? []) {
        const projected = projectRequest(row, request({ model: row.id, reasoningEffort: effort.id }), 'token')
        expect(projected.options.wireModelId, `${row.id}/${effort.id}`).toBe(
          row.thinking?.effortRouting?.[effort.id],
        )
        checked += 1
      }
    }

    // Guard the loop against going vacuous: the unrouted fallback is still
    // exercised by rows that advertise efforts without routing them.
    expect(
      CURSOR_MODELS.some(
        row =>
          row.thinking !== undefined && row.thinking.efforts.length > 0 && row.thinking.effortRouting === undefined,
      ),
    ).toBe(true)
    expect(checked).toBeGreaterThan(0)
  })

  it('refuses unlisted models and foreign routes', async () => {
    const { adapter } = adapterFor('cursor-text.jsonl')

    await expect(adapter.resolveModel(CURSOR_ROUTE, 'not-a-model')).rejects.toMatchObject({ code: UNKNOWN_MODEL })
    await expect(adapter.listModels('openai')).rejects.toMatchObject({ code: UNKNOWN_PROVIDER })
    await expect(
      collect(adapter.stream(request({ model: 'not-a-model' }))),
    ).rejects.toMatchObject({ code: UNKNOWN_MODEL })
  })

  it('describes the route', async () => {
    const { adapter } = adapterFor('cursor-text.jsonl')
    expect(adapter.providerInfo(CURSOR_ROUTE)).toEqual({ id: 'cursor', name: 'Cursor' })
  })
})

describe('OmpCursorAdapter failures', () => {
  it.each([
    ['cursor-error-resource-exhausted.jsonl', 'RATE_LIMIT', 429],
    ['cursor-error-not-found.jsonl', 'NOT_FOUND', 404],
    ['cursor-error-provider-error.jsonl', 'SERVER', 503],
    ['cursor-error-conversation-too-long.jsonl', 'CONTEXT_WINDOW_EXCEEDED', 413],
  ])('maps %s to an error finish with %s', async (fixture, code, status) => {
    const { adapter } = adapterFor(fixture)
    const chunks = await collect(adapter.stream(request()))

    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code, status } } })
  })

  it('fails a stream that ended without a terminal event', async () => {
    const { adapter } = adapterFor('cursor-open-stream.jsonl')

    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: STREAM_CLOSED })
    await expect(collect(adapter.stream(request()))).rejects.toBeInstanceOf(LlmError)
  })
})
