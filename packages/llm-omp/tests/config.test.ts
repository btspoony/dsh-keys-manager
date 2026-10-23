/**
 * Configured-provider entry tests.
 *
 * `settings.describe()` projects a plugin's resolved config through
 * `volatileForm` + `projectForm` over `plainConfig(cordis config)`: only fields
 * below a `.volatile()` node are visible, and the descriptor's `value` carries
 * the schema defaults. Consumers that list *configured* providers decide by
 * `getPath(namespace.value, ['providers', 'cursor'])`, so this file reproduces
 * that projection structurally — `@deepseek-ai/dsh-settings` exposes only its
 * seam, not the form helpers, and this package does not depend on it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  GOOGLE_ANTIGRAVITY_ROUTE,
  GOOGLE_GEMINI_CLI_ROUTE,
  OmpGoogleAntigravityAdapter,
  OmpGoogleGeminiCliAdapter,
} from '../src/adapter.js'
import {
  Config,
  TRANSPORT_UNAVAILABLE,
  apply,
  cursorCatalogModels,
  devinCatalogModels,
  googleAntigravityCatalogModels,
  googleGeminiCliCatalogModels,
} from '../src/index.js'
import type { TransportModelProfile } from '../src/index.js'
import { CURSOR_MODELS } from '../src/catalog/cursor.js'
import { DEVIN_MODELS } from '../src/catalog/devin.js'
import { GOOGLE_ANTIGRAVITY_MODELS } from '../src/catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_MODELS } from '../src/catalog/google-gemini-cli.js'

/** The accessor key a schemastery volatile value carries (cosmokit). */
const VOLATILE = Symbol.for('cosmokit.volatile.write')

/** `plainConfig` from dsh-settings: detach the config and unwrap volatile nodes. */
function plainConfig(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && VOLATILE in value) {
    return plainConfig((value as unknown as { get(): unknown }).get())
  }
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/** The descriptor `value` settings projects for one user config. */
function describeValue(user: Record<string, unknown>): unknown {
  return plainConfig(Config(user))
}

/** Read a nested value by path, like the configured-provider predicate. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

describe('Config', () => {
  it('projects default profiles for both routes with no user write', () => {
    // A guard on the shipped default, not proof of the live projection: the
    // real path runs `settings.describe` over a mounted plugin entry, which
    // this package cannot construct offline (and does not depend on). The
    // shape itself is private to schemastery and is deliberately not pinned.
    const value = describeValue({})

    expect(value).toEqual({
      providers: {
        cursor: { models: [] },
        devin: { models: [] },
        'google-gemini-cli': { models: [] },
        'google-antigravity': { models: [] },
      },
    })
    expect(getPath(value, ['providers', 'cursor'])).toBeDefined()
    expect(getPath(value, ['providers', 'devin'])).toBeDefined()
    // `configuredProvidersOf` keeps a provider when its settings path resolves.
    expect(getPath(value, ['providers', 'cursor']) !== undefined).toBe(true)
    expect(getPath(value, ['providers', 'devin']) !== undefined).toBe(true)
    // The Google pair resolves the same way, so each is a configured provider.
    expect(getPath(value, ['providers', 'google-gemini-cli']) !== undefined).toBe(true)
    expect(getPath(value, ['providers', 'google-antigravity']) !== undefined).toBe(true)
  })

  it('hands the running plugin a live providers reference', () => {
    // The loader updates a volatile reference in place instead of re-running
    // `apply`, so `apply` must read the allow-list through it.
    const resolved = Config({}) as unknown as { providers: { get(): unknown } }

    expect(resolved.providers.get()).toEqual({
      cursor: { models: [] },
      devin: { models: [] },
      'google-gemini-cli': { models: [] },
      'google-antigravity': { models: [] },
    })
  })

  it('resolves a user allow-list unchanged on either route', () => {
    const models = [{ id: 'claude-4.5-sonnet', name: 'Claude Sonnet 4.5' }]
    const devin = [{ id: 'swe-1-6', name: 'SWE-1.6' }]

    expect(getPath(describeValue({ providers: { cursor: { models } } }), ['providers', 'cursor', 'models'])).toEqual(models)
    expect(getPath(describeValue({ providers: { devin: { models: devin } } }), ['providers', 'devin', 'models'])).toEqual(
      devin,
    )
  })

  it('resolves an allow-list on either Google route', () => {
    const rows = [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }]

    for (const route of ['google-gemini-cli', 'google-antigravity'] as const) {
      const value = describeValue({ providers: { [route]: { models: rows } } })
      expect(getPath(value, ['providers', route, 'models'])).toEqual(rows)
    }
  })
})

describe('catalog projections', () => {
  it('projects every cursor row as an id/name pair', () => {
    const models = cursorCatalogModels()

    expect(models).toHaveLength(CURSOR_MODELS.length)
    expect(models[0]).toEqual({ id: CURSOR_MODELS[0]!.id, name: CURSOR_MODELS[0]!.name })
    expect(Object.keys(models[0]!)).toEqual(['id', 'name'])
  })

  it('projects every Google row as an id/name pair, one list per route', () => {
    const gemini = googleGeminiCliCatalogModels()
    const antigravity = googleAntigravityCatalogModels()

    expect(gemini).toHaveLength(GOOGLE_GEMINI_CLI_MODELS.length)
    expect(antigravity).toHaveLength(GOOGLE_ANTIGRAVITY_MODELS.length)
    expect(gemini.map(row => row.id)).toEqual(GOOGLE_GEMINI_CLI_MODELS.map(row => row.id))
    expect(antigravity.map(row => row.id)).toEqual(GOOGLE_ANTIGRAVITY_MODELS.map(row => row.id))
    expect(Object.keys(gemini[0]!)).toEqual(['id', 'name'])
    // The two routes advertise different models from one artifact.
    expect(gemini.map(row => row.id)).not.toEqual(antigravity.map(row => row.id))
  })

  it('projects every devin row as an id/name pair, in catalog order', () => {
    const models = devinCatalogModels()

    expect(models).toHaveLength(DEVIN_MODELS.length)
    expect(models.map(row => row.id)).toEqual(DEVIN_MODELS.map(row => row.id))
    expect(Object.keys(models[0]!)).toEqual(['id', 'name'])
  })
})

const FAR_FUTURE = 2_000_000_000_000

/** What the fake host recorded during one `apply`. */
interface RegisteredHost {
  readonly ctx: Context
  readonly adapters: { providers: readonly string[]; adapter: unknown }[]
  readonly providers: readonly { provider: string; settingsPath: readonly string[] }[]
  readonly flows: readonly { key: string; label: string }[]
}

/** A fake `ctx` implementing exactly the seams `apply` reaches. */
function fakeHost(record: { access: string; expires: number; projectId: string } = {
  access: 'google-token',
  expires: FAR_FUTURE,
  projectId: 'project-1',
}): RegisteredHost {
  const adapters: RegisteredHost['adapters'][number][] = []
  const providers: RegisteredHost['providers'][number][] = []
  const flows: RegisteredHost['flows'][number][] = []
  const credentials = {
    readRecord: async () => ({ kind: 'grant' as const, payload: record }),
    modifyRecord: async () => ({ kind: 'grant' as const, payload: record }),
  }
  return {
    adapters,
    providers,
    flows,
    ctx: {
      llm: {
        registerAdapter: (providers: readonly string[], adapter: unknown) => adapters.push({ providers, adapter }),
        registerConfigurableProviders: (list: readonly (typeof providers)[number][]) => providers.push(...list),
      },
      credentials,
      authorization: {
        registerFlow: (flow: RegisteredHost['flows'][number]) => flows.push(flow),
        begin: async () => ({ status: 'authorized' as const }),
      },
    } as unknown as Context,
  }
}

describe('apply registration', () => {
  it('registers four adapters, four providers and four flows in the shipped order', () => {
    const host = fakeHost()

    // A missing artifact must not fail registration: `apply` only wires lazy
    // loaders, so it never imports anything here.
    apply(host.ctx)

    expect(host.adapters.map(entry => entry.providers)).toEqual([
      ['cursor'],
      ['devin'],
      [GOOGLE_GEMINI_CLI_ROUTE],
      [GOOGLE_ANTIGRAVITY_ROUTE],
    ])
    expect(host.providers.map(entry => entry.provider)).toEqual([
      'cursor',
      'devin',
      GOOGLE_GEMINI_CLI_ROUTE,
      GOOGLE_ANTIGRAVITY_ROUTE,
    ])
    expect(host.providers.map(entry => entry.settingsPath.join('.'))).toEqual([
      'providers.cursor',
      'providers.devin',
      'providers.google-gemini-cli',
      'providers.google-antigravity',
    ])
    expect(host.flows.map(flow => flow.key)).toEqual([
      'llm-omp-transports/cursor',
      'llm-omp-transports/devin',
      'llm-omp-transports/google-gemini-cli',
      'llm-omp-transports/google-antigravity',
    ])
    expect(host.flows.map(flow => flow.label)).toEqual([
      'Cursor',
      'Devin',
      'Google Gemini CLI',
      'Google Antigravity',
    ])
  })

  it('registers the Google pair as adapters over their own catalogs', async () => {
    const host = fakeHost()
    apply(host.ctx)

    const gemini = host.adapters[2]!.adapter
    const antigravity = host.adapters[3]!.adapter
    expect(gemini).toBeInstanceOf(OmpGoogleGeminiCliAdapter)
    expect(antigravity).toBeInstanceOf(OmpGoogleAntigravityAdapter)
    expect((gemini as OmpGoogleGeminiCliAdapter).providerInfo(GOOGLE_GEMINI_CLI_ROUTE)).toEqual({
      id: GOOGLE_GEMINI_CLI_ROUTE,
      name: 'Google Gemini CLI',
    })
    expect((antigravity as OmpGoogleAntigravityAdapter).providerInfo(GOOGLE_ANTIGRAVITY_ROUTE)).toEqual({
      id: GOOGLE_ANTIGRAVITY_ROUTE,
      name: 'Google Antigravity',
    })
    expect(await (gemini as OmpGoogleGeminiCliAdapter).listModels(GOOGLE_GEMINI_CLI_ROUTE)).toHaveLength(
      GOOGLE_GEMINI_CLI_MODELS.length,
    )
    expect(await (antigravity as OmpGoogleAntigravityAdapter).listModels(GOOGLE_ANTIGRAVITY_ROUTE)).toHaveLength(
      GOOGLE_ANTIGRAVITY_MODELS.length,
    )
  })

  it('narrows each Google route by its own configured allow-list', async () => {
    const host = fakeHost()
    const rows = [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }]
    apply(host.ctx, {
      providers: {
        get: () => ({
          'google-gemini-cli': { models: rows },
          'google-antigravity': { models: [{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }] },
        }),
      },
    })

    const gemini = host.adapters[2]!.adapter as OmpGoogleGeminiCliAdapter
    const antigravity = host.adapters[3]!.adapter as OmpGoogleAntigravityAdapter
    expect((await gemini.listModels(GOOGLE_GEMINI_CLI_ROUTE)).map(row => row.id)).toEqual(['gemini-2.5-flash'])
    expect((await antigravity.listModels(GOOGLE_ANTIGRAVITY_ROUTE)).map(row => row.id)).toEqual(['claude-opus-4-5'])
    await expect(gemini.resolveModel(GOOGLE_GEMINI_CLI_ROUTE, 'gemini-3-pro-preview')).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    })
  })

  it('drops a malformed Google row instead of throwing from the live getter', async () => {
    const host = fakeHost()
    const rows = [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }, null, { name: 'no id' }, { id: 7 }]
    apply(host.ctx, {
      providers: { get: () => ({ 'google-gemini-cli': { models: rows as unknown as TransportModelProfile[] } }) },
    })

    const gemini = host.adapters[2]!.adapter as OmpGoogleGeminiCliAdapter
    expect((await gemini.listModels(GOOGLE_GEMINI_CLI_ROUTE)).map(row => row.id)).toEqual(['gemini-2.5-flash'])
    // The sibling route is untouched by a malformed row on this one.
    const antigravity = host.adapters[3]!.adapter as OmpGoogleAntigravityAdapter
    expect(await antigravity.listModels(GOOGLE_ANTIGRAVITY_ROUTE)).toHaveLength(GOOGLE_ANTIGRAVITY_MODELS.length)
  })

  it('surfaces a missing Google bundle at request time as TRANSPORT_UNAVAILABLE', async () => {
    // The source tree has no `src/omp/google.mjs`: the build writes it to `lib/`.
    // The failure must reach the request, not registration.
    const host = fakeHost()
    apply(host.ctx)

    for (const [index, route] of [
      [2, GOOGLE_GEMINI_CLI_ROUTE],
      [3, GOOGLE_ANTIGRAVITY_ROUTE],
    ] as const) {
      const adapter = host.adapters[index]!.adapter as OmpGoogleGeminiCliAdapter | OmpGoogleAntigravityAdapter
      const options: GenerateOptions = {
        provider: route,
        model: route === GOOGLE_GEMINI_CLI_ROUTE ? 'gemini-2.5-flash' : 'claude-opus-4-5',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      }
      const chunks: StreamChunk[] = []
      await expect(
        (async () => {
          for await (const chunk of adapter.stream(options)) chunks.push(chunk)
        })(),
      ).rejects.toMatchObject({ code: TRANSPORT_UNAVAILABLE })
      expect(chunks).toEqual([])
    }
  })
})
