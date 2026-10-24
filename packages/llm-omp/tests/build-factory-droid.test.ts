/**
 * Drift gate for the omp Factory Droid entry: the two build substitutions, the
 * registry seed catalog and the "explicit key only" premise S2c rests on.
 *
 * `tests/build.test.ts` already enforces the generic contract for every entry
 * (measured shape, calibrated ceiling, plain-Node import, `node:`-only
 * specifiers). This file adds what only this entry can assert:
 *
 * 1. **The substitutions actually fired.** The metafile must contain no
 *    `models.json`, no real `register-builtins.ts`, no `pi-ai/src/stream.ts`, no
 *    `env-api-key.ts` and none of the providers the pruned registry used to drag
 *    in (cursor, gitlab-duo, amazon-bedrock, openai-codex-responses).
 * 2. **The substitutes are the pin's own code.** Both lean modules carry a marked
 *    region that must be a verbatim substring of the pinned source, and the pin
 *    must still export the three streams it re-exports.
 * 3. **S2c's premise holds at runtime.** `getEnvApiKey`'s registry-derived half is
 *    dropped because every factory-droid request carries an explicit `apiKey`;
 *    the artifact test poisons the environment and proves no env value reaches the
 *    wire, and a key-less call fails loudly instead of resolving one.
 * 4. **The table is the registry seed's.** Provenance, row count, the ids and a
 *    byte-identical regeneration.
 *
 * The manifest is a build output: run `pnpm build` before `pnpm test`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { getEnvApiKey, envKeyNameFor } from '../scripts/omp-shim/env-api-key-lean'
import { FACTORY_DROID_CATALOG_SOURCE, FACTORY_DROID_MODELS } from '../src/catalog/factory-droid.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

/** The installed root of the pinned catalog, by its own manifest. */
function pinnedRoot(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).name === name) return dir
    dir = dirname(dir)
  }
  throw new Error(`cannot locate the installed ${name}`)
}

const piAiRoot = pinnedRoot('@oh-my-pi/pi-ai')
const piCatalogRoot = pinnedRoot('@oh-my-pi/pi-catalog')
const catalogRules = JSON.parse(readFileSync(join(piCatalogRoot, 'src', 'compat', 'rules.json'), 'utf8')) as {
  providers: Record<string, { seed: { models: Record<string, { id: string; api: string; provider: string }> } }>
}

interface OmpEntry {
  entry: string
  metafile: string
  moduleCount: number
  bytes: number
  piUtilsShim: string
  shimImports: Record<string, string[]>
}

interface OmpManifest {
  ompVersion: string
  piCatalogVersion: string
  entries: Record<string, OmpEntry>
  sourceHashes: Record<string, string>
}

const manifest = JSON.parse(readFileSync(join(packageRoot, 'scripts', 'omp-manifest.json'), 'utf8')) as OmpManifest
const entry = manifest.entries['factory-droid']
const metafile = JSON.parse(readFileSync(join(packageRoot, entry!.metafile), 'utf8')) as {
  inputs: Record<string, { imports: { path: string }[] }>
}
const artifactPath = join(packageRoot, entry!.entry)

/** Package-relative-ish input names, without the node_modules prefix. */
const inputs = Object.keys(metafile.inputs).map(path => path.replace(/.*node_modules\//, ''))

/**
 * One lean module and the pin it copies: the marked region must appear verbatim.
 */
const VERBATIM: readonly { lean: string; pinned: string; symbols: string[] }[] = [
  {
    lean: 'register-builtins-lean.ts',
    pinned: join(piAiRoot, 'src', 'providers', 'register-builtins.ts'),
    symbols: ['hasFinalResult', 'createProviderStream'],
  },
  {
    lean: 'pi-ai-stream-lean.ts',
    pinned: join(piAiRoot, 'src', 'stream.ts'),
    symbols: ['OUTPUT_FALLBACK_BUFFER', 'mapAnthropicToolChoice'],
  },
]

/** Every text block this lean module marks as copied from the pin. */
function pinnedRegions(lean: string): string[] {
  const source = readFileSync(join(packageRoot, 'scripts', 'omp-shim', lean), 'utf8')
  return [...source.matchAll(/\/\/ --- BEGIN PINNED REGION[^\n]*\n([\s\S]*?)\n\/\/ --- END PINNED REGION/g)].map(
    match => match[1]!,
  )
}

describe('factory-droid build substitutions', () => {
  it('retains neither the model catalog nor the pruned provider registry', () => {
    expect(entry!.piUtilsShim).toBe('scripts/omp-shim/pi-utils-factory-droid.ts')
    // S1: the 12.4 MB default import is replaced by `{}`; `models.ts` stays real.
    expect(inputs.filter(path => path.endsWith('models.json'))).toEqual([])
    // S2 + S2b: both registry aggregators are replaced by their lean copies.
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/providers/register-builtins.ts')
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/stream.ts')
    // S2c: the registry-derived env-key map is replaced; the module leaves too.
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/env-api-key.ts')
    // The mass those three edges used to keep: ten unused providers and their wires.
    for (const pruned of [
      '@oh-my-pi/pi-ai/src/providers/cursor.ts',
      '@oh-my-pi/pi-ai/src/providers/gitlab-duo.ts',
      '@oh-my-pi/pi-catalog/src/discovery/cursor-proto.ts',
      '@oh-my-pi/pi-ai/src/providers/amazon-bedrock.ts',
      '@oh-my-pi/pi-ai/src/providers/openai-codex-responses.ts',
    ]) {
      expect(inputs, pruned).not.toContain(pruned)
    }
    // The three streams the entry does need are the real provider modules.
    for (const kept of [
      '@oh-my-pi/pi-ai/src/providers/anthropic.ts',
      '@oh-my-pi/pi-ai/src/providers/openai-completions.ts',
      '@oh-my-pi/pi-ai/src/providers/openai-responses.ts',
    ]) {
      expect(inputs, kept).toContain(kept)
    }
  })

  it('copies the pinned wrapper verbatim and the pin still exports the three streams', () => {
    for (const { lean, pinned, symbols } of VERBATIM) {
      const copied = pinnedRegions(lean)
      const source = readFileSync(pinned, 'utf8')
      expect(copied.length, `${lean} regions`).toBeGreaterThan(0)
      // Verbatim: an omp bump that edits either wrapper fails here and forces a
      // mechanical re-copy instead of a silent behaviour drift.
      for (const region of copied) expect(source, `${lean} region`).toContain(region)
      const joined = copied.join('\n')
      for (const symbol of symbols) expect(joined, `${lean} ${symbol}`).toContain(symbol)
    }
    const registerBuiltins = readFileSync(join(piAiRoot, 'src', 'providers', 'register-builtins.ts'), 'utf8')
    for (const stream of ['streamAnthropic', 'streamOpenAICompletions', 'streamOpenAIResponses']) {
      expect(registerBuiltins, stream).toContain(`export const ${stream} =`)
    }
    // S2c's premise: the pin's map is still registry-derived, which is exactly
    // what the lean copy drops.
    const envApiKey = readFileSync(join(piAiRoot, 'src', 'env-api-key.ts'), 'utf8')
    expect(envApiKey).toContain('PROVIDER_REGISTRY')
  })

  it('resolves catalog env keys but not the registry-derived ones it drops', () => {
    // The catalog half survives: `openai` declares OPENAI_API_KEY in rules.json.
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-catalog-sentinel'
    try {
      expect(envKeyNameFor('openai')).toBe('OPENAI_API_KEY')
      expect(getEnvApiKey('openai')).toBe('sk-catalog-sentinel')
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
    // The dropped half: a provider the catalog does not model has no resolver
    // here, where the pin's registry would have supplied one.
    expect(getEnvApiKey('foundry')).toBeUndefined()
    expect(envKeyNameFor('foundry')).toBeUndefined()
  })
})

describe('factory-droid transport boundary', () => {
  afterEach(() => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FACTORY_API_KEY']) delete process.env[name]
  })

  /** The generated row the artifact is driven with (a Claude row: anthropic wire). */
  const row = FACTORY_DROID_MODELS.find(candidate => candidate.id.startsWith('claude-'))!
  const model = { ...row, compat: {} }

  /** One scripted fetch that answers an empty SSE stream and records the call. */
  function stubFetch(): { calls: { url: string; init?: RequestInit }[]; fetch: typeof fetch } {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      // A refusal ends the turn at once: the wire retries/decodes 2xx bodies,
      // and this test only needs the request the transport built.
      return new Response('{"error":{"message":"scripted stop"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return { calls, fetch: fetchImpl }
  }

  async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const events: unknown[] = []
    for await (const event of stream) events.push(event)
    return events
  }

  it('sends the explicit credential and never reads the environment', async () => {
    // Poison every plausible env fallback; a leak would put a sentinel on the wire.
    process.env.OPENAI_API_KEY = 'env-openai-sentinel'
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-sentinel'
    process.env.FACTORY_API_KEY = 'env-factory-sentinel'
    const module = (await import(pathToFileURL(artifactPath).href)) as {
      streamFactoryDroid: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>
    }
    const stub = stubFetch()

    await drain(
      module.streamFactoryDroid(
        model,
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }] },
        { apiKey: 'explicit-credential', fetch: stub.fetch },
      ),
    )

    expect(stub.calls).toHaveLength(1)
    const headers = new Headers(stub.calls[0]!.init?.headers)
    const authorization = headers.get('authorization') ?? headers.get('Authorization')
    expect(authorization).toBe('Bearer explicit-credential')
    const wire = JSON.stringify(stub.calls[0]!.init ?? {})
    for (const sentinel of ['env-openai-sentinel', 'env-anthropic-sentinel', 'env-factory-sentinel']) {
      expect(wire, sentinel).not.toContain(sentinel)
    }
  })

  it('fails loudly without a credential instead of resolving one from the environment', async () => {
    // The other half of the premise: with no `apiKey`, the transport refuses. It
    // never asks `getEnvApiKey`, so the lean map cannot be on any factory path.
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-sentinel'
    process.env.OPENAI_API_KEY = 'env-openai-sentinel'
    const module = (await import(pathToFileURL(artifactPath).href)) as {
      streamFactoryDroid: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>
    }
    const stub = stubFetch()

    const events = (await drain(
      module.streamFactoryDroid(
        model,
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 0 }] },
        { fetch: stub.fetch },
      ),
    )) as { type: string; error?: { message?: string } }[]

    expect(stub.calls).toEqual([])
    expect(events.at(-1)?.type).toBe('error')
    expect(JSON.stringify(events)).toMatch(/credentials/i)
  })
})

describe('factory-droid catalog', () => {
  it('carries every row of the pinned registry seed, with provenance', () => {
    const seedRows = Object.values(catalogRules.providers['factory-droid']!.seed.models)
    expect(FACTORY_DROID_MODELS).toHaveLength(seedRows.length)
    expect(FACTORY_DROID_MODELS.map(row => row.id).sort()).toEqual(seedRows.map(row => row.id).sort())
    // Every row is a zero-cost Factory credit on the same wire family.
    for (const row of FACTORY_DROID_MODELS) {
      expect(row.api).toBe('factory-droid-agent')
      expect(row.provider).toBe('factory-droid')
      expect(row.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
    expect(FACTORY_DROID_CATALOG_SOURCE).toMatchObject({
      package: '@oh-my-pi/pi-catalog',
      version: manifest.piCatalogVersion,
      file: 'src/compat/rules.json',
      key: 'factory-droid',
      rowCount: seedRows.length,
    })
    const bytes = readFileSync(join(piCatalogRoot, 'src', 'compat', 'rules.json'))
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    expect(FACTORY_DROID_CATALOG_SOURCE.sourceHash).toBe(hash)
  })

  it('regenerates byte-identically from the installed pin', () => {
    const path = join(packageRoot, 'src', 'catalog', 'factory-droid.ts')
    const before = readFileSync(path)
    const generated = spawnSync('node', ['scripts/generate-catalog.mjs'], { cwd: packageRoot, encoding: 'utf8' })
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0)
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})
