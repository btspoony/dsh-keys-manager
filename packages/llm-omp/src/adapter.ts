/**
 * Adapter for the omp-owned `cursor` route.
 *
 * The route speaks Cursor's own agent protocol (`agent.v1.AgentService/Run`
 * over HTTP/2) through the omp build artifact in `lib/omp/cursor.mjs`. The
 * transport is injected rather than imported so this module stays free of the
 * 14 MB build artifact and tests can replay recorded event scripts. Production
 * wiring (the plugin's `apply`) passes the artifact's `streamCursor`; the
 * credential seam provides {@link OmpCursorAdapterConfig.access}.
 *
 * The catalog is the generated `src/catalog/cursor.ts`, so `listModels` and
 * `resolveModel` answer without a network call and carry the transport flags the
 * projection needs (effort routing, max mode, glyph tokenization).
 *
 * @module @dsh-keys-manager/llm-omp/adapter
 */
import { LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { CURSOR_MODELS } from './catalog/cursor.js'
import { projectEvents, projectRequest } from './projection.js'
import type { CursorModelRow, OmpCursorTransport } from './omp.js'

/** The provider route this adapter owns. */
export const CURSOR_ROUTE = 'cursor'

/** Credential scope Task 3 wires this resolver to. */
const CREDENTIAL_REF = 'llm-omp/cursor'

/** Machine code for a model id the generated catalog does not contain. */
export const UNKNOWN_MODEL = 'UNKNOWN_MODEL'
/** Machine code for a provider route this adapter does not serve. */
export const UNKNOWN_PROVIDER = 'UNKNOWN_PROVIDER'

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
   * Asynchronous because Task 3 reads and refreshes the `llm-omp/cursor`
   * credential through the credentials seam. Tests inject a fake.
   */
  access: () => Promise<string>
  /**
   * The omp transport, normally the `streamCursor` export of
   * `lib/omp/cursor.mjs`. The seam tests drive it with recorded event scripts.
   */
  transport: OmpCursorTransport
}

/** The DSH llm adapter for every route this plugin's omp transport serves. */
export class OmpCursorAdapter extends LlmAdapter {
  constructor(private readonly config: OmpCursorAdapterConfig) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    assertRoute(provider)
    return CURSOR_MODELS.map(row => ({
      provider,
      id: row.id,
      name: row.name,
      inputModalities: [...row.input],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    assertRoute(provider)
    return modelInfo(provider, rowFor(model))
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.call(options)
  }

  private async *call(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const row = rowFor(options.model)
    const accessKey = assertUsableApiKey(await this.config.access(), 'llm-omp', CREDENTIAL_REF)
    const request = projectRequest(row, options, accessKey)
    yield* projectEvents(this.config.transport(request.model, request.context, request.options), options.signal)
  }
}

/** Resolve one catalog row, refusing ids the pinned catalog does not serve. */
function rowFor(model: string): CursorModelRow {
  const row = MODELS_BY_ID.get(model)
  if (row === undefined) {
    throw new LlmError(`llm-omp: the cursor route has no model "${model}"`, UNKNOWN_MODEL)
  }
  return row
}

/** Refuse routes this adapter does not own instead of describing another provider's models. */
function assertRoute(provider: string): void {
  if (provider !== CURSOR_ROUTE) {
    throw new LlmError(`llm-omp: the cursor adapter does not serve provider "${provider}"`, UNKNOWN_PROVIDER)
  }
}

/** Build the seam's exact-model metadata from one catalog row. */
function modelInfo(provider: string, row: CursorModelRow): LlmResolvedModelInfo {
  const efforts = row.thinking?.efforts ?? []
  return {
    provider,
    id: row.id,
    name: row.name,
    inputModalities: [...row.input],
    context: { contextWindow: row.contextWindow },
    // No `defaultMaxTokens`. The seam materializes that number into `maxTokens`
    // on every request that omits one, and the Cursor transport has no
    // per-request output-cap field: the projection refuses a caller-set
    // `maxTokens` instead of dropping it, so advertising a default would only
    // produce refusals. Cursor enforces the catalog cap server-side, from the
    // `maxTokens` the model object already carries.
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
