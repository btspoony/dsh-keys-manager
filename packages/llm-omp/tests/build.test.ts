/**
 * Build-artifact and drift gate for the omp Cursor bundle.
 *
 * These tests answer three questions about the shipped artifact:
 *
 * 1. **Does it run on Node?** The bundle is imported through a plain Node ESM
 *    loader with no Bun global present, and must expose `streamCursor`.
 * 2. **Can it run on Node?** Every static import in the artifact must be a Node
 *    builtin — the published `lib/` may not depend on `@oh-my-pi/*` or `bun:*`.
 * 3. **Is it the bundle the manifest describes?** The pinned omp versions, the
 *    hashed sources and the shim surface must all still match, so an omp bump
 *    fails here instead of at request time.
 *
 * Regenerate the manifest with `pnpm build` after an intentional pin bump.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

interface OmpManifest {
  ompVersion: string
  piCatalogVersion: string
  entry: string
  moduleCount: number
  bytes: number
  shimSymbols: Record<string, string[]>
  sourceHashes: Record<string, string>
}

const manifest: OmpManifest = JSON.parse(readFileSync(join(packageRoot, 'scripts/omp-manifest.json'), 'utf8'))

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

const artifactPath = join(packageRoot, manifest.entry)

describe('omp cursor bundle', () => {
  it('ships an artifact with the measured shape', () => {
    expect(manifest.entry).toBe('lib/omp/cursor.mjs')
    expect(manifest.moduleCount).toBeGreaterThan(100)
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath).byteLength).toBe(manifest.bytes)
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
})

describe('omp drift gate', () => {
  it('pins the installed omp packages', () => {
    expect(installedVersion('@oh-my-pi/pi-ai')).toBe(manifest.ompVersion)
    expect(installedVersion('@oh-my-pi/pi-catalog')).toBe(manifest.piCatalogVersion)
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
})
