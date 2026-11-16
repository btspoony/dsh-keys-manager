/**
 * Wire-level tests: real Cloud Code Assist frames through the **real bundled**
 * `streamGoogleGeminiCli`.
 *
 * The bundle is imported from `lib/omp/google.mjs` (built from the pinned omp
 * sources) and only the global `fetch` is stubbed: the transport builds the
 * request, sets the vendor client identity, parses the SSE stream and assembles
 * the terminal message. That exercises the pieces an event-level fixture cannot
 * prove — the URL, the body envelope, the header policy, the SSE decoder, the
 * in-band error mapping and Antigravity's daily→sandbox failover.
 *
 * Nothing leaves the machine: one scripted manifest response and one scripted
 * SSE body per route.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ReasoningEffortId, attributionHeaders, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OmpGoogleGeminiCliAdapter } from '../src/adapter.js'
import { GOOGLE_GEMINI_CLI_MODELS } from '../src/catalog/google-gemini-cli.js'
import type { OmpAssistantMessageEvent, OmpContext, OmpGoogleModel, OmpGoogleOptions } from '../src/omp.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

const GEMINI_CLI = 'https://cloudcode-pa.googleapis.com'
const PATH = '/v1internal:streamGenerateContent?alt=sse'

const GEMINI_MODEL = GOOGLE_GEMINI_CLI_MODELS.find(row => row.id === 'gemini-2.5-pro')
if (GEMINI_MODEL === undefined) throw new Error('the generated catalog lost gemini-2.5-pro')

type WireTransport = (
  model: OmpGoogleModel,
  context: OmpContext,
  options: OmpGoogleOptions,
) => AsyncIterable<OmpAssistantMessageEvent>

let artifact: { streamGoogleGeminiCli: WireTransport }

/** Load (or reload) the bundled artifact, so a manifest test starts cache-free. */
async function loadArtifact(): Promise<{ streamGoogleGeminiCli: WireTransport }> {
  vi.resetModules()
  return (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'google.mjs')).href)) as {
    streamGoogleGeminiCli: WireTransport
  }
}

artifact = await loadArtifact()

/** One request the stubbed `fetch` saw. */
interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  })
  return calls
}

/** One SSE body from a list of JSON chunks, as Cloud Code Assist frames them. */
function sse(chunks: readonly unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A text turn with a thinking part first, usage, and the terminal finish reason. */
function textChunks(): unknown[] {
  return [
    { response: { responseId: 'resp-1', candidates: [{ content: { parts: [{ text: 'The user ', thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: 'greets me.', thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: 'from Gemini' }] } }] } },
    {
      response: {
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 10,
          cachedContentTokenCount: 200,
          totalTokenCount: 1240,
        },
      },
    },
  ]
}

/** The credential envelope the resolver hands the adapter, as JSON. */
const ENVELOPE = JSON.stringify({
  token: 'access-token',
  projectId: 'project-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
})

function geminiAdapter(): OmpGoogleGeminiCliAdapter {
  return new OmpGoogleGeminiCliAdapter({
    access: async () => ENVELOPE,
    transport: artifact.streamGoogleGeminiCli,
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function request(
  provider: 'google-gemini-cli',
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return {
    provider,
    model: 'gemini-2.5-pro',
    system: 'You are terse.',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    // Both pinned rows require an explicit effort; `high` also routes the
    // Antigravity row onto the captured `gemini-pro-agent` wire profile.
    reasoningEffort: ReasoningEffortId('high'),
    ...extra,
  }
}

/** The Cloud Code Assist request body as the transport serialised it. */
interface GoogleRequestBody {
  readonly project: string
  readonly model: string
  readonly requestId?: string
  readonly request: {
    readonly contents: readonly { role: string; parts: readonly Record<string, unknown>[] }[]
    readonly systemInstruction?: { readonly parts: readonly { text: string }[] }
    readonly generationConfig?: Record<string, Record<string, unknown> | number>
    readonly toolConfig?: { readonly functionCallingConfig: { readonly mode: string } }
    readonly labels?: Record<string, string>
    readonly sessionId?: string
  }
}

function bodyOf(call: FetchCall): GoogleRequestBody {
  return JSON.parse(String(call.init?.body)) as GoogleRequestBody
}

beforeEach(() => {
  // The manifest lookup is proven by its own test; every other case pins the
  // captured version so no request depends on module-level discovery state.
  vi.stubEnv('PI_AI_ANTIGRAVITY_VERSION', '2.19.1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('bundled Google transport over Cloud Code Assist SSE', () => {
  it('sends the Gemini CLI identity and decodes thinking, text and usage', async () => {
    const calls = stubFetch(() => sse(textChunks()))

    const chunks = await collect(geminiAdapter().stream(request('google-gemini-cli')))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`${GEMINI_CLI}${PATH}`)
    expect(call.init?.method).toBe('POST')

    // The vendor identity is the one on the wire: attribution rides the
    // fill-absent wrapper, which must not overwrite `user-agent`.
    const headers = new Headers(call.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer access-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('text/event-stream')
    expect(headers.get('user-agent')).toBe(
      `GeminiCLI/0.46.0/gemini-2.5-pro (${process.platform}; ${process.arch}; terminal)`,
    )
    // D10: the vendor identity is not overwritten by DSH attribution.
    expect(headers.get('user-agent')).not.toBe(attributionHeaders()['user-agent'])
    expect(headers.get('client-metadata')).toBe(
      'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
    )

    const body = bodyOf(call)
    expect(body.project).toBe('project-1')
    expect(body.model).toBe('gemini-2.5-pro')
    expect(body.request.systemInstruction?.parts).toEqual([{ text: 'You are terse.' }])
    expect(body.request.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }])
    expect(body.request.generationConfig?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingBudget: expect.any(Number),
    })

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
        usage: { inputTokens: 1000, outputTokens: 40, totalTokens: 1240, cacheReadTokens: 200, reasoningTokens: 10 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })


  it('hands a server function call to DSH as a tool-calls finish', async () => {
    stubFetch(() =>
      sse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { id: 'call-1', name: 'lookup_doc', args: { query: 'hello' } } }],
                },
                finishReason: 'STOP',
              },
            ],
          },
        },
      ]),
    )

    const chunks = await collect(geminiAdapter().stream(request('google-gemini-cli')))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      // The provider streams the assembled arguments in one delta; the adapter
      // forwards it rather than synthesising a second call.
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call-1',
        name: 'lookup_doc',
        argumentsDelta: '{"query":"hello"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-1', name: 'lookup_doc', arguments: '{"query":"hello"}' },
      },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('classifies an in-band 403 as an auth failure with its status', async () => {
    stubFetch(() => sse([{ error: { code: 403, message: 'PERMISSION_DENIED: caller lacks access' } }]))

    const chunks = await collect(geminiAdapter().stream(request('google-gemini-cli')))

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'AUTH', status: 403, message: expect.stringContaining('PERMISSION_DENIED') },
      },
    })
  })

  it('classifies a 401 response as an auth failure without retrying a vendor identity', async () => {
    const calls = stubFetch(
      () => new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401 }),
    )

    const chunks = await collect(geminiAdapter().stream(request('google-gemini-cli')))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
    // One identity per attempt: the transport never retries under another client.
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init?.headers).get('user-agent')).toMatch(/^GeminiCLI\//)
  })

  it('reports a content-blocked prompt as a provider error naming the block reason', async () => {
    stubFetch(() => sse([{ response: { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'unsafe' } } }]))

    const chunks = await collect(geminiAdapter().stream(request('google-gemini-cli')))

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: expect.stringContaining('SAFETY') } },
    })
  })
})
