/**
 * The Devin route's account-scoped catalog.
 *
 * Two facts are pinned here. One, the read really goes through the pinned
 * `GetCliModelConfigs` RPC with the stored grant encoded the way omp encodes
 * it, so the bundled discovery half is wired to the route's own credential and
 * not to a second one. Two, the fallback is the committed seed: a route with no
 * grant, a failed RPC or an empty answer still lists what it can prove.
 */
import {
  ClientModelConfigSchema,
  DisplayOption,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  ModelFeaturesSchema,
  ModelInfoSchema,
} from '@oh-my-pi/pi-catalog/discovery/devin-proto'
import { create, fromBinary, toBinary } from '@oh-my-pi/pi-catalog/discovery/protobuf'
import { describe, expect, it, vi } from 'vitest'

// The installed protobuf runtime imports only `isRecord` from pi-utils, but that
// package's entry point touches the Bun runtime at load. The fixture builder
// needs the codec, not the runtime, so stand the import in with the one predicate.
vi.mock('@oh-my-pi/pi-utils', () => ({
  isRecord: (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value),
  // The discovery module logs through this; a test run must stay quiet.
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
  slugify: (input: string): string => input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
}))

import { fetchDevinModels } from '@oh-my-pi/pi-catalog/discovery/devin'
import { DEVIN_MODELS } from '../src/catalog/devin.js'
import type { CredentialRecordsLike } from '../src/cursor/credentials.js'
import { DEVIN_CREDENTIAL_KEY } from '../src/devin/credentials.js'
import { currentDevinRows, devinRows, refreshDevinRows } from '../src/devin/discovery.js'
import { devinCatalogModels } from '../src/index.js'

const FAR_FUTURE = 2_000_000_000_000

/** One read-only credential store holding an optional Devin grant. */
function store(payload?: unknown): CredentialRecordsLike {
  return {
    readRecord: async () => (payload === undefined ? undefined : { kind: 'grant', payload }),
    modifyRecord: async (_key, mutate) => mutate(undefined),
  }
}

/** One `ClientModelConfig` as the server would send it. */
function config(uid: string, label: string, options: { context?: number; output?: number; images?: boolean } = {}) {
  return create(ClientModelConfigSchema, {
    label,
    modelUid: uid,
    modelInfo: create(ModelInfoSchema, {
      maxTokens: options.context ?? 200_000,
      maxOutputTokens: options.output ?? 64_000,
      // A visible model, not an internal/eval config: the plugin's own
      // `DEVIN_DISPLAY_OPTION_NORMAL`, which the vendored enum predates.
      displayOption: 8 as DisplayOption,
      modelFeatures: create(ModelFeaturesSchema, {
        supportsToolCalls: true,
        supportsThinking: true,
        supportsImages: options.images === true,
      }),
    }),
  })
}

/** Encode a `GetCliModelConfigs` answer. */
function catalogBody(configs: ReturnType<typeof config>[]): Uint8Array {
  return toBinary(
    GetCliModelConfigsResponseSchema,
    create(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs }),
  )
}

describe('devin account catalog', () => {
  it('serves the committed seed while nothing has been discovered', () => {
    expect(currentDevinRows()).toEqual(DEVIN_MODELS)
    expect(devinCatalogModels()).toEqual(DEVIN_MODELS.map(row => ({ id: row.id, name: row.name })))
  })

  it('reads the account roster through GetCliModelConfigs with the stored grant', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) })
      return new Response(catalogBody([
        config('swe-2-high', 'SWE-2 High'),
        config('swe-2-fast', 'SWE-2 Fast', { images: true }),
      ]))
    }) as unknown as typeof globalThis.fetch

    const rows = await refreshDevinRows(
      // JWT-shaped: the wire layer only prefixes a three-segment token.
      store({ access: 'header.payload.signature', expires: FAR_FUTURE }),
      { fetch, discover: fetchDevinModels },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs')
    expect(calls[0]!.init?.method).toBe('POST')
    expect((calls[0]!.init?.headers as Record<string, string>)['content-type']).toBe('application/proto')
    // The bare session token is prefixed exactly as omp's wire layer encodes it.
    const request = fromBinary(GetCliModelConfigsRequestSchema, new Uint8Array(calls[0]!.init!.body as Uint8Array))
    expect(request.metadata?.apiKey).toBe('devin-session-token$header.payload.signature')

    // Sorted by id, and the capability flags survive the projection.
    expect(rows.map(row => row.id)).toEqual(['swe-2-fast', 'swe-2-high'])
    expect(rows[0]!.input).toEqual(['text', 'image'])
    expect(rows[0]!.reasoning).toBe(true)
    expect(rows[1]!.input).toEqual(['text'])
    expect(rows[0]!.contextWindow).toBe(200_000)
    expect(rows[0]!.maxTokens).toBe(64_000)
    expect(rows[0]!.compat.trustExplicitThinkingOnly).toBe(true)

    // The picker and the adapter both read this one slot.
    expect(devinCatalogModels()).toEqual([
      { id: 'swe-2-fast', name: 'SWE-2 Fast' },
      { id: 'swe-2-high', name: 'SWE-2 High' },
    ])
  })

  it('does not call the endpoint without a usable grant', async () => {
    let called = 0
    const fetch = (async () => {
      called += 1
      return new Response(catalogBody([config('swe-2-high', 'SWE-2 High')]))
    }) as unknown as typeof globalThis.fetch

    // No record at all.
    expect(await refreshDevinRows(store(), { fetch, discover: fetchDevinModels })).toEqual(currentDevinRows())
    // A record that expired: the resolver would refuse the request anyway.
    expect(await refreshDevinRows(store({ access: 'old', expires: 1 }), { fetch, discover: fetchDevinModels })).toEqual(currentDevinRows())
    // A record whose expiry is unreadable is not trusted either.
    expect(await refreshDevinRows(store({ access: 'old', expires: 'soon' }), { fetch, discover: fetchDevinModels })).toEqual(currentDevinRows())
    expect(called).toBe(0)
  })

  it('keeps the last good roster when the RPC fails, and reports it to a forced refresh', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof globalThis.fetch
    const records = store({ access: 'session-token', expires: FAR_FUTURE })

    // `devinRows` is the adapter's entry point: it must never reject.
    await expect(
      devinRows(records, { fetch: failing, discover: fetchDevinModels, now: () => FAR_FUTURE + 1 }),
    ).resolves.toEqual(currentDevinRows())
    // The forced read still surfaces the failure, so a picker can explain it.
    await expect(refreshDevinRows(records, { fetch: failing, discover: fetchDevinModels })).rejects.toThrow(/Devin/)
  })

  it('does not retry a failed read before the five-minute window', async () => {
    let calls = 0
    const failing = (async () => {
      calls += 1
      return new Response('boom', { status: 500 })
    }) as unknown as typeof globalThis.fetch
    const records = store({ access: 'failing.account', expires: FAR_FUTURE })
    const now = (): number => 1_700_000_000_000

    // A down endpoint costs one attempt per window, not one per turn: the
    // adapter reaches this on every listModels/resolveModel/stream.
    expect(await devinRows(records, { fetch: failing, discover: fetchDevinModels, now })).toEqual(DEVIN_MODELS)
    expect(await devinRows(records, { fetch: failing, discover: fetchDevinModels, now })).toEqual(DEVIN_MODELS)
    expect(calls).toBe(1)
  })

  it('bounds a throwing read (network, timeout, unloadable artifact) the same way', async () => {
    let calls = 0
    const throwing = (async () => {
      calls += 1
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const records = store({ access: 'throwing.account', expires: FAR_FUTURE })
    const now = (): number => 1_700_000_500_000

    expect(await devinRows(records, { fetch: throwing, discover: fetchDevinModels, now })).toEqual(DEVIN_MODELS)
    expect(await devinRows(records, { fetch: throwing, discover: fetchDevinModels, now })).toEqual(DEVIN_MODELS)
    expect(calls).toBe(1)
  })

  it('serves the seed when the credential store itself cannot be read', async () => {
    const unreadable: CredentialRecordsLike = {
      readRecord: async () => {
        throw new Error('IO error')
      },
      modifyRecord: async (_key, mutate) => mutate(undefined),
    }

    await expect(devinRows(unreadable)).resolves.toEqual(DEVIN_MODELS)
  })

  it('serves the seed, never the previous account, after a switch or sign-out', async () => {
    const serving = (async () =>
      new Response(catalogBody([config('swe-2-high', 'SWE-2 High')]))) as unknown as typeof globalThis.fetch
    const accountA = store({ access: 'account.a', expires: FAR_FUTURE })
    expect((await devinRows(accountA, { fetch: serving, discover: fetchDevinModels })).map(row => row.id)).toEqual([
      'swe-2-high',
    ])

    // A different account whose read fails must not inherit A's roster.
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof globalThis.fetch
    const accountB = store({ access: 'account.b', expires: FAR_FUTURE })
    expect(await devinRows(accountB, { fetch: failing, discover: fetchDevinModels })).toEqual(DEVIN_MODELS)

    // Signing out drops the slot as well: the route sells what it can prove.
    expect(await devinRows(store(), { fetch: failing, discover: fetchDevinModels })).toEqual(DEVIN_MODELS)
  })

  it('refuses an empty catalog instead of publishing an empty route', async () => {
    const empty = (async () => new Response(catalogBody([]))) as unknown as typeof globalThis.fetch

    await expect(
      refreshDevinRows(store({ access: 'session-token', expires: FAR_FUTURE }), { fetch: empty, discover: fetchDevinModels }),
    ).rejects.toThrow(/no model catalog/)
  })
})
