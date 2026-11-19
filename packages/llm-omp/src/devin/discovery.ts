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
 * The discovered rows live in one module-level slot keyed by the account they
 * were read for, so the adapter's `listModels` and the keys-manager's model
 * picker see the same roster without the host routing it through a service.
 * The fallback is the same account's last good roster, else the committed seed —
 * never another account's rows: a signed-out route and a switched account answer
 * the seed. A failed read is not retried before the TTL expires (a dead endpoint
 * must not cost one doomed RPC per turn).
 *
 * @module dsh-llm-omp-transports/devin/discovery
 */
import { createHash } from 'node:crypto'

import { DEVIN_MODELS } from '../catalog/devin.js'
import type { DevinModelRow, OmpDevinDiscoveredModel, OmpDevinDiscoveryOptions } from '../omp.js'
import { DEVIN_CREDENTIAL_KEY, readDevinGrant } from './credentials.js'
import type { CredentialRecordsLike } from '../cursor/credentials.js'

/** How long a discovered roster — or a failed read — is trusted before the next ask. */
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

/** The roster a successful read published, and the account it belongs to. */
let served: { readonly rows: readonly DevinModelRow[]; readonly at: number; readonly account: string } | undefined
/** When the last read for an account failed, so the TTL bounds a dead endpoint too. */
let failed: { readonly at: number; readonly account: string } | undefined
/** The read in flight, keyed by account, so concurrent callers share one RPC. */
let inFlight: { readonly account: string; readonly promise: Promise<readonly DevinModelRow[]> } | undefined

/**
 * An opaque per-account cache key.
 *
 * A digest, not the token: the slot has to recognize "the same account" across
 * turns without keeping a second copy of a live credential around.
 */
function accountKey(access: string): string {
  return createHash('sha256').update(access).digest('hex').slice(0, 16)
}

/** The rows this route serves right now: a discovery result, or the seed. */
export function currentDevinRows(): readonly DevinModelRow[] {
  return served === undefined ? DEVIN_MODELS : served.rows
}

/** Forget the published roster and the failure mark (sign-out, account switch). */
function forget(): void {
  served = undefined
  failed = undefined
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

/** One stored grant this route can ask Devin with. */
interface UsableGrant {
  readonly access: string
  readonly account: string
}

/**
 * The grant the route may discover with, or `undefined` when there is none.
 *
 * An absent, corrupt or expired record is not a failure: there is nothing to ask
 * with, and the route still serves its seed.
 */
function usableGrant(record: Awaited<ReturnType<CredentialRecordsLike['readRecord']>>, now: number): UsableGrant | undefined {
  const grant = readDevinGrant(record)
  if (grant === undefined || grant.expiresInvalid === true) return undefined
  if (grant.expires !== undefined && grant.expires <= now) return undefined
  return { access: grant.access, account: accountKey(grant.access) }
}

/**
 * Ask Devin for one account's models and publish the answer.
 *
 * Every failure — a rejected fetch, a timeout, an unloadable artifact, an empty
 * catalog — is recorded against the account before it propagates, so the TTL
 * bounds it exactly like a success. A caller's own abort is not a failure and is
 * left unrecorded.
 *
 * @param grant - the account to ask for.
 * @param options - fetch/timeout/clock seams.
 * @returns the published rows.
 * @throws when the read fails.
 */
async function discoverRows(
  grant: UsableGrant,
  options: DevinCatalogOptions,
  now: () => number,
): Promise<readonly DevinModelRow[]> {
  let specs: readonly OmpDevinDiscoveredModel[] | null
  try {
    const discover = options.discover ?? await loadDiscovery()
    specs = await discover({
      apiKey: grant.access,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (specs === null || specs.length === 0) {
      throw new Error('llm-omp-transports: Devin returned no model catalog for this account')
    }
  } catch (cause) {
    // The caller withdrawing the read is not the endpoint's fault.
    if (options.signal?.aborted !== true) failed = { at: now(), account: grant.account }
    throw cause
  }
  const rows = specs.map(toRow).sort((a, b) => a.id.localeCompare(b.id))
  served = { rows, at: now(), account: grant.account }
  failed = undefined
  return rows
}

/**
 * Read the grant and refresh the roster, publishing or recording the outcome.
 *
 * The forced re-read: unlike {@link devinRows} it ignores the TTL and reports a
 * failure instead of absorbing it. The routine path (adapter reads, the model
 * picker) goes through `devinRows`; this entry point exists for a caller that
 * wants to know whether a read works, and the test suite drives it.
 *
 * @param credentials - the record half of the credentials seam, for the grant.
 * @param options - fetch/timeout/clock seams.
 * @returns the roster now served (the seed when there is no usable grant).
 * @throws when the read fails, so a forced refresh can report it; callers that
 *   must not fail ({@link devinRows}) swallow it and serve what the route already
 *   has.
 */
export async function refreshDevinRows(
  credentials: CredentialRecordsLike,
  options: DevinCatalogOptions = {},
): Promise<readonly DevinModelRow[]> {
  const now = options.now ?? Date.now
  const grant = usableGrant(await credentials.readRecord(DEVIN_CREDENTIAL_KEY), now())
  if (grant === undefined) {
    // Signed out (or the record is unusable): the previous account's roster is
    // not this route's to serve, and there is nothing to ask with.
    forget()
    return currentDevinRows()
  }
  if (served !== undefined && served.account !== grant.account) forget()
  return discoverRows(grant, options, now)
}

/**
 * The route's roster, read at most once per {@link TTL_MS} per account.
 *
 * Never rejects: a failed read leaves what the route already serves (the same
 * account's last good roster, else the seed) in service for the rest of the TTL,
 * so an endpoint that is down costs one attempt per window instead of one per
 * turn.
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
  let grant: UsableGrant | undefined
  try {
    grant = usableGrant(await credentials.readRecord(DEVIN_CREDENTIAL_KEY), now)
  } catch {
    // The store cannot say whose roster the slot holds, and the invariant is
    // "this account or the seed": an unreadable store proves neither, so the
    // published rows are dropped rather than attributed to whoever asks next.
    forget()
    return currentDevinRows()
  }
  // The picker and the adapter both reach here, so the account check happens on
  // every call: a signed-out or switched route must not keep serving the old
  // account's rows while the same module slot survives.
  if (served !== undefined && (grant === undefined || served.account !== grant.account)) forget()
  if (grant === undefined) return currentDevinRows()
  if (served !== undefined && served.account === grant.account && now - served.at < TTL_MS) return served.rows
  if (failed !== undefined && failed.account === grant.account && now - failed.at < TTL_MS) return currentDevinRows()
  // Only the same account's read is worth sharing; a different account's
  // in-flight answer would publish its roster here.
  if (inFlight !== undefined) {
    return inFlight.account === grant.account ? inFlight.promise : currentDevinRows()
  }
  // The grant is already resolved: the refresh below must not read the store a
  // second time (and cannot reject from that read).
  const run = discoverRows(grant, options, options.now ?? Date.now)
    .catch(() => currentDevinRows())
    .finally(() => {
      if (inFlight?.promise === run) inFlight = undefined
    })
  inFlight = { account: grant.account, promise: run }
  return run
}
