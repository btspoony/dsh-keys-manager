/**
 * Projection between the DSH llm seam and the omp Cursor transport.
 *
 * Two pure functions do all the translation:
 *
 * - {@link projectRequest} turns one assembled `GenerateOptions` into the
 *   transport's three arguments (model, context, options): the one-shot
 *   `system` argument and a leading run of system messages move to Cursor's
 *   rule slot, history keeps text and reasoning, and the selected reasoning
 *   effort becomes the routed wire model id.
 * - {@link projectEvents} turns the transport's `AssistantMessageEvent` stream
 *   into `StreamChunk`s. Block indexes stay omp's `contentIndex`, as the
 *   reference pi-ai adapter does, and failures arrive as a terminal `finish`
 *   (usage first) rather than as throws, matching omp's in-band error style.
 *
 * Scope: this plan's Task 1 carries text, reasoning, usage and finish. Tool
 * calls (Task 2) and images are refused with a typed `LlmError` instead of
 * being dropped, so an unsupported turn fails loudly and names the limit. The
 * same rule covers genuinely unsupported content: a reasoning effort the model
 * does not advertise and a system message that is not part of the leading
 * prompt are refused by name rather than silently dropped or reordered.
 *
 * Request knobs are not content, and this route ignores them. Cursor's agent
 * protocol has no field for an output cap, a sampling temperature, stop
 * sequences or an auxiliary-call purpose, so those `GenerateOptions` fields are
 * advisory here: they never reach the transport and never fail the call. DSH
 * sets `purpose` on every compaction (`dsh-compaction-basic`) and session-title
 * (`dsh-session-title-llm`) request and forwards a configured `maxTokens` with
 * the compaction one, so refusing either would buy nothing the wire can carry;
 * Cursor enforces the catalog `maxTokens` limit server-side, from the model
 * object this projection already sends. Ignoring the knobs does not make
 * compaction usable yet: `dsh-compaction-basic` also sends the session's
 * `toolHistory`, which this projection refuses with `TOOLS_UNSUPPORTED` until
 * Task 2 projects tool history, so compaction is Task-2-gated rather than a
 * knob issue.
 *
 * @module @dsh-keys-manager/llm-omp/projection
 */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  attributionHeaders,
  isContextWindowExceededError,
} from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage as DshAssistantMessage,
  ContentBlock,
  GenerateOptions,
  LlmFailure,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'

import type {
  CursorModelRow,
  OmpAssistantMessage,
  OmpAssistantMessageEvent,
  OmpContentBlock,
  OmpCursorContext,
  OmpCursorModel,
  OmpCursorOptions,
  OmpHistoryMessage,
  OmpUsage,
} from './omp.js'

/** Machine code for a request or stream carrying tool calls this task cannot answer. */
export const TOOLS_UNSUPPORTED = 'TOOLS_UNSUPPORTED'
/** Machine code for content kinds (images, files, tool updates) the adapter cannot send. */
export const CONTENT_UNSUPPORTED = 'CONTENT_UNSUPPORTED'
/** Machine code for an event kind this adapter does not recognize. */
export const UNKNOWN_EVENT = 'UNKNOWN_EVENT'
/** Machine code for a terminal stop reason the adapter does not recognize. */
export const UNKNOWN_FINISH = 'UNKNOWN_FINISH'
/** Machine code for a transport stream that ended without a terminal event. */
export const STREAM_CLOSED = 'STREAM_CLOSED'
/** Machine code for a reasoning effort the selected model does not advertise. */
export const UNSUPPORTED_REASONING_EFFORT = 'UNSUPPORTED_REASONING_EFFORT'
/** Machine code for a turn the caller's own signal cancelled. */
const ABORTED_CODE = 'ABORTED'

/** A terminal stream chunk; the only chunk that ends one turn. */
type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

/** The transport identity every projected model carries. */
const CURSOR_API = 'cursor-agent'
const CURSOR_PROVIDER = 'cursor'

/** Token counters of a historical assistant message; the transport never re-prices history. */
const EMPTY_USAGE: OmpUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
})

/** The request projection's three positional transport arguments. */
export interface ProjectedRequest {
  readonly model: OmpCursorModel
  readonly context: OmpCursorContext
  readonly options: OmpCursorOptions
}

/**
 * Project one DSH request onto the omp transport's arguments.
 *
 * Advisory request fields the Cursor wire cannot carry (`maxTokens`,
 * `temperature`, `stop`, `purpose`) are ignored, not forwarded: the route has
 * no field for them, and Cursor applies the catalog output limit server-side.
 *
 * @param row - catalog row for the requested model.
 * @param options - the assembled DSH request.
 * @param accessToken - Cursor bearer token resolved for this call.
 * @returns the transport arguments, ready to hand to `streamCursor`.
 * @throws LlmError with {@link TOOLS_UNSUPPORTED} when the request carries tools.
 * @throws LlmError with {@link CONTENT_UNSUPPORTED} for content kinds this task cannot send, and
 *   for a system message that is not part of the leading prompt.
 * @throws LlmError with {@link UNSUPPORTED_REASONING_EFFORT} when the effort is not advertised by
 *   the model.
 */
export function projectRequest(row: CursorModelRow, options: GenerateOptions, accessToken: string): ProjectedRequest {
  if (options.tools !== undefined && options.tools.length > 0) throw toolsUnsupported('request tools')
  if (options.toolHistory !== undefined) throw toolsUnsupported('tool history')

  const wireModelId = resolveWireModelId(row, options.reasoningEffort)
  const systemPrompt: string[] = []
  if (options.system !== undefined && options.system.length > 0) systemPrompt.push(options.system)
  const messages: OmpHistoryMessage[] = []
  // The transport carries system text only as a prefix (`systemPrompt`), so a
  // system message is accepted while the conversation has not started yet;
  // anything later would have to be moved ahead of user turns to be sent.
  let leading = true
  for (const message of options.messages) {
    if (message.role === 'system') {
      if (!leading) throw misplacedSystem()
      systemPrompt.push(...systemText(message.content))
      continue
    }
    leading = false
    if (message.role === 'user' || message.role === 'developer') {
      messages.push({ role: message.role, content: plainContent(message.content, message.role), timestamp: 0 })
    } else if (message.role === 'assistant') {
      messages.push(historyAssistant(message))
    } else {
      throw toolsUnsupported('tool results in history')
    }
  }

  return {
    model: { api: CURSOR_API, provider: CURSOR_PROVIDER, ...row },
    context: {
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      messages,
    },
    options: {
      apiKey: accessToken,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(wireModelId !== undefined ? { wireModelId } : {}),
      // Deliberately no `externalToolExecutor`: this task refuses every request
      // that carries tools and every tool-call frame, so the turn has no
      // executor to offer. Claiming one would make the transport hand a
      // Cursor-initiated MCP call back as a tool-call handoff that
      // `projectEvents` then fails with `TOOLS_UNSUPPORTED`; leaving it off
      // lets the transport answer the call itself as unknown. Task 2 sets it
      // once it projects tools.
      headers: attributionHeaders(),
    },
  }
}

/**
 * Resolve the wire model id for one selected reasoning effort.
 *
 * Mirrors the transport's own resolution (`@oh-my-pi/pi-catalog`
 * `src/model-thinking.ts`, `resolveWireModelId`): a routed effort selects its
 * mapped wire id, while an advertised effort with no routing entry sends the
 * row's own id (`requestModelId ?? id`), which the transport already falls back
 * to when it is handed no `wireModelId`. Returning `undefined` for that case is
 * therefore the same request the reference implementation sends, and it keeps
 * every advertised effort acceptable. On an unrouted row every advertised
 * effort resolves to that same id, so choosing one is a wire-level no-op,
 * exactly as it is in omp.
 * @param row - catalog row whose `thinking` describes the advertised efforts.
 * @param effort - selected omp effort id, or `undefined` for the provider default.
 * @returns the routed wire id, or `undefined` to send the row's own id.
 * @throws LlmError with {@link UNSUPPORTED_REASONING_EFFORT} when the model does
 *   not advertise the selected effort at all.
 */
function resolveWireModelId(row: CursorModelRow, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  const routed = row.thinking?.effortRouting?.[effort]
  if (routed !== undefined) return routed
  if (row.thinking?.efforts.includes(effort) === true) return undefined
  throw new LlmError(
    `llm-omp: cursor model "${row.id}" does not advertise reasoning effort "${effort}"`,
    UNSUPPORTED_REASONING_EFFORT,
  )
}

/**
 * Refuse a system message that appears after a non-system message.
 *
 * The transport accepts system text only as a `systemPrompt` prefix, so sending
 * a mid-history system message would mean moving it ahead of every user turn —
 * a silent reorder of the conversation the seam has no way to express. DSH does
 * not declare `systemPromptUpdate` for this adapter, so this arrives only from a
 * future producer; fail loudly rather than rewriting the history.
 */
function misplacedSystem(): LlmError {
  return new LlmError(
    'llm-omp: a system message after a non-system message cannot be projected; the cursor transport carries system text only ahead of the conversation',
    CONTENT_UNSUPPORTED,
  )
}

/** Collect a system-role message's text blocks; anything else is unsupported input. */
function systemText(content: readonly ContentBlock[]): string[] {
  return content.map(block => {
    if (block.type !== 'text') throw unsupportedContent(block.type, 'system')
    return block.text
  })
}

/** Map user/developer content to Cursor's text-only turn steps. */
function plainContent(content: readonly ContentBlock[], role: 'user' | 'developer'): OmpContentBlock[] {
  return content.map(block => {
    if (block.type !== 'text') throw unsupportedContent(block.type, role)
    return { type: 'text', text: block.text }
  })
}

/**
 * Map one DSH assistant message to an omp history step.
 *
 * The model id stays the one that produced the message so the transport can
 * decide whether its reasoning is replayable; the transport identity is this
 * route's, because the omp history builder only knows one transport.
 */
function historyAssistant(message: DshAssistantMessage): OmpAssistantMessage {
  return {
    role: 'assistant',
    content: message.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'reasoning') return { type: 'thinking', thinking: block.text }
      throw unsupportedContent(block.type, 'assistant')
    }),
    model: message.source.model,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 0,
  }
}

function toolsUnsupported(what: string): LlmError {
  return new LlmError(
    `llm-omp: ${what} are not supported yet; plan omp-transport-cursor hands tool calls to DSH in Task 2`,
    TOOLS_UNSUPPORTED,
  )
}

function unsupportedContent(kind: string, role: string): LlmError {
  return new LlmError(
    `llm-omp: ${role} message content block "${kind}" is not supported; plan omp-transport-cursor carries text and reasoning only in Task 1`,
    CONTENT_UNSUPPORTED,
  )
}

/**
 * Translate one omp Cursor event stream into DSH chunks.
 *
 * Known-but-unsupported events (tool calls, images) throw a typed error; an
 * unknown event kind throws {@link UNKNOWN_EVENT} rather than being skipped.
 * @param events - the transport's event stream for one turn.
 * @param signal - caller cancellation; an abort that races a provider error
 *   classifies that error as an aborted finish, as the seam expects.
 * @returns chunks ending with `usage` then `finish`.
 * @throws LlmError for unsupported or unrecognized events, and when the source
 *   ends without a terminal event.
 */
export async function* projectEvents(
  events: AsyncIterable<OmpAssistantMessageEvent>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        throw toolsUnsupported(`cursor "${event.type}" events`)
      case 'image_end':
        throw unsupportedContent('image', 'assistant')
      case 'done':
        yield { type: 'usage', usage: toTokenUsage(event.message.usage) }
        yield doneFinish(event.message, event.reason)
        return
      case 'error':
        yield { type: 'usage', usage: toTokenUsage(event.error.usage) }
        yield errorFinish(event.error, event.reason, signal)
        return
      default: {
        const kind = (event as { type?: unknown }).type
        throw new LlmError(`llm-omp: unrecognized cursor event "${String(kind)}"`, UNKNOWN_EVENT)
      }
    }
  }
  throw new LlmError('llm-omp: cursor event stream ended without done/error', STREAM_CLOSED)
}

/**
 * Map omp's finished message to a DSH finish reason.
 * @param message - the assembled assistant message.
 * @param reason - the terminal event's own reason.
 * @returns the mapped finish chunk.
 * @throws LlmError with {@link UNKNOWN_FINISH} for a reason outside the mapped set.
 */
function doneFinish(message: OmpAssistantMessage, reason: 'stop' | 'length' | 'toolUse'): FinishChunk {
  if (reason === 'stop') {
    if (message.content.length === 0) {
      return finishOf('error', {
        message: `llm-omp: cursor model "${message.model}" completed the turn with no content`,
        code: EMPTY_RESPONSE_CODE,
      })
    }
    return finishOf('stop')
  }
  if (reason === 'length') return finishOf('max-tokens')
  if (reason === 'toolUse') return finishOf('tool-calls')
  throw new LlmError(`llm-omp: unrecognized cursor stop reason "${String(reason)}"`, UNKNOWN_FINISH)
}

/**
 * Map an in-band transport error to a DSH finish chunk.
 * @param message - the failed assistant message.
 * @param reason - the error event's own reason.
 * @param signal - caller cancellation, which outranks the provider's own verdict.
 */
function errorFinish(
  message: OmpAssistantMessage,
  reason: 'aborted' | 'error',
  signal: AbortSignal | undefined,
): FinishChunk {
  const text = message.errorMessage ?? 'cursor stream error'
  if (signal?.aborted === true || reason === 'aborted') {
    return finishOf('aborted', failureOf(text, ABORTED_CODE, message.errorStatus))
  }
  if (isContextWindowExceededError(text) || /\bCONVERSATION_TOO_LONG\b/.test(text)) {
    return finishOf('error', failureOf(text, CONTEXT_WINDOW_EXCEEDED_CODE, message.errorStatus))
  }
  return finishOf('error', failureOf(text, classifyFailure(text, message.errorStatus), message.errorStatus))
}

/** Build one terminal finish chunk. */
function finishOf(kind: 'stop' | 'max-tokens' | 'tool-calls'): FinishChunk
function finishOf(kind: 'error' | 'aborted', failure: LlmFailure): FinishChunk
function finishOf(kind: 'stop' | 'max-tokens' | 'tool-calls' | 'error' | 'aborted', failure?: LlmFailure): FinishChunk {
  if (kind === 'error' || kind === 'aborted') {
    if (failure === undefined) throw new Error('llm-omp: an error finish requires a failure')
    return { type: 'finish', reason: { kind, failure } }
  }
  return { type: 'finish', reason: { kind } }
}

/** Build a failure record, omitting an absent HTTP status. */
function failureOf(message: string, code: string, status: number | undefined): LlmFailure {
  return {
    message,
    code,
    ...(status !== undefined && Number.isInteger(status) && status > 0 ? { status } : {}),
  }
}

/**
 * Classify a Cursor failure into the seam's provider-neutral code vocabulary.
 *
 * Cursor's own error names arrive in the message (the transport prefixes them
 * with `Cursor`), and the transport also records the HTTP status it derived.
 * Status wins because it is the transport's own classification.
 */
function classifyFailure(message: string, status: number | undefined): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (/\bRESOURCE_EXHAUSTED\b|\bRATE_LIMITED\b|\bGENERIC_RATE_LIMIT_EXCEEDED\b/.test(message)) return 'RATE_LIMIT'
  if (/\bNOT_FOUND\b|\bFILE_NOT_FOUND\b/.test(message)) return 'NOT_FOUND'
  if (/\bUNAUTHORIZED\b|\bBAD_USER_API_KEY\b/.test(message)) return 'AUTH'
  if (/\bPROVIDER_ERROR\b|\bINTERNAL\b|\bNETWORK_ERROR\b/.test(message)) return 'SERVER'
  return 'CURSOR_ERROR'
}

/**
 * Map omp usage to the seam's disjoint counters.
 *
 * `input` is already uncached on the Cursor path (the transport subtracts cache
 * reads and writes from the prompt total), cache fields appear only when non-zero
 * (omp reports zeros, not absence), and the aggregate total is derived from the
 * disjoint buckets so a mid-turn estimate that omitted cache tokens cannot
 * understate it.
 */
function toTokenUsage(usage: OmpUsage): TokenUsage {
  const { input, output, cacheRead, cacheWrite } = usage
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(usage.reasoningTokens !== undefined && usage.reasoningTokens > 0
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
  }
}
