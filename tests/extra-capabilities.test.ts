/**
 * Extra-provider capabilities: the committed image and reasoning indexes, the
 * merge into a discovery or seed answer, the installed-profile repair, and both
 * indexes' agreement with the pinned catalog and the seed rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeModelCapabilities, repairModelCapabilities, sanitizeReasoningEfforts } from '../src/capabilities'
import type { ModelRecord } from '../src/domain'
import { EXTRA_IMAGE_MODELS, EXTRA_REASONING_EFFORTS } from '../src/extra-capabilities.generated'
import { EXTRA_PROVIDERS } from '../src/providers'
// @ts-ignore — scripts/generate-extra-capabilities.mjs is plain Node ESM without type declarations.
import {
  DSH_THINKING_LEVELS,
  generateCapabilitiesSource,
  packageRootOf,
  readProviderIds,
  readProviders,
} from '../scripts/generate-extra-capabilities.mjs'
// @ts-ignore — scripts/model-catalog-format.mjs is plain Node ESM without type declarations.
import { encodeModelCatalog, getCatalogProviders, getCatalogProvider, openModelCatalog } from '../scripts/model-catalog-format.mjs'

interface CatalogRow {
  id: string
  input?: string[]
  thinking?: { mode: string; efforts?: string[] }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const catalogRoot = packageRootOf('@oh-my-pi/pi-catalog')
const modelsBytes = readFileSync(join(catalogRoot, 'src/models.json'))
/** The installed pin's catalog, opened through the ported opener. */
const catalog = openModelCatalog(JSON.parse(modelsBytes.toString('utf8')))

/** One route's decoded rows; `{}` for a provider the pin does not describe. */
function rowsOf(providerId: string): Record<string, CatalogRow> {
  return (getCatalogProvider(catalog, providerId) ?? {}) as Record<string, CatalogRow>
}

describe('mergeModelCapabilities', () => {
  it('marks a discovered id the catalog knows as image-capable', () => {
    const merged = mergeModelCapabilities('ollama-cloud', [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }])

    expect(merged).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      },
    ])
  })

  it('declares the catalog effort ladder on an indexed row', () => {
    const [row] = mergeModelCapabilities('ollama-cloud', [{ id: 'beam' }])

    expect(row.input).toEqual(['text'])
    expect(row.reasoningEfforts).toEqual({ off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' })
  })

  it('declares an adaptive ladder with the level as the wire value and forces adaptive thinking', () => {
    // MiniMax's Anthropic-compatible endpoint dispatches these levels only as
    // `thinking:{type:"adaptive"}` + `output_config:{effort}`, so the row needs the
    // compat flag as well as the dict.
    const [row] = mergeModelCapabilities('minimax-code-cn', [{ id: 'MiniMax-M2.7' }])

    expect(row.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high' })
    expect(row.compat).toEqual({ forceAdaptiveThinking: true })
  })

  it('adds the adaptive flag to a row that declares its own ladder', () => {
    // The flag is a route fact, not a property of the ladder: a row that brought
    // its own levels still dispatches on DSH's budget path without it.
    const declared = { low: 'low' }
    const [row] = mergeModelCapabilities('minimax-code-cn', [{ id: 'MiniMax-M2.7', reasoningEfforts: declared }])

    expect(row.reasoningEfforts).toBe(declared)
    expect(row.compat).toEqual({ forceAdaptiveThinking: true })
  })

  it('never overrides a compat field the row already sets', () => {
    const [row] = mergeModelCapabilities('minimax-code-cn', [
      { id: 'MiniMax-M2.7', compat: { forceAdaptiveThinking: false } },
    ])

    expect(row.compat).toEqual({ forceAdaptiveThinking: false })
  })

  it('merges the adaptive flag into a compat the row already carries', () => {
    const [row] = mergeModelCapabilities('minimax-code-cn', [{ id: 'MiniMax-M2.7', compat: { keep: 'me' } }])

    expect(row.compat).toEqual({ keep: 'me', forceAdaptiveThinking: true })
  })

  it('keeps a declaration the row already carries', () => {
    const declared = { low: 'low' }
    const [row] = mergeModelCapabilities('ollama-cloud', [{ id: 'beam', reasoningEfforts: declared }])

    expect(row.reasoningEfforts).toBe(declared)
  })

  it('leaves a row the index does not describe alone', () => {
    // `umans-coder` is a `budget`-mode row: no DSH level maps onto it.
    const [budget] = mergeModelCapabilities('umans', [{ id: 'umans-coder' }])

    expect(budget.reasoningEfforts).toBeUndefined()
    expect(budget.compat).toBeUndefined()
  })

  it('leaves an id the catalog marks text-only as text', () => {
    const [row] = mergeModelCapabilities('ollama-cloud', [{ id: 'beam' }])

    expect(row.input).toEqual(['text'])
  })

  it('keeps the modalities discovery already reported', () => {
    const [row] = mergeModelCapabilities('ollama-cloud', [{ id: 'deepseek-v4.1-flash', input: ['text'] }])

    expect(row.input).toEqual(['text'])
  })

  it('defaults every row of an extra route the pin does not describe to text', () => {
    // siliconflow has no row in the pinned catalog: nothing there can be image.
    const [row] = mergeModelCapabilities('siliconflow', [{ id: 'some/vision-model' }])

    expect(row.input).toEqual(['text'])
    expect(row.reasoningEfforts).toBeUndefined()
  })

  it('leaves a route outside the extra catalog untouched', () => {
    const rows: ModelRecord[] = [{ id: 'discovered-chat' }]

    expect(mergeModelCapabilities('zai-coding-cn', rows)).toEqual(rows)
  })
})

describe('repairModelCapabilities', () => {
  it('fills a missing modality and a missing ladder on the rows the catalog describes', () => {
    const repaired = repairModelCapabilities('ollama-cloud', [
      { id: 'deepseek-v4.1-flash', name: 'Flash' },
      { id: 'beam', name: 'Beam' },
      { id: 'deepseek-v4.1-flash:1017', input: ['text'] },
    ])

    expect(repaired).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        name: 'Flash',
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      },
      // A text row the repair has no modality claim on keeps its shape, but the
      // catalog's ladder still lands on it.
      { id: 'beam', name: 'Beam', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' } },
      { id: 'deepseek-v4.1-flash:1017', input: ['text'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    ])
  })

  it('reports nothing to repair once every indexed row is filled', () => {
    const rows: ModelRecord[] = [
      { id: 'deepseek-v4.1-flash', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'beam', reasoningEfforts: { off: null, low: 'low' } },
      { id: 'not-in-the-catalog' },
    ]

    expect(repairModelCapabilities('ollama-cloud', rows)).toBeUndefined()
  })

  it('leaves a route outside the extra catalog alone', () => {
    expect(repairModelCapabilities('zai-coding-cn', [{ id: 'deepseek-v4.1-flash' }])).toBeUndefined()
  })
})

describe('extra reasoning index', () => {
  it('declares an effort row with the catalog wire value and a null off', () => {
    expect(EXTRA_REASONING_EFFORTS['ollama-cloud']?.['beam']).toEqual({
      efforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
    })
  })

  it('takes the wire value from the catalog effortMap, not from the level name', () => {
    const row = EXTRA_REASONING_EFFORTS['abliteration']?.['abliterated-model-large-v2']

    // The catalog maps `medium` onto `high` and `xhigh` onto `max`.
    expect(row?.efforts).toEqual({ low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' })
    // `requiresEffort`: the model refuses "send nothing", so no `off` level.
    expect(row?.efforts.off).toBeUndefined()
  })

  it('declares an adaptive ladder with the level as the wire value and no off', () => {
    expect(EXTRA_REASONING_EFFORTS['minimax-code-cn']?.['MiniMax-M2.7']).toEqual({
      efforts: { low: 'low', medium: 'medium', high: 'high' },
      adaptive: true,
    })
  })

  it('skips a budget row and a route the pin does not describe', () => {
    expect(EXTRA_REASONING_EFFORTS['umans']?.['umans-coder']).toBeUndefined()
    expect(EXTRA_REASONING_EFFORTS['litellm']).toBeUndefined()
  })

  it('agrees with the decoded catalog for every route and row it lists', () => {
    const routeApi = new Map(EXTRA_PROVIDERS.map(provider => [provider.id, provider.api]))
    for (const [providerId, rows] of Object.entries(EXTRA_REASONING_EFFORTS)) {
      const api = routeApi.get(providerId)
      // Only an extra route can be described: the index is built from that list.
      expect(api, providerId).toBeDefined()
      for (const [id, row] of Object.entries(rows)) {
        const thinking = rowsOf(providerId)[id]?.thinking
        expect(thinking, `${providerId}/${id}`).toBeDefined()
        const adaptive = thinking?.mode === 'anthropic-adaptive'
        expect(api === 'anthropic-messages', `${providerId}/${id}`).toBe(adaptive)
        expect(thinking?.mode === 'effort' || adaptive, `${providerId}/${id}`).toBe(true)
        // Only `off` may map to null, and an adaptive row never declares it.
        for (const [level, wire] of Object.entries(row.efforts)) {
          expect(DSH_THINKING_LEVELS, `${providerId}/${id} ${level}`).toContain(level)
          if (wire === null) expect(level, `${providerId}/${id}`).toBe('off')
          else expect(wire.length > 0, `${providerId}/${id} ${level}`).toBe(true)
        }
        if (adaptive) expect(row.efforts.off, `${providerId}/${id}`).toBeUndefined()
        expect(row.adaptive === true, `${providerId}/${id}`).toBe(adaptive)
      }
    }
  })
})

describe('generated capability index', () => {
  it('reads the extra route ids out of the seed catalog', () => {
    expect(readProviderIds()).toEqual(EXTRA_PROVIDERS.map(provider => provider.id))
  })

  it('regenerates byte-identically from the pinned catalog', () => {
    const committed = readFileSync(join(repoRoot, 'src/extra-capabilities.generated.ts'), 'utf8')
    const providers = readProviders()

    expect(generateCapabilitiesSource(catalogRoot, providers)).toBe(committed)
    // Determinism is the property, not only today's bytes.
    expect(generateCapabilitiesSource(catalogRoot, providers))
      .toBe(generateCapabilitiesSource(catalogRoot, providers))
  })

  it('lists only ids the pin marks image, sorted', () => {
    for (const [providerId, ids] of Object.entries(EXTRA_IMAGE_MODELS)) {
      expect(ids).toEqual([...ids].sort())
      for (const id of ids) expect(rowsOf(providerId)[id]?.input).toContain('image')
    }
  })

  it('agrees with every seed row the pin describes', () => {
    for (const provider of EXTRA_PROVIDERS) {
      const index = EXTRA_IMAGE_MODELS[provider.id] ?? []
      const pinned = rowsOf(provider.id)
      for (const model of provider.models) {
        // A row the pin does not describe keeps its curated modality: the
        // index cannot speak for an id the catalog has never seen.
        if (pinned[model.id] === undefined) continue
        const catalogImage = (pinned[model.id].input ?? []).includes('image')
        expect(model.input?.includes('image') ?? false, `${provider.id}/${model.id}`).toBe(catalogImage)
        expect(index.includes(model.id), `${provider.id}/${model.id}`).toBe(catalogImage)
      }
    }
  })
})
describe('compact catalog codec', () => {
  it('decodes an encoded catalog back to the rows it was given', () => {
    // One shape per encoding feature: a boolean (carried in a shape mask), a
    // nested object and array (interned and shared), and a second row whose
    // `compat` differs from the api's common one by a delta.
    const models = {
      demo: {
        'model-a': {
          id: 'model-a',
          name: 'Demo A',
          contextWindow: 128000,
          input: ['text', 'image'],
          reasoning: true,
          streaming: false,
          compat: { supportsParallelToolCalls: true, trustExplicitThinkingOnly: false },
          nested: { efforts: ['low', 'high'], routing: { low: 'a' } },
        },
        'model-b': {
          id: 'model-b',
          name: 'Demo A',
          contextWindow: 128000,
          input: ['text'],
          reasoning: false,
          streaming: false,
          compat: { supportsParallelToolCalls: false },
          nested: { efforts: ['low'], routing: { low: 'a' } },
        },
      },
    }

    const reopened = openModelCatalog(JSON.parse(encodeModelCatalog(models)))

    expect(getCatalogProviders(reopened)).toEqual(['demo'])
    expect(getCatalogProvider(reopened, 'demo')).toEqual(models.demo)
    expect(getCatalogProvider(reopened, 'absent')).toBeUndefined()
  })

  it('is deterministic and refuses a catalog that is not version 1', () => {
    const models = { demo: { 'model-a': { id: 'model-a', name: 'A', input: ['text'] } } }

    expect(encodeModelCatalog(models)).toBe(encodeModelCatalog(models))
    expect(() => openModelCatalog({ version: 2 })).toThrow(/Unsupported model catalog version/)
  })

  it('decodes the installed pin into the rows the index is built from', () => {
    // A row whose thinking ladder Task 2 indexes, and one image row: both are
    // only reachable through the opener, so a decode regression fails here
    // instead of silently emptying the generated index.
    expect(rowsOf('minimax-code-cn')['MiniMax-M2.7']?.thinking).toMatchObject({
      mode: 'anthropic-adaptive',
      efforts: ['low', 'medium', 'high'],
    })
    expect(rowsOf('openrouter')['alibaba/happyhorse-1.0']?.input).toEqual(['text', 'image'])
    // And the committed index agrees with those same decoded rows.
    expect(EXTRA_IMAGE_MODELS.aiand).toContain('moonshotai/kimi-k2.6')
    expect(rowsOf('aiand')['moonshotai/kimi-k2.6']?.input).toContain('image')
  })
})

describe('sanitizeReasoningEfforts', () => {
  it('keeps the levels and wire values DSH accepts', () => {
    expect(sanitizeReasoningEfforts({ off: null, low: 'low', high: 'high' })).toEqual({ off: null, low: 'low', high: 'high' })
  })

  it('drops keys DSH does not read and values it refuses', () => {
    // A level outside DSH's seven, a non-string value, a null on a level other
    // than `off`, and an empty wire string are all refused by the seam.
    expect(sanitizeReasoningEfforts({ low: 'low', turbo: 'turbo', medium: 3, high: null, xhigh: '' })).toEqual({ low: 'low' })
  })

  it('drops a declaration that offers no level beyond off', () => {
    // DSH refuses a dict whose only level is `off`, so the gate drops it whole
    // instead of writing a field the seam would reject.
    expect(sanitizeReasoningEfforts({ off: null })).toBeUndefined()
    expect(sanitizeReasoningEfforts({})).toBeUndefined()
    expect(sanitizeReasoningEfforts(null)).toBeUndefined()
    expect(sanitizeReasoningEfforts(['low'])).toBeUndefined()
  })
})
