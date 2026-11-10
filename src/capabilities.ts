/**
 * Input modalities for the extra-provider model rows.
 *
 * DSH's remote model discovery reports no input modalities for a route its
 * bundled catalog does not ship — which is every extra provider — so a profile
 * written from that answer makes even an image model look text-only. The pinned
 * omp catalog does know, so {@link EXTRA_IMAGE_MODELS} decides: a row whose id
 * is listed is `text + image`, everything else is text.
 *
 * @module dsh-keys-manager/capabilities
 */
import type { ModelRecord } from './domain.js'
import { EXTRA_IMAGE_MODELS } from './extra-capabilities.generated.js'
import { EXTRA_PROVIDER_MAP } from './providers.js'

const TEXT_INPUT = ['text'] as const
const TEXT_IMAGE_INPUT = ['text', 'image'] as const

/**
 * The image-capable ids of one extra route: `[]` when the pin describes the
 * route with no image model, `undefined` when the route is not an extra one
 * (the installed DSH catalog answers for its own routes, not this index).
 */
function imageIds(providerId: string): readonly string[] | undefined {
  if (!EXTRA_PROVIDER_MAP.has(providerId)) return undefined
  return EXTRA_IMAGE_MODELS[providerId] ?? []
}

/**
 * Fill the modalities of a discovery answer before it is written to a profile:
 * a discovered modality list always wins (DSH knows its own bundled routes),
 * an indexed id gets `text + image`, and every other row is plain text.
 */
export function mergeModelCapabilities(providerId: string, models: readonly ModelRecord[]): ModelRecord[] {
  const image = imageIds(providerId)
  if (image === undefined) return [...models]
  const imageSet = new Set(image)
  return models.map(model => model.input !== undefined
    ? model
    : { ...model, input: imageSet.has(model.id) ? [...TEXT_IMAGE_INPUT] : [...TEXT_INPUT] })
}

/**
 * Fill the image capability the index knows into rows of a profile this
 * manager wrote before the index existed. Only a row the pin marks image and
 * that carries no `input` at all changes; every other row is returned as it is,
 * so a repaired profile is byte-identical except for those rows.
 * `undefined` means there is nothing to repair and nothing to write.
 */
export function repairImageModalities(providerId: string, models: readonly ModelRecord[]): ModelRecord[] | undefined {
  const image = imageIds(providerId)
  if (image === undefined) return undefined
  const imageSet = new Set(image)
  let repaired = false
  const rows = models.map(model => {
    if (model.input !== undefined || !imageSet.has(model.id)) return model
    repaired = true
    return { ...model, input: [...TEXT_IMAGE_INPUT] }
  })
  return repaired ? rows : undefined
}
