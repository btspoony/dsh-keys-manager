/**
 * Build the omp sign-in OAuth bundle and refresh its drift manifest.
 *
 * omp publishes TypeScript sources, so the two flows (`kilo`,
 * `zai-coding-plan`) are consumed at build time: esbuild inlines their graph,
 * substitutes the Node shims and the policy-derived overrides, and writes one
 * ESM artifact under `lib/`. The published package depends on nothing from
 * `@oh-my-pi/*`; `src/oauth/adapter.ts` loads the artifact lazily by URL,
 * inside a sign-in attempt.
 *
 * The contracts mirror the Cursor transport bundle
 * (`packages/llm-omp/scripts/build-omp.mjs`), copied rather than imported so
 * the two packages stay independent:
 *
 * 1. A missing shim symbol fails this build, not the test.
 * 2. `scripts/omp-oauth/omp-manifest.json` records the pinned versions, the
 *    measured artifact, the shim surface, every substitution, the hashes of
 *    the omp sources whose semantics the flows depend on, the policy facts the
 *    flows are generated from, and the reached Bun members; the drift test
 *    re-checks all of it.
 * 3. The policy slice and the narrowed hook registry are *generated* into the
 *    source tree, so an omp bump produces a reviewable diff of what the flow
 *    will do.
 *
 * Determinism: no timestamps, no source maps, sorted manifest keys, so a
 * rebuild of an unchanged pin produces a byte-identical artifact and manifest.
 *
 * @module dsh-keys-manager/omp-oauth/build-oauth
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import {
  HOOKS_FILE,
  POLICY_FILE,
  generateAll,
  installedPackageRoot,
  packageRoot,
  policyFactsOf,
  policySlice,
  rulesFilePath,
} from './generate-policy.mjs'
import { shimImportsOf } from './omp-reach.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))

const ENTRY = join(scriptsDir, 'entry.ts')
const OUT = join(packageRoot, 'lib', 'omp-oauth', 'oauth.mjs')
/** esbuild's own graph description; the drift test re-derives `shimImports` from it. */
const METAFILE = join(packageRoot, 'lib', 'omp-oauth', 'metafile.json')
const MANIFEST = join(scriptsDir, 'omp-manifest.json')

const PI_UTILS_SHIM = join(scriptsDir, 'omp-shim', 'pi-utils.ts')
const BUN_GLOBAL_SHIM = join(scriptsDir, 'omp-shim', 'bun-global.ts')
const HOOKS_OVERRIDE = HOOKS_FILE
const API_KEY_VALIDATION_OVERRIDE = join(scriptsDir, 'overrides', 'api-key-validation.ts')
const PI_NATIVES_OVERRIDE = join(scriptsDir, 'overrides', 'pi-natives.ts')
const COMPAT_POLICY_OVERRIDE = join(scriptsDir, 'overrides', 'compat-policy.ts')

/** Shim module name → its path as esbuild keys the metafile (relative to the package root). */
const SHIM_PATHS = {
  'pi-utils': relative(packageRoot, PI_UTILS_SHIM).split('\\').join('/'),
  'bun-global': relative(packageRoot, BUN_GLOBAL_SHIM).split('\\').join('/'),
}

/**
 * Every build-time substitution, one row per reason.
 *
 * `sourceHash` hashes the substituted file itself, so editing a shim is a
 * manifest diff even when the reach set is unchanged.
 */
const OVERRIDES = [
  {
    specifier: '@oh-my-pi/pi-utils(/*)',
    file: relative(packageRoot, PI_UTILS_SHIM).split('\\').join('/'),
    reason: 'Bun-oriented utility barrel; only the sign-in surface is implemented on Node',
  },
  {
    specifier: 'Bun (global)',
    file: relative(packageRoot, BUN_GLOBAL_SHIM).split('\\').join('/'),
    reason: 'Bun runtime global; sleep is real, hashing keeps Bun return contracts',
  },
  {
    specifier: '@oh-my-pi/pi-ai/src/registry/hooks',
    file: relative(packageRoot, HOOKS_OVERRIDE).split('\\').join('/'),
    reason: 'eager registry pulled the model catalog; narrowed to the hooks the copied rule names',
  },
  {
    specifier: '@oh-my-pi/pi-ai/src/registry/api-key-validation',
    file: relative(packageRoot, API_KEY_VALIDATION_OVERRIDE).split('\\').join('/'),
    reason: 'pasteKey branch is unreachable (the copied rule declares no pasteKey)',
  },
  {
    specifier: '@oh-my-pi/pi-natives',
    file: relative(packageRoot, PI_NATIVES_OVERRIDE).split('\\').join('/'),
    reason: 'native URI-scheme helper; the copied rule sets nativeScheme: false',
  },
  {
    specifier: '@oh-my-pi/pi-catalog/compat/behavior',
    file: relative(packageRoot, COMPAT_POLICY_OVERRIDE).split('\\').join('/'),
    reason: 'retry-reset timezone facts only; would otherwise inline the 467 KB rules catalog',
  },
]

/** Named ESM exports of a shim module (the drift-gated shim surface), sorted. */
function shimSymbols(file) {
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/^export\s+(?:abstract\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/** The `Bun` members the shim declares, read from its own `BUN_MEMBERS` line. */
function bunSurface(file) {
  const source = readFileSync(file, 'utf8')
  const match = /^export const BUN_MEMBERS = \[([^\]]*)\] as const/m.exec(source)
  if (match === null) throw new Error('omp-oauth: bun-global.ts must declare BUN_MEMBERS')
  return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1])
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Version of an installed package. */
function versionOf(name) {
  return JSON.parse(readFileSync(join(installedPackageRoot(name), 'package.json'), 'utf8')).version
}

/** A JSON object key that can be emitted as an ESM binding name. */
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

/**
 * Convert one JSON module's text into an ESM module with named exports.
 *
 * Same form as the transport build: identifier-named top-level keys become
 * bindings, and the default export re-assembles every key so a default import
 * stays faithful while named imports stay tree-shakeable.
 * @param text - the JSON source text.
 */
export function jsonAsEsmModule(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const keys = Object.keys(data)
  const named = keys.filter(key => IDENTIFIER_KEY.test(key))
  if (named.length === 0) return undefined
  const locals = new Map(named.map((name, index) => [name, `__key_${index}`]))
  const contents = [
    ...named.map(name => `const ${locals.get(name)} = ${JSON.stringify(data[name])};`),
    ...named.map(name => `export const ${name} = ${locals.get(name)};`),
    `export default { ${keys
      .map(key => `${JSON.stringify(key)}: ${locals.get(key) ?? JSON.stringify(data[key])}`)
      .join(', ')} };`,
    '',
  ].join('\n')
  return { contents, loader: 'js' }
}

const ompJsonAsEsm = () => ({
  name: 'omp-oauth-json-as-esm',
  setup(build_) {
    build_.onLoad({ filter: /\.json$/ }, async args => {
      const text = await readFile(args.path, 'utf8')
      return jsonAsEsmModule(text) ?? { contents: text, loader: 'json' }
    })
  },
})

const ompOauthOverrides = () => ({
  name: 'omp-oauth-overrides',
  setup(build_) {
    build_.onResolve({ filter: /^@oh-my-pi\/pi-utils(\/.*)?$/ }, () => ({ path: PI_UTILS_SHIM }))
    // omp's engine imports the hook registry by relative specifier.
    build_.onResolve({ filter: /^\.\.\/hooks$/ }, () => ({ path: HOOKS_OVERRIDE }))
    build_.onResolve({ filter: /^\.\.\/api-key-validation$/ }, () => ({ path: API_KEY_VALIDATION_OVERRIDE }))
    build_.onResolve({ filter: /^@oh-my-pi\/pi-natives$/ }, () => ({ path: PI_NATIVES_OVERRIDE }))
    build_.onResolve({ filter: /^@oh-my-pi\/pi-catalog\/compat\/(?:behavior|cascade)$/ }, () => ({
      path: COMPAT_POLICY_OVERRIDE,
    }))
  },
})

/** Fail the build when the graph reaches a shim symbol the shim does not export. */
function assertReachedSymbols(manifest) {
  const missing = []
  for (const [shim, imports] of Object.entries(manifest.shimImports)) {
    const declared = new Set(manifest.shimSymbols[shim] ?? [])
    for (const name of imports) {
      if (name === '*' || declared.has(name)) continue
      missing.push(`${shim}.${name}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`omp-oauth: the bundle reaches shim symbols that are not implemented: ${missing.join(', ')}`)
  }
}

async function main() {
  // The policy slice and hook registry are generated first: the build consumes
  // them, and a bump must show up as a diff of these files.
  const { rulesText, policy, hooks } = generateAll()
  mkdirSync(dirname(HOOKS_FILE), { recursive: true })
  writeFileSync(POLICY_FILE, policy)
  writeFileSync(HOOKS_FILE, hooks)

  await mkdir(dirname(OUT), { recursive: true })

  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // MIT notices of the inlined omp sources travel with the artifact.
    legalComments: 'eof',
    // omp imports its callback page as text.
    loader: { '.md': 'text', '.html': 'text' },
    metafile: true,
    logLevel: 'warning',
    // Free `Bun` identifiers (the runtime global, not `bun:*` modules) resolve
    // to the Node shim, so the artifact carries no unmet runtime global.
    inject: [BUN_GLOBAL_SHIM],
    plugins: [ompJsonAsEsm(), ompOauthOverrides()],
  })

  const piAiRoot = installedPackageRoot('@oh-my-pi/pi-ai')
  const piCatalogRoot = installedPackageRoot('@oh-my-pi/pi-catalog')

  const tracked = {
    '@oh-my-pi/pi-ai/src/registry/oauth/kilo.ts': join(piAiRoot, 'src/registry/oauth/kilo.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/zai.ts': join(piAiRoot, 'src/registry/oauth/zai.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/callback-server.ts': join(piAiRoot, 'src/registry/oauth/callback-server.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/device-code.ts': join(piAiRoot, 'src/registry/oauth/device-code.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/pkce.ts': join(piAiRoot, 'src/registry/oauth/pkce.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/native-scheme-callback.ts': join(
      piAiRoot,
      'src/registry/oauth/native-scheme-callback.ts',
    ),
    '@oh-my-pi/pi-ai/src/registry/oauth/types.ts': join(piAiRoot, 'src/registry/oauth/types.ts'),
    '@oh-my-pi/pi-ai/src/registry/oauth/oauth.html': join(piAiRoot, 'src/registry/oauth/oauth.html'),
    '@oh-my-pi/pi-ai/src/registry/engine/common.ts': join(piAiRoot, 'src/registry/engine/common.ts'),
    '@oh-my-pi/pi-ai/src/registry/engine/oauth-code.ts': join(piAiRoot, 'src/registry/engine/oauth-code.ts'),
    // The error graph the flows raise through (kilo/zai/AIError).
    '@oh-my-pi/pi-ai/src/error/index.ts': join(piAiRoot, 'src/error/index.ts'),
    '@oh-my-pi/pi-ai/src/error/flags.ts': join(piAiRoot, 'src/error/flags.ts'),
    '@oh-my-pi/pi-ai/src/error/oauth.ts': join(piAiRoot, 'src/error/oauth.ts'),
    '@oh-my-pi/pi-ai/src/error/classes.ts': join(piAiRoot, 'src/error/classes.ts'),
    '@oh-my-pi/pi-ai/src/utils/retry-after.ts': join(piAiRoot, 'src/utils/retry-after.ts'),
    '@oh-my-pi/pi-catalog/src/compat/rules.json': rulesFilePath(),
    '@oh-my-pi/pi-catalog/src/compat/rules/auth/zai-coding-plan.kdl': join(
      piCatalogRoot,
      'src/compat/rules/auth/zai-coding-plan.kdl',
    ),
    '@oh-my-pi/pi-catalog/src/compat/rules/auth/kilo.kdl': join(piCatalogRoot, 'src/compat/rules/auth/kilo.kdl'),
  }

  const sourceHashes = {}
  for (const [key, path] of Object.entries(tracked)) {
    if (!existsSync(path)) throw new Error(`omp-oauth: tracked omp source is missing: ${key}`)
    sourceHashes[key] = sha256(await readFile(path))
  }

  const artifact = await readFile(OUT)
  await writeFile(METAFILE, `${JSON.stringify(result.metafile)}\n`)

  const overrides = OVERRIDES.map(entry => ({
    ...entry,
    sourceHash: sha256(readFileSync(join(packageRoot, entry.file))),
  }))

  const manifest = {
    ompVersion: versionOf('@oh-my-pi/pi-ai'),
    piCatalogVersion: versionOf('@oh-my-pi/pi-catalog'),
    // The shim imports nothing from omp today; the pin is recorded anyway so a
    // future real re-export cannot hide which utility version it came from.
    piUtilsVersion: versionOf('@oh-my-pi/pi-utils'),
    esbuildVersion: versionOf('esbuild'),
    entry: relative(packageRoot, OUT).split('\\').join('/'),
    moduleCount: Object.keys(result.metafile.inputs).length,
    bytes: artifact.byteLength,
    shimSymbols: {
      'pi-utils': shimSymbols(PI_UTILS_SHIM),
      'bun-global': shimSymbols(BUN_GLOBAL_SHIM),
    },
    shimImports: shimImportsOf(result.metafile, { packageRoot, shimPaths: SHIM_PATHS }),
    overrides,
    sourceHashes,
    policyFacts: policyFactsOf(policySlice(rulesText)),
    bunSurface: bunSurface(BUN_GLOBAL_SHIM),
    bundleCeiling: 2_000_000,
  }

  assertReachedSymbols(manifest)

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(
    `omp-oauth: bundled ${manifest.moduleCount} modules → ${manifest.entry} (${manifest.bytes} bytes) ` +
      `from @oh-my-pi/pi-ai@${manifest.ompVersion} with esbuild@${manifest.esbuildVersion}`,
  )
  console.log(
    `omp-oauth: shim surface pi-utils=${manifest.shimSymbols['pi-utils'].length} ` +
      `bun-global=${manifest.shimSymbols['bun-global'].length}; ` +
      `reached pi-utils=${manifest.shimImports['pi-utils'].length} ` +
      `bun-global=${manifest.shimImports['bun-global'].length}`,
  )
  for (const [key, hash] of Object.entries(sourceHashes)) console.log(`omp-oauth: ${hash}  ${key}`)
  if (process.env.OMP_BUILD_DEBUG) {
    for (const module of Object.keys(result.metafile.inputs)) console.log(`omp-oauth: module ${module}`)
  }
}

// The build runs only when this file is the script (`pnpm build`,
// `node scripts/omp-oauth/build-oauth.mjs`); the drift test imports
// `jsonAsEsmModule` from it, and an import must not rewrite the artifact.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) await main()
