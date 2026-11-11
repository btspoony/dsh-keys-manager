/**
 * Capabilities for the extra-provider model rows: input modalities and the
 * thinking ladder.
 *
 * DSH's remote model discovery reports neither, for a route its bundled catalog
 * does not ship — which is every extra provider — so a profile written from that
 * answer makes an image model look text-only and every reasoning model look
 * non-reasoning. The pinned omp catalog knows both, so the generated indexes
 * decide: {@link EXTRA_IMAGE_MODELS} names the image-capable ids and
 * {@link EXTRA_REASONING_EFFORTS} carries the ladder each indexed row declares.
 *
 * @module dsh-keys-manager/capabilities
 */
import type { ModelRecord } from './domain.js'
import { EXTRA_IMAGE_MODELS, EXTRA_REASONING_EFFORTS, type ExtraReasoningRow } from './extra-capabilities.generated.js'
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

/** The reasoning declarations of one extra route, keyed by model id. */
function reasoningRows(providerId: string): Readonly<Record<string, ExtraReasoningRow>> {
  return EXTRA_REASONING_EFFORTS[providerId] ?? {}
}

/**
 * Apply the index to one row, returning the same reference when it already
 * carries everything the pin declares.
 *
 * A declared modality or ladder always wins: discovery knows its own bundled
 * routes, and a profile the user edited is theirs. The ladder is only added to a
 * row that declares none, so an existing `reasoningEfforts` is never rewritten;
 * an adaptive route's `compat` is merged, never replaced.
 *
 * `declareText` is the one difference between the two callers: a discovery or
 * seed answer gets an explicit modality on every row, while a repair leaves a
 * row the pin says nothing about exactly as it was — it must not rewrite a list
 * it has no claim on.
 */
function withCapabilities(
  model: ModelRecord,
  imageSet: ReadonlySet<string>,
  reasoning: Readonly<Record<string, ExtraReasoningRow>>,
  declareText: boolean,
): ModelRecord {
  let next = model
  if (next.input === undefined && (declareText || imageSet.has(next.id))) {
    next = { ...next, input: imageSet.has(next.id) ? [...TEXT_IMAGE_INPUT] : [...TEXT_INPUT] }
  }
  const declared = reasoning[next.id]
  if (declared !== undefined && next.reasoningEfforts === undefined) {
    next = { ...next, reasoningEfforts: { ...declared.efforts } }
    if (declared.adaptive === true) next = { ...next, compat: { ...next.compat, forceAdaptiveThinking: true } }
  }
  return next
}

/**
 * Read a persisted `reasoningEfforts` declaration, keeping only the shapes DSH
 * accepts: a string wire value, or `null` for "supported, send nothing". Both a
 * settings file and the store are hand-editable, so this is the one gate for the
 * field. `undefined` means the row declares nothing.
 */
export function sanitizeReasoningEfforts(raw: unknown): Record<string, string | null> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const declared = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null,
  )
  return declared.length === 0 ? undefined : Object.fromEntries(declared)
}

/**
 * Fill the capabilities of a discovery answer — or of a seed catalog — before it
 * is written to a profile. A row that already declares them keeps them, an
 * indexed row gains what the pin declares, and every other row is returned
 * unchanged (no empty dict, no `false`).
 */
export function mergeModelCapabilities(providerId: string, models: readonly ModelRecord[]): ModelRecord[] {
  const image = imageIds(providerId)
  if (image === undefined) return [...models]
  const imageSet = new Set(image)
  const reasoning = reasoningRows(providerId)
  return models.map(model => withCapabilities(model, imageSet, reasoning, true))
}

/**
 * Fill the capabilities the index knows into rows of a profile this manager
 * wrote before the index existed. Only a row that carries no `input` and no
 * `reasoningEfforts` changes; every other row is returned as it is, so a
 * repaired profile is byte-identical except for those rows. `undefined` means
 * there is nothing to repair and nothing to write.
 */
export function repairModelCapabilities(providerId: string, models: readonly ModelRecord[]): ModelRecord[] | undefined {
  const image = imageIds(providerId)
  if (image === undefined) return undefined
  const imageSet = new Set(image)
  const reasoning = reasoningRows(providerId)
  let repaired = false
  const rows = models.map(model => {
    const next = withCapabilities(model, imageSet, reasoning, false)
    if (next !== model) repaired = true
    return next
  })
  return repaired ? rows : undefined
}
