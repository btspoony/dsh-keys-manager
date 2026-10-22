/**
 * Generated Devin model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.12.3` `src/models.json` key `devin`
 * (2 rows, sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c). Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The drift gate in `tests/build-devin.test.ts` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Each row carries the resolved `compat` trio and the `reasoning` flag the
 * transport dereferences, and no field the wire never reads.
 *
 * @module dsh-llm-omp-transports/catalog/devin
 */
import type { DevinModelRow } from '../omp.js'

/** Provenance of {@link DEVIN_MODELS}. */
export const DEVIN_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.12.3',
  file: 'src/models.json',
  key: 'devin',
  sourceHash: 'sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c',
  rowCount: 2,
} as const

/** Every Devin model the pinned catalog serves, sorted by id. */
export const DEVIN_MODELS: readonly DevinModelRow[] = [
  {
    "id": "swe-1-6",
    "name": "SWE-1.6",
    "baseUrl": "https://server.codeium.com",
    "contextWindow": 200000,
    "maxTokens": 128000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "compat": {
      "trustExplicitThinkingOnly": true,
      "modelRouter": false,
      "supportsParallelToolCalls": true
    }
  },
  {
    "id": "swe-1-6-fast",
    "name": "SWE-1.6 Fast",
    "baseUrl": "https://server.codeium.com",
    "contextWindow": 200000,
    "maxTokens": 128000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0.3,
      "output": 1.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    },
    "reasoning": true,
    "compat": {
      "trustExplicitThinkingOnly": true,
      "modelRouter": false,
      "supportsParallelToolCalls": true
    }
  },
]
