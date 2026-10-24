/**
 * The agent route's tool contract at the adapter boundary.
 *
 * GitLab's server-side loop *yields* at every tool call: the transport parks the
 * pending action and emits the standard `toolcall_*` events, so DSH executes the
 * tool and the next turn replays the result through the goal transcript. This
 * suite pins that contract with a scripted transport (the event shape is the
 * transport's own) and anchors the action vocabulary to the pin, so a rename in an
 * omp bump fails here instead of silently dropping the handoff.
 *
 * The full checkpoint round trip over a fake socket is the recorded residual in
 * the task report: it needs a scripted REST bootstrap and a checkpoint corpus, and
 * this fixture deliberately does not invent one.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { OmpGitLabDuoAgentAdapter } from '../src/adapter.js'
import { GITLAB_DUO_AGENT_MODELS } from '../src/catalog/gitlab-duo-agent.js'
import type { OmpAssistantMessageEvent, OmpGitLabDuoAgentModel, OmpGitLabDuoWorkflowOptions } from '../src/omp.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const ROW = GITLAB_DUO_AGENT_MODELS[0]!
const MODEL = ROW.id

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'gitlab-duo-agent',
    model: MODEL,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Look it up' }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The transport's own action events, as the workflow loop emits them. */
const EVENTS: OmpAssistantMessageEvent[] = [
  { type: 'start' },
  { type: 'text_start', contentIndex: 0 },
  { type: 'text_delta', contentIndex: 0, delta: 'Looking it up.' },
  { type: 'text_end', contentIndex: 0, content: 'Looking it up.' },
  {
    type: 'toolcall_start',
    contentIndex: 1,
    partial: {
      role: 'assistant',
      model: MODEL,
      stopReason: 'stop',
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'toolCall', id: 'call-agent-1', name: 'lookup_doc', arguments: { tool: 'lookup_doc' } },
      ],
      api: 'gitlab-duo-agent',
      provider: 'gitlab-duo-agent',
    },
  },
  {
    type: 'toolcall_end',
    contentIndex: 1,
    toolCall: { type: 'toolCall', id: 'call-agent-1', name: 'lookup_doc', arguments: { tool: 'lookup_doc' } },
    partial: {
      role: 'assistant',
      model: MODEL,
      stopReason: 'toolUse',
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'toolCall', id: 'call-agent-1', name: 'lookup_doc', arguments: { tool: 'lookup_doc' } },
      ],
    } as never,
  },
  {
    type: 'done',
    reason: 'toolUse',
    message: {
      role: 'assistant',
      model: MODEL,
      stopReason: 'toolUse',
      timestamp: 1_760_000_000_000,
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'toolCall', id: 'call-agent-1', name: 'lookup_doc', arguments: { tool: 'lookup_doc' } },
      ],
    } as never,
  },
]

describe('OmpGitLabDuoAgentAdapter tool handoff', () => {
  it('hands the parked action to DSH as a tool-call and finishes toolUse', async () => {
    const calls: { options: OmpGitLabDuoWorkflowOptions }[] = []
    const adapter = new OmpGitLabDuoAgentAdapter({
      access: async () => 'gitlab-token',
      transport: async function* (
        _model: OmpGitLabDuoAgentModel,
        _context: unknown,
        options: OmpGitLabDuoWorkflowOptions,
      ) {
        calls.push({ options })
        yield* EVENTS
      },
    })

    const chunks = await collect(adapter.stream(request()))

    // The action is DSH's to run: the turn finishes tool-calls, never "stop".
    expect(chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toHaveLength(1)
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call-agent-1', name: 'lookup_doc', arguments: '{"tool":"lookup_doc"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    // A fresh state map per request: the next turn re-seeds the workflow with the
    // tool result in the goal transcript rather than resuming this socket.
    expect(calls[0]!.options.providerSessionState).toBeInstanceOf(Map)
    expect((calls[0]!.options.providerSessionState as Map<string, unknown>).size).toBe(0)
    expect(calls[0]!.options).not.toHaveProperty('externalToolExecutor')
  })

  it('anchors the single-action vocabulary to the pin', () => {
    // The transport parks exactly one action and names it `runMCPTool`; a rename on
    // an omp bump would silently drop the handoff, so the names are asserted here.
    const pinned = dirname(fileURLToPath(import.meta.resolve('@oh-my-pi/pi-ai')))
    let dir = pinned
    while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== '@oh-my-pi/pi-ai') {
      dir = dirname(dir)
    }
    const source = readFileSync(join(dir, 'src/providers/gitlab-duo-workflow.ts'), 'utf8')
    expect(source).toContain('const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"]')
    expect(source).toContain('pendingActions')
    // The route stays on DSH's native loop: no exec channel, no external executor.
    expect(source).not.toContain('externalToolExecutor')
    void packageRoot
  })
})
