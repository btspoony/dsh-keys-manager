/**
 * Build-artifact and drift gate for the omp Cursor bundle.
 *
 * These tests answer four questions about the shipped artifact:
 *
 * 1. **Does it run on Node?** The bundle is imported through a plain Node ESM
 *    loader with no Bun global present, and must expose `streamCursor`.
 * 2. **Can it run on Node?** Every static import in the artifact must be a Node
 *    builtin — the published `lib/` may not depend on `@oh-my-pi/*` or `bun:*`.
 * 3. **Is it the bundle the manifest describes?** The pinned omp versions, the
 *    hashed sources, the shim surface and — from the build's own esbuild
 *    metafile — the shim symbols the graph actually reaches and the measured
 *    artifact must all still match, so an omp bump that starts calling a
 *    degraded `simplify:` member fails here instead of at request time.
 * 4. **Does the shim keep Bun's contract** for the members this graph reads?
 *
 * The bundle, its metafile and the manifest are build outputs: run `pnpm build`
 * (which regenerates all three) before `pnpm test`. CI builds first and then
 * asserts the committed manifest is unchanged, so a pin bump that changes reach
 * shows up as a reviewable one-line manifest diff.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { jsonAsEsmModule } from '../scripts/build-omp.mjs'
import { shimImportsOf } from '../scripts/omp-reach.mjs'
import { Bun as BunGlobal, CryptoHasher, SHA256 } from '../scripts/omp-shim/bun-global'
import {
  LRUCache,
  classifyJsonPrefix,
  parseJsonWithRepair,
  parseStreamingJsonThrottled,
} from '../scripts/omp-shim/pi-utils'
import { CURSOR_CATALOG_SOURCE, CURSOR_MODELS } from '../src/catalog/cursor.js'
import { CURSOR_AUTH } from '../src/cursor/auth.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

/**
 * Hard ceiling per shipped artifact, calibrated against the measurement the
 * manifest records rather than a stale snapshot literal: ~1.5x the measurement
 * leaves room for the transport to grow, while still failing the pre-fix
 * 14.7 MB form — a catalog (or another large asset) being pulled back into the
 * bundle. Every build changes `entries.<name>.bytes`, so CI's manifest diff
 * already names a size change; these bounds answer "how big is too big".
 *
 * cursor: 1 392 691 bytes measured -> 2 000 000.
 * devin: 1 278 632 bytes measured -> 1 920 000; its graph is strictly smaller
 * in source (a 914-line provider plus a 2 650-line codec vs Cursor's 6 800 +
 * 8 810), so a size above Cursor's bound means something was pulled in that
 * this route never reads.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  cursor: 2_000_000,
  devin: 1_920_000,
  // google: 1 303 142 bytes measured (one artifact, both Cloud Code Assist
  // routes) -> 1 960 000. Its graph is the Cursor-sized provider plus the
  // Anthropic image prep module and the vendor identity headers; a size above
  // 1.5x that measurement means a catalog or another provider graph was pulled
  // back into the bundle, not that the route grew.
  google: 1_960_000,
  // factory-droid: 2 008 424 bytes measured (200 modules) -> 3 120 000. Its graph
  // is the largest by construction: the wire multiplexer keeps three providers
  // (anthropic + both OpenAI encoders), the KDL registry (`rules.json`, 468 KB) and
  // the schema/type validators. Three entry-scoped build substitutions are what
  // make it 2 MB instead of 17 MB; a size near this ceiling means one of them
  // stopped firing (the metafile assertions in `tests/build-factory-droid.test.ts`
  // name which), not that the route grew.
  'factory-droid': 3_120_000,
  // gitlab-duo-agent: 1 001 890 bytes measured (118 modules) -> 1 500 000. The
  // graph is the Duo Workflow transport plus its catalog helpers, built from the
  // existing shims; a size near this ceiling means a provider registry or the
  // model catalog was pulled in, not that the route grew.
  'gitlab-duo-agent': 1_500_000,
}

/** One entry's measured build facts (manifest schema v2). */
interface OmpEntry {
  entry: string
  metafile: string
  moduleCount: number
  bytes: number
  /** Package-relative path of the module that replaced `@oh-my-pi/pi-utils`. */
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

interface Metafile {
  inputs: Record<string, { imports: { path: string; original?: string }[] }>
}

/** The esbuild export each entry is expected to expose, per artifact name. */
const EXPORTS: Readonly<Record<string, string>> = {
  cursor: 'streamCursor',
  devin: 'streamDevin',
  google: 'streamGoogleGeminiCli',
  'factory-droid': 'streamFactoryDroid',
  'gitlab-duo-agent': 'streamGitLabDuoWorkflow',
}

const entries = Object.entries(manifest.entries).map(([name, entry]) => ({
  name,
  manifest: entry,
  artifactPath: join(packageRoot, entry.entry),
  metafilePath: join(packageRoot, entry.metafile),
  metafile: (existsSync(join(packageRoot, entry.metafile))
    ? JSON.parse(readFileSync(join(packageRoot, entry.metafile), 'utf8'))
    : undefined) as Metafile | undefined,
}))

if (entries.length === 0 || entries.some(entry => entry.metafile === undefined)) {
  throw new Error('llm-omp: run `pnpm build` first — every artifact and its metafile are build outputs')
}

/**
 * Shim module name → the same package-relative key the build records.
 * `pi-utils` comes from the entry: the Google build resolves it to the
 * extension module, and reach is measured against that build's surface.
 */
function shimPaths(entry: OmpEntry): Record<string, string> {
  return {
    'pi-utils': entry.piUtilsShim,
    'bun-modules': 'scripts/omp-shim/bun-modules.ts',
    'bun-global': 'scripts/omp-shim/bun-global.ts',
  }
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

function installedVersion(name: string): string {
  const manifestPath = join(installedPackageRoot(name), 'package.json')
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version
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

/** Named ESM exports of a shim module, mirroring the build script's extraction. */
function shimSymbols(name: keyof OmpManifest['shimSymbols']): string[] {
  const file = join(packageRoot, 'scripts/omp-shim', `${name}.ts`)
  const source = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/^export\s+(?:abstract\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1])
  }
  return [...names].sort()
}

describe.each(entries)('omp $name bundle', ({ name, manifest: entry, artifactPath, metafile }) => {
  it('ships an artifact with the measured shape', () => {
    expect(entry.entry).toBe(`lib/omp/${name}.mjs`)
    // Exact, not a floor: the metafile is this build's module list, so a pin
    // bump that adds or drops a module changes the manifest (and CI's diff).
    expect(entry.moduleCount).toBe(Object.keys(metafile!.inputs).length)
    expect(existsSync(artifactPath)).toBe(true)
    const artifact = readFileSync(artifactPath)
    expect(artifact.byteLength).toBe(entry.bytes)
    // An entry with no calibrated ceiling is a gap, not a pass.
    const ceiling = CEILINGS[name]
    expect(ceiling, `no calibrated ceiling for ${name}`).toBeDefined()
    expect(artifact.byteLength, name).toBeLessThanOrEqual(ceiling!)
  })

  it('imports under plain Node without a Bun global', async () => {
    expect('Bun' in globalThis).toBe(false)
    const module = (await import(pathToFileURL(artifactPath).href)) as Record<string, unknown>
    const exportName = EXPORTS[name]
    expect(exportName, `no expected export for ${name}`).toBeDefined()
    expect(Object.keys(module)).toEqual([exportName])
    expect(typeof module[exportName!]).toBe('function')
  })

  it('imports nothing but Node builtins', () => {
    const source = readFileSync(artifactPath, 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
  })
})

describe('omp packed surface', () => {
  it('packs the built entry, both transports and the bundle patch', () => {
    // Publish parity: `files` + `prepack` must produce a tarball whose `main`,
    // `types` and bundle patch actually exist in it. `--ignore-scripts` because
    // the build already ran and a pack must not rebuild under the test.
    const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    const listing = `${packed.stdout ?? ''}\n${packed.stderr ?? ''}`
    expect(packed.status, listing).toBe(0)
    for (const path of [
      'lib/index.js',
      'lib/index.d.ts',
      'lib/omp/cursor.mjs',
      'lib/omp/devin.mjs',
      'lib/omp/google.mjs',
      'lib/omp/factory-droid.mjs',
      'lib/omp/gitlab-duo-agent.mjs',
      'bundle/cordis.patch.yml',
    ]) {
      expect(listing, path).toMatch(new RegExp(`notice\\s+\\S+\\s+${path.replace(/[.]/g, '\\.')}(\\s|$)`))
    }
    // Metafiles are build intermediates, not part of the published surface.
    expect(listing).not.toContain('lib/omp/cursor.metafile.json')
    expect(listing).not.toContain('lib/omp/devin.metafile.json')
    expect(listing).not.toContain('lib/omp/google.metafile.json')
    expect(listing).not.toContain('lib/omp/factory-droid.metafile.json')
    expect(listing).not.toContain('lib/omp/gitlab-duo-agent.metafile.json')
  })
})

describe('omp JSON module generator', () => {
  it('keeps every key of a mixed-key JSON in the default export', async () => {
    const emitted = jsonAsEsmModule('{"a":1,"b-c":2,"3d":4}')
    expect(emitted?.loader).toBe('js')
    // the emitted module is executed as-is: this asserts the shipped shape, not
    // a string that happens to contain the keys.
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(emitted?.contents ?? '', 'utf8').toString('base64')}`
    )) as { default: Record<string, unknown>; a?: unknown }
    expect(module.default).toEqual({ a: 1, 'b-c': 2, '3d': 4 })
    expect(module.a).toBe(1)
    // Only identifier-named keys are bindings; the non-identifier keys live in
    // the default export instead of being silently dropped.
    expect(Object.keys(module).sort()).toEqual(['a', 'default'])
  })

  it('emits one named export per identifier-valid key', async () => {
    const emitted = jsonAsEsmModule('{"openai":{},"anthropic":{}}')
    expect(emitted?.loader).toBe('js')
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(emitted?.contents ?? '', 'utf8').toString('base64')}`
    )) as { default: Record<string, unknown>; openai?: unknown; anthropic?: unknown }
    // Both keys become bindings; the non-identifier fallback is the case above.
    expect(Object.keys(module).sort()).toEqual(['anthropic', 'default', 'openai'])
    expect(module.openai).toEqual({})
    expect(module.anthropic).toEqual({})
    // The default export re-assembles the same values by reference, so a
    // consumer of either surface sees one object (and tree-shaking keeps one).
    expect(module.default).toEqual({ openai: module.openai, anthropic: module.anthropic })
    expect(module.default.openai).toBe(module.openai)
    expect(module.default.anthropic).toBe(module.anthropic)
  })

  it('falls back to esbuild JSON handling when no key can be a binding', () => {
    // A faithful fallback: the loader keeps the file verbatim.
    expect(jsonAsEsmModule('{"b-c":2}')).toBeUndefined()
    expect(jsonAsEsmModule('[1,2]')).toBeUndefined()
    expect(jsonAsEsmModule('not json')).toBeUndefined()
  })
})

describe('omp drift gate', () => {
  it('pins the installed omp packages', () => {
    expect(installedVersion('@oh-my-pi/pi-ai')).toBe(manifest.ompVersion)
    expect(installedVersion('@oh-my-pi/pi-catalog')).toBe(manifest.piCatalogVersion)
    // The shim re-exports this package's JSON parser, and the build declares it
    // directly: an install that resolves a different patch changes the manifest.
    expect(installedVersion('@oh-my-pi/pi-utils')).toBe(manifest.piUtilsVersion)
  })

  it('records the esbuild that decides the artifact bytes', () => {
    // The manifest names its build tool: a developer resolving a different
    // patch sees a manifest diff that says which version produced it.
    expect(manifest.esbuildVersion).toBe(installedVersion('esbuild'))
  })

  it('copies the pinned Cursor identity and endpoints into the auth module', () => {
    // The auth module may not import `@oh-my-pi/*` at runtime, so its client id,
    // client version and endpoints are copies. Pin them to the installed sources
    // the transport already depends on; an omp bump that moves either value fails
    // here instead of presenting an identity the server no longer serves.
    const wire = readFileSync(installedSourcePath('@oh-my-pi/pi-catalog/src/wire/cursor.ts'), 'utf8')
    const oauth = readFileSync(installedSourcePath('@oh-my-pi/pi-ai/src/registry/oauth/cursor.ts'), 'utf8')
    expect(wire).toContain(`"${CURSOR_AUTH.clientVersion}"`)
    for (const copy of [
      CURSOR_AUTH.loginUrl,
      CURSOR_AUTH.pollUrl,
      CURSOR_AUTH.refreshUrl,
      CURSOR_AUTH.profileUrl,
      CURSOR_AUTH.clientId,
    ]) {
      expect(oauth, copy).toContain(`"${copy}"`)
    }
  })

  it('hashes the transport sources the bundle was built from', () => {
    const keys = Object.keys(manifest.sourceHashes)
    expect(keys).toContain('@oh-my-pi/pi-ai/src/providers/cursor.ts')
    expect(keys).toContain('@oh-my-pi/pi-catalog/src/discovery/cursor-proto.ts')
    expect(keys).toContain('@oh-my-pi/pi-catalog/src/wire/cursor.ts')
    // The shim re-exports the real JSON algorithms, so their sources are part of
    // the semantic surface the artifact ships.
    expect(keys).toContain('@oh-my-pi/pi-utils/src/json-lexer.ts')
    expect(keys).toContain('@oh-my-pi/pi-utils/src/json-parse.ts')
    expect(keys).toContain('@oh-my-pi/pi-ai/src/providers/cursor-external-tool-handoff.md')
    for (const key of keys) {
      expect(sha256(installedSourcePath(key)), key).toBe(manifest.sourceHashes[key])
    }
  })

  it('records the shim surface the build actually provides', () => {
    expect(Object.keys(manifest.shimSymbols).sort()).toEqual(['bun-global', 'bun-modules', 'pi-utils'])
    for (const name of Object.keys(manifest.shimSymbols) as (keyof OmpManifest['shimSymbols'])[]) {
      expect(shimSymbols(name), name).toEqual(manifest.shimSymbols[name])
    }
  })

  it('records the shim symbols each bundled graph actually reaches', () => {
    for (const { name, manifest: entry, metafile } of entries) {
      const reached = shimImportsOf(metafile!, { packageRoot, shimPaths: shimPaths(entry) }) as Record<
        string,
        string[]
      >
      // A `simplify:` member that becomes reachable changes this set, so the
      // manifest diff names it before the behaviour change ships.
      expect(reached, name).toEqual(entry.shimImports)
      // Both sides run the same derivation, so a parser regression would shrink
      // them together; the real reach must never silently become empty.
      expect(reached['pi-utils'].length, name).toBeGreaterThan(0)
      expect(entry.shimImports['pi-utils'].length, name).toBeGreaterThan(0)
      // No module in any graph imports a `bun:*` builtin: the shim exists to
      // fail loudly if one ever does, so its reach must stay empty.
      expect(entry.shimImports['bun-modules'], name).toEqual([])
    }
  })
})

describe('generated cursor table freshness', () => {
  it('describes the installed catalog and the pin the manifest records', () => {
    // The table carries the claim "this table came from that pin". Without this
    // comparison a catalog bump refreshes the manifest and leaves the committed
    // table describing the previous models, and nothing fails.
    expect(CURSOR_CATALOG_SOURCE.version).toBe(manifest.piCatalogVersion)
    const modelsPath = installedSourcePath('@oh-my-pi/pi-catalog/src/models.json')
    expect(CURSOR_CATALOG_SOURCE.sourceHash).toBe(manifest.sourceHashes['@oh-my-pi/pi-catalog/src/models.json'])
    expect(CURSOR_CATALOG_SOURCE.sourceHash).toBe(sha256(modelsPath))
    const cursorRows = (JSON.parse(readFileSync(modelsPath, 'utf8')) as { cursor?: Record<string, unknown> }).cursor
    expect(cursorRows).toBeDefined()
    expect(CURSOR_CATALOG_SOURCE.rowCount).toBe(Object.keys(cursorRows ?? {}).length)
    expect(CURSOR_MODELS).toHaveLength(CURSOR_CATALOG_SOURCE.rowCount)
  })
})

describe('omp reach derivation', () => {
  it('derives the reached names from every import form', () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-reach-'))
    try {
      const shim = join(root, 'scripts', 'omp-shim', 'pi-utils.ts')
      const bunShim = join(root, 'scripts', 'omp-shim', 'bun-global.ts')
      mkdirSync(dirname(shim), { recursive: true })
      writeFileSync(shim, 'export const plain = 1\n')
      writeFileSync(bunShim, 'export const Bun = {}\n')
      const importer = join(root, 'src', 'importer.ts')
      mkdirSync(dirname(importer), { recursive: true })
      writeFileSync(
        importer,
        [
          "import { plain } from '@oh-my-pi/pi-utils'",
          "import { fromShim as localName } from '@oh-my-pi/pi-utils'",
          "import { type TypeOnly } from '@oh-my-pi/pi-utils'",
          "import * as ns from '@oh-my-pi/pi-utils'",
          "export { reexported } from '@oh-my-pi/pi-utils'",
          'import {',
          '  multiOne,',
          '  multiTwo as multiAlias,',
          "} from '@oh-my-pi/pi-utils'",
          '',
        ].join('\n'),
      )
      const reached = shimImportsOf(
        {
          inputs: {
            'src/importer.ts': {
              imports: [
                // relative edge, as esbuild keys a normal import
                { path: 'scripts/omp-shim/pi-utils.ts', original: '@oh-my-pi/pi-utils' },
                // a plugin-resolved edge keeps an absolute path
                { path: shim, original: '@oh-my-pi/pi-utils' },
                // a `..` segment normalizes onto the same shim key
                { path: 'scripts/omp-shim/../omp-shim/pi-utils.ts', original: '@oh-my-pi/pi-utils' },
                // the injected `Bun` global has no `original`: the binding is the fact
                { path: 'scripts/omp-shim/bun-global.ts' },
              ],
            },
          },
        },
        {
          packageRoot: root,
          shimPaths: {
            'pi-utils': 'scripts/omp-shim/pi-utils.ts',
            'bun-global': 'scripts/omp-shim/bun-global.ts',
          },
        },
      ) as Record<string, string[]>
      // `{ a as b }` reaches `a` (the shim's own export), not the local alias;
      // `type T` is erased before bundling; a namespace/star import reaches all.
      expect(reached['pi-utils']).toEqual(['*', 'fromShim', 'multiOne', 'multiTwo', 'plain', 'reexported'])
      expect(reached['bun-global']).toEqual(['Bun'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('omp pi-utils shim contract', () => {
  it('bounds the cache at `max` and evicts the least recently used entry', () => {
    const cache = new LRUCache<string, string>({ max: 2 })
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key)

    expect(cache.size).toBe(2)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
    // `delete` is the only way to remove an entry ahead of eviction.
    expect(cache.delete('c')).toBe(true)
    expect(cache.has('c')).toBe(false)
  })

  it('refreshes recency on `get`', () => {
    const cache = new LRUCache<string, string>({ max: 2 })
    cache.set('a', '1')
    cache.set('b', '2')
    expect(cache.get('a')).toBe('1')

    cache.set('c', '3')
    // `a` was read, so `b` is the oldest entry now.
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  it('repairs the JSON malformations a model emits instead of dropping arguments', () => {
    // These are the real omp algorithms, re-exported rather than approximated:
    // a strict parse would turn each of these into a silently absent tool
    // argument. The last case must still throw — a truncated final parse is a
    // bad tool call, not one to execute.
    expect(parseJsonWithRepair('{"query": "hi",}')).toEqual({ query: 'hi' })
    expect(parseJsonWithRepair("{'query': 'hi'}")).toEqual({ query: 'hi' })
    expect(parseJsonWithRepair('{"query": "it\'s"}')).toEqual({ query: "it's" })
    expect(() => parseJsonWithRepair('{"query": ')).toThrow()
  })

  it('keeps streaming updates geometric and classifies partial prefixes', () => {
    // The throttled parse is the tool-argument hot path: it must return the
    // parsed prefix plus the length it consumed, and skip re-parsing until the
    // buffer grew by max(256, len / 32).
    const first = parseStreamingJsonThrottled<Record<string, unknown>>('{"query": "he', 0)
    expect(first).toEqual({ value: { query: 'he' }, parsedLen: 13 })
    expect(parseStreamingJsonThrottled('{"query": "he', 13)).toBeNull()

    expect(classifyJsonPrefix('{"query": ')).toBe('prefix')
    expect(classifyJsonPrefix('{"query":"hi"}')).toBe('complete')
    expect(classifyJsonPrefix('{"query":"hi"}x')).toBe('invalid')
  })
})

describe('omp bun-global shim contract', () => {
  it('returns a number from Bun.hash, like Bun', () => {
    const inputs = ['x', 'a longer input that walks the whole 64-bit FNV-1a chain', new Uint8Array([1, 2, 3])]
    for (const input of inputs) {
      const digest = BunGlobal.hash(input)
      expect(typeof digest).toBe('number')
      expect(Number.isFinite(digest)).toBe(true)
      expect(digest).toBeGreaterThanOrEqual(0)
      expect(digest).toBeLessThan(2 ** 64)
    }
    // A u64 above the float53 range is still a `number`, not a `BigInt`.
    expect(typeof BunGlobal.hash('y'.repeat(64))).toBe('number')
  })

  it('continues the chain for a numeric or bigint seed', () => {
    expect(BunGlobal.hash('x', 42)).toBe(BunGlobal.hash('x', 42n))
    expect(BunGlobal.hash('x', 42)).not.toBe(BunGlobal.hash('x'))
    // Bun accepts a fractional seed; `BigInt(seed)` alone would throw a RangeError.
    expect(typeof BunGlobal.hash('x', 1.5)).toBe('number')
  })

  it('serializes the digest with the rest of a persisted checkpoint', () => {
    expect(() => JSON.stringify({ digest: BunGlobal.hash('turn'), seeded: BunGlobal.hash('turn', 7) })).not.toThrow()
    const roundTripped = JSON.parse(JSON.stringify({ h: BunGlobal.hash('x') })) as { h: unknown }
    expect(roundTripped.h).toBe(BunGlobal.hash('x'))
  })

  it('returns digest bytes as the ArrayBuffer Bun returns', () => {
    const expected = createHash('sha256').update('x').digest('hex')
    const staticDigest = SHA256.hash('x')
    expect(staticDigest).toBeInstanceOf(ArrayBuffer)
    expect((staticDigest as ArrayBuffer).byteLength).toBe(32)
    expect(Buffer.from(staticDigest as ArrayBuffer).toString('hex')).toBe(expected)

    const incremental = new SHA256().update('x').digest()
    expect(incremental).toBeInstanceOf(ArrayBuffer)
    expect(Buffer.from(incremental as ArrayBuffer).toString('hex')).toBe(expected)

    const hasher = new CryptoHasher('sha256').update('x').digest()
    expect(hasher).toBeInstanceOf(ArrayBuffer)
    expect(Buffer.from(hasher as ArrayBuffer).toString('hex')).toBe(expected)
  })
})
