/**
 * Extra-provider capabilities: the committed image index, the merge into a
 * discovery answer, the installed-profile repair, and the index's agreement
 * with the pinned catalog and the seed rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeModelCapabilities, repairImageModalities } from '../src/capabilities'
import type { ModelRecord } from '../src/domain'
import { EXTRA_IMAGE_MODELS } from '../src/extra-capabilities.generated'
import { EXTRA_PROVIDERS } from '../src/providers'
// @ts-ignore — scripts/generate-extra-capabilities.mjs is plain Node ESM without type declarations.
import { generateCapabilitiesSource, packageRootOf, readProviderIds } from '../scripts/generate-extra-capabilities.mjs'
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

    expect(merged).toEqual([{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', input: ['text', 'image'] }])
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
  })

  it('leaves a route outside the extra catalog untouched', () => {
    const rows: ModelRecord[] = [{ id: 'discovered-chat' }]

    expect(mergeModelCapabilities('zai-coding-cn', rows)).toEqual(rows)
  })
})

describe('repairImageModalities', () => {
  it('fills a missing modality only on a row the catalog marks image', () => {
    const repaired = repairImageModalities('ollama-cloud', [
      { id: 'deepseek-v4.1-flash', name: 'Flash' },
      { id: 'beam', name: 'Beam' },
      { id: 'deepseek-v4.1-flash:1017', input: ['text'] },
    ])

    expect(repaired).toEqual([
      { id: 'deepseek-v4.1-flash', name: 'Flash', input: ['text', 'image'] },
      { id: 'beam', name: 'Beam' },
      { id: 'deepseek-v4.1-flash:1017', input: ['text'] },
    ])
  })

  it('reports nothing to repair once every image row is filled', () => {
    const rows: ModelRecord[] = [
      { id: 'deepseek-v4.1-flash', input: ['text', 'image'] },
      { id: 'beam' },
    ]

    expect(repairImageModalities('ollama-cloud', rows)).toBeUndefined()
  })

  it('leaves a route outside the extra catalog alone', () => {
    expect(repairImageModalities('zai-coding-cn', [{ id: 'deepseek-v4.1-flash' }])).toBeUndefined()
  })
})

describe('generated capability index', () => {
  it('reads the extra route ids out of the seed catalog', () => {
    expect(readProviderIds()).toEqual(EXTRA_PROVIDERS.map(provider => provider.id))
  })

  it('regenerates byte-identically from the pinned catalog', () => {
    const committed = readFileSync(join(repoRoot, 'src/extra-capabilities.generated.ts'), 'utf8')
    const providerIds = readProviderIds()

    expect(generateCapabilitiesSource(catalogRoot, providerIds)).toBe(committed)
    // Determinism is the property, not only today's bytes.
    expect(generateCapabilitiesSource(catalogRoot, providerIds))
      .toBe(generateCapabilitiesSource(catalogRoot, providerIds))
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
