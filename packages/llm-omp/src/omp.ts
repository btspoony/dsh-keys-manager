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
 * - a content block carries `text`, `thinking`, or a tool call; image blocks are
 *   recognized by their `type` and rejected where this route cannot carry them;
 * - the drift gate in `tests/build.test.ts` pins the omp version and source
 *   hashes, so a bump that changes these shapes fails before the plugin reads
 *   them.
 *
 * @module dsh-llm-omp-transports/omp
 */

/** Per-million-token prices omp prices a turn with. */
export interface ModelCost {
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
  readonly cost: ModelCost
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

/** Devin's resolved compat trio: the required keys of omp's `ResolvedDevinCompat`. */
export interface DevinModelCompat {
  readonly trustExplicitThinkingOnly: boolean
  /** Server-side router models resolve through `AssignModel`; no pinned row sets it. */
  readonly modelRouter: boolean
  readonly supportsParallelToolCalls: boolean
}

/** One row of the generated Devin model table. */
export interface DevinModelRow {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  /** Combined request and response context window in tokens. */
  readonly contextWindow: number
  /** Per-response output cap the catalog advertises. */
  readonly maxTokens: number
  readonly input: ('text' | 'image')[]
  readonly cost: ModelCost
  /** Gates plaintext-reasoning replay inside the transport. */
  readonly reasoning: boolean
  readonly compat: DevinModelCompat
  /** Wire model id to request when it differs from {@link id}. */
  readonly requestModelId?: string
}

/** The omp model object for devin: one catalog row plus the transport identity. */
export interface OmpDevinModel extends DevinModelRow {
  readonly api: 'devin-agent'
  readonly provider: 'devin'
}

/**
 * The wire family a Google row speaks.
 *
 * omp's Google provider switches on `identity.class` (Anthropic-shaped Claude
 * rows vs Gemini rows), and the projection forwards the whole record.
 */
export interface GoogleModelIdentity {
  /** `gemini`, `anthropic`, …: decides request/response shape on the wire. */
  readonly class: string
  /** Vendor lineage; rows the class alone classifies omit it. */
  readonly family?: string
  /** Model generation; rows the catalog does not version omit it. */
  readonly revision?: string
}

/** Google's thinking-effort metadata: the offered efforts and their wire models. */
export interface GoogleModelThinking {
  readonly mode: string
  readonly efforts: readonly string[]
  /** Effort → wire model id (`off` means the row's own id). */
  readonly effortRouting?: Readonly<Record<string, string>>
  /** Mandatory-reasoning endpoints reject a disabled thinking config. */
  readonly requiresEffort?: boolean
  /** Off maps to the lowest supported effort instead of an explicit disable. */
  readonly suppressWhenOff?: boolean
  readonly prefixBinding?: boolean
  /** Per-effort thinking budgets when the catalog pins them. */
  readonly effortBudgets?: Readonly<Record<string, number>>
}

/**
 * The per-model wire flags omp's Google provider reads.
 *
 * Copied whole from the pinned catalog: the transport dereferences members
 * across request building, schema normalization and usage labels, so a
 * hand-picked subset would drop a wire decision on an omp bump.
 */
export type GoogleModelCompat = Readonly<Record<string, boolean | number | string | undefined>>

/** One row of the generated Google model tables (both Cloud Code Assist routes). */
export interface GoogleModelRow {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  /** Combined request and response context window in tokens. */
  readonly contextWindow: number
  /** Per-response output cap the catalog advertises. */
  readonly maxTokens: number
  readonly input: ('text' | 'image')[]
  readonly cost: ModelCost
  readonly reasoning: boolean
  readonly identity: GoogleModelIdentity
  readonly compat: GoogleModelCompat
  readonly thinking?: GoogleModelThinking
  /** Wire model id to request when it differs from {@link id}. */
  readonly requestModelId?: string
}

/**
 * One row of the generated Factory Droid model table.
 *
 * The table is generated from `compat/rules.json`
 * (`providers.\`factory-droid\`.seed.models`) because the pinned `models.json`
 * carries no rows for this provider: its seed lives in the KDL registry rule.
 * Every row is a zero-cost Factory credit and the transport multiplexes the four
 * wire protocols by model id, so the row keeps the identity fields the wire
 * header and the family dispatch read — `id`, `api`, `provider`, `baseUrl` — plus
 * the limits and the capability flags the seam advertises.
 */
export interface FactoryDroidModelRow {
  readonly id: string
  readonly name: string
  readonly api: 'factory-droid-agent'
  readonly provider: 'factory-droid'
  readonly baseUrl: string
  /** Combined request and response context window in tokens. */
  readonly contextWindow: number
  /** Per-response output cap the catalog advertises. */
  readonly maxTokens: number
  readonly input: ('text' | 'image')[]
  readonly cost: ModelCost
  readonly reasoning: boolean
}

/** The omp model object for a Google row: one catalog row plus the transport identity. */
export interface OmpGoogleModel extends GoogleModelRow {
  readonly api: 'google-gemini-cli'
  readonly provider: 'google-gemini-cli' | 'google-antigravity'
}

/** Explicit thinking-off suppression: CCA re-applies the baked per-id default when omitted. */
export type OmpGoogleThinkingSuppress = { readonly level: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' } | { readonly budget: number }

/**
 * The Google provider's thinking configuration.
 *
 * Mirrors `GoogleGeminiCliOptions['thinking']`: `budgetTokens` for the
 * budget-mode rows (Gemini 2.x, the Anthropic-shaped Antigravity rows) and
 * `level` for the `google-level` rows (Gemini 3+).
 */
export interface OmpGoogleThinking {
  readonly enabled: boolean
  readonly budgetTokens?: number
  readonly level?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
  /** Present only when thinking is off on a `suppressWhenOff` row. */
  readonly suppress?: OmpGoogleThinkingSuppress
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
  readonly id?: string
  readonly name?: string
  readonly arguments?: Readonly<Record<string, unknown>>
}

/** A tool invocation the transport emits for DSH's tool loop to execute. */
export interface OmpToolCallBlock extends OmpContentBlock {
  readonly type: 'toolCall'
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
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

/** One tool result replayed in conversation history. */
export interface OmpToolResultMessage {
  readonly role: 'toolResult'
  readonly toolCallId: string
  readonly toolName: string
  readonly content: readonly OmpContentBlock[]
  readonly isError: boolean
  readonly timestamp: number
}

/** Conversation history the transport accepts from the plugin. */
export type OmpHistoryMessage = OmpUserMessage | OmpAssistantMessage | OmpToolResultMessage

/** One tool declaration advertised to Cursor as an MCP tool. */
export interface OmpTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

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

/** A tool-call block opened at `contentIndex`; the call's identity rides on `partial`. */
export interface OmpToolCallStartEvent {
  readonly type: 'toolcall_start'
  readonly contentIndex: number
  readonly partial?: OmpAssistantMessage
}

/** More raw JSON arguments for the open tool-call block. */
export interface OmpToolCallDeltaEvent {
  readonly type: 'toolcall_delta'
  readonly contentIndex: number
  readonly delta?: string
  readonly partial?: OmpAssistantMessage
}

/** The tool-call block closed at `contentIndex` with its assembled call. */
export interface OmpToolCallEndEvent {
  readonly type: 'toolcall_end'
  readonly contentIndex: number
  readonly toolCall?: OmpToolCallBlock
  readonly partial?: OmpAssistantMessage
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
  | OmpToolCallStartEvent
  | OmpToolCallDeltaEvent
  | OmpToolCallEndEvent
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

/** Request options handed to the omp devin transport. */
export interface OmpDevinOptions {
  /** Devin session token; the transport prefixes its wire scheme itself. */
  readonly apiKey: string
  readonly signal?: AbortSignal
  /** Reused as `cascade_id` so the backend threads turns. */
  readonly sessionId?: string
  /** Forwarded output cap; falls back to the row's `maxTokens` inside the transport. */
  readonly maxTokens?: number
  readonly temperature?: number
  readonly stopSequences?: string[]
  /** Fill-absent attribution wrapper (`src/devin/transport.ts`). */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/**
 * Request options handed to the omp Google transport (`streamGoogleGeminiCli`).
 *
 * No `headers`: caller headers merge last on the Cloud Code Assist wire and
 * would overwrite the vendor `user-agent` the provider sets (`GeminiCLI/…`,
 * `antigravity/hub/…`). Attribution travels through `fetch` instead.
 */
export interface OmpGoogleOptions {
  /**
   * The provider's credential envelope, as JSON:
   * `{token, projectId, refreshToken?, expiresAt?, email?}`.
   *
   * omp's `parseGeminiCliCredentials` reads it and refuses a missing `token` or
   * `projectId`, so the plugin hands the parsed record over verbatim.
   */
  readonly apiKey: string
  readonly signal?: AbortSignal
  /** Forwarded as the Cloud Code Assist request's own `sessionId`. */
  readonly sessionId?: string
  /** Forwarded output cap; the thinking budget is added on top, as omp does. */
  readonly maxTokens?: number
  readonly temperature?: number
  /** Wire model id selected by thinking-effort routing. */
  readonly requestModelId?: string
  readonly thinking?: OmpGoogleThinking
  /** Antigravity endpoint-failover state; the provider keys it itself. */
  readonly providerSessionState?: Map<string, unknown>
  /** Fill-absent attribution wrapper (`src/transport/fetch.ts`). */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** One fully projected request: the devin transport's three positional arguments. */
export interface OmpContext {
  readonly systemPrompt?: readonly string[]
  readonly messages: readonly OmpHistoryMessage[]
  /** Active tool declarations, advertised to Devin as chat tools. */
  readonly tools?: readonly OmpTool[]
}

/** The Cursor route's name for {@link OmpContext}. */
export type OmpCursorContext = OmpContext

/** The injected transport shape: omp's `streamCursor`. */
export type OmpCursorTransport = (
  model: OmpCursorModel,
  context: OmpContext,
  options: OmpCursorOptions,
) => AsyncIterable<OmpAssistantMessageEvent>

/** The injected devin transport shape: omp's `streamDevin`. */
export type OmpDevinTransport = (
  model: OmpDevinModel,
  context: OmpContext,
  options: OmpDevinOptions,
) => AsyncIterable<OmpAssistantMessageEvent>


/** The injected Google transport shape: omp's `streamGoogleGeminiCli` for both routes. */
export type OmpGoogleTransport = (
  model: OmpGoogleModel,
  context: OmpContext,
  options: OmpGoogleOptions,
) => AsyncIterable<OmpAssistantMessageEvent>
