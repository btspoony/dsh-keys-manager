/**
 * Drift gate for the omp GitLab Duo **agent** entry.
 *
 * `tests/build.test.ts` already loads every artifact under plain Node, compares
 * its measured shape with the metafile and enforces the calibrated ceiling; this
 * file adds what only this route can assert:
 *
 * 1. **The artifact is the workflow transport alone**, built from the existing
 *    shims with no `bun:*` reach, exporting exactly `streamGitLabDuoWorkflow`.
 * 2. **Are the sources the pinned ones?** Provider, chatml note, discovery module
 *    and the auth rule are hashed in the manifest.
 * 3. **Do the copied auth facts still exist?** The client id, the authorize/token
 *    URLs, the `vscode://` redirect and the refresh's `redirect_uri` param are read
 *    from the installed rule, so an omp bump that moves one fails here.
 * 4. **Is the generated row the installed catalog's?** Provenance, row count and a
 *    byte-identical regeneration.
 *
 * The manifest is a build output: run `pnpm build` before `pnpm test`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { GITLAB_DUO_CATALOG_SOURCE, GITLAB_DUO_MODELS } from '../src/catalog/gitlab-duo.js'
import { GITLAB_DUO_AGENT_CATALOG_SOURCE, GITLAB_DUO_AGENT_MODELS } from '../src/catalog/gitlab-duo-agent.js'
import { GITLAB_DUO_AGENT_AUTH, GITLAB_DUO_AUTH } from '../src/gitlab/auth.js'
import { gitlabDuoAgentCatalogModels, gitlabDuoCatalogModels } from '../src/index.js'

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
const entry = manifest.entries['gitlab-duo-agent']
if (entry === undefined) throw new Error('llm-omp: the manifest records no gitlab-duo-agent entry — run `pnpm build`')

/** Locate the installed copy of a package by walking up to its own `package.json`. */
function installedPackageRoot(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)))
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

describe('gitlab duo agent drift gate', () => {
  it('ships the workflow transport alone, with no bun reach', () => {
    expect(entry.entry).toBe('lib/omp/gitlab-duo-agent.mjs')
    // The graph is the workflow transport plus its catalog helpers; the design
    // measured 118 modules / ~1 MB with the existing shims, and this entry adds
    // nothing to them.
    expect(entry.moduleCount).toBe(118)
    // 1 001 890 bytes measured; the ceiling (`tests/build.test.ts`) is 1 500 000.
    expect(entry.bytes).toBeLessThanOrEqual(1_500_000)
    expect(entry.shimImports['bun-modules']).toEqual([])
    expect(entry.shimImports['bun-global']).toEqual(['Bun'])
    // No shim extension: the existing `pi-utils` shim covers this graph.
    expect(entry.piUtilsShim).toBe('scripts/omp-shim/pi-utils.ts')
  })

  it('hashes the GitLab workflow sources the bundle was built from', () => {
    for (const key of [
      '@oh-my-pi/pi-ai/src/providers/gitlab-duo-workflow.ts',
      '@oh-my-pi/pi-ai/src/providers/gitlab-duo-workflow-chatml-note.md',
      '@oh-my-pi/pi-catalog/src/discovery/gitlab-duo-workflow.ts',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/gitlab-duo-agent.kdl',
    ]) {
      expect(manifest.sourceHashes[key], key).toBe(sha256(installedSourcePath(key)))
    }
  })

  it('pins the login facts this module copies from the rule', () => {
    const rule = readFileSync(installedSourcePath('@oh-my-pi/pi-catalog/src/compat/rules/auth/gitlab-duo-agent.kdl'), 'utf8')
    expect(rule).toContain(`client-id "${GITLAB_DUO_AGENT_AUTH.clientId}"`)
    expect(rule).toContain(`authorize-url "${GITLAB_DUO_AGENT_AUTH.authorizeUrl}"`)
    expect(rule).toContain('token url="https://gitlab.com/oauth/token"')
    expect(rule).toContain('pkce #true')
    expect(rule).toContain('scopes "api"')
    expect(rule).toContain(`redirect-uri="${GITLAB_DUO_AGENT_AUTH.redirectUri}"`)
    expect(rule).toContain('manual-only=#true')
    // The refresh must echo the redirect URI: the rule's params block is the
    // reason this route's refresh differs from a plain grant_type exchange.
    expect(rule).toContain('params { redirect_uri "{redirect_uri}" }')
    expect(rule).toContain('expires "seconds" path="expires_in" from="created_at" skew-ms=300000')
  })

  it('describes the installed catalog and the pin the manifest records', () => {
    expect(GITLAB_DUO_AGENT_CATALOG_SOURCE.version).toBe(manifest.piCatalogVersion)
    const modelsPath = installedSourcePath('@oh-my-pi/pi-catalog/src/models.json')
    expect(GITLAB_DUO_AGENT_CATALOG_SOURCE.sourceHash).toBe(manifest.sourceHashes['@oh-my-pi/pi-catalog/src/models.json'])
    expect(GITLAB_DUO_AGENT_CATALOG_SOURCE.sourceHash).toBe(sha256(modelsPath))
    const rows = (JSON.parse(readFileSync(modelsPath, 'utf8')) as { 'gitlab-duo-agent'?: Record<string, unknown> })[
      'gitlab-duo-agent'
    ]
    expect(rows).toBeDefined()
    expect(GITLAB_DUO_AGENT_CATALOG_SOURCE.rowCount).toBe(Object.keys(rows ?? {}).length)
    expect(GITLAB_DUO_AGENT_MODELS).toHaveLength(GITLAB_DUO_AGENT_CATALOG_SOURCE.rowCount)
  })

  it('carries the single static row with its limits and no invented output cap', () => {
    expect(GITLAB_DUO_AGENT_MODELS.map(row => row.id)).toEqual(['claude_sonnet_4_6_vertex'])
    const [row] = GITLAB_DUO_AGENT_MODELS
    expect(row).toMatchObject({
      name: 'Claude Sonnet 4.6 - Vertex',
      baseUrl: 'https://gitlab.com',
      contextWindow: 1_000_000,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
    })
    // The pin declares `maxTokens: null` for this model: the generated row omits
    // the field rather than carrying a sentinel.
    expect(row).not.toHaveProperty('maxTokens')
  })

  it('regenerates byte-identically and projects for the host picker', () => {
    const catalogPath = join(packageRoot, 'src', 'catalog', 'gitlab-duo-agent.ts')
    const before = readFileSync(catalogPath)
    const generated = spawnSync('node', ['scripts/generate-catalog.mjs'], { cwd: packageRoot, encoding: 'utf8' })
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0)
    expect(readFileSync(catalogPath).equals(before)).toBe(true)
    expect(gitlabDuoAgentCatalogModels()).toEqual(GITLAB_DUO_AGENT_MODELS.map(row => ({ id: row.id, name: row.name })))
  })
})

describe('gitlab duo proxy drift gate', () => {
  const duo = manifest.entries['gitlab-duo']
  const metafile = JSON.parse(readFileSync(join(packageRoot, duo!.metafile), 'utf8')) as {
    inputs: Record<string, { imports: { path: string }[] }>
  }
  const inputs = Object.keys(metafile.inputs).map(path => path.replace(/.*node_modules\//, ''))

  it('builds under the 4 MB bound from the entry-scoped substitutions', () => {
    // 2 654 940 bytes measured; the ceiling is 3 980 000 (plan D12: ≤4 MB).
    expect(duo!.bytes).toBeLessThanOrEqual(4_000_000)
    expect(duo!.moduleCount).toBe(231)
    // The alias fired: the lean registry substitute is an input and the real
    // dispatch table is not, so the builtin provider registry never enters.
    expect(inputs).toContain('scripts/omp-shim/register-builtins-lean.ts')
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/providers/register-builtins.ts')
    expect(inputs.filter(path => path.endsWith('models.json'))).toEqual([])
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/stream.ts')
    expect(inputs).not.toContain('@oh-my-pi/pi-ai/src/env-api-key.ts')
    // The three generic transports it delegates to are the real modules.
    for (const kept of [
      '@oh-my-pi/pi-ai/src/providers/anthropic.ts',
      '@oh-my-pi/pi-ai/src/providers/openai-completions.ts',
      '@oh-my-pi/pi-ai/src/providers/openai-responses.ts',
    ]) {
      expect(inputs, kept).toContain(kept)
    }
    expect(duo!.shimImports['bun-modules']).toEqual([])
  })

  it('records the per-entry shim surfaces, unmodified shared shims', () => {
    expect(duo!.piUtilsShim).toBe('scripts/omp-shim/pi-utils-gitlab-duo.ts')
    // The shared shim keeps its exact surface: this route's extra members live in
    // its own extension module (the Google precedent).
    expect(manifest.shimSymbols['pi-utils']).not.toContain('readSseEvents')
    expect(duo!.shimImports['pi-utils']).toContain('readSseEvents')
    expect(duo!.shimImports['pi-utils']).toContain('USER_AGENT')
  })

  it('hashes the proxy sources and the alias table the catalog is built from', () => {
    for (const key of [
      '@oh-my-pi/pi-ai/src/providers/gitlab-duo.ts',
      '@oh-my-pi/pi-catalog/src/provider-models/special.ts',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/gitlab-duo.kdl',
    ]) {
      expect(manifest.sourceHashes[key], key).toBe(sha256(installedSourcePath(key)))
    }
  })

  it('carries 16 rows with the upstream id and the wire each routes to', () => {
    expect(GITLAB_DUO_MODELS).toHaveLength(16)
    expect(GITLAB_DUO_CATALOG_SOURCE.rowCount).toBe(16)
    expect(GITLAB_DUO_CATALOG_SOURCE.version).toBe(manifest.piCatalogVersion)
    for (const row of GITLAB_DUO_MODELS) {
      expect(row.api).toBe('gitlab-duo')
      expect(row.provider).toBe('gitlab-duo')
      expect(['anthropic-messages', 'openai-responses', 'openai-completions']).toContain(row.apiRoute)
      expect(typeof row.upstreamModelId).toBe('string')
      // The alias rows substitute an upstream id; bare upstream rows resolve to themselves.
      if (row.id.startsWith('duo-chat-gpt')) expect(row.upstreamModelId).not.toBe(row.id)
    }
    // The three wires are all represented, and the alias table is folded in.
    expect(new Set(GITLAB_DUO_MODELS.map(row => row.apiRoute)).size).toBe(3)
    const aliasRow = GITLAB_DUO_MODELS.find(row => row.id === 'duo-chat-opus-4-6')!
    expect(aliasRow.upstreamModelId).toBe('claude-opus-4-6')
    const codex = GITLAB_DUO_MODELS.find(row => row.id === 'duo-chat-gpt-5-2-codex')!
    expect(codex).toMatchObject({ upstreamModelId: 'gpt-5.2-codex', apiRoute: 'openai-responses' })
  })

  it('regenerates byte-identically and projects for the host picker', () => {
    const catalogPath = join(packageRoot, 'src', 'catalog', 'gitlab-duo.ts')
    const before = readFileSync(catalogPath)
    const generated = spawnSync('node', ['scripts/generate-catalog.mjs'], { cwd: packageRoot, encoding: 'utf8' })
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0)
    expect(readFileSync(catalogPath).equals(before)).toBe(true)
    expect(gitlabDuoCatalogModels()).toEqual(GITLAB_DUO_MODELS.map(row => ({ id: row.id, name: row.name })))
  })

  it('pins the Duo login facts this package copies', () => {
    const rule = readFileSync(installedSourcePath('@oh-my-pi/pi-catalog/src/compat/rules/auth/gitlab-duo.kdl'), 'utf8')
    expect(rule).toContain(`client-id "${GITLAB_DUO_AUTH.clientId}"`)
    expect(rule).toContain('callback port=8080 path="/callback" hostname="localhost"')
    expect(rule).toContain('pkce #true')
    expect(rule).toContain('after-exchange hook="gitlab-duo-clear-cache"')
    // The refresh block declares no token/params: it reuses the login's endpoint.
    expect(rule).toContain('refresh {\n\t\tafter-refresh hook="gitlab-duo-clear-cache"\n\t}')
  })
})
