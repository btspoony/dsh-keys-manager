/**
 * The Devin route's live model catalog.
 *
 * Devin's roster is credential-scoped: the pinned catalog deliberately ships a
 * single seed row (`swe-1-6`) because baking one account's entitlement into a
 * shared table would misstate every other account's. omp therefore marks the
 * provider `dynamic-models-authoritative` and replaces the seed with the result
 * of `GetCliModelConfigs` at runtime; this module does the same for the plugin,
 * reading that RPC through the bundled artifact (the published package may not
 * import `@oh-my-pi/*` at runtime).
 *
 * The discovered rows are held in one module-level slot, so the adapter's
 * `listModels` and the keys-manager's model picker see the same roster without
 * the host having to route it through a service. An absent, failed or expired
 * read falls back to the committed seed: a route that cannot list its account's
 * models must still serve the one model it can prove.
 *
 * @module dsh-llm-omp-transports/devin/discovery
 */
import { DEVIN_MODELS } from '../catalog/devin.js'
import type { DevinModelRow, OmpDevinDiscoveredModel, OmpDevinDiscoveryOptions } from '../omp.js'
import { DEVIN_CREDENTIAL_KEY, readDevinGrant } from './credentials.js'
import type { CredentialRecordsLike } from '../cursor/credentials.js'

/** How long a discovered roster is served before the next read asks Devin again. */
const TTL_MS = 5 * 60 * 1000

/** The discovery half of the bundled artifact (also the tests' seam). */
export type DiscoverDevinModels = (
  options: OmpDevinDiscoveryOptions,
) => Promise<readonly OmpDevinDiscoveredModel[] | null>

/** Test seams for {@link refreshDevinRows}; the plugin uses the real network and clock. */
export interface DevinCatalogOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
  /** The discovery implementation; defaults to the bundled artifact. */
  readonly discover?: DiscoverDevinModels
}

/** The roster currently served: the last good discovery, else the committed seed. */
let served: { readonly rows: readonly DevinModelRow[]; readonly at: number } | undefined
/** The read in flight, so concurrent callers share one RPC. */
let inFlight: Promise<readonly DevinModelRow[]> | undefined

/** The rows this route serves right now: a discovery result, or the seed. */
export function currentDevinRows(): readonly DevinModelRow[] {
  return served?.rows ?? DEVIN_MODELS
}

/**
 * Load the discovery half of the bundled artifact on first use.
 *
 * As lazy as `bundledTransport`: a source checkout without `pnpm build` keeps
 * serving the seed instead of failing the route at import time.
 */
async function loadDiscovery(): Promise<DiscoverDevinModels> {
  const loaded = (await import(new URL('../omp/devin.mjs', import.meta.url).href)) as Record<string, unknown>
  const candidate = loaded.fetchDevinModels
  if (typeof candidate !== 'function') throw new Error('the bundled devin artifact exports no fetchDevinModels')
  return candidate as DiscoverDevinModels
}

/** omp's fallbacks for a server row that states neither limit. */
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000

/** One discovered spec as the generated row shape the adapter serves. */
function toRow(spec: OmpDevinDiscoveredModel): DevinModelRow {
  return {
    id: spec.id,
    name: spec.name,
    baseUrl: spec.baseUrl,
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
    input: [...spec.input],
    cost: { ...spec.cost },
    reasoning: spec.reasoning === true,
    compat: {
      // The provider rule pins `on-api "devin-agent" trust-explicit-thinking-only
      // #true`; the discovery spec only ever names the two optional flags.
      trustExplicitThinkingOnly: spec.compat?.trustExplicitThinkingOnly ?? true,
      modelRouter: spec.compat?.modelRouter === true,
      supportsParallelToolCalls: spec.compat?.supportsParallelToolCalls === true,
    },
    ...(spec.requestModelId === undefined ? {} : { requestModelId: spec.requestModelId }),
  }
}

/**
 * Ask Devin for this account's models and publish the answer.
 *
 * @param credentials - the record half of the credentials seam, for the grant.
 * @param options - fetch/timeout/clock seams.
 * @returns the roster now served (the seed when there is no usable grant).
 * @throws when the RPC fails, so a forced refresh can report it; callers that
 *   must not fail ({@link devinRows}) swallow it and keep serving the last good
 *   roster.
 */
export async function refreshDevinRows(
  credentials: CredentialRecordsLike,
  options: DevinCatalogOptions = {},
): Promise<readonly DevinModelRow[]> {
  const now = options.now ?? Date.now
  const grant = readDevinGrant(await credentials.readRecord(DEVIN_CREDENTIAL_KEY))
  // No readable grant: there is nothing to ask with, and this is not a failure
  // (a signed-out route still serves the seed).
  if (grant === undefined || grant.expiresInvalid === true) return currentDevinRows()
  if (grant.expires !== undefined && grant.expires <= now()) return currentDevinRows()

  const discover = options.discover ?? await loadDiscovery()
  const specs = await discover({
    apiKey: grant.access,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (specs === null || specs.length === 0) {
    throw new Error('llm-omp-transports: Devin returned no model catalog for this account')
  }
  const rows = specs.map(toRow).sort((a, b) => a.id.localeCompare(b.id))
  served = { rows, at: now() }
  return rows
}

/**
 * The route's roster, refreshed at most once per {@link TTL_MS}.
 *
 * Never rejects: a failed read keeps the previous roster (or the seed) in
 * service, exactly as omp's own discovery falls back to its seed.
 *
 * @param credentials - the record half of the credentials seam.
 * @param options - fetch/timeout/clock seams, forwarded to the refresh.
 * @returns the rows to serve.
 */
export async function devinRows(
  credentials: CredentialRecordsLike,
  options: DevinCatalogOptions = {},
): Promise<readonly DevinModelRow[]> {
  const now = (options.now ?? Date.now)()
  if (served !== undefined && now - served.at < TTL_MS) return served.rows
  if (inFlight !== undefined) return inFlight
  const run = refreshDevinRows(credentials, options)
    .catch(() => currentDevinRows())
    .finally(() => {
      if (inFlight === run) inFlight = undefined
    })
  inFlight = run
  return run
}
