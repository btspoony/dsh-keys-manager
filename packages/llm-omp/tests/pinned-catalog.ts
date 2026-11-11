/**
 * The installed pin's decoded model catalog, for the drift gates that compare a
 * generated table against the rows it came from.
 *
 * The pin ships its catalog compact-encoded (`version/keys/nodes/compat/
 * providers`), so rows are only reachable through its opener. This is the same
 * port `scripts/generate-catalog.mjs` builds the tables with, imported by the
 * repo-relative path because that script is build tooling, never shipped.
 */
import { readFileSync } from 'node:fs'

// @ts-ignore — scripts/model-catalog-format.mjs is plain Node ESM outside this package.
import { getCatalogProvider, openModelCatalog } from '../../../scripts/model-catalog-format.mjs'

/** An opened catalog handle (`openModelCatalog`). */
export type PinnedCatalog = ReturnType<typeof openModelCatalog>

/** Open the pin's `models.json` at `path`. */
export function openPinnedCatalog(path: string): PinnedCatalog {
  return openModelCatalog(JSON.parse(readFileSync(path, 'utf8')))
}

/** One provider's decoded rows; `{}` when the pin does not describe it. */
export function pinnedRows(catalog: PinnedCatalog, providerId: string): Record<string, unknown> {
  return getCatalogProvider(catalog, providerId) ?? {}
}
