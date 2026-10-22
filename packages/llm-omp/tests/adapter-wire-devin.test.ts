/**
 * Wire-level tests: real Connect frames through the **real bundled**
 * `streamDevin`.
 *
 * The bundle is imported from `lib/omp/devin.mjs` (built from the pinned omp
 * sources) and only the global `fetch` is stubbed: the handshake answers a bare
 * protobuf `GetUserJwtResponse`, the chat call answers a Connect stream of
 * `GetChatMessageResponse` frames. That keeps the test offline while exercising
 * the artifact's own gzip request encoding, Connect frame decoding, tool-call
 * accumulation, trailer handling and terminal events — the pieces an
 * event-level fixture cannot prove.
 *
 * Frames are built with the installed `@oh-my-pi/pi-catalog` protobuf codecs, so
 * the fixture data is readable and the bytes on the wire are genuine
 * `exa.*` messages.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

import type { GetChatMessageResponse } from '@oh-my-pi/pi-catalog/discovery/devin-proto'
import {
  ChatMessageSource,
  ChatToolCallSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  ModelUsageStatsSchema,
  StopReason,
} from '@oh-my-pi/pi-catalog/discovery/devin-proto'
import { create, fromBinary, toBinary } from '@oh-my-pi/pi-catalog/discovery/protobuf'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The installed protobuf runtime imports only `isRecord` from pi-utils, but that
// package's entry point touches the Bun runtime at load. The fixture builder
// needs the codec, not the runtime, so stand the import in with the one predicate.
vi.mock('@oh-my-pi/pi-utils', () => ({
  isRecord: (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value),
}))

import { DEVIN_MODELS } from '../src/catalog/devin.js'
import { OmpDevinAdapter } from '../src/adapter.js'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { OmpAssistantMessageEvent, OmpContext, OmpDevinModel, OmpDevinOptions } from '../src/omp.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

/** Connect's compression and end-stream flags. */
const CONNECT_COMPRESSED_FLAG = 0x01
const CONNECT_END_STREAM_FLAG = 0x02

/** The pinned bundle's own cap; a header above it must fail the turn. */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024

const ROW = DEVIN_MODELS.find(row => row.id === 'swe-1-6')
if (ROW === undefined) throw new Error('the generated catalog lost swe-1-6')
const MODEL: OmpDevinModel = { api: 'devin-agent', provider: 'devin', ...ROW }

type WireTransport = (
  model: OmpDevinModel,
  context: OmpContext,
  options: OmpDevinOptions,
) => AsyncIterable<OmpAssistantMessageEvent>

const artifact = (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'devin.mjs')).href)) as {
  streamDevin: WireTransport
}

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

/** Wrap one payload in the Connect streaming envelope. */
function frameConnect(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = flags
  frame.writeUInt32BE(payload.length, 1)
  frame.set(payload, 5)
  return frame
}

/** One gzip-compressed `GetChatMessageResponse` frame. */
function serverFrame(message: Partial<GetChatMessageResponse>): Buffer {
  const payload = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, message))
  return frameConnect(gzipSync(payload), CONNECT_COMPRESSED_FLAG)
}

/** One Connect end-stream trailer frame (JSON error envelope). */
function trailerFrame(trailer: unknown): Buffer {
  return frameConnect(Buffer.from(JSON.stringify(trailer)), CONNECT_END_STREAM_FLAG)
}

/** A response body that yields the given frames and then closes. */
function frameStream(frames: readonly Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new Uint8Array(frame))
      controller.close()
    },
  })
}

/** The handshake response: a bare protobuf body, no Connect envelope. */
function authResponse(userJwt = 'user-jwt-1'): Response {
  return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt })))
}

/** A text-only streamed turn: two deltas, usage, then the terminal stop reason. */
function textStream(): Response {
  return new Response(
    frameStream([
      serverFrame({ messageId: 'msg-1', deltaText: 'Hello ' }),
      serverFrame({ messageId: 'msg-1', deltaText: 'from Devin' }),
      serverFrame({
        messageId: 'msg-1',
        stopReason: StopReason.STOP_PATTERN,
        usage: create(ModelUsageStatsSchema, {
          inputTokens: 100n,
          outputTokens: 5n,
          cacheReadTokens: 10n,
          cacheWriteTokens: 0n,
        }),
      }),
    ]),
  )
}

function adapterFor(respond: (call: FetchCall) => Response | Promise<Response>): {
  adapter: OmpDevinAdapter
  calls: FetchCall[]
} {
  const calls = stubFetch(respond)
  const adapter = new OmpDevinAdapter({
    access: async () => 'session-token',
    transport: artifact.streamDevin,
  })
  return { adapter, calls }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function request(): Parameters<OmpDevinAdapter['stream']>[0] {
  return {
    provider: 'devin',
    model: 'swe-1-6',
    system: 'You are terse.',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    maxTokens: 512,
    temperature: 0.2,
    stop: ['END'],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bundled devin transport over Connect frames', () => {
  it('handshakes with the CLI identity, keeps connect-go on chat and decodes the gzip request', async () => {
    const { adapter, calls } = adapterFor(call =>
      call.url.endsWith('/exa.auth_pb.AuthService/GetUserJwt') ? authResponse() : textStream(),
    )

    const chunks = await collect(adapter.stream(request()))

    expect(calls).toHaveLength(2)
    // 1. The handshake: bare protobuf, the CLI metadata tuple, the session
    //    token with its required scheme prefix, and DSH's attribution header
    //    (the request itself sends none, so the fill-absent wrapper adds it).
    const handshake = calls[0]!
    expect(handshake.url).toBe('https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt')
    expect(handshake.init?.method).toBe('POST')
    expect(new Headers(handshake.init?.headers).get('content-type')).toBe('application/proto')
    expect(new Headers(handshake.init?.headers).get('user-agent')).toBe(attributionHeaders()['user-agent'])
    const authRequest = fromBinary(GetUserJwtRequestSchema, new Uint8Array(handshake.init?.body as Buffer))
    expect(authRequest.metadata).toMatchObject({
      apiKey: 'devin-session-token$session-token',
      ideName: 'devin-cli',
      ideType: 'chisel',
      ideVersion: '3000.11.3',
      extensionName: 'chisel',
    })

    // 2. The chat call: one gzip-compressed Connect frame, the transport's own
    //    client identity untouched, and the projected request inside.
    const chat = calls[1]!
    expect(chat.url).toBe('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage')
    const chatHeaders = new Headers(chat.init?.headers)
    expect(chatHeaders.get('content-type')).toBe('application/connect+proto')
    expect(chatHeaders.get('connect-content-encoding')).toBe('gzip')
    expect(chatHeaders.get('user-agent')).toBe('connect-go/1.18.1 (go1.26.3)')

    const body = Buffer.from(chat.init?.body as Buffer)
    expect(body[0]).toBe(CONNECT_COMPRESSED_FLAG)
    const declared = body.readUInt32BE(1)
    expect(declared).toBe(body.byteLength - 5)
    const chatRequest = fromBinary(GetChatMessageRequestSchema, new Uint8Array(gunzipSync(body.subarray(5))))
    expect(chatRequest.prompt).toBe('You are terse.')
    expect(chatRequest.chatModelUid).toBe('swe-1-6')
    expect(chatRequest.metadata?.userJwt).toBe('user-jwt-1')
    expect(chatRequest.chatMessagePrompts.map(prompt => ({ source: prompt.source, prompt: prompt.prompt }))).toEqual([
      { source: ChatMessageSource.USER, prompt: 'Hello' },
    ])
    expect(chatRequest.configuration).toMatchObject({
      maxTokens: 512n,
      temperature: 0.2,
      stopPatterns: ['END'],
    })

    // 3. The frames become the adapter's chunks and a clean stop.
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'from Devin' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello from Devin' } },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 115, cacheReadTokens: 10 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams a tool call and finishes the turn as tool-calls', async () => {
    const { adapter } = adapterFor(call =>
      call.url.endsWith('/exa.auth_pb.AuthService/GetUserJwt')
        ? authResponse()
        : new Response(
            frameStream([
              serverFrame({
                messageId: 'msg-2',
                deltaToolCalls: [
                  create(ChatToolCallSchema, { id: 'call-1', name: 'lookup_doc', argumentsJson: '{"query":"hello"}' }),
                ],
              }),
              serverFrame({ messageId: 'msg-2' }),
            ]),
          ),
    )

    const chunks = await collect(adapter.stream(request()))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
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

  it('turns a Connect trailer error into a classified error finish', async () => {
    const { adapter } = adapterFor(call =>
      call.url.endsWith('/exa.auth_pb.AuthService/GetUserJwt')
        ? authResponse()
        : new Response(frameStream([trailerFrame({ error: { code: 'permission_denied', message: 'not allowed' } })])),
    )

    const chunks = await collect(adapter.stream(request()))

    // The trailer carries no HTTP status, so the bundle reports an unclassified
    // provider failure and the projection's devin fallback names it.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'PROVIDER_ERROR', message: expect.stringContaining('permission_denied') },
      },
    })
  })

  it('fails an oversize frame header with the server code', async () => {
    const header = Buffer.alloc(5)
    header[0] = 0
    header.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD + 1, 1)
    const { adapter } = adapterFor(call =>
      call.url.endsWith('/exa.auth_pb.AuthService/GetUserJwt') ? authResponse() : new Response(frameStream([header])),
    )

    const chunks = await collect(adapter.stream(request()))

    // The frame decoder's cap error carries no HTTP status either, so the
    // transport surfaces it as an unclassified provider failure.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: expect.stringContaining('cap') } },
    })
  })

  it('classifies an HTTP handshake failure before any chat request', async () => {
    const { adapter, calls } = adapterFor(() => new Response('unauthorized', { status: 401 }))

    const chunks = await collect(adapter.stream(request()))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', status: 401 } } })
    // A 401 handshake is retried once with the raw key (omp's documented
    // second attempt), and no chat request follows a failed handshake.
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url.endsWith('/exa.auth_pb.AuthService/GetUserJwt'))).toBe(true)
    const retry = fromBinary(GetUserJwtRequestSchema, new Uint8Array(calls[1]!.init?.body as Buffer))
    expect(retry.metadata?.apiKey).toBe('session-token')
  })
})
