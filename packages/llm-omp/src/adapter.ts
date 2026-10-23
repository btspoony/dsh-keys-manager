/**
 * Adapter for the omp-owned routes this plugin serves.
 *
 * Two routes share one shape: the provider speaks its own agent protocol
 * (Cursor's `agent.v1.AgentService/Run`, Devin's Connect-framed
 * `GetChatMessage`) through an omp build artifact in `lib/omp/*.mjs`. The
 * transport is injected rather than imported so this module stays free of the
 * bundled artifacts and tests can replay recorded event scripts. A
 * {@link TransportRoute} carries what differs per route: the catalog, the
 * projection and the credential key; the base class carries the shared
 * credential/turn ordering.
 *
 * The catalogs are the generated `src/catalog/*.ts`, so `listModels` and
 * `resolveModel` answer without a network call and carry the transport flags the
 * projection needs (effort routing, max mode, glyph tokenization).
 *
 * @module dsh-llm-omp-transports/adapter
 */
import { LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { CURSOR_MODELS } from './catalog/cursor.js'
import { DEVIN_MODELS } from './catalog/devin.js'
import { GOOGLE_ANTIGRAVITY_MODELS } from './catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_MODELS } from './catalog/google-gemini-cli.js'
import { CURSOR_CREDENTIAL_KEY } from './cursor/credentials.js'
import { DEVIN_CREDENTIAL_KEY } from './devin/credentials.js'
import {
  CURSOR_PROFILE,
  DEVIN_PROFILE,
  GOOGLE_ANTIGRAVITY_PROFILE,
  GOOGLE_GEMINI_CLI_PROFILE,
  abortedFinish,
  projectDevinRequest,
  projectEvents,
  projectGoogleRequest,
  projectRequest,
} from './projection.js'
import type { RouteProfile } from './projection.js'
import type { OmpAssistantMessageEvent, OmpContext } from './omp.js'
import type {
  CursorModelRow,
  DevinModelRow,
  GoogleModelRow,
  OmpCursorModel,
  OmpCursorOptions,
  OmpDevinModel,
  OmpDevinOptions,
  OmpGoogleModel,
  OmpGoogleOptions,
} from './omp.js'

/** The Cursor provider route this adapter owns. */
export const CURSOR_ROUTE = 'cursor'
/** The Devin provider route this adapter owns. */
export const DEVIN_ROUTE = 'devin'
/** The Gemini CLI provider route this adapter owns. */
export const GOOGLE_GEMINI_CLI_ROUTE = 'google-gemini-cli'
/** The Antigravity provider route this adapter owns. */
export const GOOGLE_ANTIGRAVITY_ROUTE = 'google-antigravity'

/** Machine code for a model id the generated catalog does not contain. */
export const UNKNOWN_MODEL = 'UNKNOWN_MODEL'
/** Machine code for a provider route this adapter does not serve. */
export const UNKNOWN_PROVIDER = 'UNKNOWN_PROVIDER'

/**
 * Input modalities every advertised row carries.
 *
 * shortcut: both projections carry text only and refuse every non-text block
 * with `CONTENT_UNSUPPORTED`, so advertising the catalog row's `input` verbatim
 * would promise a turn this route fails after DSH's own image→text fallback is
 * skipped. Task 2/3 add image forwarding; that is when `row.input` becomes
 * advertisable again.
 */
const INPUT_MODALITIES: readonly ModelModality[] = ['text']

/** Display names for the catalog's reasoning efforts. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** The catalog fields every route's row must carry. */
interface TransportRow {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
}

/** The transport options both routes accept at their shared surface. */
interface TransportOptions {
  readonly apiKey?: string
  readonly signal?: AbortSignal
}

/** One omp transport function, narrowed to the plugin's event contract. */
export type OmpTransportOf<Model, Options> = (
  model: Model,
  context: OmpContext,
  options: Options,
) => AsyncIterable<OmpAssistantMessageEvent>

/** The three positional transport arguments a projection produces. */
export interface ProjectedTransportRequest<Model, Options> {
  readonly model: Model
  readonly context: OmpContext
  /** Transport options without the credential; the adapter injects `apiKey`. */
  readonly options: Omit<Options, 'apiKey'> & { readonly apiKey?: string }
}

/** What differs between the routes: identity, catalog, projection and credential record. */
export interface TransportRoute<Row extends TransportRow, Model, Options extends TransportOptions> {
  /** Provider id; also the registered route set the projection's profile accepts. */
  readonly id: 'cursor' | 'devin' | 'google-gemini-cli' | 'google-antigravity'
  /** Models-page / provider-info display name. */
  readonly displayName: string
  /** The `ctx.credentials` record this route reads. */
  readonly credentialKey: string
  /** Projection facts: identity, fallback error code and transport-resolved marker. */
  readonly profile: RouteProfile
  /** The generated catalog. */
  readonly models: readonly Row[]
  /** Project one DSH request onto this route's transport arguments. */
  readonly project: (row: Row, options: GenerateOptions) => ProjectedTransportRequest<Model, Options>
  /**
   * The row's advertised reasoning efforts.
   *
   * Cursor's rows carry `thinking.efforts`; Devin's rows advertise none (a
   * selected effort is refused by its projection), so the route may omit this.
   */
  readonly efforts?: (row: Row) => readonly string[] | undefined
}

/** The Cursor route's facts. */
export const CURSOR_TRANSPORT_ROUTE: TransportRoute<CursorModelRow, OmpCursorModel, OmpCursorOptions> = {
  id: CURSOR_ROUTE,
  displayName: 'Cursor',
  credentialKey: CURSOR_CREDENTIAL_KEY,
  profile: CURSOR_PROFILE,
  models: CURSOR_MODELS,
  project: projectRequest,
  efforts: row => row.thinking?.efforts,
}

/** The Devin route's facts. */
export const DEVIN_TRANSPORT_ROUTE: TransportRoute<DevinModelRow, OmpDevinModel, OmpDevinOptions> = {
  id: DEVIN_ROUTE,
  displayName: 'Devin',
  credentialKey: DEVIN_CREDENTIAL_KEY,
  profile: DEVIN_PROFILE,
  models: DEVIN_MODELS,
  project: projectDevinRequest,
}

/**
 * The two Google routes' facts.
 *
 * One artifact serves both: `streamGoogleGeminiCli` dispatches on
 * `model.provider`, so only the profile, the catalog and the credential record
 * differ. The credential key is the route id under the package namespace
 * (`llm-omp-transports/<route>`), as it is for cursor and devin; the Google
 * resolver reads and writes those records.
 */
export const GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE: TransportRoute<GoogleModelRow, OmpGoogleModel, OmpGoogleOptions> = {
  id: GOOGLE_GEMINI_CLI_ROUTE,
  displayName: 'Google Gemini CLI',
  credentialKey: `llm-omp-transports/${GOOGLE_GEMINI_CLI_ROUTE}`,
  profile: GOOGLE_GEMINI_CLI_PROFILE,
  models: GOOGLE_GEMINI_CLI_MODELS,
  project: (row, options) => projectGoogleRequest(row, GOOGLE_GEMINI_CLI_PROFILE, options),
  efforts: row => row.thinking?.efforts,
}

/** The Antigravity route's facts: the same provider over its own catalog and endpoint family. */
export const GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE: TransportRoute<GoogleModelRow, OmpGoogleModel, OmpGoogleOptions> = {
  id: GOOGLE_ANTIGRAVITY_ROUTE,
  displayName: 'Google Antigravity',
  credentialKey: `llm-omp-transports/${GOOGLE_ANTIGRAVITY_ROUTE}`,
  profile: GOOGLE_ANTIGRAVITY_PROFILE,
  models: GOOGLE_ANTIGRAVITY_MODELS,
  project: (row, options) => projectGoogleRequest(row, GOOGLE_ANTIGRAVITY_PROFILE, options),
  efforts: row => row.thinking?.efforts,
}

/** What an adapter needs from its host plugin. */
export interface OmpAdapterOptions<Model, Options extends TransportOptions> {
  /**
   * Resolve the route's bearer token for one request.
   *
   * @remarks
   * Asynchronous because it reads (and, for Cursor, refreshes) the route's
   * credential through the credentials seam. The request signal is forwarded
   * so an aborted turn can abandon a refresh instead of writing it late. Tests
   * inject a fake.
   */
  access: (signal?: AbortSignal) => Promise<string>
  /** The omp transport, normally the artifact's stream export. Tests script it. */
  transport: OmpTransportOf<Model, Options>
  /**
   * Read the configured allow-list of catalog ids.
   *
   * @remarks
   * A getter because the profile is a volatile setting: a save updates the
   * running config reference without re-running the plugin, so a captured
   * array would go stale. An absent or empty list advertises the full catalog,
   * so the schema default (`providers.<route>.models: []`) is today's behavior;
   * a non-empty list narrows the advertised models and the accepted ids.
   */
  models?: () => readonly string[] | undefined
}

/** The adapter configuration for one concrete route. */
interface OmpRouteAdapterConfig<Row extends TransportRow, Model, Options extends TransportOptions>
  extends OmpAdapterOptions<Model, Options> {
  readonly route: TransportRoute<Row, Model, Options>
}

/**
 * The DSH llm adapter for one omp-backed route.
 *
 * @remarks
 * The per-turn order is fixed: refuse an already-aborted turn, resolve the row,
 * project the request (refusals must not pay a credential read), read the
 * credential, validate it, then stream. Cursor's grant can be refreshed under
 * that read; Devin's resolver only reads.
 */
abstract class OmpTransportAdapter<
  Row extends TransportRow,
  Model,
  Options extends TransportOptions,
> extends LlmAdapter {
  private readonly rows: ReadonlyMap<string, Row>

  protected constructor(private readonly config: OmpRouteAdapterConfig<Row, Model, Options>) {
    super()
    this.rows = new Map(config.route.models.map(row => [row.id, row]))
  }

  /** The configured ids, or undefined when the route advertises the full catalog. */
  private allowed(): ReadonlySet<string> | undefined {
    const models = this.config.models?.()
    return models === undefined || models.length === 0 ? undefined : new Set(models)
  }

  /** Resolve one catalog row, refusing ids the configured allow-list excludes. */
  private rowFor(model: string): Row {
    const row = this.rows.get(model)
    const allowed = this.allowed()
    if (row === undefined || (allowed !== undefined && !allowed.has(row.id))) {
      throw new LlmError(`llm-omp-transports: the ${this.config.route.id} route has no model "${model}"`, UNKNOWN_MODEL)
    }
    return row
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.assertRoute(provider)
    return { id: provider, name: this.config.route.displayName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertRoute(provider)
    const allowed = this.allowed()
    return this.config.route.models
      .filter(row => allowed === undefined || allowed.has(row.id))
      .map(row => ({
        provider,
        id: row.id,
        name: row.name,
        inputModalities: [...INPUT_MODALITIES],
      }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.assertRoute(provider)
    return this.modelInfo(provider, this.rowFor(model))
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.call(options)
  }

  /** Refuse routes this adapter does not own instead of describing another provider's models. */
  private assertRoute(provider: string): void {
    if (provider !== this.config.route.id) {
      throw new LlmError(
        `llm-omp-transports: the ${this.config.route.id} adapter does not serve provider "${provider}"`,
        UNKNOWN_PROVIDER,
      )
    }
  }

  private async *call(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // Read the live signal each time: it can abort while the credential is read.
    const aborted = (): boolean => options.signal?.aborted === true
    // An already-cancelled turn must not pay a credential read (nor, once Cursor
    // refreshes, a CAS write) or open a stream.
    if (aborted()) {
      yield abortedFinish()
      return
    }
    const row = this.rowFor(options.model)
    // Validate and project before touching the credential: a refused request
    // must not pay a credential read. Only a request that can be served
    // resolves `access` and carries its token into the transport options.
    const request = this.config.route.project(row, options)
    let credential: string
    try {
      credential = await this.config.access(options.signal)
    } catch (error) {
      // The resolver rejects when the caller aborts (a refresh is abandoned,
      // not failed), so that rejection is the turn's cancellation. A genuine
      // credential failure has no aborted signal and still propagates.
      if (!aborted()) throw error
      yield abortedFinish()
      return
    }
    const accessKey = assertUsableApiKey(credential, 'llm-omp-transports', this.config.route.credentialKey)
    if (aborted()) {
      yield abortedFinish()
      return
    }
    const transportOptions = { ...request.options, apiKey: accessKey } as Options
    yield* projectEvents(this.config.transport(request.model, request.context, transportOptions), options.signal, this.config.route.profile)
  }

  /** Build the seam's exact-model metadata from one catalog row. */
  private modelInfo(provider: string, row: Row): LlmResolvedModelInfo {
    const efforts = this.config.route.efforts?.(row) ?? []
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: [...INPUT_MODALITIES],
      context: { contextWindow: row.contextWindow },
      // No `defaultMaxTokens`. The seam materializes that number into
      // `maxTokens` on every request that omits one; Cursor's wire has no
      // per-request output-cap field, and Devin's projection forwards an
      // explicit `maxTokens` but the transport already defaults to the row's
      // `maxTokens`. Advertising a default would only promise a cap nothing
      // enforces. Both catalogs apply their cap from the model object.
      // Every effort list is advertised exactly as the catalog declares it. On
      // a row with no `effortRouting` entry each advertised effort resolves to
      // the same wire id — the row's own — so those selections are wire-level
      // no-ops, exactly as in omp.
      ...(efforts.length > 0
        ? {
            reasoning: {
              efforts: efforts.map(effort => ({
                id: ReasoningEffortId(effort),
                name: EFFORT_NAMES[effort] ?? effort,
              })),
            },
          }
        : {}),
    }
  }
}

/** The DSH llm adapter configuration for the Cursor route. */
export type OmpCursorAdapterConfig = OmpAdapterOptions<OmpCursorModel, OmpCursorOptions>

/** The Cursor adapter: the bundled `streamCursor` over the generated Cursor catalog. */
export class OmpCursorAdapter extends OmpTransportAdapter<CursorModelRow, OmpCursorModel, OmpCursorOptions> {
  constructor(options: OmpCursorAdapterConfig) {
    super({ route: CURSOR_TRANSPORT_ROUTE, ...options })
  }
}

/** The DSH llm adapter configuration for the Devin route. */
export type OmpDevinAdapterConfig = OmpAdapterOptions<OmpDevinModel, OmpDevinOptions>

/** The Devin adapter: the bundled `streamDevin` over the generated Devin catalog. */
export class OmpDevinAdapter extends OmpTransportAdapter<DevinModelRow, OmpDevinModel, OmpDevinOptions> {
  constructor(options: OmpDevinAdapterConfig) {
    super({ route: DEVIN_TRANSPORT_ROUTE, ...options })
  }
}

/** The DSH llm adapter configuration for a Google route. */
export type OmpGoogleAdapterConfig = OmpAdapterOptions<OmpGoogleModel, OmpGoogleOptions>

/** The Gemini CLI adapter: the bundled `streamGoogleGeminiCli` over the Gemini CLI catalog. */
export class OmpGoogleGeminiCliAdapter extends OmpTransportAdapter<GoogleModelRow, OmpGoogleModel, OmpGoogleOptions> {
  constructor(options: OmpGoogleAdapterConfig) {
    super({ route: GOOGLE_GEMINI_CLI_TRANSPORT_ROUTE, ...options })
  }
}

/** The Antigravity adapter: the same artifact and transport over the Antigravity catalog. */
export class OmpGoogleAntigravityAdapter extends OmpTransportAdapter<GoogleModelRow, OmpGoogleModel, OmpGoogleOptions> {
  constructor(options: OmpGoogleAdapterConfig) {
    super({ route: GOOGLE_ANTIGRAVITY_TRANSPORT_ROUTE, ...options })
  }
}
