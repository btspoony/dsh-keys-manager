/**
 * Projection between the DSH llm seam and the omp transports.
 *
 * Both routes share one engine: the request builder differs only in the
 * transport identity, which request knobs the wire carries, and the
 * external-executor claim (Cursor's agent protocol has one, Devin's chat stream
 * does not); the event projection differs only in a {@link RouteProfile}. The
 * route-specific pieces are data, not a second implementation:
 *
 * - {@link projectRequest} turns one assembled `GenerateOptions` into the
 *   transport's three arguments (model, context, options): the one-shot
 *   `system` argument and a leading run of system messages move to Cursor's
 *   rule slot, history keeps text, reasoning, tool calls and tool results, the
 *   active tool declarations become MCP tool definitions, and the selected
 *   reasoning effort becomes the routed wire model id.
 * - {@link projectEvents} turns the transport's `AssistantMessageEvent` stream
 *   into `StreamChunk`s. Block indexes stay omp's `contentIndex`, as the
 *   reference pi-ai adapter does, and failures arrive as a terminal `finish`
 *   (usage first) rather than as throws, matching omp's in-band error style.
 *
 * Tool execution stays on DSH's side. Cursor's server drives execution over its
 * exec channel, so the transport runs in external-executor mode: an unhandled
 * MCP call is emitted as an unresolved tool call and answered with a handoff,
 * then DSH's loop runs the tool and the next request replays the result from
 * `toolHistory`/`tool` messages. The adapter never executes a tool itself, and
 * it never hands off a call the transport already answered: a native exec frame
 * (read/shell/write/delete/grep/ls/diagnostics/todo, ...) is synthesized as a
 * tool call the transport has settled, so it is filtered out of the stream —
 * otherwise DSH would run it a second time or fail it as an unknown tool.
 *
 * Scope: this plan's Task 1 carries text, reasoning, tool calls and tool
 * results. Images and files are refused with a typed `LlmError` instead of
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
 * object this projection already sends.
 *
 * `toolHistory` is consumed but cannot be replayed: the transport advertises one
 * declaration set per request (MCP definitions) and its history carries no
 * declaration updates. DSH's own `projectToolUpdates` already folds history
 * into `options.tools` for a route that declares no update mode, so the active
 * set is the projection and `toolHistory` only has to be accepted rather than
 * refused — without that, a session that ever changed tools could not use this
 * route at all.
 *
 * @module dsh-llm-omp-transports/projection
 */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  ToolCallId,
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
  ToolCallBlock,
  ToolResultMessage,
} from '@deepseek-ai/dsh-llm'

import { attributionPreservingFetch } from './devin/transport.js'
import type {
  CursorModelRow,
  DevinModelRow,
  OmpAssistantMessage,
  OmpAssistantMessageEvent,
  OmpContentBlock,
  OmpContext,
  OmpCursorModel,
  OmpCursorOptions,
  OmpDevinModel,
  OmpDevinOptions,
  OmpHistoryMessage,
  OmpTool,
  OmpToolCallBlock,
  OmpUsage,
} from './omp.js'

/** Machine code for content kinds (images, files) the adapter cannot send. */
export const CONTENT_UNSUPPORTED = 'CONTENT_UNSUPPORTED'
/** Machine code for a historical tool call whose arguments are not a JSON object. */
export const TOOL_ARGUMENTS_INVALID = 'TOOL_ARGUMENTS_INVALID'
/** Machine code for a tool-call event that does not carry its call block. */
export const MALFORMED_TOOL_CALL = 'MALFORMED_TOOL_CALL'
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

/**
 * The route-specific facts of the shared projection.
 *
 * This replaces the module constants the Cursor-only projection carried: the
 * transport identity, the provider-neutral code a transport failure falls back
 * to, and the private mark a transport leaves on a call it answered itself.
 * `devin` has no such mark — every tool call its transport emits is DSH's.
 */
export interface RouteProfile {
  /** Provider route id: history identity and the label inside error messages. */
  readonly provider: 'cursor' | 'devin'
  /** omp's `Api` for the route. */
  readonly api: 'cursor-agent' | 'devin-agent'
  /** Provider-neutral code an unclassified transport failure maps to. */
  readonly fallbackErrorCode: string
  /**
   * Description of the private symbol marking a transport-resolved tool call.
   *
   * `@oh-my-pi/pi-ai@18.12.3` tags every block the Cursor transport settled
   * itself — the synthesized tool calls for Cursor's own exec frames (`read`,
   * `shell`, `write`, `edit`, `delete`, `grep`, `ls`, `diagnostics`, plus
   * `todo`, `web_fetch` and `connect_scm`) and its streamed edit display — with
   * the private symbol `provider.block.cursorExecResolved`
   * (`src/utils/block-symbols.ts`). It exports neither the symbol nor a name
   * list, so the marker is matched by its description, which the transport
   * never changes without changing what it means. An MCP call awaiting an
   * external executor carries no marker: that one is the handoff.
   * `tests/projection.test.ts` pins the marker and `tests/adapter-wire.test.ts`
   * proves the bundled artifact still sets it.
   */
  readonly transportResolvedMarker?: string
}

/** The shipped Cursor route's projection facts. */
export const CURSOR_PROFILE = {
  provider: 'cursor',
  api: 'cursor-agent',
  fallbackErrorCode: 'CURSOR_ERROR',
  transportResolvedMarker: 'provider.block.cursorExecResolved',
} as const satisfies RouteProfile

/**
 * The Devin route's projection facts.
 *
 * No marker: its transport emits `deltaToolCalls` as plain calls and finishes
 * the turn `toolUse`, so DSH's tool loop is the native mode here.
 */
export const DEVIN_PROFILE = {
  provider: 'devin',
  api: 'devin-agent',
  fallbackErrorCode: 'PROVIDER_ERROR',
} as const satisfies RouteProfile

/** Token counters of a historical assistant message; the transport never re-prices history. */
const EMPTY_USAGE: OmpUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
})

/** The Cursor request projection's three positional transport arguments. */
export interface ProjectedRequest {
  readonly model: OmpCursorModel
  readonly context: OmpContext
  /**
   * Transport options without the credential. The adapter resolves the token
   * only for a request the projection accepted, then injects `apiKey`.
   */
  readonly options: Omit<OmpCursorOptions, 'apiKey'> & { readonly apiKey?: string }
}

/** The Devin request projection's three positional transport arguments. */
export interface ProjectedDevinRequest {
  readonly model: OmpDevinModel
  readonly context: OmpContext
  /**
   * Transport options without the credential. The adapter resolves the token
   * only for a request the projection accepted, then injects `apiKey`.
   */
  readonly options: Omit<OmpDevinOptions, 'apiKey'> & { readonly apiKey?: string }
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
 * @param accessToken - bearer token already resolved for this call; omit it to
 *   project before the credential is read.
 * @returns the transport arguments, ready to hand to `streamCursor`.
 * @throws LlmError with {@link CONTENT_UNSUPPORTED} for content kinds this route
 *   cannot send, and for a system message that is not part of the leading prompt.
 * @throws LlmError with {@link TOOL_ARGUMENTS_INVALID} for a historical tool call
 *   whose arguments are not a JSON object.
 * @throws LlmError with {@link UNSUPPORTED_REASONING_EFFORT} when the effort is not advertised by
 *   the model.
 */
export function projectRequest(
  row: CursorModelRow,
  options: GenerateOptions,
  accessToken?: string,
): ProjectedRequest {
  const wireModelId = resolveWireModelId(row, options.reasoningEffort)
  const context = projectContext(CURSOR_PROFILE, options)
  return {
    model: { api: CURSOR_PROFILE.api, provider: CURSOR_PROFILE.provider, ...row },
    context,
    options: {
      ...(accessToken !== undefined ? { apiKey: accessToken } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(wireModelId !== undefined ? { wireModelId } : {}),
      // Claim an external executor only when a tool is actually advertised.
      // Without one there is no DSH tool loop to run a Cursor-initiated MCP
      // call: the transport would emit an unresolved tool call that nothing
      // answers, so it must answer the server frame itself as unknown. With one
      // it hands the call to DSH and answers the frame with the handoff result.
      ...(context.tools !== undefined ? { externalToolExecutor: true } : {}),
      headers: attributionHeaders(),
    },
  }
}

/**
 * Project one DSH request onto the omp Devin transport's arguments.
 *
 * Devin is a chat stream, not an agent protocol: it has no external-executor
 * handoff, so that option is never sent and DSH's tool loop is the native mode.
 * The wire does carry the request knobs Cursor cannot (`maxTokens`,
 * `temperature`, `stopSequences`), so those are forwarded instead of ignored.
 * No `wireModelId`: the pinned catalog has no `thinking` rows, so any requested
 * effort is refused rather than routed.
 *
 * @param row - catalog row for the requested model.
 * @param options - the assembled DSH request.
 * @param accessToken - bearer token already resolved for this call; omit it to
 *   project before the credential is read.
 * @returns the transport arguments, ready to hand to `streamDevin`.
 * @throws LlmError with {@link CONTENT_UNSUPPORTED} for content kinds this route
 *   cannot send, and for a system message that is not part of the leading prompt.
 * @throws LlmError with {@link TOOL_ARGUMENTS_INVALID} for a historical tool call
 *   whose arguments are not a JSON object.
 * @throws LlmError with {@link UNSUPPORTED_REASONING_EFFORT} for any selected
 *   effort: no pinned Devin row advertises one.
 */
export function projectDevinRequest(
  row: DevinModelRow,
  options: GenerateOptions,
  accessToken?: string,
): ProjectedDevinRequest {
  if (options.reasoningEffort !== undefined) {
    throw new LlmError(
      `llm-omp-transports: devin model "${row.id}" does not advertise reasoning effort "${options.reasoningEffort}"`,
      UNSUPPORTED_REASONING_EFFORT,
    )
  }
  const context = projectContext(DEVIN_PROFILE, options)
  return {
    model: { api: DEVIN_PROFILE.api, provider: DEVIN_PROFILE.provider, ...row },
    context,
    options: {
      ...(accessToken !== undefined ? { apiKey: accessToken } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      // The transport reuses `sessionId` as `cascade_id`, so turns thread.
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stop !== undefined ? { stopSequences: [...options.stop] } : {}),
      // The chat request must keep the transport's own `connect-go` identity,
      // and the header-less handshake must still carry DSH's attribution: this
      // wrapper fills only headers a request left absent.
      fetch: attributionPreservingFetch,
    },
  }
}

/**
 * Build the transport context both routes share.
 *
 * The system slot, history mapping, tool projection and the typed refusals are
 * identical on both routes; only the route identity inside the projected
 * messages and the error wording differ, so both come from the profile.
 * @param profile - the route being projected.
 * @param options - the assembled DSH request.
 * @returns the context for the transport's second positional argument.
 */
function projectContext(profile: RouteProfile, options: GenerateOptions): OmpContext {
  const tools = projectTools(options)
  const systemPrompt: string[] = []
  if (options.system !== undefined && options.system.length > 0) systemPrompt.push(options.system)
  const messages: OmpHistoryMessage[] = []
  // Tool results carry no name of their own; replay pairs them by call id and
  // needs the declaration's name, so the assistant turn that issued the call
  // supplies it while history is projected in order.
  const toolNames = new Map<string, string>()
  // The transport carries system text only as a prefix (`systemPrompt`), so a
  // system message is accepted while the conversation has not started yet;
  // anything later would have to be moved ahead of user turns to be sent.
  let leading = true
  for (const message of options.messages) {
    if (message.role === 'system') {
      if (!leading) throw misplacedSystem(profile)
      systemPrompt.push(...systemText(message.content, profile))
      continue
    }
    leading = false
    if (message.role === 'user' || message.role === 'developer') {
      const content = plainContent(message.content, message.role, profile)
      // A developer message that carried only tool updates projects to no wire
      // content; emitting an empty turn would add noise the transport replays.
      if (content.length > 0) messages.push({ role: message.role, content, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      messages.push(historyAssistant(message, toolNames, profile))
      continue
    }
    messages.push(historyToolResult(message, toolNames, profile))
  }

  return {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
  }
}

/**
 * Project the request's active tool declarations onto Cursor's MCP tool list.
 *
 * `options.tools` is authoritative: DSH already folds `toolHistory` into it for
 * a route that declares no update mode, and Cursor's wire advertises one
 * declaration set per request with no way to replay an update. `deferLoading`
 * is dropped because Cursor has no deferred-loading concept; a deferred tool
 * must be callable from this route's first request or it never becomes usable.
 * @param options - the assembled request.
 * @returns the declarations in request order, or `undefined` when none are active.
 */
function projectTools(options: GenerateOptions): readonly OmpTool[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined
  const byName = new Map<string, OmpTool>()
  for (const tool of options.tools) {
    byName.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters })
  }
  return [...byName.values()]
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
  const routing = row.thinking?.effortRouting
  if (routing !== undefined && Object.hasOwn(routing, effort)) return routing[effort]
  if (row.thinking?.efforts.includes(effort) === true) return undefined
  throw new LlmError(
    `llm-omp-transports: cursor model "${row.id}" does not advertise reasoning effort "${effort}"`,
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
function misplacedSystem(profile: RouteProfile): LlmError {
  return new LlmError(
    `llm-omp-transports: a system message after a non-system message cannot be projected; the ${profile.provider} transport carries system text only ahead of the conversation`,
    CONTENT_UNSUPPORTED,
  )
}

/** Collect a system-role message's text blocks; anything else is unsupported input. */
function systemText(content: readonly ContentBlock[], profile: RouteProfile): string[] {
  return content.map(block => {
    if (block.type !== 'text') throw unsupportedContent(block.type, 'system', profile)
    return block.text
  })
}

/**
 * Map user content to Cursor's text-only turn steps.
 *
 * Developer content may also carry `tool-addition` / `tool-removal` blocks,
 * which have no wire representation: the active declarations travel as MCP
 * tool definitions instead, so those blocks are folded out rather than refused.
 */
function plainContent(
  content: readonly ContentBlock[],
  role: 'user' | 'developer',
  profile: RouteProfile,
): OmpContentBlock[] {
  return content.flatMap((block): OmpContentBlock[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (role === 'developer' && (block.type === 'tool-addition' || block.type === 'tool-removal')) return []
    throw unsupportedContent(block.type, role, profile)
  })
}

/**
 * Map one DSH assistant message to an omp history step.
 *
 * The model id and the transport identity stay the ones that produced the
 * message. The transport's K3 checks (`canReplayCursorThinking`,
 * `assertCursorKimiK3HistoryReplayable`) trust `api`/`provider`/`model`, so a
 * turn from another route keeps its real provider: claiming the Cursor identity
 * for it would let foreign reasoning be replayed as native thinking. Only
 * history this route produced carries the Cursor identity.
 *
 * Reasoning from another provider is dropped rather than forwarded: it is not
 * Cursor-signed, the transport replays reasoning only for such history, and for
 * a K3 target the mismatched identity makes it refuse the history outright.
 *
 * Tool calls keep their provider-issued id so the transport can pair the
 * replayed call with the `toolResult` step that answers it.
 */
function historyAssistant(
  message: DshAssistantMessage,
  toolNames: Map<string, string>,
  profile: RouteProfile,
): OmpAssistantMessage {
  const source = message.source
  const routeSourced = source.provider === profile.provider
  return {
    role: 'assistant',
    content: message.content.flatMap((block): OmpContentBlock[] => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }]
      if (block.type === 'reasoning') return routeSourced ? [{ type: 'thinking', thinking: block.text }] : []
      if (block.type === 'tool-call') {
        toolNames.set(block.id, block.name)
        return [{ type: 'toolCall', id: block.id, name: block.name, arguments: toolArguments(block) }]
      }
      throw unsupportedContent(block.type, 'assistant', profile)
    }),
    model: source.model,
    api: routeSourced ? profile.api : source.provider,
    provider: routeSourced ? profile.provider : source.provider,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 0,
  }
}

/**
 * Map one DSH `tool` message to the omp result step the transport replays.
 *
 * The name comes from the assistant call carried earlier in the same history;
 * an orphan result (a truncated history) keeps an empty name, which the
 * transport renders as text because nothing pairs it. Non-text result content
 * is refused rather than dropped, like every other non-text block.
 */
function historyToolResult(
  message: ToolResultMessage,
  toolNames: ReadonlyMap<string, string>,
  profile: RouteProfile,
): OmpHistoryMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? '',
    content: message.content.map(block => {
      if (block.type !== 'text') throw unsupportedContent(block.type, 'tool', profile)
      return { type: 'text', text: block.text }
    }),
    isError: message.isError === true,
    timestamp: 0,
  }
}

/** Parse a historical tool call's raw JSON arguments into Cursor's object shape. */
function toolArguments(block: ToolCallBlock): Readonly<Record<string, unknown>> {
  if (block.arguments.trim().length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(block.arguments)
  } catch {
    throw invalidToolArguments(`tool call "${block.name}" (${block.id}) carries arguments that are not JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidToolArguments(`tool call "${block.name}" (${block.id}) arguments must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function invalidToolArguments(detail: string): LlmError {
  return new LlmError(`llm-omp-transports: ${detail}`, TOOL_ARGUMENTS_INVALID)
}

function unsupportedContent(kind: string, role: string, profile: RouteProfile): LlmError {
  return new LlmError(
    `llm-omp-transports: the ${profile.provider} route carries text, reasoning and tool calls only; ${role} message content block "${kind}" is not supported`,
    CONTENT_UNSUPPORTED,
  )
}

/**
 * Translate one omp event stream into DSH chunks.
 *
 * The stream shape is omp's `AssistantMessageEvent` on both routes; the profile
 * supplies the route identity inside messages, the code an unclassified
 * failure falls back to, and (Cursor only) the marker of a call the transport
 * already answered.
 *
 * Known-but-unsupported events (images) throw a typed error; an unknown event
 * kind throws {@link UNKNOWN_EVENT} rather than being skipped. A tool-call
 * lifecycle becomes DSH's `block-start` / `tool-call-delta` / `block-end`
 * sequence, and the turn finishes `tool-calls` whether the transport labelled
 * it `toolUse` or left the default `stop`.
 * @param events - the transport's event stream for one turn.
 * @param signal - caller cancellation; an abort that races a provider error
 *   classifies that error as an aborted finish, as the seam expects.
 * @param profile - route facts; defaults to the shipped Cursor route.
 * @returns chunks ending with `usage` then `finish`.
 * @throws LlmError for unsupported or unrecognized events, a tool-call event
 *   without its call block, and when the source ends without a terminal event.
 */
export async function* projectEvents(
  events: AsyncIterable<OmpAssistantMessageEvent>,
  signal?: AbortSignal,
  profile: RouteProfile = CURSOR_PROFILE,
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
      case 'toolcall_start': {
        // Resolve the call now: DSH needs its id on every following delta, and a
        // start without a block would leave a block that can never be closed.
        const call = toolCallOf(event.contentIndex, event.partial, profile)
        if (isTransportResolved(call, profile)) break
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const call = toolCallOf(event.contentIndex, event.partial, profile)
        if (isTransportResolved(call, profile)) break
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: ToolCallId(call.id),
          name: call.name,
          argumentsDelta: event.delta ?? '',
        }
        break
      }
      case 'toolcall_end': {
        const call = event.toolCall ?? toolCallOf(event.contentIndex, event.partial, profile)
        if (isTransportResolved(call, profile)) break
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(call.id),
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        }
        break
      }
      case 'image_end':
        throw unsupportedContent('image', 'assistant', profile)
      case 'done':
        yield { type: 'usage', usage: toTokenUsage(event.message.usage) }
        yield doneFinish(event.message, event.reason, profile)
        return
      case 'error':
        yield { type: 'usage', usage: toTokenUsage(event.error.usage) }
        yield errorFinish(event.error, event.reason, signal, profile)
        return
      default: {
        const kind = (event as { type?: unknown }).type
        throw new LlmError(`llm-omp-transports: unrecognized ${profile.provider} event "${String(kind)}"`, UNKNOWN_EVENT)
      }
    }
  }
  throw new LlmError(`llm-omp-transports: ${profile.provider} event stream ended without done/error`, STREAM_CLOSED)
}

/** Whether the route's transport already answered this tool call, so DSH must not run it. */
function isTransportResolved(block: OmpContentBlock | undefined, profile: RouteProfile): boolean {
  const marker = profile.transportResolvedMarker
  return (
    block !== undefined &&
    marker !== undefined &&
    Object.getOwnPropertySymbols(block).some(symbol => symbol.description === marker)
  )
}

/**
 * Read the tool call one event with `contentIndex` refers to.
 *
 * omp emits `toolcall_start` / `toolcall_delta` with the assembled message as
 * `partial`, whose block at `contentIndex` is the call that was just pushed; an
 * adapter cannot invent the id, so a missing block is a malformed stream rather
 * than something to paper over.
 */
function toolCallOf(
  contentIndex: number,
  partial: OmpAssistantMessage | undefined,
  profile: RouteProfile,
): OmpToolCallBlock {
  const block = partial?.content[contentIndex]
  if (block?.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    throw new LlmError(
      `llm-omp-transports: ${profile.provider} tool-call event at index ${contentIndex} carries no call block`,
      MALFORMED_TOOL_CALL,
    )
  }
  return block as OmpToolCallBlock
}

/**
 * Map omp's finished message to a DSH finish reason.
 *
 * The transport leaves `stopReason` at its default `stop` for an external
 * handoff — the agent loop, not the provider, decides the turn ends on a tool
 * call — so the assembled content is what identifies a tool-call finish. Calls
 * the transport answered itself were never streamed to DSH, so they cannot be
 * what makes the turn a tool-call turn; a turn whose only content is such calls
 * still happened, so it finishes `stop` instead of the empty-response error.
 * @param message - the assembled assistant message.
 * @param reason - the terminal event's own reason.
 * @returns the mapped finish chunk.
 * @throws LlmError with {@link UNKNOWN_FINISH} for a reason outside the mapped set.
 */
function doneFinish(
  message: OmpAssistantMessage,
  reason: 'stop' | 'length' | 'toolUse',
  profile: RouteProfile,
): FinishChunk {
  if (reason === 'toolUse') return finishOf('tool-calls')
  if (reason === 'length') return finishOf('max-tokens')
  if (reason === 'stop') {
    // Calls the transport answered itself were never streamed to DSH, so they
    // do not make this a tool-call turn.
    const visible = message.content.filter(
      block => block.type !== 'toolCall' || !isTransportResolved(block, profile),
    )
    if (visible.some(block => block.type === 'toolCall')) return finishOf('tool-calls')
    if (visible.length === 0 && message.content.length === 0) {
      return finishOf('error', {
        message: `llm-omp-transports: ${profile.provider} model "${message.model}" completed the turn with no content`,
        code: EMPTY_RESPONSE_CODE,
      })
    }
    return finishOf('stop')
  }
  throw new LlmError(
    `llm-omp-transports: unrecognized ${profile.provider} stop reason "${String(reason)}"`,
    UNKNOWN_FINISH,
  )
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
  profile: RouteProfile,
): FinishChunk {
  const text = message.errorMessage ?? `${profile.provider} stream error`
  if (signal?.aborted === true || reason === 'aborted') {
    return finishOf('aborted', failureOf(text, ABORTED_CODE, message.errorStatus))
  }
  if (isContextWindowExceededError(text) || /\bCONVERSATION_TOO_LONG\b/.test(text)) {
    return finishOf('error', failureOf(text, CONTEXT_WINDOW_EXCEEDED_CODE, message.errorStatus))
  }
  return finishOf('error', failureOf(text, classifyFailure(text, message.errorStatus, profile), message.errorStatus))
}

/**
 * The terminal chunk for a turn the caller cancelled before it reached the
 * transport; the adapter yields it instead of resolving a credential.
 */
export function abortedFinish(): StreamChunk {
  return finishOf('aborted', failureOf('llm-omp-transports: request aborted before it was sent', ABORTED_CODE, undefined))
}

/** Build one terminal finish chunk. */
function finishOf(kind: 'stop' | 'max-tokens' | 'tool-calls'): FinishChunk
function finishOf(kind: 'error' | 'aborted', failure: LlmFailure): FinishChunk
function finishOf(kind: 'stop' | 'max-tokens' | 'tool-calls' | 'error' | 'aborted', failure?: LlmFailure): FinishChunk {
  if (kind === 'error' || kind === 'aborted') {
    if (failure === undefined) throw new Error('llm-omp-transports: an error finish requires a failure')
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
 * Classify a transport failure into the seam's provider-neutral code vocabulary.
 *
 * omp's provider error names arrive in the message (Cursor's transport prefixes
 * them with `Cursor`), and the transport also records the HTTP status it
 * derived. Status wins because it is the transport's own classification; the
 * profile supplies the unclassified fallback.
 */
function classifyFailure(message: string, status: number | undefined, profile: RouteProfile): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (/\bRESOURCE_EXHAUSTED\b|\bRATE_LIMITED\b|\bGENERIC_RATE_LIMIT_EXCEEDED\b/.test(message)) return 'RATE_LIMIT'
  if (/\bNOT_FOUND\b|\bFILE_NOT_FOUND\b/.test(message)) return 'NOT_FOUND'
  if (/\bUNAUTHORIZED\b|\bBAD_USER_API_KEY\b/.test(message)) return 'AUTH'
  if (/\bPROVIDER_ERROR\b|\bINTERNAL\b|\bNETWORK_ERROR\b/.test(message)) return 'SERVER'
  return profile.fallbackErrorCode
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
