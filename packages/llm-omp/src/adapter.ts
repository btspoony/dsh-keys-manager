/**
 * Adapter for the omp-owned `cursor` route.
 *
 * The route speaks Cursor's own agent protocol (`agent.v1.AgentService/Run`
 * over HTTP/2) through the omp build artifact in `lib/omp/cursor.mjs`. The
 * transport is injected rather than imported so this module stays free of the
 * 14 MB build artifact and tests can replay recorded event scripts. The plugin
 * wires the bundled `streamCursor` at registration and the credential seam
 * provides {@link OmpCursorAdapterConfig.access}, which refreshes an expiring
 * grant under the store's lock before it answers.
 *
 * The catalog is the generated `src/catalog/cursor.ts`, so `listModels` and
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
import { CURSOR_CREDENTIAL_KEY } from './cursor/credentials.js'
import { abortedFinish, projectEvents, projectRequest } from './projection.js'
import type { CursorModelRow, OmpCursorOptions, OmpCursorTransport } from './omp.js'

/** The provider route this adapter owns. */
export const CURSOR_ROUTE = 'cursor'

/** Machine code for a model id the generated catalog does not contain. */
export const UNKNOWN_MODEL = 'UNKNOWN_MODEL'
/** Machine code for a provider route this adapter does not serve. */
export const UNKNOWN_PROVIDER = 'UNKNOWN_PROVIDER'

/**
 * Input modalities every advertised row carries.
 *
 * shortcut: the projection carries text only and refuses every non-text block
 * with `CONTENT_UNSUPPORTED`, so advertising the catalog row's `input` verbatim
 * (100 of 123 rows say `image`) would promise a turn this route fails after
 * DSH's own image→text fallback is skipped. Task 2/3 add image forwarding; that
 * is when `row.input` becomes advertisable again.
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

/** The generated catalog, indexed for exact-model resolution. */
const MODELS_BY_ID: ReadonlyMap<string, CursorModelRow> = new Map(CURSOR_MODELS.map(row => [row.id, row]))

/** What the adapter needs from its host plugin. */
export interface OmpCursorAdapterConfig {
  /**
   * Resolve the Cursor bearer token for one request.
   *
   * @remarks
   * Asynchronous because it reads and refreshes the `llm-omp-transports/cursor`
   * credential through the credentials seam. The request signal is forwarded
   * so an aborted turn can abandon a refresh instead of writing it late. Tests
   * inject a fake.
   */
  access: (signal?: AbortSignal) => Promise<string>
  /**
   * The omp transport, normally the `streamCursor` export of
   * `lib/omp/cursor.mjs`. The seam tests drive it with recorded event scripts.
   */
  transport: OmpCursorTransport
  /**
   * Read the configured allow-list of catalog ids.
   *
   * @remarks
   * A getter because the profile is a volatile setting: a save updates the
   * running config reference without re-running the plugin, so a captured
   * array would go stale. An absent or empty list advertises the full catalog,
   * so the schema default (`providers.cursor.models: []`) is today's behavior;
   * a non-empty list narrows the advertised models and the accepted ids.
   */
  models?: () => readonly string[] | undefined
}

/** The DSH llm adapter for every route this plugin's omp transport serves. */
export class OmpCursorAdapter extends LlmAdapter {
  constructor(private readonly config: OmpCursorAdapterConfig) {
    super()
  }

  /**
   * Describe the route.
   *
   * @remarks
   * Cursor's agent protocol takes no client-side output cap, sampling
   * temperature, stop sequence or auxiliary-call purpose: the wire carries no
   * field for any of them, so the projection ignores those `GenerateOptions`
   * values instead of forwarding them. Cursor applies the catalog `maxTokens`
   * limit server-side.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    assertRoute(provider)
    const allowed = this.allowed()
    return CURSOR_MODELS.filter(row => allowed === undefined || allowed.has(row.id)).map(row => ({
      provider,
      id: row.id,
      name: row.name,
      inputModalities: [...INPUT_MODALITIES],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    assertRoute(provider)
    return modelInfo(provider, this.rowFor(model))
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.call(options)
  }

  /** The configured ids, or undefined when the route advertises the full catalog. */
  private allowed(): ReadonlySet<string> | undefined {
    const models = this.config.models?.()
    return models === undefined || models.length === 0 ? undefined : new Set(models)
  }

  /** Resolve one catalog row, refusing ids the configured allow-list excludes. */
  private rowFor(model: string): CursorModelRow {
    const row = MODELS_BY_ID.get(model)
    const allowed = this.allowed()
    if (row === undefined || (allowed !== undefined && !allowed.has(row.id))) {
      throw new LlmError(`llm-omp-transports: the cursor route has no model "${model}"`, UNKNOWN_MODEL)
    }
    return row
  }

  private async *call(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // Read the live signal each time: it can abort while the credential is read.
    const aborted = (): boolean => options.signal?.aborted === true
    // An already-cancelled turn must not pay a credential read (nor, once the
    // resolver refreshes, a CAS write) or open a stream.
    if (aborted()) {
      yield abortedFinish()
      return
    }
    const row = this.rowFor(options.model)
    // Validate and project before touching the credential: a refused request
    // must not pay a credential read (nor, once the resolver refreshes, a CAS
    // write). Only a request that can be served resolves `access` and carries
    // its token into the transport options.
    const request = projectRequest(row, options)
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
    const accessKey = assertUsableApiKey(credential, 'llm-omp-transports', CURSOR_CREDENTIAL_KEY)
    if (aborted()) {
      yield abortedFinish()
      return
    }
    const transportOptions: OmpCursorOptions = { ...request.options, apiKey: accessKey }
    yield* projectEvents(this.config.transport(request.model, request.context, transportOptions), options.signal)
  }
}

/** Refuse routes this adapter does not own instead of describing another provider's models. */
function assertRoute(provider: string): void {
  if (provider !== CURSOR_ROUTE) {
    throw new LlmError(`llm-omp-transports: the cursor adapter does not serve provider "${provider}"`, UNKNOWN_PROVIDER)
  }
}

/** Build the seam's exact-model metadata from one catalog row. */
function modelInfo(provider: string, row: CursorModelRow): LlmResolvedModelInfo {
  const efforts = row.thinking?.efforts ?? []
  return {
    provider,
    id: row.id,
    name: row.name,
    inputModalities: [...INPUT_MODALITIES],
    context: { contextWindow: row.contextWindow },
    // No `defaultMaxTokens`. The seam materializes that number into `maxTokens`
    // on every request that omits one, and Cursor's wire has no per-request
    // output-cap field: the projection ignores `maxTokens` rather than
    // forwarding it, so advertising a default would only promise a cap nothing
    // enforces. Cursor applies the catalog cap server-side, from the `maxTokens`
    // the model object already carries.
    // Every effort list is advertised exactly as the catalog declares it. On a
    // row with no `effortRouting` entry each advertised effort resolves to the
    // same wire id — the row's own — so those selections are wire-level no-ops,
    // exactly as in omp.
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
