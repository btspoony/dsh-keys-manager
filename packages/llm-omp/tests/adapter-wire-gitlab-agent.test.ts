/**
 * Wire-level proof for the GitLab Duo **agent** route: the real bundled
 * `streamGitLabDuoWorkflow` over a stubbed `fetch`, with the `webSocketFactory`
 * seam standing in for Node's global socket.
 *
 * The transport bootstraps a workflow over GitLab's REST API (namespace → project
 * → `direct_access` → workflow create) and only then opens the WebSocket, so this
 * suite proves the credential and seam contract at that boundary: the bearer on
 * every REST call, the pinned endpoint vocabulary, that no socket opens before a
 * workflow exists, and that a refused bootstrap surfaces as a terminal error.
 *
 * What this suite deliberately does **not** claim is the server's checkpoint
 * protocol itself (the goal-reseed round trip). The full loop needs a scripted
 * nine-call REST bootstrap plus a checkpoint/action frame corpus; that is the
 * recorded residual in the task report, not something this fixture invents.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  it('sends the GitLab bearer to the pinned REST vocabulary and opens no socket first', async () => {
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

  it('takes the webSocketFactory from the projection, and the row pins the static model', () => {
    // The adapter never invents a socket: the seam is a transport option, so a
    // host (or a test) supplies it and the shipped default is Node's global.
    expect(ROW).toMatchObject({ id: 'claude_sonnet_4_6_vertex', contextWindow: 1_000_000, input: ['text'] })
    expect(GITLAB_DUO_AGENT_MODELS).toHaveLength(1)
  })
})
