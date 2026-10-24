/**
 * Generate the committed model tables for the omp-backed routes from the pinned
 * omp catalog.
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
 * `requiresCursorToolSchemaProjection`, `compat`, `cost`). `cost` is not shown
 * by DSH, but the transport prices the turn from it and fails without it.
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
const catalogVersion = JSON.parse(readFileSync(join(catalogRoot, 'package.json'), 'utf8')).version

/** One pinned source file: parsed data plus the hash the generated provenance records. */
const sources = new Map()
function source(file) {
  if (!sources.has(file)) {
    const bytes = readFileSync(join(catalogRoot, file))
    sources.set(file, {
      data: JSON.parse(bytes.toString('utf8')),
      hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })
  }
  return sources.get(file)
}

/** The compiled compat registry (`rules.json`), read once. */
let rulesCache
function rules() {
  rulesCache ??= source('src/compat/rules.json').data
  return rulesCache
}

/** The four per-million prices omp prices a turn with. */
function reduceCost(cost) {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  }
}

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
    cost: reduceCost(row.cost),
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
    cost: reduceCost(row.cost),
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
 * Reduce one Google catalog row (both Cloud Code Assist routes).
 *
 * `compat` is copied whole: the transport reads twelve members of it
 * (`dropUnsignedThinking`, `supportsFunctionPartId`, `ccaLegacyParametersSchema`,
 * `maxImageDimension`, `antigravityUsageLabel`, …) and the flags are the
 * per-model wire decision. `identity` decides the wire family (anthropic vs
 * gemini) and the thinking metadata decides the `thinkingConfig` route, so both
 * are load-bearing rather than descriptive.
 *
 * @param row - one `models.json` Google row.
 * @returns the generated row.
 */
function reduceGoogle(row) {
  const out = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: [...row.input],
    cost: reduceCost(row.cost),
    reasoning: row.reasoning === true,
    identity: {
      class: row.identity.class,
      family: row.identity.family,
      revision: row.identity.revision,
    },
    compat: { ...row.compat },
  }
  if (row.thinking) {
    out.thinking = {
      mode: row.thinking.mode,
      efforts: [...(row.thinking.efforts ?? [])],
      ...(row.thinking.effortRouting ? { effortRouting: { ...row.thinking.effortRouting } } : {}),
    }
    // Read by omp's shared stream wrapper when it picks a thinkingConfig:
    // mandatory-reasoning endpoints, off-suppression and per-effort budgets.
    for (const flag of ['requiresEffort', 'suppressWhenOff', 'prefixBinding']) {
      if (row.thinking[flag]) out.thinking[flag] = true
    }
    if (row.thinking.effortBudgets) out.thinking.effortBudgets = { ...row.thinking.effortBudgets }
  }
  if (row.requestModelId !== undefined) out.requestModelId = row.requestModelId
  return out
}

/**
 * Reduce one Factory Droid row from the KDL registry's provider seed.
 *
 * The pinned `models.json` has no `factory-droid` key at all: this provider's
 * models are declared by its compat rule (`providers.\`factory-droid\`.seed.models`,
 * 62 rows at this pin). The row is carried as the rule declares it — the
 * transport multiplexes by model id, dispatches on `api`/`provider`, and prices
 * every row at zero Factory credits, so there is nothing to reduce away.
 *
 * @param row - one `seed.models` entry.
 * @returns the generated row.
 */
function reduceFactoryDroid(row) {
  return {
    id: row.id,
    name: row.name,
    api: row.api,
    provider: row.provider,
    // No `baseUrl`: the transport derives the per-wire proxy path (and the
    // residency host) from the wire it resolved; a host-only seed URL would send
    // every wire to the bare host, a divergence from the pinned full build.
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: [...row.input],
    cost: reduceCost(row.cost),
    reasoning: row.reasoning === true,
  }
}

/**
 * The Duo proxy's alias → upstream id table, read from the pin's
 * `provider-models/special.ts`.
 *
 * The table is a TypeScript literal (not JSON), and it is *deployment identity*,
 * not model metadata: the proxy serves these upstream ids whatever the catalog
 * calls the row. It is parsed here rather than hand-tracked so a pin bump that
 * renames an upstream fails the manifest's source hash and this table together.
 *
 * @returns alias → upstream model id.
 */
function gitlabDuoAliases() {
  const text = readFileSync(join(catalogRoot, 'src/provider-models/special.ts'), 'utf8')
  const start = text.indexOf('const GITLAB_DUO_MODEL_IDENTITIES')
  if (start === -1) throw new Error('llm-omp: the pin has no GITLAB_DUO_MODEL_IDENTITIES table')
  const block = text.slice(start, text.indexOf('\n};', start))
  const aliases = new Map()
  for (const match of block.matchAll(/"([^"]+)":\s*\{[^}]*?upstreamModelId:\s*"([^"]+)"/g)) {
    aliases.set(match[1], match[2])
  }
  if (aliases.size === 0) throw new Error('llm-omp: the Duo alias table parsed empty')
  return aliases
}

/**
 * The wire one Duo row routes to, from the compiled `api-routes` registry.
 *
 * Mirrors omp's `apiRouteFor`: the first route whose `prefix`/`exact` match list
 * contains the id wins, and the provider's `default` applies otherwise. A row
 * whose id matches nothing and whose provider has no default is a hard error —
 * the transport would refuse the request, so the catalog must not ship it.
 *
 * @param id - the catalog row id (the alias the proxy serves).
 * @returns the wire protocol.
 */
function gitlabDuoApiRoute(id) {
  const entry = (rules().behavior?.apiRoutes ?? []).find(candidate => candidate.provider === 'gitlab-duo')
  if (entry === undefined) throw new Error('llm-omp: the pin declares no gitlab-duo api-routes')
  for (const route of entry.routes ?? []) {
    const { prefix = [], exact = [] } = route.match ?? {}
    if (exact.includes(id) || prefix.some(candidate => id.startsWith(candidate))) return route.api
  }
  if (typeof entry.default === 'string') return entry.default
  throw new Error(`llm-omp: no Duo api route for ${id}`)
}

/**
 * Reduce one GitLab Duo **proxy** row.
 *
 * The row is a proxy alias: its `api`/`provider` are the route, `upstreamModelId`
 * is what the proxy expects on the wire (the transport substitutes it) and
 * `apiRoute` picks the generic transport. `compat` is copied whole — the
 * transport hands it to `buildModel` as `compatConfig` and the inner transport
 * re-reads its flags — and the rest is the metadata the seam advertises.
 *
 * @param row - one `models.json` `gitlab-duo` row.
 * @param aliases - the alias → upstream id table.
 * @returns the generated row.
 */
function reduceGitLabDuo(row, aliases) {
  const out = {
    id: row.id,
    name: row.name,
    api: 'gitlab-duo',
    provider: 'gitlab-duo',
    // A bare upstream id resolves to itself: the reverse lookup in the pin maps
    // it onto the alias that names the same upstream.
    upstreamModelId: aliases.get(row.id) ?? row.id,
    apiRoute: gitlabDuoApiRoute(row.id),
    baseUrl: row.baseUrl,
    contextWindow: row.contextWindow,
    input: [...row.input],
    cost: reduceCost(row.cost),
    reasoning: row.reasoning === true,
    compat: { ...row.compat },
  }
  if (typeof row.maxTokens === 'number') out.maxTokens = row.maxTokens
  return out
}

/**
 * Reduce one GitLab Duo **agent** row.
 *
 * The roster is the single static row its pinned catalog declares; the live
 * GraphQL discovery is a non-goal, so nothing is fetched at build time. The row's
 * `maxTokens` is `null` in the pin (this model omits the field), so an absent cap
 * is carried as absent rather than as a sentinel number.
 *
 * @param row - one `models.json` `gitlab-duo-agent` row.
 * @returns the generated row.
 */
function reduceGitLabDuoAgent(row) {
  const out = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    contextWindow: row.contextWindow,
    input: [...row.input],
    cost: reduceCost(row.cost),
    reasoning: row.reasoning === true,
  }
  if (typeof row.maxTokens === 'number') out.maxTokens = row.maxTokens
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
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
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
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
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
  {
    key: 'google-gemini-cli',
    out: join(packageRoot, 'src', 'catalog', 'google-gemini-cli.ts'),
    constName: 'GOOGLE_GEMINI_CLI_MODELS',
    sourceConst: 'GOOGLE_GEMINI_CLI_CATALOG_SOURCE',
    rowType: 'GoogleModelRow',
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
    summary: 'Every Gemini CLI model the pinned catalog serves, sorted by id.',
    reduce: reduceGoogle,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated Gemini CLI model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key \`google-gemini-cli\`
 * (${rowCount} rows, ${sourceHash}). Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The drift gate in \`tests/build-google.test.ts\` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Both Google routes share the generated row shape because they share one
 * bundled transport; \`identity.class\` decides the wire family and \`compat\`
 * carries the per-model wire flags whole.
 *
 * @module dsh-llm-omp-transports/catalog/google-gemini-cli
 */`,
  },
  {
    key: 'gitlab-duo',
    out: join(packageRoot, 'src', 'catalog', 'gitlab-duo.ts'),
    constName: 'GITLAB_DUO_MODELS',
    sourceConst: 'GITLAB_DUO_CATALOG_SOURCE',
    rowType: 'GitLabDuoModelRow',
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
    summary: 'Every GitLab Duo proxy row the pinned catalog serves, sorted by id.',
    reduce: (row, provider) => reduceGitLabDuo(row, provider?.aliases ?? gitlabDuoAliases()),
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated GitLab Duo proxy model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key
 * \`gitlab-duo\` (${rowCount} rows, ${sourceHash}), plus the alias → upstream id
 * table parsed from \`src/provider-models/special.ts\` and the wire per row from
 * \`src/compat/rules.json\` \`behavior.apiRoutes\`. Regenerate with
 * \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The route is a proxy: \`upstreamModelId\` is what GitLab's gateway expects on
 * the wire (the transport substitutes it for the row id), \`apiRoute\` selects one
 * of the three generic transports, and \`compat\` travels whole because the
 * transport hands it to \`buildModel\` and the inner transport re-reads it.
 *
 * The drift gate in \`tests/build-gitlab.test.ts\` pins the catalog source hash, the
 * alias-table source hash and every row's wire, so an omp bump that renames an
 * upstream or reroutes a row fails before the table describes the wrong proxy.
 *
 * @module dsh-llm-omp-transports/catalog/gitlab-duo
 */`,
  },
  {
    key: 'gitlab-duo-agent',
    out: join(packageRoot, 'src', 'catalog', 'gitlab-duo-agent.ts'),
    constName: 'GITLAB_DUO_AGENT_MODELS',
    sourceConst: 'GITLAB_DUO_AGENT_CATALOG_SOURCE',
    rowType: 'GitLabDuoAgentModelRow',
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
    summary: 'The one static GitLab Duo agent model the pinned catalog declares.',
    reduce: reduceGitLabDuoAgent,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated GitLab Duo agent model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key
 * \`gitlab-duo-agent\` (${rowCount} row, ${sourceHash}). Regenerate with
 * \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The route's live GraphQL discovery is a non-goal for this slice, so the picker
 * offers this one row; the server may still pin another model through
 * \`pinnedModel\`, which is harmless. The drift gate in
 * \`tests/build-gitlab.test.ts\` pins the same package version and source hash.
 *
 * @module dsh-llm-omp-transports/catalog/gitlab-duo-agent
 */`,
  },
  {
    key: 'factory-droid',
    out: join(packageRoot, 'src', 'catalog', 'factory-droid.ts'),
    constName: 'FACTORY_DROID_MODELS',
    sourceConst: 'FACTORY_DROID_CATALOG_SOURCE',
    rowType: 'FactoryDroidModelRow',
    // The seed lives in the KDL registry rule, not in the model catalog.
    sourceFile: 'src/compat/rules.json',
    select: data => data.providers['factory-droid'].seed.models,
    summary: 'Every Factory Droid model the pinned registry seed declares, sorted by id.',
    reduce: reduceFactoryDroid,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated Factory Droid model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/compat/rules.json\`
 * \`providers.factory-droid.seed.models\` (${rowCount} rows, ${sourceHash}).
 * Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The rows live in the KDL compat registry because the pinned \`models.json\`
 * carries no \`factory-droid\` key; the drift gate in
 * \`tests/build-factory-droid.test.ts\` pins the same package version and source
 * hash, so an omp bump fails there before this table can describe the wrong
 * models.
 *
 * Every row is a zero-cost Factory credit, and the route multiplexes four wire
 * protocols by model id, so the table carries the identity fields the wire
 * header and the family dispatch read rather than a reduced subset.
 *
 * @module dsh-llm-omp-transports/catalog/factory-droid
 */`,
  },
  {
    key: 'google-antigravity',
    out: join(packageRoot, 'src', 'catalog', 'google-antigravity.ts'),
    constName: 'GOOGLE_ANTIGRAVITY_MODELS',
    sourceConst: 'GOOGLE_ANTIGRAVITY_CATALOG_SOURCE',
    rowType: 'GoogleModelRow',
    sourceFile: 'src/models.json',
    select: (data, key) => data[key],
    summary: 'Every Antigravity model the pinned catalog serves, sorted by id.',
    reduce: reduceGoogle,
    doc: ({ version, rowCount, sourceHash }) => `/**
 * Generated Antigravity model table — do not edit by hand.
 *
 * Source: \`@oh-my-pi/pi-catalog@${version}\` \`src/models.json\` key \`google-antigravity\`
 * (${rowCount} rows, ${sourceHash}). Regenerate with \`pnpm -C packages/llm-omp run generate:catalog\`.
 *
 * The drift gate in \`tests/build-google.test.ts\` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Rows reach the same bundled transport as the Gemini CLI table; the route is
 * the row's \`provider\`, and \`requestModelId\` routes an effort to its wire id.
 *
 * @module dsh-llm-omp-transports/catalog/google-antigravity
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
  const { data, hash } = source(provider.sourceFile)
  const rows = provider.select(data, provider.key)
  if (rows === undefined || rows === null) {
    throw new Error(`llm-omp: \`${provider.sourceFile}\` has no \`${provider.key}\` models`)
  }

  // The Duo proxy table also needs the pin's alias map; every other reducer
  // ignores the second argument.
  const context = provider.key === 'gitlab-duo' ? { aliases: gitlabDuoAliases() } : undefined
  const reduced = Object.values(rows)
    .map(row => provider.reduce(row, context))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (reduced.length === 0) throw new Error(`llm-omp: the installed catalog has no \`${provider.key}\` models`)
  const body = reduced.map(row => `  ${render(row, '  ')},`).join('\n')

  const key = provider.key
  const file = `${provider.doc({
    version: catalogVersion,
    rowCount: reduced.length,
    sourceHash: hash,
  })}
import type { ${provider.rowType} } from '../omp.js'

/** Provenance of {@link ${provider.constName}}. */
export const ${provider.sourceConst} = {
  package: '@oh-my-pi/pi-catalog',
  version: '${catalogVersion}',
  file: '${provider.sourceFile}',
  key: '${key}',
  sourceHash: '${hash}',
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
    `llm-omp: wrote ${reduced.length} ${provider.key} models from @oh-my-pi/pi-catalog@${catalogVersion} (${hash})`,
  )
  return reduced.length
}

for (const provider of PROVIDERS) generate(provider)
