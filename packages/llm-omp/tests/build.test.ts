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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { shimImportsOf } from '../scripts/omp-reach.mjs'
import { Bun as BunGlobal, CryptoHasher, SHA256 } from '../scripts/omp-shim/bun-global'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

/**
 * Measured 1,372,181 bytes when the whole model catalog is tree-shaken out of
 * the graph. The ceiling is a loud backstop for a catalog (or another large
 * asset) being pulled back into the shipped bundle on purpose-less drift.
 */
const MAX_BUNDLE_BYTES = 15_500_000

interface OmpManifest {
  ompVersion: string
  piCatalogVersion: string
  esbuildVersion: string
  entry: string
  moduleCount: number
  bytes: number
  shimSymbols: Record<string, string[]>
  shimImports: Record<string, string[]>
  sourceHashes: Record<string, string>
}

const manifest: OmpManifest = JSON.parse(readFileSync(join(packageRoot, 'scripts/omp-manifest.json'), 'utf8'))

const artifactPath = join(packageRoot, manifest.entry)
/** esbuild's graph description of the same build; written next to the artifact. */
const metafilePath = join(dirname(artifactPath), 'metafile.json')

if (!existsSync(artifactPath) || !existsSync(metafilePath)) {
  throw new Error(`llm-omp: run \`pnpm build\` first — the bundle and ${metafilePath} are build outputs`)
}

interface Metafile {
  inputs: Record<string, { imports: { path: string; original?: string }[] }>
}

const metafile: Metafile = JSON.parse(readFileSync(metafilePath, 'utf8'))

/** Shim module name → the same package-relative key the build records. */
const shimPaths = {
  'pi-utils': 'scripts/omp-shim/pi-utils.ts',
  'bun-modules': 'scripts/omp-shim/bun-modules.ts',
  'bun-global': 'scripts/omp-shim/bun-global.ts',
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

describe('omp cursor bundle', () => {
  it('ships an artifact with the measured shape', () => {
    expect(manifest.entry).toBe('lib/omp/cursor.mjs')
    // Exact, not a floor: the metafile is this build's module list, so a pin
    // bump that adds or drops a module changes the manifest (and CI's diff).
    expect(manifest.moduleCount).toBe(Object.keys(metafile.inputs).length)
    expect(existsSync(artifactPath)).toBe(true)
    const artifact = readFileSync(artifactPath)
    expect(artifact.byteLength).toBe(manifest.bytes)
    expect(artifact.byteLength).toBeLessThanOrEqual(MAX_BUNDLE_BYTES)
  })

  it('imports under plain Node without a Bun global', async () => {
    expect('Bun' in globalThis).toBe(false)
    const module = (await import(pathToFileURL(artifactPath).href)) as { streamCursor?: unknown }
    expect(Object.keys(module)).toEqual(['streamCursor'])
    expect(typeof module.streamCursor).toBe('function')
  })

  it('imports nothing but Node builtins', () => {
    const source = readFileSync(artifactPath, 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
  })

  it('packs the built entry, the transport and the bundle patch', () => {
    // Publish parity: `files` + `prepack` must produce a tarball whose `main`,
    // `types` and bundle patch actually exist in it. `--ignore-scripts` because
    // the build already ran and a pack must not rebuild under the test.
    const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    const listing = `${packed.stdout ?? ''}\n${packed.stderr ?? ''}`
    expect(packed.status, listing).toBe(0)
    for (const path of ['lib/index.js', 'lib/index.d.ts', 'lib/omp/cursor.mjs', 'bundle/cordis.patch.yml']) {
      expect(listing, path).toMatch(new RegExp(`notice\\s+\\S+\\s+${path.replace(/[.]/g, '\\.')}(\\s|$)`))
    }
    // The metafile is a build intermediate, not part of the published surface.
    expect(listing).not.toContain('lib/omp/metafile.json')
  })
})

describe('omp drift gate', () => {
  it('pins the installed omp packages', () => {
    expect(installedVersion('@oh-my-pi/pi-ai')).toBe(manifest.ompVersion)
    expect(installedVersion('@oh-my-pi/pi-catalog')).toBe(manifest.piCatalogVersion)
  })

  it('records the esbuild that decides the artifact bytes', () => {
    // The manifest names its build tool: a developer resolving a different
    // patch sees a manifest diff that says which version produced it.
    expect(manifest.esbuildVersion).toBe(installedVersion('esbuild'))
  })

  it('hashes the transport sources the bundle was built from', () => {
    const keys = Object.keys(manifest.sourceHashes)
    expect(keys).toContain('@oh-my-pi/pi-ai/src/providers/cursor.ts')
    expect(keys).toContain('@oh-my-pi/pi-catalog/src/discovery/cursor-proto.ts')
    expect(keys).toContain('@oh-my-pi/pi-catalog/src/wire/cursor.ts')
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

  it('records the shim symbols the bundled graph actually reaches', () => {
    // A `simplify:` member that becomes reachable changes this set, so the
    // manifest diff names it before the behaviour change ships.
    expect(shimImportsOf(metafile, { packageRoot, shimPaths })).toEqual(manifest.shimImports)
    // No module in the graph imports a `bun:*` builtin: the shim exists to fail
    // loudly if one ever does, so its reach must stay empty.
    expect(manifest.shimImports['bun-modules']).toEqual([])
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
