/**
 * Build the omp Cursor transport bundle and refresh its drift manifest.
 *
 * omp publishes TypeScript sources, so the transport is consumed at build time:
 * esbuild inlines the `@oh-my-pi/pi-ai/providers/cursor` graph, substitutes the
 * Node shims in `scripts/omp-shim/`, and writes one ESM artifact. The runtime
 * package therefore depends on nothing from `@oh-my-pi/*`.
 *
 * Three contracts make an omp bump safe:
 *
 * 1. A missing shim symbol or a new shim *category* fails this build loudly.
 * 2. `scripts/omp-manifest.json` records the pinned versions, the measured
 *    artifact, the shim surface, and the hashes of every source whose semantics
 *    the transport depends on; `tests/build.test.ts` re-checks all of it.
 * 3. The manifest also records which shim symbols the bundled graph *reaches*
 *    (`shimImports`, derived from the esbuild metafile), so an omp bump that
 *    starts calling a deliberately degraded `simplify:` member fails the drift
 *    gate with a one-line manifest diff. `lib/omp/metafile.json` is the build
 *    output the test re-derives those facts from; it is gitignored and excluded
 *    from the published tarball.
 *
 * Determinism: no timestamps, no source maps, sorted manifest keys, so a rebuild
 * of an unchanged pin produces a byte-identical artifact and manifest.
 *
 * @module dsh-llm-omp-transports/build-omp
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { shimImportsOf } from './omp-reach.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(scriptsDir)

const ENTRY = join(scriptsDir, 'omp-entry.ts')
const OUT = join(packageRoot, 'lib', 'omp', 'cursor.mjs')
/** esbuild's own graph description; `tests/build.test.ts` re-derives `shimImports` from it. */
const METAFILE = join(packageRoot, 'lib', 'omp', 'metafile.json')
const MANIFEST = join(scriptsDir, 'omp-manifest.json')

const PI_UTILS_SHIM = join(scriptsDir, 'omp-shim', 'pi-utils.ts')
const BUN_SHIM = join(scriptsDir, 'omp-shim', 'bun-modules.ts')
const BUN_GLOBAL_SHIM = join(scriptsDir, 'omp-shim', 'bun-global.ts')

/** Shim module name → its path as esbuild keys the metafile (relative to the package root). */
const SHIM_PATHS = {
  'pi-utils': relative(packageRoot, PI_UTILS_SHIM).split('\\').join('/'),
  'bun-modules': relative(packageRoot, BUN_SHIM).split('\\').join('/'),
  'bun-global': relative(packageRoot, BUN_GLOBAL_SHIM).split('\\').join('/'),
}

/** Resolve the on-disk root of an installed package (its `package.json` owner). */
function packageRootOf(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === name) return dir
    }
    dir = dirname(dir)
  }
  throw new Error(`llm-omp: cannot locate the installed package ${name}`)
}

/** Version of the installed esbuild; recorded because it decides `bytes`/`moduleCount`. */
function esbuildVersion() {
  return JSON.parse(readFileSync(join(packageRootOf('esbuild'), 'package.json'), 'utf8')).version
}

/** Named ESM exports of a shim module (the drift-gated shim surface), sorted. */
function shimSymbols(file) {
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/^export\s+(?:abstract\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1])
  }
  return [...names].sort()
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** A JSON object key that can be emitted as an ESM binding name. */
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

/**
 * Convert one JSON module's text into an ESM module with named exports.
 *
 * omp imports large JSON catalogs with import attributes, and the shipped
 * catalog data is read as a module by its own call sites. Emitting it as a
 * JavaScript module keeps the default-export shape those call sites expect and
 * sidesteps attribute handling inside the bundle entirely.
 *
 * Every identifier-named top-level key becomes its own binding and its own
 * `export const`, and the default export re-assembles **every** top-level key of
 * the JSON — identifier keys by reference, the rest inline as literals — so the
 * default stays a faithful copy of the file. The module stays tree-shake-able:
 * a call site that imports named keys sheds every key it does not read, and a
 * default import that no retained code reads lets esbuild drop the catalog
 * entirely. (A per-key `export const key = module[key]` over one shared literal
 * pins that literal into the bundle whatever the graph reads: 10.3 MB of model
 * catalog before this form, nothing after.)
 *
 * `undefined` means "not convertible" — a JSON scalar/array, invalid JSON, or a
 * file whose keys are all non-identifier — and the loader falls back to
 * esbuild's own JSON handling, which preserves the file verbatim.
 * @param text - the JSON source text.
 * @returns the emitted ESM module, or `undefined` when the JSON form is not convertible.
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
  name: 'omp-json-as-esm',
  setup(build_) {
    build_.onLoad({ filter: /\.json$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8')
      return jsonAsEsmModule(text) ?? { contents: text, loader: 'json' }
    })
  },
})

const ompShims = () => ({
  name: 'omp-node-shims',
  setup(build_) {
    build_.onResolve({ filter: /^@oh-my-pi\/pi-utils(\/.*)?$/ }, args => {
      // The shim re-exports omp's real JSON parser instead of reimplementing it;
      // redirecting that import would resolve straight back to the shim.
      if (args.importer === PI_UTILS_SHIM) return undefined
      return { path: PI_UTILS_SHIM }
    })
    build_.onResolve({ filter: /^bun(:.*)?$/ }, () => ({ path: BUN_SHIM }))
  },
})

async function main() {
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
    // omp ships non-code assets that the transport imports as text.
    loader: { '.md': 'text', '.html': 'text' },
    metafile: true,
    logLevel: 'warning',
    // Free `Bun` identifiers (the runtime global, not the `bun:*` modules) resolve
    // to the Node shim, so the artifact carries no unmet runtime global.
    inject: [BUN_GLOBAL_SHIM],
    plugins: [ompJsonAsEsm(), ompShims()],
  })

  const piAiRoot = packageRootOf('@oh-my-pi/pi-ai')
  const piCatalogRoot = packageRootOf('@oh-my-pi/pi-catalog')
  const piUtilsRoot = packageRootOf('@oh-my-pi/pi-utils')
  const piAiVersion = JSON.parse(readFileSync(join(piAiRoot, 'package.json'), 'utf8')).version
  const piCatalogVersion = JSON.parse(readFileSync(join(piCatalogRoot, 'package.json'), 'utf8')).version
  const piUtilsVersion = JSON.parse(readFileSync(join(piUtilsRoot, 'package.json'), 'utf8')).version

  const tracked = {
    '@oh-my-pi/pi-ai/src/providers/cursor.ts': join(piAiRoot, 'src/providers/cursor.ts'),
    '@oh-my-pi/pi-catalog/src/discovery/cursor-proto.ts': join(piCatalogRoot, 'src/discovery/cursor-proto.ts'),
    '@oh-my-pi/pi-catalog/src/models.json': join(piCatalogRoot, 'src/models.json'),
    '@oh-my-pi/pi-catalog/src/wire/cursor.ts': join(piCatalogRoot, 'src/wire/cursor.ts'),
    '@oh-my-pi/pi-catalog/src/compat/rules/auth/cursor.kdl': join(piCatalogRoot, 'src/compat/rules/auth/cursor.kdl'),
    // Real JSON algorithms the shim re-exports (not a reimplementation).
    '@oh-my-pi/pi-utils/src/json-lexer.ts': join(packageRootOf('@oh-my-pi/pi-utils'), 'src/json-lexer.ts'),
    '@oh-my-pi/pi-utils/src/json-parse.ts': join(packageRootOf('@oh-my-pi/pi-utils'), 'src/json-parse.ts'),
    // The external-executor handoff text the wire fixture asserts verbatim.
    '@oh-my-pi/pi-ai/src/providers/cursor-external-tool-handoff.md': join(
      piAiRoot,
      'src/providers/cursor-external-tool-handoff.md',
    ),
  }

  const sourceHashes = {}
  for (const [key, path] of Object.entries(tracked)) {
    sourceHashes[key] = sha256(await readFile(path))
  }

  const artifact = await readFile(OUT)
  await writeFile(METAFILE, `${JSON.stringify(result.metafile)}\n`)

  const manifest = {
    ompVersion: piAiVersion,
    piCatalogVersion,
    // The shim re-exports this package's real JSON algorithms, so its pin is a
    // devDependency of its own rather than a transitive accident.
    piUtilsVersion,
    esbuildVersion: esbuildVersion(),
    entry: relative(packageRoot, OUT).split('\\').join('/'),
    moduleCount: Object.keys(result.metafile.inputs).length,
    bytes: artifact.byteLength,
    shimSymbols: {
      'pi-utils': shimSymbols(PI_UTILS_SHIM),
      'bun-modules': shimSymbols(BUN_SHIM),
      'bun-global': shimSymbols(BUN_GLOBAL_SHIM),
    },
    shimImports: shimImportsOf(result.metafile, { packageRoot, shimPaths: SHIM_PATHS }),
    sourceHashes,
  }

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

  const modules = Object.keys(result.metafile.inputs)
  console.log(
    `llm-omp: bundled ${manifest.moduleCount} modules → ${manifest.entry} (${manifest.bytes} bytes) ` +
      `from @oh-my-pi/pi-ai@${piAiVersion} with esbuild@${manifest.esbuildVersion}`,
  )
  console.log(
    `llm-omp: shim surface pi-utils=${manifest.shimSymbols['pi-utils'].length} ` +
      `bun-modules=${manifest.shimSymbols['bun-modules'].length} ` +
      `bun-global=${manifest.shimSymbols['bun-global'].length}; ` +
      `reached pi-utils=${manifest.shimImports['pi-utils'].length} ` +
      `bun-modules=${manifest.shimImports['bun-modules'].length} ` +
      `bun-global=${manifest.shimImports['bun-global'].length}`,
  )
  for (const [key, hash] of Object.entries(sourceHashes)) console.log(`llm-omp: ${hash}  ${key}`)
  if (process.env.OMP_BUILD_DEBUG) {
    for (const module of modules) console.log(`llm-omp: module ${module}`)
  }
}

// The build runs only when this file is the script (`pnpm build`,
// `node scripts/build-omp.mjs`); `tests/build.test.ts` imports `jsonAsEsmModule`
// from it, and an import must not rewrite the artifact or the manifest.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) await main()
