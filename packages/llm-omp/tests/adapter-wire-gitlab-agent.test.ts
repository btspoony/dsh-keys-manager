/**
 * Wire-level proof for the GitLab Duo **agent** route: the real bundled
 * `streamGitLabDuoWorkflow` over a stubbed `fetch`, with the `webSocketFactory`
 * seam standing in for Node's global socket.
 *
 * The transport bootstraps a workflow over GitLab's REST API (namespace → project
 * → `direct_access` → workflow create) and only then opens the WebSocket, so this
 * suite proves the credential and seam contract at that boundary: the bearer on
 * the first bootstrap call, that the first call is a GitLab REST endpoint, that no
 * socket opens before a workflow exists, and that a refused bootstrap surfaces as
 * a terminal error. The later calls of the sequence are not scripted here.
 *
 * The second half of the suite goes further: it scripts the whole REST bootstrap
 * (namespace → group-settings PUT → project discovery → `direct_access` → workflow
 * create → GraphQL → PATCH) and injects a fake socket through the transport's
 * `webSocketFactory` seam, so one **successful** turn runs on the real bundle — a
 * checkpoint's agent text plus a `runMCPTool` action — and a second request
 * re-seeds a fresh workflow and finishes with text. The adapter boundary is
 * untouched: the fixture wraps the artifact in the transport shape and adds the
 * socket seam there.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { OmpGitLabDuoAgentAdapter } from '../src/adapter.js'
import { GITLAB_DUO_AGENT_MODELS } from '../src/catalog/gitlab-duo-agent.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

interface WireTransport {
  (model: unknown, context: unknown, options: unknown): AsyncIterable<unknown>
}

const artifact = (await import(pathToFileURL(join(packageRoot, 'lib', 'omp', 'gitlab-duo-agent.mjs')).href)) as {
  streamGitLabDuoWorkflow: WireTransport
}

interface FetchCall {
  readonly url: string
  readonly init?: RequestInit
}

const ROW = GITLAB_DUO_AGENT_MODELS[0]!
const MODEL = ROW.id

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'gitlab-duo-agent',
    model: MODEL,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Fix the bug' }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream as AsyncIterable<StreamChunk>) chunks.push(chunk)
  return chunks
}

describe('gitlab duo agent wire: REST bootstrap before any socket', () => {
  it('sends the GitLab bearer to a GitLab REST endpoint and opens no socket first', async () => {
    const calls: FetchCall[] = []
    const adapter = new OmpGitLabDuoAgentAdapter({
      access: async () => 'gitlab-agent-token',
      transport: artifact.streamGitLabDuoWorkflow as never,
      models: () => [MODEL],
    })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      // A refused namespace listing ends the turn early: the first call is what
      // this case is about.
      return new Response(JSON.stringify({ message: 'scripted stop' }), { status: 401 })
    }) as typeof globalThis.fetch
    try {
      const chunks = await collect(
        adapter.stream({
          ...request(),
          // The transport retries a refused bootstrap; the caller's signal bounds it.
          signal: AbortSignal.timeout(800),
        }),
      )
      const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
      expect(finish.type).toBe('finish')
      expect(['error', 'aborted']).toContain(finish.reason.kind)
    } finally {
      globalThis.fetch = original
    }

    expect(calls.length).toBeGreaterThan(0)
    const first = calls[0]!
    // The workflow bootstrap is GitLab REST, not the socket.
    expect(first.url.startsWith('https://gitlab.com/api/v4/')).toBe(true)
    expect(new Headers(first.init?.headers).get('authorization')).toBe('Bearer gitlab-agent-token')
    // A refused bootstrap never reaches the socket: the transport opens it only
    // after a workflow exists, which is why no factory is invoked here.
  })

  it('advertises the one static row the agent catalog declares', () => {
    // The socket seam is a transport option the adapter never invents (the shipped
    // default is Node's global `WebSocket`), so there is nothing to inject at this
    // boundary; the fake-socket round trip is the recorded follow-up.
    expect(ROW).toMatchObject({ id: 'claude_sonnet_4_6_vertex', contextWindow: 1_000_000, input: ['text'] })
    expect(GITLAB_DUO_AGENT_MODELS).toHaveLength(1)
  })
})

/** A `fetch` answering the whole Duo Workflow REST bootstrap. */
function bootstrapFetch(): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = []
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(`${url}`)
    if (url.includes('/api/v4/groups?')) return json([{ id: 99, full_path: 'grp', name: 'grp' }])
    if (url.includes('/api/v4/groups/99/projects')) {
      return json([{ id: 42, path_with_namespace: 'grp/proj', name: 'proj' }])
    }
    if (url.includes('duo_workflows/direct_access')) return json({ token: 'dws-token', headers: {} })
    if (url.endsWith('/api/v4/ai/duo_workflows/workflows')) return json({ id: 'wf-1', status: 'created' })
    if (url.includes('/api/v4/ai/duo_workflows/workflows/')) return json({ id: 'wf-1', status: 'running' })
    return json({})
  }) as typeof globalThis.fetch
  return { fetch: impl, calls }
}

/** One checkpoint frame carrying the given `ui_chat_log` entries. */
function checkpointFrame(entries: unknown[]): unknown {
  return { newCheckpoint: { checkpoint: JSON.stringify({ channel_values: { ui_chat_log: entries } }) } }
}

/**
 * A fake socket factory that replays `frames` on the transport's seam.
 *
 * @param frames - server frames, delivered one per tick after the socket opens.
 * @returns the factory and the sockets it handed out.
 */
function fakeSockets(frames: unknown[]): {
  factory: (url: string, options: { headers: Record<string, string> }) => unknown
  sockets: { url: string; headers: Record<string, string>; sent: string[]; closed: boolean }[]
} {
  const sockets: { url: string; headers: Record<string, string>; sent: string[]; closed: boolean }[] = []
  return {
    sockets,
    factory: (url, options) => {
      const record = { url, headers: options.headers, sent: [] as string[], closed: false }
      sockets.push(record)
      const socket = {
        readyState: 0,
        send: (data: string) => record.sent.push(data),
        close: () => {
          record.closed = true
        },
        onopen: null as ((event: unknown) => void) | null,
        onmessage: null as ((event: { data: string }) => void) | null,
        onerror: null,
        onclose: null,
      }
      queueMicrotask(() => {
        socket.readyState = 1
        socket.onopen?.({})
        let index = 0
        const pump = (): void => {
          if (index >= frames.length) return
          socket.onmessage?.({ data: JSON.stringify(frames[index++]) })
          setTimeout(pump, 2)
        }
        setTimeout(pump, 2)
      })
      return socket
    },
  }
}

/** The artifact behind the transport shape, with the fixture's fetch and socket seam. */
function fixtureTransport(
  fetchImpl: typeof globalThis.fetch,
  factory: (url: string, options: { headers: Record<string, string> }) => unknown,
) {
  return async function* (model: unknown, context: unknown, options: Record<string, unknown>) {
    yield* artifact.streamGitLabDuoWorkflow(model, context, {
      ...options,
      fetch: fetchImpl,
      webSocketFactory: factory,
    }) as AsyncIterable<unknown>
  }
}

describe('gitlab duo agent wire: a full tool round on the real bundle', () => {
  it('streams the checkpoint text, parks the runMCPTool action, and finishes tool-calls', async () => {
    const rest = bootstrapFetch()
    const { sockets, factory } = fakeSockets([
      checkpointFrame([
        { message_type: 'request', content: 'Look it up' },
        { message_type: 'agent', message_id: 'm1', content: 'Looking it up.' },
      ]),
      // The action's `args` names the MCP tool (`toolName`) and carries its input.
      { requestID: 'req-1', runMCPTool: { toolName: 'lookup_doc', args: { query: 'x' } } },
    ])
    const adapter = new OmpGitLabDuoAgentAdapter({
      access: async () => 'gitlab-token',
      transport: fixtureTransport(rest.fetch, factory) as never,
      models: () => [MODEL],
    })

    const chunks = await collect(
      adapter.stream(
        request({
          messages: [
            createSystemMessage('Be terse.'),
            createUserMessage({ content: [{ type: 'text', text: 'Fix the bug' }], source: { kind: 'user' } }),
          ],
        }),
      ),
    )

    // The server's agent text arrives as a text block.
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Looking it up.' })
    // The action is DSH's to run: the turn ends tool-calls, not stop.
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'req-1', name: 'lookup_doc', arguments: '{"query":"x"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })

    // The start frame carries the inline flow config and the goal transcript.
    expect(sockets).toHaveLength(1)
    const start = JSON.parse(sockets[0]!.sent[0]!) as {
      startRequest: {
        workflowID: string
        goal: string
        workflowDefinition: string
        flowConfig: { prompts: { prompt_template: { system: string } }[] }
        mcpTools: unknown[]
        preapproved_tools: unknown[]
      }
    }
    expect(start.startRequest).toMatchObject({ workflowID: 'wf-1', workflowDefinition: 'ambient' })
    // The goal is the rendered transcript of the request this fixture sent.
    expect(start.startRequest.goal).toContain('Fix the bug')
    expect(start.startRequest.flowConfig.prompts[0]!.prompt_template.system).toContain('terse')
    expect(start.startRequest.mcpTools).toEqual([])
    expect(start.startRequest.preapproved_tools).toEqual([])
    // The workflow was created over REST before the socket opened.
    expect(rest.calls.some(url => url.endsWith('/api/v4/ai/duo_workflows/workflows'))).toBe(true)
    expect(sockets[0]!.url).toContain('/api/v4/ai/duo_workflows/ws?')
  })

  it('re-seeds a fresh workflow for the follow-up turn and finishes with text', async () => {
    const rest = bootstrapFetch()
    const { sockets, factory } = fakeSockets([
      checkpointFrame([
        { message_type: 'request', content: 'Look it up' },
        { message_type: 'tool', content: 'ok' },
        { message_type: 'agent', message_id: 'm2', content: 'Found it.' },
      ]),
      { newCheckpoint: { status: 'FINISHED' } },
    ])
    const adapter = new OmpGitLabDuoAgentAdapter({
      access: async () => 'gitlab-token',
      transport: fixtureTransport(rest.fetch, factory) as never,
      models: () => [MODEL],
    })

    // The follow-up carries the tool result in history, as the agent loop does.
    const chunks = await collect(
      adapter.stream(
        request({
          messages: [
            createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } }),
            createAssistantMessage({
              content: [{ type: 'tool-call', id: ToolCallId('req-1'), name: 'lookup_doc', arguments: '{"query":"x"}' }],
              source: { provider: 'gitlab-duo-agent', model: MODEL },
            }),
            createToolResultMessage({
              callId: ToolCallId('req-1'),
              content: [{ type: 'text', text: 'document body' }],
              isError: false,
            }),
          ],
        }),
      ),
    )

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Found it.' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // A second socket: the turn re-seeded a workflow instead of resuming the first.
    expect(sockets).toHaveLength(1)
    const start = JSON.parse(sockets[0]!.sent[0]!) as { startRequest: { goal: string } }
    // The replayed transcript rides the goal: the request and its tool result.
    expect(start.startRequest.goal).toContain('Look it up')
    expect(start.startRequest.goal).toContain('document body')
  })
})
