/**
 * Generate the committed Cursor and Devin model tables from the pinned omp
 * catalog.
 *
 * `@oh-my-pi/pi-catalog` ships one `models.json` describing every provider it
 * serves. Each omp-backed route this plugin must offer on the DSH llm seam gets
 * a generated copy instead of importing a 12 MB catalog at runtime: the table
 * is reviewable, stable, and its provenance (package version + source hash) is
 * recorded beside the rows.
 *
 * The output is deterministic — rows sorted by id, generated values only, fixed
 * formatting — so regenerating an unchanged pin produces byte-identical files.
 * Every field is kept only because something reads it: the DSH model metadata,
 * or the omp transport itself (`thinking`, `cursorMaxMode*`, `requestModelId`,
 * `requiresCursorToolSchemaProjection`, `cost`). `cost` is not shown by DSH, but
 * the transport prices the turn from it and fails without it.
 *
 * Reasoning efforts are copied verbatim, including rows that advertise efforts
 * with no `effortRouting` (19 of the pinned catalog's 123 cursor rows). omp
 * resolves an unrouted effort to the row's own wire id (`requestModelId ?? id`)
 * in `@oh-my-pi/pi-catalog/src/model-thinking.ts`, and every downstream wire
 * decision (`cursorMaxMode`, discovery route, `cursorModelParameters`) derives
 * from that one id, so on those rows every advertised effort sends exactly the
 * same request: effort selection is a wire-level no-op, exactly as in omp. The
 * list is still carried unfiltered because the catalog advertises it and the
 * projection mirrors the fallback; `tests/adapter-text.test.ts` asserts every
 * advertised effort resolves, so an omp bump that starts refusing one fails
 * there instead of surfacing as a runtime `UNSUPPORTED_REASONING_EFFORT`.
 *
 * @module dsh-llm-omp-transports/generate-catalog
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(scriptsDir)

/** Resolve the installed root of a package by walking up to its own manifest. */
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

const catalogRoot = packageRootOf('@oh-my-pi/pi-catalog')
const modelsPath = join(catalogRoot, 'src', 'models.json')
const modelsBytes = readFileSync(modelsPath)
const catalogVersion = JSON.parse(readFileSync(join(catalogRoot, 'package.json'), 'utf8')).version
const catalog = JSON.parse(modelsBytes.toString('utf8'))
const sourceHash = `sha256:${createHash('sha256').update(modelsBytes).digest('hex')}`

/**
 * Reduce one Cursor catalog row to the fields the seam and the transport consume.
 *
 * @param row - one `models.json` Cursor row.
 * @returns the generated row, with absent optionals omitted rather than null.
 */
function reduceCursor(row) {
  const out = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: [...row.input],
    cost: {
      input: row.cost.input,
      output: row.cost.output,
      cacheRead: row.cost.cacheRead,
      cacheWrite: row.cost.cacheWrite,
    },
  }
  if (row.cursorMaxMode !== undefined && row.cursorMaxMode !== null) out.cursorMaxMode = row.cursorMaxMode
  if (row.cursorMaxModeRoutes) out.cursorMaxModeRoutes = { ...row.cursorMaxModeRoutes }
  if (row.thinking) {
    out.thinking = {
      mode: row.thinking.mode,
      efforts: [...(row.thinking.efforts ?? [])],
      ...(row.thinking.effortRouting ? { effortRouting: { ...row.thinking.effortRouting } } : {}),
    }
  }
  if (row.requestModelId !== undefined) out.requestModelId = row.requestModelId
  out.requiresGlyphTokenization = row.requiresGlyphTokenization === true
  if (row.requiresCursorToolSchemaProjection !== undefined) {
    out.requiresCursorToolSchemaProjection = row.requiresCursorToolSchemaProjection
  }
  return out
}

/**
 * Reduce one Devin catalog row to the fields the seam and the transport consume.
 *
 * The transport dereferences `compat.modelRouter` (router branch),
 * `compat.supportsParallelToolCalls` (`disableParallelToolCalls`) and the whole
 * `reasoning` flag (plaintext-reasoning replay); `ResolvedDevinCompat` also
 * requires `trustExplicitThinkingOnly`. `identity`, `supportsComputerUse`,
 * `compatConfig` and `supportsTools` are read by neither side and stay out.
 *
 * @param row - one `models.json` Devin row.
 * @returns the generated row, with absent optionals omitted rather than null.
 */
function reduceDevin(row) {
  const out = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: [...row.input],
    cost: {
      input: row.cost.input,
      output: row.cost.output,
      cacheRead: row.cost.cacheRead,
      cacheWrite: row.cost.cacheWrite,
    },
    reasoning: row.reasoning === true,
    compat: {
      trustExplicitThinkingOnly: row.compat.trustExplicitThinkingOnly === true,
      modelRouter: row.compat.modelRouter === true,
      supportsParallelToolCalls: row.compat.supportsParallelToolCalls === true,
    },
  }
  if (row.requestModelId !== undefined) out.requestModelId = row.requestModelId
  return out
}

/**
 * One generated table. The prose and the drift-gate file are per route; the
 * rendering, sort order and provenance shape are shared.
 */
const PROVIDERS = [
  {
    key: 'cursor',
    out: join(packageRoot, 'src', 'catalog', 'cursor.ts'),
    constName: 'CURSOR_MODELS',
    sourceConst: 'CURSOR_CATALOG_SOURCE',
    rowType: 'CursorModelRow',
    summary: 'Every Cursor model the pinned catalog serves, sorted by id.',
    reduce: reduceCursor,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated Cursor model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key \`cursor\`
 * (${rowCount} rows, ${sourceHash}). Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The drift gate in \`tests/build.test.ts\` pins the same package version and
 * source hash, so an omp bump fails there before this table can describe the
 * wrong models.
 *
 * Rows that advertise efforts without routing them are carried unchanged, and
 * on each of them every advertised effort resolves to the same wire id (the
 * row's own, \`requestModelId ?? id\`): selecting one is a wire-level no-op,
 * exactly as in omp. No row's effort list is filtered.
 *
 * @module dsh-llm-omp-transports/catalog/cursor
 */`,
  },
  {
    key: 'devin',
    out: join(packageRoot, 'src', 'catalog', 'devin.ts'),
    constName: 'DEVIN_MODELS',
    sourceConst: 'DEVIN_CATALOG_SOURCE',
    rowType: 'DevinModelRow',
    summary: 'Every Devin model the pinned catalog serves, sorted by id.',
    reduce: reduceDevin,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated Devin model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key \`devin\`
 * (${rowCount} rows, ${sourceHash}). Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The drift gate in \`tests/build-devin.test.ts\` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Each row carries the resolved \`compat\` trio and the \`reasoning\` flag the
 * transport dereferences, and no field the wire never reads.
 *
 * @module dsh-llm-omp-transports/catalog/devin
 */`,
  },
]

/** Render a JSON value at a fixed indentation inside the surrounding array. */
function render(value, indent) {
  const text = JSON.stringify(value, null, 2)
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
}

/**
 * Write one provider's generated table.
 * @param provider - the provider table row.
 * @returns the number of rows written.
 */
function generate(provider) {
  const rows = Object.values(catalog[provider.key] ?? {})
  if (rows.length === 0) throw new Error(`llm-omp: the installed catalog has no \`${provider.key}\` models`)

  const reduced = rows.map(provider.reduce).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const body = reduced.map(row => `  ${render(row, '  ')},`).join('\n')

  const file = `${provider.doc({
    version: catalogVersion,
    rowCount: reduced.length,
    sourceHash,
  })}
import type { ${provider.rowType} } from '../omp.js'

/** Provenance of {@link ${provider.constName}}. */
export const ${provider.sourceConst} = {
  package: '@oh-my-pi/pi-catalog',
  version: '${catalogVersion}',
  file: 'src/models.json',
  key: '${provider.key}',
  sourceHash: '${sourceHash}',
  rowCount: ${reduced.length},
} as const

/** ${provider.summary} */
export const ${provider.constName}: readonly ${provider.rowType}[] = [
${body}
]
`

  mkdirSync(dirname(provider.out), { recursive: true })
  writeFileSync(provider.out, file)
  console.log(
    `llm-omp: wrote ${reduced.length} ${provider.key} models from @oh-my-pi/pi-catalog@${catalogVersion} (${sourceHash})`,
  )
  return reduced.length
}

for (const provider of PROVIDERS) generate(provider)
