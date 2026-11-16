/**
 * Generated GitLab Duo agent model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.20.3` `src/models.json` key
 * `gitlab-duo-agent` (1 row, sha256:d183025c204d185d1a002fccfc2bd7afd39407c3b96062fa373e56947e1ccdaf). Regenerate with
 * `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The route's live GraphQL discovery is a non-goal for this slice, so the picker
 * offers this one row; the server may still pin another model through
 * `pinnedModel`, which is harmless. The drift gate in
 * `tests/build-gitlab.test.ts` pins the same package version and source hash.
 *
 * @module dsh-llm-omp-transports/catalog/gitlab-duo-agent
 */
import type { GitLabDuoAgentModelRow } from '../omp.js'

/** Provenance of {@link GITLAB_DUO_AGENT_MODELS}. */
export const GITLAB_DUO_AGENT_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.20.3',
  file: 'src/models.json',
  key: 'gitlab-duo-agent',
  sourceHash: 'sha256:d183025c204d185d1a002fccfc2bd7afd39407c3b96062fa373e56947e1ccdaf',
  rowCount: 1,
} as const

/** The one static GitLab Duo agent model the pinned catalog declares. */
export const GITLAB_DUO_AGENT_MODELS: readonly GitLabDuoAgentModelRow[] = [
  {
    "id": "claude_sonnet_4_6_vertex",
    "name": "Claude Sonnet 4.6 - Vertex",
    "baseUrl": "https://gitlab.com",
    "contextWindow": 1000000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": false
  },
]
