/**
 * Build-artifact and drift gate for the omp sign-in OAuth bundle.
 *
 * The suite answers the questions a reviewer needs before trusting the
 * artifact that ships in `lib/omp-oauth/`:
 *
 * 1. **Does it run on Node?** The bundle is imported through a plain Node ESM
 *    loader with no `Bun` global present, and must expose exactly the two
 *    sign-in entry points.
 * 2. **Can it run on Node?** Every static import in the artifact must be a Node
 *    builtin — the published `lib/` may not depend on `@oh-my-pi/*` or `bun:*`.
 * 3. **Is it the bundle the manifest describes?** Pinned versions, hashed omp
 *    sources, the shim surface, the reached shim symbols, the substitutions and
 *    the measured artifact must all still match.
 * 4. **Does the generated policy still describe the installed rules?** The
 *    `zai-coding-plan` slice is regenerated in memory from `rules.json` and
 *    compared byte-for-byte, so an omp bump is a reviewable diff of what the
 *    flow will do rather than a silent behaviour change.
 *
 * The bundle, its metafile, the policy slice and the manifest are build
 * outputs: run `pnpm build` before `pnpm test`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { jsonAsEsmModule } from '../scripts/omp-oauth/build-oauth.mjs'
import {
  HOOKS_FILE,
  POLICY_FILE,
  installedPackageRoot,
  policyFactsOf,
  policySlice,
  renderHooks,
  renderPolicy,
  rulesFilePath,
} from '../scripts/omp-oauth/generate-policy.mjs'
import { shimImportsOf } from '../scripts/omp-oauth/omp-reach.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(testsDir)

interface OmpOauthManifest {
  ompVersion: string
  piCatalogVersion: string
  piUtilsVersion: string
  esbuildVersion: string
  entry: string
  moduleCount: number
  bytes: number
  shimSymbols: Record<string, string[]>
  shimImports: Record<string, string[]>
  overrides: { specifier: string; file: string; reason: string; sourceHash: string }[]
  sourceHashes: Record<string, string>
  policyFacts: Record<string, Record<string, unknown>>
  bunSurface: string[]
  bundleCeiling: number
}

interface Metafile {
  inputs: Record<string, { imports: { path: string; original?: string }[] }>
}

const manifest: OmpOauthManifest = JSON.parse(
  readFileSync(join(packageRoot, 'scripts/omp-oauth/omp-manifest.json'), 'utf8'),
)

const artifactPath = join(packageRoot, manifest.entry)
const metafilePath = join(dirname(artifactPath), 'metafile.json')

if (!existsSync(artifactPath) || !existsSync(metafilePath)) {
  throw new Error(`omp-oauth: run \`pnpm build\` first — the bundle and ${metafilePath} are build outputs`)
}

const metafile: Metafile = JSON.parse(readFileSync(metafilePath, 'utf8'))

/** Shim module name → the same package-relative key the build records. */
const shimPaths = {
  'pi-utils': 'scripts/omp-oauth/omp-shim/pi-utils.ts',
  'bun-global': 'scripts/omp-oauth/omp-shim/bun-global.ts',
}

function installedVersion(name: string): string {
  return JSON.parse(readFileSync(join(installedPackageRoot(name), 'package.json'), 'utf8')).version as string
}

/** Map a manifest source key (`@oh-my-pi/<package>/<path>`) onto the installed file. */
function installedSourcePath(key: string): string {
  const match = /^(@oh-my-pi\/[^/]+)\/(.+)$/.exec(key)
  if (!match) throw new Error(`unexpected manifest source key ${key}`)
  return join(installedPackageRoot(match[1]), match[2])
}

function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/** Named ESM exports of a shim module, mirroring the build script's extraction. */
function shimSymbols(name: keyof OmpOauthManifest['shimSymbols']): string[] {
  const file = join(packageRoot, 'scripts/omp-oauth/omp-shim', `${name}.ts`)
  const source = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/^export\s+(?:abstract\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1])
  }
  return [...names].sort()
}

const rulesText = readFileSync(rulesFilePath(), 'utf8')

describe('omp sign-in bundle', () => {
  it('ships an artifact with the measured shape', () => {
    expect(manifest.entry).toBe('lib/omp-oauth/oauth.mjs')
    // Exact, not a floor: the metafile is this build's module list, so a pin
    // bump that adds or drops a module changes the manifest (and CI's diff).
    expect(manifest.moduleCount).toBe(Object.keys(metafile.inputs).length)
    const artifact = readFileSync(artifactPath)
    expect(artifact.byteLength).toBe(manifest.bytes)
    expect(artifact.byteLength).toBeLessThanOrEqual(manifest.bundleCeiling)
  })

  it('imports under plain Node without a Bun global and exposes the two drivers', async () => {
    expect('Bun' in globalThis).toBe(false)
    const module = (await import(pathToFileURL(artifactPath).href)) as Record<string, unknown>
    expect(Object.keys(module).sort()).toEqual(['loginKilo', 'loginZaiCodingPlan'])
    expect(typeof module.loginKilo).toBe('function')
    expect(typeof module.loginZaiCodingPlan).toBe('function')
  })

  it('imports nothing but Node builtins', () => {
    const source = readFileSync(artifactPath, 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
  })

  it('mentions no omp package or bun specifier in any import or dynamic import', () => {
    const source = readFileSync(artifactPath, 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('node:')) continue
      expect(specifier, 'the artifact must carry no omp or bun specifier').not.toMatch(/^@oh-my-pi\/|^bun:/)
      // A relative specifier would escape the bundle; the artifact is one file.
      expect(specifier, 'the artifact must be self-contained').not.toMatch(/^\.\.?\//)
    }
  })

  it('rebuilds byte-identically', () => {
    const artifactBefore = sha256File(artifactPath)
    const manifestBefore = sha256File(join(packageRoot, 'scripts/omp-oauth/omp-manifest.json'))
    for (let run = 0; run < 2; run += 1) {
      const rebuilt = spawnSync('node', [join(packageRoot, 'scripts/omp-oauth/build-oauth.mjs')], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
      expect(rebuilt.status, `${rebuilt.stdout ?? ''}\n${rebuilt.stderr ?? ''}`).toBe(0)
      expect(sha256File(artifactPath)).toBe(artifactBefore)
      expect(sha256File(join(packageRoot, 'scripts/omp-oauth/omp-manifest.json'))).toBe(manifestBefore)
    }
  })
})

describe('omp sign-in drift gate', () => {
  it('pins the installed omp packages and the esbuild that decides the bytes', () => {
    expect(installedVersion('@oh-my-pi/pi-ai')).toBe(manifest.ompVersion)
    expect(installedVersion('@oh-my-pi/pi-catalog')).toBe(manifest.piCatalogVersion)
    expect(installedVersion('@oh-my-pi/pi-utils')).toBe(manifest.piUtilsVersion)
    expect(installedVersion('esbuild')).toBe(manifest.esbuildVersion)
  })

  it('hashes every omp source whose semantics the flows depend on', () => {
    const keys = Object.keys(manifest.sourceHashes)
    for (const key of [
      '@oh-my-pi/pi-ai/src/registry/oauth/kilo.ts',
      '@oh-my-pi/pi-ai/src/registry/oauth/zai.ts',
      '@oh-my-pi/pi-ai/src/registry/oauth/callback-server.ts',
      '@oh-my-pi/pi-ai/src/registry/engine/oauth-code.ts',
      '@oh-my-pi/pi-catalog/src/compat/rules.json',
      '@oh-my-pi/pi-catalog/src/compat/rules/auth/zai-coding-plan.kdl',
    ]) {
      expect(keys, key).toContain(key)
    }
    for (const key of keys) {
      expect(sha256File(installedSourcePath(key)), key).toBe(manifest.sourceHashes[key])
    }
  })

  it('records the shim surface the build actually provides', () => {
    expect(Object.keys(manifest.shimSymbols).sort()).toEqual(['bun-global', 'pi-utils'])
    for (const name of Object.keys(manifest.shimSymbols) as (keyof OmpOauthManifest['shimSymbols'])[]) {
      expect(shimSymbols(name), name).toEqual(manifest.shimSymbols[name])
    }
  })

  it('records the shim symbols the bundled graph actually reaches, and all of them exist', () => {
    const reached = shimImportsOf(metafile, { packageRoot, shimPaths }) as Record<string, string[]>
    expect(reached).toEqual(manifest.shimImports)
    expect(manifest.shimImports['pi-utils'].length).toBeGreaterThan(0)
    for (const [shim, imports] of Object.entries(manifest.shimImports)) {
      const declared = new Set(manifest.shimSymbols[shim])
      for (const name of imports) {
        if (name === '*') continue
        expect(declared.has(name), `${shim}.${name} is reached but not implemented`).toBe(true)
      }
    }
  })

  it('records every build-time substitution with its own hash', () => {
    expect(manifest.overrides).toHaveLength(6)
    for (const override of manifest.overrides) {
      expect(existsSync(join(packageRoot, override.file)), override.file).toBe(true)
      expect(sha256File(join(packageRoot, override.file)), override.file).toBe(override.sourceHash)
      expect(override.reason.length, override.specifier).toBeGreaterThan(0)
    }
    expect(manifest.overrides.map(entry => entry.specifier)).toContain('@oh-my-pi/pi-utils(/*)')
    expect(manifest.overrides.map(entry => entry.specifier)).toContain('Bun (global)')
  })

  it('records the Bun members the shim implements', () => {
    const source = readFileSync(join(packageRoot, 'scripts/omp-oauth/omp-shim/bun-global.ts'), 'utf8')
    const match = /^export const BUN_MEMBERS = \[([^\]]*)\] as const/m.exec(source)
    expect(match).not.toBeNull()
    expect([...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map(entry => entry[1])).toEqual(manifest.bunSurface)
    // `Bun.sleep` is the reason this shim exists: the Kilo device poll awaits it.
    expect(manifest.bunSurface).toContain('sleep')
  })
})

describe('generated omp policy slice', () => {
  it('matches the installed rules.json byte-for-byte, with its single edit recorded', () => {
    expect(readFileSync(POLICY_FILE, 'utf8')).toBe(renderPolicy(rulesText))
    const source = readFileSync(POLICY_FILE, 'utf8')
    expect(source).toContain(sha256Text(rulesText))
    expect(source).toContain('nativeScheme: true → false')
  })

  it('applies exactly one local edit to the copied rule', () => {
    const raw = policySlice(rulesText)
    // The installed rule asks for the native scheme handler; the copied rule
    // must not, and nothing else may differ.
    const installed = JSON.parse(rulesText).auth.providers.find(
      (provider: { id?: string }) => provider?.id === 'zai-coding-plan',
    )
    expect(installed.login.callback.nativeScheme).toBe(true)
    expect(raw.zai.login.callback.nativeScheme).toBe(false)
    const withoutNativeScheme = (value: { login: { callback: Record<string, unknown> } }) => {
      const copy = structuredClone(value)
      delete copy.login.callback.nativeScheme
      return copy
    }
    expect(withoutNativeScheme(raw.zai)).toEqual(withoutNativeScheme(installed))
  })

  it('records policy facts that answer to the installed rules', () => {
    const facts = policyFactsOf(policySlice(rulesText))
    expect(manifest.policyFacts).toEqual(facts)
    expect(facts.zaiCodingPlan).toMatchObject({
      id: 'zai-coding-plan',
      storeAs: 'zai',
      pkce: false,
      state: 'hex',
      manualOnly: true,
      nativeScheme: false,
      afterExchange: 'zai-mint-key',
      expiresMode: 'never',
      refreshKind: 'none',
      // The engine's `pasteKey` short-circuit must stay unreachable so the
      // api-key-validation stub is never entered.
      pasteKey: false,
      pasteCode: true,
      authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
      tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
      redirectUri: 'zcode://zai-auth/callback',
      accessPath: 'data.zai.access_token',
    })
    expect(facts.kilo).toMatchObject({ id: 'kilo', apiKeyFormat: 'bearer', loginKind: 'custom', loginHook: 'kilo' })
  })

  it('refuses a policy that names a hook the bundle does not bind', () => {
    // The registry substitution is only safe while every referenced hook is
    // bound explicitly. These are the two ways a rules bump could break that:
    // a renamed after-exchange hook, and a `hook=` on a runtime-resolved value.
    const renamed = structuredClone(policySlice(rulesText))
    renamed.zai.login.afterExchange = 'some-new-hook'
    expect(() => renderHooks(renamed)).toThrow(/some-new-hook/)

    const valueHook = structuredClone(policySlice(rulesText))
    valueHook.zai.login.token.url.hook = 'some-value-hook'
    expect(() => renderHooks(valueHook)).toThrow(/some-value-hook/)

    // The one `hook=` the slice legitimately names (kilo's custom login) stays
    // accepted: entry.ts imports it directly instead of the registry.
    expect(() => renderHooks(policySlice(rulesText))).not.toThrow()
  })

  it('narrows the hook registry to the hooks the copied rule names', () => {
    expect(readFileSync(HOOKS_FILE, 'utf8')).toBe(renderHooks(policySlice(rulesText)))
    const source = readFileSync(HOOKS_FILE, 'utf8')
    // The rule's after-exchange hook is present and resolves to the real omp
    // implementation; anything else would be a degenerate registry.
    expect(source).toContain('"zai-mint-key"')
    expect(source).toContain("@oh-my-pi/pi-ai/oauth/zai")
    expect(source).toContain('zaiMintKeyHook')
  })
})

describe('root packed surface', () => {
  it('packs the sign-in bundle but not its metafile or the build scripts', () => {
    // Publish parity: `files` must keep the built artifact reachable while the
    // metafile and `scripts/omp-oauth/**` stay build intermediates of the repo.
    const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    expect(packed.status, packed.stderr).toBe(0)
    const [result] = JSON.parse(packed.stdout) as [{ files: { path: string }[] }]
    const paths = result.files.map(file => file.path)
    expect(paths).toEqual(expect.arrayContaining(['lib/index.js', 'lib/omp-oauth/oauth.mjs']))
    expect(paths).not.toContain('lib/omp-oauth/metafile.json')
    expect(paths.some(path => path.startsWith('scripts/omp-oauth/'))).toBe(false)
  })

  it('pins the same omp versions as the transports package', () => {
    // Two manifests pin one upstream: a bump applied to only one keeps both
    // gates green while the install ships two omp versions.
    const sibling = JSON.parse(
      readFileSync(join(packageRoot, 'packages/llm-omp/scripts/omp-manifest.json'), 'utf8'),
    ) as { ompVersion: string; piCatalogVersion: string; piUtilsVersion: string; esbuildVersion: string }
    expect(sibling.ompVersion).toBe(manifest.ompVersion)
    expect(sibling.piCatalogVersion).toBe(manifest.piCatalogVersion)
    expect(sibling.piUtilsVersion).toBe(manifest.piUtilsVersion)
    expect(sibling.esbuildVersion).toBe(manifest.esbuildVersion)
  })
})

describe('omp JSON module generator', () => {
  it('keeps every key of a mixed-key JSON in the default export', async () => {
    const emitted = jsonAsEsmModule('{"a":1,"b-c":2,"3d":4}')
    expect(emitted?.loader).toBe('js')
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(emitted?.contents ?? '', 'utf8').toString('base64')}`
    )) as { default: Record<string, unknown>; a?: unknown }
    expect(module.default).toEqual({ a: 1, 'b-c': 2, '3d': 4 })
    expect(module.a).toBe(1)
    expect(Object.keys(module).sort()).toEqual(['a', 'default'])
  })

  it('falls back to esbuild JSON handling when no key can be a binding', () => {
    expect(jsonAsEsmModule('{"b-c":2}')).toBeUndefined()
    expect(jsonAsEsmModule('[1,2]')).toBeUndefined()
    expect(jsonAsEsmModule('not json')).toBeUndefined()
  })
})
