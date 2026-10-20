/**
 * Structural contract between this plugin and the omp Cursor transport.
 *
 * The transport is a build-time artifact (`lib/omp/cursor.mjs`, built from
 * `@oh-my-pi/pi-ai@18.12.3`), so this module declares the subset of omp's
 * shapes the plugin constructs or reads — not a copy of omp's own types. Only
 * declared members are part of the contract:
 *
 * - message fields the plugin writes into outbound history (`api`, `provider`,
 *   `timestamp`) are optional here because event fixtures and stream messages do
 *   not need them, while history mapping always supplies them;
 * - a content block carries `text` or `thinking`; other omp block kinds (tool
 *   calls, images) are recognized by their `type` and rejected where this task
 *   cannot carry them;
 * - the drift gate in `tests/build.test.ts` pins the omp version and source
 *   hashes, so a bump that changes these shapes fails before the plugin reads
 *   them.
 *
 * @module @dsh-keys-manager/llm-omp/omp
 */

/** Per-million-token prices omp prices a Cursor turn with. */
export interface CursorModelCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Cursor's thinking-effort metadata: the offered efforts and their wire models. */
export interface CursorModelThinking {
  readonly mode: string
  readonly efforts: readonly string[]
  /** Effort → wire model id (`off` means the row's own id). */
  readonly effortRouting?: Readonly<Record<string, string>>
}

/** One row of the generated Cursor model table. */
export interface CursorModelRow {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  /** Combined request and response context window in tokens. */
  readonly contextWindow: number
  /** Per-response output cap the catalog advertises. */
  readonly maxTokens: number
  readonly input: ('text' | 'image')[]
  readonly cost: CursorModelCost
  /** `max_mode` marker; only meaningful per routed wire id on collapsed rows. */
  readonly cursorMaxMode?: boolean
  /** Per-wire-id `max_mode` markers when the row collapsed several wire ids. */
  readonly cursorMaxModeRoutes?: Readonly<Record<string, boolean>>
  readonly thinking?: CursorModelThinking
  /** Wire model id to request when it differs from {@link id}. */
  readonly requestModelId?: string
  readonly requiresGlyphTokenization: boolean
  /** Whether tool schemas need Cursor's schema combiner projection. */
  readonly requiresCursorToolSchemaProjection?: boolean
}

/** The omp model object: one catalog row plus the transport identity. */
export interface OmpCursorModel extends CursorModelRow {
  readonly api: 'cursor-agent'
  readonly provider: 'cursor'
}

/** Token counters omp reports for one turn. */
export interface OmpUsage {
  /** Uncached prompt tokens. */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** omp's aggregate total (input + output + cache read + cache write). */
  readonly totalTokens: number
  readonly reasoningTokens?: number
}

/** One content block of an omp message, narrowed to the fields the plugin reads. */
export interface OmpContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
}

/** An omp assistant message: outbound history and the terminal stream payload. */
export interface OmpAssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly OmpContentBlock[]
  readonly usage: OmpUsage
  readonly stopReason: string
  readonly model: string
  /**
   * Provider identity of the turn that produced this message (outbound history).
   *
   * The transport replays reasoning only when `api`/`provider`/`model` name the
   * Cursor target (`canReplayCursorThinking`), so a turn from another route
   * keeps its real provider here instead of the Cursor identity.
   */
  readonly api?: string
  /** Present on outbound history; see {@link api}. */
  readonly provider?: string
  readonly timestamp?: number
  readonly errorMessage?: string
  /** HTTP status the transport classified the failure to. */
  readonly errorStatus?: number
}

/** An omp user or developer message the plugin can produce. */
export interface OmpUserMessage {
  readonly role: 'user' | 'developer'
  readonly content: readonly OmpContentBlock[]
  readonly timestamp: number
}

/** Conversation history the transport accepts from the plugin. */
export type OmpHistoryMessage = OmpUserMessage | OmpAssistantMessage

/** Stream opened; carries no content of its own. */
export interface OmpStartEvent {
  readonly type: 'start'
}

/** A text block opened at `contentIndex`. */
export interface OmpTextStartEvent {
  readonly type: 'text_start'
  readonly contentIndex: number
}

/** More text for the open text block. */
export interface OmpTextDeltaEvent {
  readonly type: 'text_delta'
  readonly contentIndex: number
  readonly delta: string
}

/** The text block closed at `contentIndex` with its assembled text. */
export interface OmpTextEndEvent {
  readonly type: 'text_end'
  readonly contentIndex: number
  readonly content: string
}

/** A reasoning block opened at `contentIndex`. */
export interface OmpThinkingStartEvent {
  readonly type: 'thinking_start'
  readonly contentIndex: number
}

/** More reasoning for the open reasoning block. */
export interface OmpThinkingDeltaEvent {
  readonly type: 'thinking_delta'
  readonly contentIndex: number
  readonly delta: string
}

/** The reasoning block closed at `contentIndex` with its assembled text. */
export interface OmpThinkingEndEvent {
  readonly type: 'thinking_end'
  readonly contentIndex: number
  readonly content: string
}

/** A tool-call block lifecycle event (Task 2 of the plan carries these). */
export interface OmpToolCallEvent {
  readonly type: 'toolcall_start' | 'toolcall_delta' | 'toolcall_end'
  readonly contentIndex: number
}

/** An image block completed inside the assistant turn. */
export interface OmpImageEvent {
  readonly type: 'image_end'
  readonly contentIndex: number
}

/** Terminal success event carrying the assembled message and usage. */
export interface OmpDoneEvent {
  readonly type: 'done'
  readonly reason: 'stop' | 'length' | 'toolUse'
  readonly message: OmpAssistantMessage
}

/** Terminal failure event; failures are in-band, not thrown. */
export interface OmpErrorEvent {
  readonly type: 'error'
  readonly reason: 'aborted' | 'error'
  readonly error: OmpAssistantMessage
}

/** Every event kind this plugin knows how to receive. */
export type OmpAssistantMessageEvent =
  | OmpStartEvent
  | OmpTextStartEvent
  | OmpTextDeltaEvent
  | OmpTextEndEvent
  | OmpThinkingStartEvent
  | OmpThinkingDeltaEvent
  | OmpThinkingEndEvent
  | OmpToolCallEvent
  | OmpImageEvent
  | OmpDoneEvent
  | OmpErrorEvent

/** Request options handed to the omp transport. */
export interface OmpCursorOptions {
  /** Bearer token for Cursor's RPCs. */
  readonly apiKey: string
  readonly signal?: AbortSignal
  /** Session id reused as the Cursor conversation id, for transport affinity. */
  readonly sessionId?: string
  /** Wire model id selected by thinking-effort routing. */
  readonly wireModelId?: string
  /** Accept unhandled MCP calls as handoffs to DSH's own tool loop. */
  readonly externalToolExecutor?: boolean
  readonly headers?: Readonly<Record<string, string>>
  readonly transport?: 'auto' | 'http2' | 'http1'
}

/** One fully projected request: the transport's three positional arguments. */
export interface OmpCursorContext {
  readonly systemPrompt?: readonly string[]
  readonly messages: readonly OmpHistoryMessage[]
}

/** The injected transport shape: omp's `streamCursor`. */
export type OmpCursorTransport = (
  model: OmpCursorModel,
  context: OmpCursorContext,
  options: OmpCursorOptions,
) => AsyncIterable<OmpAssistantMessageEvent>
