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

interface CatalogRow {
  id: string
  input?: string[]
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const catalogRoot = packageRootOf('@oh-my-pi/pi-catalog')
/** The pinned catalog rows, keyed by route then model id. */
const catalog = JSON.parse(readFileSync(join(catalogRoot, 'src/models.json'), 'utf8')) as Record<string, Record<string, CatalogRow>>

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
      for (const id of ids) expect(catalog[providerId]?.[id]?.input).toContain('image')
    }
  })

  it('agrees with every seed row the pin describes', () => {
    for (const provider of EXTRA_PROVIDERS) {
      const index = EXTRA_IMAGE_MODELS[provider.id] ?? []
      const pinned = catalog[provider.id] ?? {}
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
