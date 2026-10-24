/**
 * Wire-level proof for the Factory Droid route: the **real bundled**
 * `streamFactoryDroid` over a stubbed `fetch`, one case per wire.
 *
 * The provider multiplexes four wire protocols by model id, so the suite drives a
 * representative row of each family and asserts what the artifact actually put on
 * the wire: the host and path, the Factory identity headers (`User-Agent:
 * factory-cli/…`, `X-Client-Version`, `X-Factory-Client: cli`, `x-api-provider`,
 * the v4-shaped session id), the body's upstream model id, and — for the
 * Anthropic family — the SSE decode back into DSH chunks. The remaining families
 * answer with a refusal, which pins the wire selection without depending on three
 * more SSE dialects.
 *
 * Nothing leaves the machine: the only `fetch` is the one the adapter injects.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { OmpFactoryDroidAdapter } from '../src/adapter.js'
import { FACTORY_DROID_MODELS } from '../src/catalog/factory-droid.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

interface WireTransport {
  (model: unknown, context: unknown, options: unknown): AsyncIterable<unknown>
}

const artifact = (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'factory-droid.mjs')).href)) as {
  streamFactoryDroid: WireTransport
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

/** A `fetch` the adapter injects; records calls and answers from `respond`. */
function stubFetch(respond: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), ...(init === undefined ? {} : { init }) }
    calls.push(call)
    return respond(call)
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

function json(value: unknown, status = 400): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** The Anthropic SSE the transport decodes: one text block and a stop. */
function anthropicSse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 12 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from Droid' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ROW = (id: string) => {
  const row = FACTORY_DROID_MODELS.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`the generated catalog lost ${id}`)
  return row
}

function request(id: string): GenerateOptions {
  return {
    provider: 'factory-droid',
    model: id,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream as AsyncIterable<StreamChunk>) chunks.push(chunk)
  return chunks
}

/** Run one turn through the artifact with the injected fetch. */
async function runTurn(id: string, respond: (call: FetchCall) => Response): Promise<{
  calls: FetchCall[]
  chunks: StreamChunk[]
}> {
  const stub = stubFetch(respond)
  const adapter = new OmpFactoryDroidAdapter({
    access: async () => 'workos-token',
    transport: artifact.streamFactoryDroid as never,
    models: () => [id],
  })
  // The projection forwards the fill-absent wrapper; the stub replaces the global
  // so both the wrapper and the transport land here.
  const original = globalThis.fetch
  globalThis.fetch = stub.fetch
  try {
    const chunks = await collect(adapter.stream(request(id)))
    return { calls: stub.calls, chunks }
  } finally {
    globalThis.fetch = original
  }
}

describe('factory droid wire: model id picks the protocol', () => {
  it('sends a Claude row to the Anthropic proxy path and decodes its SSE', async () => {
    const { calls, chunks } = await runTurn('claude-fable-5.1', () => anthropicSse())

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.factory.ai/api/llm/a/v1/messages')
    expect(call.init?.method).toBe('POST')
    const headers = new Headers(call.init?.headers)
    // Factory's CLI identity, not DSH's: the backend gates on this tuple.
    expect(headers.get('user-agent')).toBe('factory-cli/0.237.0')
    expect(headers.get('x-client-version')).toBe('0.237.0')
    expect(headers.get('x-factory-client')).toBe('cli')
    expect(headers.get('authorization')).toBe('Bearer workos-token')
    expect(headers.get('x-api-provider')).toBeTruthy()
    expect(headers.get('x-session-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(headers.get('x-assistant-message-id')).toBeTruthy()
    expect(headers.get('x-stainless-lang')).toBe('js')

    const body = JSON.parse(String(call.init?.body)) as { model: string; messages: unknown[] }
    // The row's own id is the upstream model here: the wire has no second alias.
    expect(body.model).toBe('claude-fable-5.1')
    expect(body.messages).toHaveLength(1)

    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => (chunk as { text: string }).text)
      .join('')
    expect(text).toBe('Hello from Droid')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('sends a GPT row to the Responses API and a DeepSeek row to Chat Completions', async () => {
    const gpt = await runTurn('gpt-5.2', () => json({ error: { message: 'scripted stop' } }))
    expect(gpt.calls[0]!.url).toBe('https://api.factory.ai/api/llm/o/v1/responses')
    expect(JSON.parse(String(gpt.calls[0]!.init?.body))).toMatchObject({ model: 'gpt-5.2' })

    const deepseek = await runTurn('deepseek-v4-pro', () => json({ error: { message: 'scripted stop' } }))
    expect(deepseek.calls[0]!.url).toBe('https://api.factory.ai/api/llm/o/v1/chat/completions')
    expect(JSON.parse(String(deepseek.calls[0]!.init?.body))).toMatchObject({ model: 'deepseek-v4-pro' })
  })

  it('sends a Gemini row to the native generate path', async () => {
    const gemini = await runTurn('gemini-3.1-pro-preview', () => json({ error: { message: 'scripted stop' } }))

    expect(gemini.calls[0]!.url).toBe('https://api.factory.ai/api/llm/g/v1/generate')
    const body = JSON.parse(String(gemini.calls[0]!.init?.body)) as { model?: string }
    expect(body.model).toBe('gemini-3.1-pro-preview')
  })

  it('folds a wire failure into a classified finish instead of throwing', async () => {
    const { chunks } = await runTurn('claude-fable-5.1', () =>
      json({ error: { type: 'permission_error', message: 'not available in this region' } }),
    )

    const finish = chunks.at(-1) as { type: string; reason: { kind: string; failure: { message: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure.message).toContain('region')
  })
})
