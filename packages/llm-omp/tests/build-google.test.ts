/**
 * Drift gate for the omp Google entry and the two generated Google tables.
 *
 * `tests/build.test.ts` loads every artifact under plain Node, compares its
 * measured shape with the build metafile, enforces the calibrated ceiling and
 * re-derives the shim reach. This file adds what only the Google route can
 * assert:
 *
 * 1. **One artifact, two routes.** Both Cloud Code Assist route ids ride
 *    `lib/omp/google.mjs` and a single manifest entry, because the provider
 *    dispatches on `model.provider`.
 * 2. **Are the Google sources the pinned ones?** Provider, shared wire helpers,
 *    wire types, the image-prep module with the dead `Bun.Image` reference, the
 *    vendor identity headers and both declarative auth rules are hashed in the
 *    manifest.
 * 3. **Does the shim extension carry the real framing/retry algorithms?** The
 *    Google graph reads `readSseJson` and `fetchWithRetry`, which the shared
 *    shim does not provide; they are re-exported from omp's own modules through
 *    `pi-utils-google.ts`, and this file exercises their contract instead of
 *    trusting the declaration.
 * 4. **Are the generated tables the installed catalog's?** Provenance, row
 *    counts and a byte-identical regeneration for both route tables.
 *
 * The manifest is a build output: run `pnpm build` before `pnpm test`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as baseShim from '../scripts/omp-shim/pi-utils'
import * as googleShim from '../scripts/omp-shim/pi-utils-google'
import { GOOGLE_ANTIGRAVITY_CATALOG_SOURCE, GOOGLE_ANTIGRAVITY_MODELS } from '../src/catalog/google-antigravity.js'
import { GOOGLE_GEMINI_CLI_CATALOG_SOURCE, GOOGLE_GEMINI_CLI_MODELS } from '../src/catalog/google-gemini-cli.js'
import { googleAntigravityCatalogModels, googleGeminiCliCatalogModels } from '../src/index.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

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
  piUtilsVersion: string
  esbuildVersion: string
  entries: Record<string, OmpEntry>
  shimSymbols: Record<string, string[]>
  sourceHashes: Record<string, string>
}

const manifest: OmpManifest = JSON.parse(readFileSync(join(packageRoot, 'scripts/omp-manifest.json'), 'utf8'))
const google = manifest.entries.google
if (google === undefined) {
  throw new Error('llm-omp: the manifest records no google entry — run `pnpm build`')
}

/** Locate the installed copy of a package by walking up to its own `package.json`. */
function installedPackageRoot(name: string): string {
  const resolved = import.meta.resolve(name)
  let dir = dirname(fileURLToPath(resolved))
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
      if (parsed.name === name) return dir
    }
    dir = dirname(dir)
  }
  throw new Error(`cannot locate the installed package ${name}`)
}

/** Map a manifest source key (`@oh-my-pi/<package>/<path>`) onto the installed file. */
function installedSourcePath(key: string): string {
  const match = /^(@oh-my-pi\/[^/]+)\/(.+)$/.exec(key)
  if (!match) throw new Error(`unexpected manifest source key ${key}`)
  return join(installedPackageRoot(match[1]), match[2])
}

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/** One text response body as the `ReadableStream` the SSE reader consumes. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('google drift gate', () => {
  it('serves both Cloud Code Assist routes from one artifact and one manifest entry', () => {
    expect(google.entry).toBe('lib/omp/google.mjs')
    // A per-route artifact would mean the shared-provider decision (design §1)
    // was reversed without the manifest saying so. The other entries are the
    // independent routes, one artifact each.
    expect(Object.keys(manifest.entries).sort()).toEqual(['cursor', 'devin', 'factory-droid', 'google'])
  })

  it('hashes the Google transport sources the bundle was built from', () => {
    const keys = Object.keys(manifest.sourceHashes)
    for (const key of [
      '@oh-my-pi/pi-ai/src/providers/google-gemini-cli.ts',
      '@oh-my-pi/pi-ai/src/providers/google-shared.ts',
      '@oh-my-pi/pi-ai/src/providers/google-types.ts',
      '@oh-my-pi/pi-ai/src/providers/anthropic-images.ts',
      '@oh-my-pi/pi-catalog/src/wire/gemini-headers.ts',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/google-gemini-cli.kdl',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/google-antigravity.kdl',
    ]) {
      expect(keys, key).toContain(key)
      expect(sha256(installedSourcePath(key)), key).toBe(manifest.sourceHashes[key])
    }
  })

  it('resolves the shim to its Google extension and reaches the real SSE/retry helpers', () => {
    // The two helpers are the reason the extension exists: an entry that does
    // not read them (cursor, devin) keeps the base shim, so its artifact stays
    // byte-identical to the release that predates this route.
    expect(google.piUtilsShim).toBe('scripts/omp-shim/pi-utils-google.ts')
    expect(manifest.entries.cursor!.piUtilsShim).toBe('scripts/omp-shim/pi-utils.ts')
    expect(manifest.entries.devin!.piUtilsShim).toBe('scripts/omp-shim/pi-utils.ts')
    expect(google.shimImports['pi-utils']).toEqual(expect.arrayContaining(['fetchWithRetry', 'readSseJson']))
    expect(google.shimImports['bun-modules']).toEqual([])
  })
})

describe('google shim extension contract', () => {
  it('re-exports the whole base surface plus the two Google helpers', () => {
    const extension = Object.keys(googleShim)
    for (const name of Object.keys(baseShim)) expect(extension, name).toContain(name)
    expect(typeof googleShim.readSseJson).toBe('function')
    expect(typeof googleShim.fetchWithRetry).toBe('function')
  })

  it('frames SSE events: multi-line data joins and [DONE] ends the stream', async () => {
    const frames: unknown[] = []
    for await (const frame of googleShim.readSseJson(
      streamOf('data: {"candidates":[{"content":\ndata: {"parts":[{"text":"hi"}]}}]}\n\ndata: [DONE]\n\n'),
    )) {
      frames.push(frame)
    }
    expect(frames).toEqual([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }])
  })

  it('retries a retryable response within the attempt bound', async () => {
    let calls = 0
    const response = await googleShim.fetchWithRetry('https://example.invalid/v1internal:streamGenerateContent', {
      fetch: async () => {
        calls += 1
        return new Response(calls === 1 ? 'busy' : 'ok', { status: calls === 1 ? 500 : 200 })
      },
      maxAttempts: 2,
      defaultDelayMs: 0,
    })
    expect(calls).toBe(2)
    expect(response.status).toBe(200)
  })
})

describe('generated google tables freshness', () => {
  it('describes the installed catalog and the pin the manifest records', () => {
    const modelsPath = installedSourcePath('@oh-my-pi/pi-catalog/src/models.json')
    const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, Record<string, unknown>>
    for (const [key, source, rows] of [
      ['google-gemini-cli', GOOGLE_GEMINI_CLI_CATALOG_SOURCE, GOOGLE_GEMINI_CLI_MODELS],
      ['google-antigravity', GOOGLE_ANTIGRAVITY_CATALOG_SOURCE, GOOGLE_ANTIGRAVITY_MODELS],
    ] as const) {
      expect(source.version, key).toBe(manifest.piCatalogVersion)
      expect(source.key, key).toBe(key)
      expect(source.sourceHash, key).toBe(manifest.sourceHashes['@oh-my-pi/pi-catalog/src/models.json'])
      expect(source.sourceHash, key).toBe(sha256(modelsPath))
      expect(source.rowCount, key).toBe(Object.keys(models[key] ?? {}).length)
      expect(rows, key).toHaveLength(source.rowCount)
    }
  })

  it('regenerates byte-identically from the installed pin', () => {
    const paths = [
      join(packageRoot, 'src', 'catalog', 'google-gemini-cli.ts'),
      join(packageRoot, 'src', 'catalog', 'google-antigravity.ts'),
    ]
    const before = paths.map(path => readFileSync(path))
    const generated = spawnSync('node', ['scripts/generate-catalog.mjs'], { cwd: packageRoot, encoding: 'utf8' })
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0)
    // A pin bump that changes a row's consumed fields shows up as this diff
    // instead of shipping a committed table the bundle no longer matches.
    for (const [index, path] of paths.entries()) {
      expect(readFileSync(path).equals(before[index]!), path).toBe(true)
    }
  })

  it('projects both generated tables for host-side surfaces', () => {
    // The root keys-manager's model picker needs the unfiltered rows; the shape
    // is the same `TransportCatalogModel` and order `cursorCatalogModels()` uses.
    const gemini = googleGeminiCliCatalogModels()
    expect(gemini).toEqual(GOOGLE_GEMINI_CLI_MODELS.map(row => ({ id: row.id, name: row.name })))
    expect(Object.keys(gemini[0]!)).toEqual(['id', 'name'])
    const antigravity = googleAntigravityCatalogModels()
    expect(antigravity).toEqual(GOOGLE_ANTIGRAVITY_MODELS.map(row => ({ id: row.id, name: row.name })))
    expect(Object.keys(antigravity[0]!)).toEqual(['id', 'name'])
  })
})
