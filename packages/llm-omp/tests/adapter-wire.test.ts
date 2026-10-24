/**
 * Wire-level tests: recorded `agent.v1.AgentService/Run` Connect frame streams
 * driven through the **real bundled** `streamCursor`.
 *
 * The bundle is imported from `lib/omp/cursor.mjs` (built from the pinned omp
 * sources) and only `node:http2` is stubbed: `http2.connect` returns a fake
 * session whose single request stream replays the fixture's frames and then
 * ends. That keeps the test offline while exercising the artifact's own Connect
 * decoding, exec-frame handling, usage accounting and terminal events — the
 * pieces an event-level fixture cannot prove.
 *
 * Frames are built with the installed `@oh-my-pi/pi-catalog` protobuf codecs,
 * so the fixture text is a readable script and the bytes on the wire are
 * genuine `agent.v1` messages.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  GrepArgsSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  ReadArgsSchema,
  RequestContextArgsSchema,
  ShellArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  WriteArgsSchema,
} from '@oh-my-pi/pi-catalog/discovery/cursor-proto'
import type { AgentClientMessage, AgentServerMessage, McpResult } from '@oh-my-pi/pi-catalog/discovery/cursor-proto'
import { create, encodeJsonValue, fromBinary, toBinary } from '@oh-my-pi/pi-catalog/discovery/protobuf'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The installed protobuf runtime imports only `isRecord` from pi-utils, but that
// package's entry point touches the Bun runtime at load. The fixture builder
// needs the codec, not the runtime, so stand the import in with the one predicate.
vi.mock('@oh-my-pi/pi-utils', () => ({
  isRecord: (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value),
}))

import { CURSOR_MODELS } from '../src/catalog/cursor.js'
import type { OmpAssistantMessageEvent, OmpCursorContext, OmpCursorModel, OmpCursorOptions } from '../src/omp.js'
import { projectEvents, projectRequest } from '../src/projection.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)
const fixturesDir = join(testsDir, 'fixtures')

/** Connect's end-stream flag: the payload is a JSON trailer, not a protobuf message. */
const CONNECT_END_STREAM_FLAG = 0x02

/** The exact text the real transport answers an externally executed MCP call with. */
const HANDOFF_TEXT =
  'Tool call received and handed off to the external client for execution. Do not retry or call it again; end the turn. The result will be provided in the next request.'

/** A host-supplied `execHandlers.read` result: the handler returns a tool result. */
const localReadResult = {
  role: 'toolResult',
  toolCallId: 'call-native-1',
  toolName: 'read',
  content: [{ type: 'text', text: 'file body' }],
  isError: false,
  timestamp: 0,
}

const SONNET_ROW = CURSOR_MODELS.find(row => row.id === 'claude-4.5-sonnet')
if (SONNET_ROW === undefined) throw new Error('the generated catalog lost claude-4.5-sonnet')
const MODEL: OmpCursorModel = { api: 'cursor-agent', provider: 'cursor', ...SONNET_ROW }

const artifact = (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'cursor.mjs')).href)) as {
  streamCursor: (
    model: OmpCursorModel,
    context: OmpCursorContext,
    options: OmpCursorOptions,
  ) => AsyncIterable<OmpAssistantMessageEvent>
}

/** One line of a wire fixture: a server behaviour, not yet a frame. */
type WireLine =
  | { kind: 'text'; text: string }
  | {
      kind: 'turnEnded'
      usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    }
  | {
      kind: 'exec'
      /** Which exec frame to send; `mcp` is Cursor's call for an advertised tool. */
      frame?: 'mcp' | 'read' | 'shell' | 'grep' | 'write' | 'delete'
      name: string
      toolName: string
      toolCallId: string
      args: Record<string, string | number | boolean>
    }
  | { kind: 'end' }
  | { kind: 'error'; code: string; message: string }
  /** The server asks for rules/tools before it issues calls. */
  | { kind: 'requestContext' }

function readScript(name: string): WireLine[] {
  return readFileSync(join(fixturesDir, name), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as WireLine)
}

/** Wrap one payload in the Connect streaming envelope. */
function frameConnect(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = flags
  frame.writeUInt32BE(payload.length, 1)
  frame.set(payload, 5)
  return frame
}

/** Encode one protobuf server message inside a Connect frame. */
function serverFrame(message: AgentServerMessage): Buffer {
  return frameConnect(toBinary(AgentServerMessageSchema, message))
}

/** Build the Connect frame a fixture line describes. */
function frameFor(line: WireLine): Buffer {
  switch (line.kind) {
    case 'text': {
      const update = create(InteractionUpdateSchema, {
        message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: line.text }) },
      })
      return serverFrame(
        create(AgentServerMessageSchema, { message: { case: 'interactionUpdate', value: update } }),
      )
    }
    case 'turnEnded': {
      const update = create(InteractionUpdateSchema, {
        message: {
          case: 'turnEnded',
          value: create(TurnEndedUpdateSchema, {
            ...(line.usage.inputTokens !== undefined ? { inputTokens: BigInt(line.usage.inputTokens) } : {}),
            ...(line.usage.outputTokens !== undefined ? { outputTokens: BigInt(line.usage.outputTokens) } : {}),
            ...(line.usage.cacheReadTokens !== undefined ? { cacheReadTokens: BigInt(line.usage.cacheReadTokens) } : {}),
            ...(line.usage.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: BigInt(line.usage.cacheWriteTokens) }
              : {}),
          }),
        },
      })
      return serverFrame(
        create(AgentServerMessageSchema, { message: { case: 'interactionUpdate', value: update } }),
      )
    }
    case 'exec': {
      // Native exec frames: the server asks the client to run a tool locally.
      if (line.frame !== undefined && line.frame !== 'mcp') {
        // One builder per native frame; values carry only the fields each
        // frame's schema needs (`toolCallId` is common to all of them).
        const toolCallId = line.toolCallId
        const nativeMessage = (() => {
          switch (line.frame) {
            case 'read':
              return { case: 'readArgs' as const, value: create(ReadArgsSchema, { toolCallId, path: String(line.args.path ?? '') }) }
            case 'shell':
              return {
                case: 'shellArgs' as const,
                value: create(ShellArgsSchema, { toolCallId, command: String(line.args.command ?? ''), workingDirectory: String(line.args.workingDirectory ?? '') }),
              }
            case 'grep':
              return {
                case: 'grepArgs' as const,
                value: create(GrepArgsSchema, { toolCallId, pattern: String(line.args.pattern ?? ''), path: line.args.path === undefined ? undefined : String(line.args.path), glob: line.args.glob === undefined ? undefined : String(line.args.glob) }),
              }
            case 'write':
              return {
                case: 'writeArgs' as const,
                value: create(WriteArgsSchema, { toolCallId, path: String(line.args.path ?? ''), fileText: String(line.args.fileText ?? '') }),
              }
            case 'delete':
              return { case: 'deleteArgs' as const, value: create(DeleteArgsSchema, { toolCallId, path: String(line.args.path ?? '') }) }
          }
        })()
        const exec = create(ExecServerMessageSchema, {
          id: 1,
          execId: 'exec-frame-1',
          message: nativeMessage,
        })
        return serverFrame(
          create(AgentServerMessageSchema, { message: { case: 'execServerMessage', value: exec } }),
        )
      }
      const args = Object.fromEntries(
        Object.entries(line.args).map(([key, value]) => [key, encodeJsonValue(value)]),
      )
      const exec = create(ExecServerMessageSchema, {
        id: 1,
        execId: 'exec-frame-1',
        message: {
          case: 'mcpArgs',
          value: create(McpArgsSchema, {
            name: line.name,
            toolName: line.toolName,
            toolCallId: line.toolCallId,
            providerIdentifier: 'pi-agent',
            args,
          }),
        },
      })
      return serverFrame(
        create(AgentServerMessageSchema, { message: { case: 'execServerMessage', value: exec } }),
      )
    }
    case 'end':
      return frameConnect(new TextEncoder().encode('{}'), CONNECT_END_STREAM_FLAG)
    case 'requestContext': {
      const exec = create(ExecServerMessageSchema, {
        id: 2,
        execId: 'exec-context-1',
        message: { case: 'requestContextArgs', value: create(RequestContextArgsSchema, {}) },
      })
      return serverFrame(
        create(AgentServerMessageSchema, { message: { case: 'execServerMessage', value: exec } }),
      )
    }
    case 'error':
      return frameConnect(
        new TextEncoder().encode(JSON.stringify({ error: { code: line.code, message: line.message } })),
        CONNECT_END_STREAM_FLAG,
      )
  }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Decode one client frame the transport wrote (Connect envelope + protobuf). */
function decodeClientFrame(frame: Buffer): AgentClientMessage {
  return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + frame.readUInt32BE(1)))
}

interface FakeWire {
  readonly written: Buffer[]
  readonly connectCalls: number
  restore(): void
}

let wire: FakeWire | undefined

afterEach(() => {
  wire?.restore()
  wire = undefined
})

/**
 * Stub `http2.connect` with one session whose request stream replays `lines`.
 *
 * Frames are delivered one macrotask apart so the transport's own microtasks
 * (notably the async exec handoff reply) run between them, and the first frame
 * is split across two chunks to exercise Connect reassembly.
 */
function stubWire(lines: readonly WireLine[]): FakeWire {
  const written: Buffer[] = []
  const original = http2.connect
  let connectCalls = 0

  const stream = Object.assign(new EventEmitter(), {
    closed: false,
    writableEnded: false,
    write(chunk: Buffer): void {
      written.push(Buffer.from(chunk))
    },
    end(): void {
      this.writableEnded = true
    },
    close(): void {
      this.closed = true
    },
  })

  const session = Object.assign(new EventEmitter(), {
    request: () => stream,
    close: (): void => {},
  })

  ;(http2 as { connect: unknown }).connect = () => {
    connectCalls += 1
    void (async () => {
      await tick()
      stream.emit('response', { ':status': '200' })
      for (const [index, line] of lines.entries()) {
        const frame = frameFor(line)
        if (index === 0) {
          stream.emit('data', frame.subarray(0, 3))
          await tick()
          stream.emit('data', frame.subarray(3))
        } else {
          stream.emit('data', frame)
        }
        await tick()
      }
      stream.emit('end')
    })()
    return session
  }

  return {
    written,
    get connectCalls(): number {
      return connectCalls
    },
    restore(): void {
      ;(http2 as { connect: unknown }).connect = original
    },
  }
}

async function run(
  fixture: string,
  extra: Partial<OmpCursorOptions> = {},
  contextExtra: Partial<OmpCursorContext> = {},
): Promise<{ events: OmpAssistantMessageEvent[]; wire: FakeWire }> {
  wire = stubWire(readScript(fixture))
  const events: OmpAssistantMessageEvent[] = []
  const stream = artifact.streamCursor(
    MODEL,
    {
      systemPrompt: ['You are terse.'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }],
      ...contextExtra,
    },
    { apiKey: 'test-token', sessionId: 'wire-session', ...extra },
  )
  for await (const event of stream) events.push(event)
  return { events, wire }
}

describe('bundled streamCursor over a Connect frame stream', () => {
  it('decodes text deltas and turnEnded usage, then ends the turn', async () => {
    const { events } = await run('cursor-wire-text.jsonl')

    expect(events.map(event => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'done',
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'stop',
      message: {
        content: [{ type: 'text', text: 'Hello from the wire' }],
        // turnEnded input is the aggregate prompt count; cache reads are
        // subtracted so the seam's counters stay disjoint.
        usage: { input: 1180, output: 34, cacheRead: 20, totalTokens: 1234 },
      },
    })
  })

  it('maps a Connect end-stream error without retrying', async () => {
    const { events, wire } = await run('cursor-wire-error.jsonl')

    expect(events.map(event => event.type)).toEqual(['start', 'error'])
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: { errorMessage: expect.stringContaining('permission_denied') },
    })
    // A terminal Connect error must not be replayed: the fake saw one connect.
    expect(wire.connectCalls).toBe(1)
  })

  it('advertises the DSH tool and answers an mcpArgs frame with the handoff result', async () => {
    const { events, wire } = await run(
      'cursor-wire-handoff.jsonl',
      { externalToolExecutor: true },
      { tools: [{ name: 'lookup_doc', description: 'Look up a document', parameters: { type: 'object' } }] },
    )

    expect(events.map(event => event.type)).toEqual(['start', 'toolcall_start', 'toolcall_end', 'done'])
    expect(events[2]).toMatchObject({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'call-wire-1', name: 'lookup_doc', arguments: { query: 'hello' } },
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })

    // Frame 0 is the Run request; frames 1 and 2 are the two exec replies.
    expect(decodeClientFrame(wire.written[0]).message.case).toBe('runRequest')

    // Frame 1 answers the server's requestContext handshake with the DSH tool
    // declaration list — this is how tools reach Cursor's MCP view.
    const contextReply = decodeClientFrame(wire.written[1])
    expect(contextReply.message.case).toBe('execClientMessage')
    const contextClient =
      contextReply.message.case === 'execClientMessage' ? contextReply.message.value : undefined
    expect(contextClient).toMatchObject({ id: 2, execId: 'exec-context-1' })
    expect(contextClient?.message.case).toBe('requestContextResult')
    const contextResult = (contextClient?.message.case === 'requestContextResult'
      ? contextClient.message.value
      : undefined) as { result: { case?: string; value?: { requestContext?: { tools: { toolName: string }[] } } } }
    expect(contextResult.result.case).toBe('success')
    expect((contextResult.result.value?.requestContext?.tools ?? []).map(tool => tool.toolName)).toEqual([
      'lookup_doc',
    ])

    // Frame 2 is the exec reply: success carrying the handoff marker, not an
    // adapter-side execution.
    const reply = decodeClientFrame(wire.written[2])
    expect(reply.message.case).toBe('execClientMessage')
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client).toMatchObject({ id: 1, execId: 'exec-frame-1' })
    expect(client?.message.case).toBe('mcpResult')
    const result = (client?.message.case === 'mcpResult' ? client.message.value : undefined) as McpResult | undefined
    expect(result?.result.case).toBe('success')
    const success = (result?.result.case === 'success' ? result.result.value : undefined) as {
      isError: boolean
      content: { content: { case?: string; value?: { text?: string } } }[]
    }
    expect(success.isError).toBe(false)
    expect(success.content).toHaveLength(1)
    expect(success.content[0].content.case).toBe('text')
    expect(success.content[0].content.value?.text).toBe(HANDOFF_TEXT)
  })

  it('advertises a colliding DSH tool under its alias and hands the aliased call back as the DSH name', async () => {
    // The pinned transport filters `read` out of the MCP list, so the
    // projection advertises `dsh_read`; the server calls that name, and the
    // projection restores the DSH one for the tool loop.
    const projected = projectRequest(SONNET_ROW, {
      provider: 'cursor',
      model: 'claude-4.5-sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Read README.md' }], source: { kind: 'user' } })],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    })
    const { events, wire } = await run(
      'cursor-wire-handoff-alias.jsonl',
      { externalToolExecutor: true },
      { tools: projected.context.tools },
    )

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({ type: 'toolCall', name: 'dsh_read', arguments: { path: 'README.md' } })

    // The handshake advertises the alias, never the filtered native name.
    const contextReply = decodeClientFrame(wire.written[1])
    const contextClient =
      contextReply.message.case === 'execClientMessage' ? contextReply.message.value : undefined
    const contextResult = (contextClient?.message.case === 'requestContextResult'
      ? contextClient.message.value
      : undefined) as { result: { case?: string; value?: { requestContext?: { tools: { toolName: string }[] } } } }
    expect((contextResult.result.value?.requestContext?.tools ?? []).map(tool => tool.toolName)).toEqual(['dsh_read'])

    // The exec reply is the handoff, not an adapter-side execution.
    const reply = decodeClientFrame(wire.written[2])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    const result = (client?.message.case === 'mcpResult' ? client.message.value : undefined) as McpResult | undefined
    const success = (result?.result.case === 'success' ? result.result.value : undefined) as {
      content: { content: { value?: { text?: string } } }[]
    }
    expect(success.content[0].content.value?.text).toBe(HANDOFF_TEXT)

    // Through the projection, DSH gets the tool it declared.
    const chunks: StreamChunk[] = []
    for await (const chunk of projectEvents(
      (async function* () {
        yield* events
      })(),
    )) {
      chunks.push(chunk)
    }
    const blockEnd = chunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end',
    )
    expect(blockEnd?.block).toMatchObject({ type: 'tool-call', name: 'read' })
  })

  it('hands a native read frame to DSH as an unresolved tool call and answers with the handoff result', async () => {
    const { events, wire } = await run(
      'cursor-wire-native-read.jsonl',
      { externalToolExecutor: true },
      { tools: [{ name: 'lookup_doc', description: 'Look up a document', parameters: { type: 'object' } }] },
    )

    // The synthesized call carries no `cursorExecResolved` mark, so it is DSH's
    // to run; its arguments are in DSH's read-tool dialect.
    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({ type: 'toolCall', name: 'read', arguments: { file_path: 'README.md' } })
    expect(Object.getOwnPropertySymbols(call!).map(symbol => symbol.description)).not.toContain(
      'provider.block.cursorExecResolved',
    )

    // The exec reply is the handoff placeholder — schema-valid for ReadResult —
    // not an adapter-side execution result.
    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('readResult')
    const result = client?.message.case === 'readResult' ? (client.message.value as { result: { case?: string; value?: { reason?: string } } }) : undefined
    expect(result?.result.case).toBe('rejected')
    expect(result?.result.value?.reason).toBe(HANDOFF_TEXT)

    // Through the projection, DSH gets the unresolved tool call to run.
    const chunks: StreamChunk[] = []
    for await (const chunk of projectEvents(
      (async function* () {
        yield* events
      })(),
    )) {
      chunks.push(chunk)
    }
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(true)
  })

  it('hands a native shell frame to DSH with the working directory folded into the command', async () => {
    const { events, wire } = await run('cursor-wire-native-shell.jsonl', { externalToolExecutor: true })

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: { command: 'cd /tmp/demo && ls -la' },
    })

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('shellResult')
    const result =
      client?.message.case === 'shellResult'
        ? (client.message.value as { result: { case?: string; value?: { reason?: string } } })
        : undefined
    expect(result?.result.case).toBe('rejected')
    expect(result?.result.value?.reason).toBe(HANDOFF_TEXT)
  })

  it('hands a native grep frame to DSH with glob translated to include and the extra flags dropped', async () => {
    const { events, wire } = await run('cursor-wire-native-grep.jsonl', { externalToolExecutor: true })

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({
      type: 'toolCall',
      name: 'grep',
      arguments: { pattern: 'TODO', path: 'src', include: '*.ts' },
    })
    // case/skip/offset have no DSH slot: they must not leak into the arguments.
    expect(Object.keys(call!.arguments)).toEqual(['pattern', 'path', 'include'])

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('grepResult')
    const result =
      client?.message.case === 'grepResult'
        ? (client.message.value as { result: { case?: string; value?: { error?: string } } })
        : undefined
    expect(result?.result.case).toBe('error')
    expect(result?.result.value?.error).toBe(HANDOFF_TEXT)
  })

  it('hands a native write frame to DSH as file_path plus content', async () => {
    const { events, wire } = await run('cursor-wire-native-write.jsonl', { externalToolExecutor: true })

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({
      type: 'toolCall',
      name: 'write',
      arguments: { file_path: 'out.txt', content: 'hello' },
    })

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('writeResult')
    const result =
      client?.message.case === 'writeResult'
        ? (client.message.value as { result: { case?: string; value?: { reason?: string } } })
        : undefined
    expect(result?.result.case).toBe('rejected')
    expect(result?.result.value?.reason).toBe(HANDOFF_TEXT)
  })

  it('still rejects a native delete frame with no unresolved call for DSH', async () => {
    const { events, wire } = await run('cursor-wire-native-delete.jsonl', { externalToolExecutor: true })

    // Delete has no DSH equivalent: the block is stamped resolved (answered
    // locally as "Tool not available"), so DSH's projection sees no call.
    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(Object.getOwnPropertySymbols(call!).map(symbol => symbol.description)).toContain(
      'provider.block.cursorExecResolved',
    )
    const chunks: StreamChunk[] = []
    for await (const chunk of projectEvents(
      (async function* () {
        yield* events
      })(),
    )) {
      chunks.push(chunk)
    }
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('deleteResult')
    const result =
      client?.message.case === 'deleteResult'
        ? (client.message.value as { result: { case?: string; value?: { reason?: string } } })
        : undefined
    expect(result?.result.case).toBe('rejected')
    expect(result?.result.value?.reason).toBe('Tool not available')
  })

  it('keeps an explicit execHandlers.read winner local: resolved call, real result, no handoff', async () => {
    const { events, wire } = await run('cursor-wire-native-read.jsonl', {
      externalToolExecutor: true,
      // The adapter ships no exec handlers; a host that supplies one must keep
      // today's local-execution behaviour. (Not part of OmpCursorOptions —
      // the adapter never sets it — so the test passes it through verbatim.)
      ...({ execHandlers: { read: async () => localReadResult } } as unknown as Record<string, never>),
    } as Partial<OmpCursorOptions>)

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({ type: 'toolCall', name: 'read', arguments: { path: 'README.md' } })
    expect(Object.getOwnPropertySymbols(call!).map(symbol => symbol.description)).toContain(
      'provider.block.cursorExecResolved',
    )

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('readResult')
    const result =
      client?.message.case === 'readResult'
        ? (client.message.value as { result: { case?: string; value?: { file?: { content?: { case?: string; value?: { text?: string } } } } } })
        : undefined
    expect(result?.result.case).toBe('success')
    const success =
      result?.result.case === 'success'
        ? (result.result.value as { output?: { value?: unknown } })
        : undefined
    expect(String(success?.output?.value)).toContain('file body')

    const chunks: StreamChunk[] = []
    for await (const chunk of projectEvents(
      (async function* () {
        yield* events
      })(),
    )) {
      chunks.push(chunk)
    }
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
  })

  it('keeps today`s behaviour without externalToolExecutor: rejected read, no unresolved call', async () => {
    const { events, wire } = await run('cursor-wire-native-read.jsonl')

    const call = events.find(event => event.type === 'toolcall_end')?.toolCall
    expect(call).toMatchObject({ type: 'toolCall', name: 'read' })
    expect(Object.getOwnPropertySymbols(call!).map(symbol => symbol.description)).toContain(
      'provider.block.cursorExecResolved',
    )

    const reply = decodeClientFrame(wire.written[1])
    const client = reply.message.case === 'execClientMessage' ? reply.message.value : undefined
    expect(client?.message.case).toBe('readResult')
    const result =
      client?.message.case === 'readResult'
        ? (client.message.value as { result: { case?: string; value?: { reason?: string } } })
        : undefined
    expect(result?.result.case).toBe('rejected')
    expect(result?.result.value?.reason).toBe('Tool not available')
  })
})
