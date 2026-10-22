/**
 * Drift gate for the omp Devin entry.
 *
 * `tests/build.test.ts` already loads both artifacts under plain Node, asserts
 * each one's measured shape against its metafile and enforces the calibrated
 * ceilings; this file adds what only the Devin route can assert:
 *
 * 1. **Are the Devin sources the pinned ones?** Provider, Connect envelope,
 *    codecs and the auth rule are hashed in the manifest.
 * 2. **Do the copied wire facts still exist?** The CLI identity, the authorize
 *    page and the callback port are read from the installed sources the bundle
 *    was built from, so an omp bump that moves one fails here instead of
 *    presenting an identity the server no longer serves.
 * 3. **Is the generated table the installed catalog's?** Provenance, row count
 *    and a byte-identical regeneration.
 *
 * The manifest is a build output: run `pnpm build` before `pnpm test`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DEVIN_CATALOG_SOURCE, DEVIN_MODELS } from '../src/catalog/devin.js'
import { devinCatalogModels } from '../src/index.js'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

interface OmpEntry {
  entry: string
  metafile: string
  moduleCount: number
  bytes: number
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
if (manifest.entries.devin === undefined) {
  throw new Error('llm-omp: the manifest records no devin entry — run `pnpm build`')
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

describe('devin drift gate', () => {
  it('pins the installed omp packages', () => {
    expect(installedVersion('@oh-my-pi/pi-ai')).toBe(manifest.ompVersion)
    expect(installedVersion('@oh-my-pi/pi-catalog')).toBe(manifest.piCatalogVersion)
    expect(installedVersion('@oh-my-pi/pi-utils')).toBe(manifest.piUtilsVersion)
  })

  it('hashes the Devin transport sources the bundle was built from', () => {
    const keys = Object.keys(manifest.sourceHashes)
    for (const key of [
      '@oh-my-pi/pi-ai/src/providers/devin.ts',
      '@oh-my-pi/pi-ai/src/providers/connect-frame.ts',
      '@oh-my-pi/pi-catalog/src/discovery/devin-proto.ts',
      '@oh-my-pi/pi-catalog/src/discovery/protobuf.ts',
      '@oh-my-pi/pi-catalog/src/wire/devin.ts',
      '@oh-my-pi/pi-catalog/src/wire/devin-proto.ts',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/devin.kdl',
    ]) {
      expect(keys, key).toContain(key)
      expect(sha256(installedSourcePath(key)), key).toBe(manifest.sourceHashes[key])
    }
  })

  it('pins the installed Devin CLI identity and login endpoints', () => {
    // The wire identity and the declarative login rule are omp's, not ours: the
    // auth module (task 3) copies them because it may not import
    // `@oh-my-pi/*` at runtime, so the copies are anchored to the pin here.
    const wire = readFileSync(installedSourcePath('@oh-my-pi/pi-catalog/src/wire/devin.ts'), 'utf8')
    expect(wire).toContain('ideName: "devin-cli"')
    expect(wire).toContain('ideType: "chisel"')
    expect(wire).toContain('ideVersion: "3000.11.3"')
    expect(wire).toContain('devin-session-token$')
    const rule = readFileSync(installedSourcePath('@oh-my-pi/pi-catalog/src/compat/rules/auth/devin.kdl'), 'utf8')
    expect(rule).toContain('authorize-url "https://app.devin.ai/auth/cli/continue"')
    expect(rule).toContain('token url="https://api.devin.ai/auth/cli/token"')
    expect(rule).toContain('callback port=59653 path="/callback" hostname="127.0.0.1"')
    expect(rule).toContain('expires "jwt" fallback-ms=31536000000')
    expect(rule).toContain('refresh "none"')
  })
})

describe('generated devin table freshness', () => {
  it('describes the installed catalog and the pin the manifest records', () => {
    expect(DEVIN_CATALOG_SOURCE.version).toBe(manifest.piCatalogVersion)
    const modelsPath = installedSourcePath('@oh-my-pi/pi-catalog/src/models.json')
    expect(DEVIN_CATALOG_SOURCE.sourceHash).toBe(manifest.sourceHashes['@oh-my-pi/pi-catalog/src/models.json'])
    expect(DEVIN_CATALOG_SOURCE.sourceHash).toBe(sha256(modelsPath))
    const devinRows = (JSON.parse(readFileSync(modelsPath, 'utf8')) as { devin?: Record<string, unknown> }).devin
    expect(devinRows).toBeDefined()
    expect(DEVIN_CATALOG_SOURCE.rowCount).toBe(Object.keys(devinRows ?? {}).length)
    expect(DEVIN_MODELS).toHaveLength(DEVIN_CATALOG_SOURCE.rowCount)
  })

  it('regenerates byte-identically from the installed pin', () => {
    const catalogPath = join(packageRoot, 'src', 'catalog', 'devin.ts')
    const before = readFileSync(catalogPath)
    const generated = spawnSync('node', ['scripts/generate-catalog.mjs'], { cwd: packageRoot, encoding: 'utf8' })
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0)
    // A pin bump that changes a row's consumed fields shows up as this diff
    // instead of shipping a committed table the bundle no longer matches.
    expect(readFileSync(catalogPath).equals(before)).toBe(true)
  })

  it('projects the generated table for host-side surfaces', () => {
    // The root keys-manager's model picker needs the unfiltered rows; the shape
    // is the same `TransportCatalogModel` and order `cursorCatalogModels()`
    // projects from the Cursor table.
    const models = devinCatalogModels()
    expect(models).toEqual(DEVIN_MODELS.map(row => ({ id: row.id, name: row.name })))
    expect(Object.keys(models[0]!)).toEqual(['id', 'name'])
  })
})
