/**
 * Generate the committed Cursor model table from the pinned omp catalog.
 *
 * `@oh-my-pi/pi-catalog` ships one `models.json` describing every provider it
 * serves. The Cursor slice is the model list this plugin must offer on the DSH
 * llm seam, so the plugin carries a generated copy instead of importing a
 * 12 MB catalog at runtime: the table is reviewable, stable, and its provenance
 * (package version + source hash) is recorded beside the rows.
 *
 * The output is deterministic — rows sorted by id, generated values only, fixed
 * formatting — so regenerating an unchanged pin produces a byte-identical file.
 * Every field is kept only because something reads it: the DSH model metadata,
 * or the omp transport itself (`thinking`, `cursorMaxMode*`, `requestModelId`,
 * `requiresCursorToolSchemaProjection`, `cost`). `cost` is not shown by DSH, but
 * the transport prices the turn from it and fails without it.
 *
 * Reasoning efforts are copied verbatim, including rows that advertise efforts
 * with no `effortRouting` (19 of the pinned catalog's 123 rows). omp resolves an
 * unrouted effort to the row's own wire id (`requestModelId ?? id`) in
 * `@oh-my-pi/pi-catalog/src/model-thinking.ts`, and every downstream wire
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
const OUT = join(packageRoot, 'src', 'catalog', 'cursor.ts')

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

const rows = Object.values(catalog.cursor ?? {})
if (rows.length === 0) throw new Error('llm-omp: the installed catalog has no `cursor` models')

/**
 * Reduce one catalog row to the fields the seam and the transport consume.
 *
 * @param row - one `models.json` Cursor row.
 * @returns the generated row, with absent optionals omitted rather than null.
 */
function reduce(row) {
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

const reduced = rows
  .map(reduce)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Render a JSON value at a fixed indentation inside the surrounding array. */
function render(value, indent) {
  const text = JSON.stringify(value, null, 2)
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
}

const body = reduced.map(row => `  ${render(row, '  ')},`).join('\n')

const file = `/**
 * Generated Cursor model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${catalogVersion}\` \`src/models.json\` key \`cursor\`
 * (${reduced.length} rows, ${sourceHash}). Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
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
 */
import type { CursorModelRow } from '../omp.js'

/** Provenance of {@link CURSOR_MODELS}. */
export const CURSOR_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '${catalogVersion}',
  file: 'src/models.json',
  key: 'cursor',
  sourceHash: '${sourceHash}',
  rowCount: ${reduced.length},
} as const

/** Every Cursor model the pinned catalog serves, sorted by id. */
export const CURSOR_MODELS: readonly CursorModelRow[] = [
${body}
]
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, file)

console.log(
  `llm-omp: wrote ${reduced.length} cursor models from @oh-my-pi/pi-catalog@${catalogVersion} (${sourceHash})`,
)
