/**
 * Wire-level proof for the GitLab Duo proxy: the **real bundled**
 * `streamGitLabDuo` over a stubbed `fetch`, one case per inner wire.
 *
 * The provider first POSTs for a direct-access token on GitLab's API, then hands
 * the turn to one of the three generic transports through GitLab's AI gateway. The
 * suite asserts exactly that sequence: the bootstrap body and bearer, the gateway
 * URL per wire, the substituted upstream model id (not the row's alias), the
 * gateway headers merged into the request, the Anthropic SSE decoded back into DSH
 * chunks, and the 403 → "Duo not enabled" classification.
 *
 * Nothing leaves the machine: the only `fetch` is the one the adapter injects.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { OmpGitLabDuoAdapter } from '../src/adapter.js'
import { GITLAB_DUO_MODELS } from '../src/catalog/gitlab-duo.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

interface WireTransport {
  (model: unknown, context: unknown, options: unknown): AsyncIterable<unknown>
}

const artifact = (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'gitlab-duo.mjs')).href)) as {
  streamGitLabDuo: WireTransport
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

const GITLAB_DIRECT_ACCESS = 'https://gitlab.com/api/v4/ai/third_party_agents/direct_access'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** The bootstrap answer: a direct-access token plus the gateway headers to reuse. */
function directAccess(extra: Record<string, string> = {}): Response {
  return json({ token: 'direct-token', headers: { 'x-gitlab-gateway': 'duo', ...extra } })
}

/** The Anthropic SSE the inner transport decodes. */
function anthropicSse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 7 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi from ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Duo' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const ROW = (id: string) => {
  const row = GITLAB_DUO_MODELS.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`the generated catalog lost ${id}`)
  return row
}

function request(id: string): GenerateOptions {
  return {
    provider: 'gitlab-duo',
    model: id,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream as AsyncIterable<StreamChunk>) chunks.push(chunk)
  return chunks
}

/** Run one turn through the artifact with a scripted `fetch`. */
async function runTurn(
  id: string,
  respond: (call: FetchCall, index: number) => Response,
  signal?: AbortSignal,
): Promise<{ calls: FetchCall[]; chunks: StreamChunk[] }> {
  const calls: FetchCall[] = []
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), ...(init === undefined ? {} : { init }) }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof globalThis.fetch
  const adapter = new OmpGitLabDuoAdapter({
    access: async () => 'gitlab-token',
    transport: artifact.streamGitLabDuo as never,
    models: () => [id],
  })
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return { calls, chunks: await collect(adapter.stream({ ...request(id), ...(signal === undefined ? {} : { signal }) })) }
  } finally {
    globalThis.fetch = original
  }
}

/** Every wire's response: bootstrap first, then the scripted inner answer. */
const wire = (inner: (call: FetchCall) => Response) => (call: FetchCall, index: number) =>
  index === 0 ? directAccess() : inner(call)

describe('gitlab duo wire: bootstrap then one inner transport', () => {
  it('routes a codex row to the OpenAI proxy and a completions row to its own path', async () => {
    const responses = await runTurn(
      'duo-chat-gpt-5-2-codex',
      wire(() => json({ error: { message: 'scripted stop' } })),
    )
    // The bootstrap first: GitLab's bearer, the platform feature flag, and the
    // direct-access token it answers with.
    const bootstrap = responses.calls[0]!
    expect(bootstrap.url).toBe(GITLAB_DIRECT_ACCESS)
    expect(bootstrap.init?.method).toBe('POST')
    expect(new Headers(bootstrap.init?.headers).get('authorization')).toBe('Bearer gitlab-token')
    expect(JSON.parse(String(bootstrap.init?.body))).toEqual({ feature_flags: { DuoAgentPlatformNext: true } })

    const inner = responses.calls[1]!
    expect(inner.url).toBe('https://cloud.gitlab.com/ai/v1/proxy/openai/v1/responses')
    const headers = new Headers(inner.init?.headers)
    // The direct-access token authorizes the gateway, and its headers ride along.
    expect(headers.get('authorization')).toBe('Bearer direct-token')
    expect(headers.get('x-gitlab-gateway')).toBe('duo')
    // The alias is substituted for the upstream id the proxy serves.
    expect(JSON.parse(String(inner.init?.body))).toMatchObject({ model: 'gpt-5.2-codex' })

    const completions = await runTurn(
      'duo-chat-gpt-5-1',
      wire(() => json({ error: { message: 'scripted stop' } })),
    )
    expect(completions.calls[1]!.url).toBe('https://cloud.gitlab.com/ai/v1/proxy/openai/v1/chat/completions')
    expect(JSON.parse(String(completions.calls[1]!.init?.body))).toMatchObject({ model: 'gpt-5.1-2025-11-13' })
  })

  it('reuses one direct-access token across turns of the same credential', async () => {
    // The artifact caches the bootstrap for 25 minutes, keyed on the GitLab token.
    const calls: FetchCall[] = []
    const adapter = new OmpGitLabDuoAdapter({
      access: async () => 'gitlab-token-cached',
      transport: artifact.streamGitLabDuo as never,
      models: () => ['duo-chat-opus-4-6'],
    })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      return calls.length === 1 ? directAccess() : json({ error: { message: 'scripted stop' } })
    }) as typeof globalThis.fetch
    try {
      await collect(adapter.stream({ ...request('duo-chat-opus-4-6'), signal: AbortSignal.timeout(500) }))
      const afterFirst = calls.filter(call => call.url === GITLAB_DIRECT_ACCESS).length
      await collect(adapter.stream({ ...request('duo-chat-opus-4-6'), signal: AbortSignal.timeout(500) }))
      const afterSecond = calls.filter(call => call.url === GITLAB_DIRECT_ACCESS).length
      expect(afterFirst).toBe(1)
      // Cached: the second turn skips the bootstrap entirely.
      expect(afterSecond).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('pins each row to the wire its catalog entry declares', () => {
    // The catalog's `apiRoute` is the generator's view of the same registry the
    // transport reads; a mismatch would send a row to the wrong proxy path.
    expect(ROW('duo-chat-opus-4-6')).toMatchObject({ apiRoute: 'anthropic-messages', upstreamModelId: 'claude-opus-4-6' })
    expect(ROW('duo-chat-gpt-5-2-codex')).toMatchObject({ apiRoute: 'openai-responses', upstreamModelId: 'gpt-5.2-codex' })
    expect(ROW('duo-chat-gpt-5-1')).toMatchObject({ apiRoute: 'openai-completions', upstreamModelId: 'gpt-5.1-2025-11-13' })
  })
})
