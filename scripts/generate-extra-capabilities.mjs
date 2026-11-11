/**
 * Generate the committed image-capability index for the extra-provider routes.
 *
 * DSH's remote model discovery (`readListing`) reports no input modalities, so
 * every row an extra-provider profile installs looks text-only. The pinned
 * `@oh-my-pi/pi-catalog` does know which of those models accept images; this
 * script copies that answer into a small committed module instead of importing
 * a 12 MB catalog at runtime.
 *
 * Only routes the pinned catalog describes are emitted: an absent route means
 * "the pin says nothing about it", which is not the same as "no image models",
 * and the runtime merge leaves such a route's curated seed modalities alone.
 *
 * The same pass emits the reasoning index: for a row whose catalog `thinking`
 * mode the route can dispatch, the DSH thinking levels to declare and the wire
 * value of each. See {@link buildReasoningIndex} for the rules.
 *
 * The output is deterministic — providers and ids sorted, fixed formatting, and
 * a provenance header naming the package version and the sha256 of its
 * `src/models.json` — so regenerating an unchanged pin is byte-identical.
 *
 * @module dsh-keys-manager/generate-extra-capabilities
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The pin ships its catalog compact-encoded, so rows are only reachable through
// its opener. The port keeps this generator independent of the pin's TS sources.
import { getCatalogProvider, openModelCatalog } from './model-catalog-format.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptsDir)

/** Resolve the installed root of a package by walking up to its own manifest. */
export function packageRootOf(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === name) return dir
    }
    dir = dirname(dir)
  }
  throw new Error(`cannot locate the installed package ${name}`)
}

/**
 * The extra-provider route ids, read out of the seed catalog module. The array
 * literal is plain JSON, so slicing it out keeps one source of truth instead of
 * a second hand-maintained id list that could drift.
 */
export function readProviders(root = repoRoot) {
  const source = readFileSync(join(root, 'src/providers.ts'), 'utf8')
  const start = source.indexOf('deepFreeze([\n')
  const end = source.indexOf('\n])', start)
  if (start < 0 || end < 0) throw new Error('cannot find the EXTRA_PROVIDERS array in src/providers.ts')
  return JSON.parse(source.slice(start + 'deepFreeze('.length, end + 2)).map(provider => ({
    id: provider.id,
    api: provider.api,
  }))
}

/** The extra-provider route ids, in declaration order. */
export function readProviderIds(root = repoRoot) {
  return readProviders(root).map(provider => provider.id)
}

/**
 * Per route, the catalog model ids whose entry accepts image input.
 * @param {object} catalog - the opened pinned catalog (`openModelCatalog`).
 * @param {readonly string[]} providerIds - the extra-provider route ids.
 */
export function buildImageIndex(catalog, providerIds) {
  const index = {}
  for (const providerId of [...providerIds].sort()) {
    const rows = getCatalogProvider(catalog, providerId)
    if (rows === null || typeof rows !== 'object') continue
    index[providerId] = Object.values(rows)
      .filter(row => Array.isArray(row.input) && row.input.includes('image'))
      .map(row => row.id)
      .sort()
  }
  return index
}

/** DSH's accepted thinking levels, in the order its selector shows them. */
export const DSH_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The reasoning declaration one catalog row contributes, or `undefined` when the
 * pin describes no ladder this route can dispatch.
 *
 * - `effort` mode on an `openai-completions`/`openai-responses` route: the
 *   catalog's efforts, each with its own `effortMap` wire value (the catalog's
 *   spelling wins over the level name). `off: null` is added only when the model
 *   does not require an effort, because "send nothing" is a supported level and
 *   a required-effort model would reject it — or answer with its own default.
 * - `anthropic-adaptive` mode on an `anthropic-messages` route: the same level
 *   set with the **level name** as the wire value. omp's `effortMap` values of
 *   `"adaptive"` are its own tag-only spelling, not request values: DSH sends
 *   the level itself as `output_config.effort`. `off` is never declared (the
 *   documented endpoint rejects `thinking.type: "disabled"`), and the route needs
 *   `compat.forceAdaptiveThinking` for these levels to dispatch at all.
 * - Every other mode (`budget`, or a route mode the catalog does not model), a
 *   filtered-empty ladder, and a route the pin does not describe: absent.
 *
 * @param {string} routeApi - the extra provider's declared api.
 * @param {object} row - one decoded catalog row.
 * @returns {{ efforts: Record<string, string | null>, adaptive?: true } | undefined}
 */
export function reasoningDeclaration(routeApi, row) {
  const thinking = row.thinking
  if (thinking === null || typeof thinking !== 'object') return undefined
  const efforts = Array.isArray(thinking.efforts)
    ? DSH_THINKING_LEVELS.filter(level => level !== 'off' && thinking.efforts.includes(level))
    : []
  if (efforts.length === 0) return undefined
  if (thinking.mode === 'effort' && (routeApi === 'openai-completions' || routeApi === 'openai-responses')) {
    const wire = thinking.effortMap ?? {}
    const declared = {}
    // `off` first, so the rendered ladder reads in DSH's own order.
    if (thinking.requiresEffort !== true) declared.off = null
    for (const level of efforts) declared[level] = typeof wire[level] === 'string' ? wire[level] : level
    return { efforts: declared }
  }
  if (thinking.mode === 'anthropic-adaptive' && routeApi === 'anthropic-messages') {
    const declared = {}
    for (const level of efforts) declared[level] = level
    return { efforts: declared, adaptive: true }
  }
  return undefined
}

/**
 * Per route and model id (both sorted), the reasoning declaration to install.
 * @param {object} catalog - the opened pinned catalog.
 * @param {readonly { id: string, api: string }[]} providers - the extra routes.
 */
export function buildReasoningIndex(catalog, providers) {
  const index = {}
  for (const provider of [...providers].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    const rows = getCatalogProvider(catalog, provider.id)
    if (rows === null || typeof rows !== 'object') continue
    const route = {}
    for (const id of Object.keys(rows).sort()) {
      const declared = reasoningDeclaration(provider.api, rows[id])
      if (declared !== undefined) route[id] = declared
    }
    if (Object.keys(route).length > 0) index[provider.id] = route
  }
  return index
}

/** Render the committed module. Pure: the same indexes always produce the same bytes. */
export function renderCapabilitiesSource(imageIndex, reasoningIndex, provenance) {
  const lines = [
    '/**',
    ' * Generated by scripts/generate-extra-capabilities.mjs — do not edit by hand;',
    ' * run `pnpm run generate:capabilities` after bumping @oh-my-pi/pi-catalog.',
    ' *',
    ` * Source: @oh-my-pi/pi-catalog@${provenance.version} src/models.json (sha256:${provenance.hash}).`,
    ' *',
    ' * Two indexes over the same pin, both keyed by extra-provider route.',
    ' *',
    ' * {@link EXTRA_IMAGE_MODELS}: the model ids the pinned catalog marks',
    ' * image-capable. A route the catalog does not describe is absent: the pin has',
    ' * no answer for it, so its rows keep the modality the seed catalog gives them.',
    ' *',
    ' * {@link EXTRA_REASONING_EFFORTS}: the thinking ladder to declare on a row,',
    ' * with the wire value of each DSH level. Only the rows a catalog rule models',
    ' * are listed; every other row stays non-reasoning rather than guessed at.',
    ' */',
    '',
    '/**',
    ' * One row\'s reasoning declaration.',
    ' */',
    'export interface ExtraReasoningRow {',
    '  /** Wire value per offered DSH thinking level; only `off` may be null. */',
    '  efforts: Readonly<Record<string, string | null>>',
    '  /** The route needs `compat.forceAdaptiveThinking` for these efforts to dispatch. */',
    '  adaptive?: true',
    '}',
    '',
    'export const EXTRA_IMAGE_MODELS: Readonly<Record<string, readonly string[]>> = {',
  ]
  for (const providerId of Object.keys(imageIndex).sort()) {
    lines.push(`  ${JSON.stringify(providerId)}: [`)
    for (const id of imageIndex[providerId]) lines.push(`    ${JSON.stringify(id)},`)
    lines.push('  ],')
  }
  lines.push('}', '')
  lines.push('export const EXTRA_REASONING_EFFORTS: Readonly<')
  lines.push('  Record<string, Readonly<Record<string, ExtraReasoningRow>>>')
  lines.push('> = {')
  for (const providerId of Object.keys(reasoningIndex).sort()) {
    lines.push(`  ${JSON.stringify(providerId)}: {`)
    for (const id of Object.keys(reasoningIndex[providerId]).sort()) {
      const row = reasoningIndex[providerId][id]
      const efforts = Object.keys(row.efforts)
        .map(level => `${JSON.stringify(level)}: ${JSON.stringify(row.efforts[level])}`)
        .join(', ')
      lines.push(`    ${JSON.stringify(id)}: {`)
      lines.push(`      efforts: { ${efforts} },`)
      if (row.adaptive === true) lines.push('      adaptive: true,')
      lines.push('    },')
    }
    lines.push('  },')
  }
  lines.push('}', '')
  return lines.join('\n')
}

/** The full committed source for one installed catalog and one route list. */
export function generateCapabilitiesSource(catalogRoot, providers) {
  const manifest = JSON.parse(readFileSync(join(catalogRoot, 'package.json'), 'utf8'))
  const bytes = readFileSync(join(catalogRoot, 'src/models.json'))
  const catalog = openModelCatalog(JSON.parse(bytes.toString('utf8')))
  return renderCapabilitiesSource(
    buildImageIndex(catalog, providers.map(provider => provider.id)),
    buildReasoningIndex(catalog, providers),
    { version: manifest.version, hash: createHash('sha256').update(bytes).digest('hex') },
  )
}

function main() {
  const catalogRoot = packageRootOf('@oh-my-pi/pi-catalog')
  const source = generateCapabilitiesSource(catalogRoot, readProviders())
  writeFileSync(join(repoRoot, 'src/extra-capabilities.generated.ts'), source, 'utf8')
  console.log(`wrote src/extra-capabilities.generated.ts (${source.length} bytes)`)
}

/**
 * Whether this module is the entry point of the running process. Compared by
 * real path, not by string: a symlinked checkout runs `argv[1]` through a
 * different path than `import.meta.url`.
 */
function isDirectExecution() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Importing the module (tests) must not write the generated file.
if (isDirectExecution()) main()
