/**
 * Generated GitLab Duo agent model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.12.3` `src/models.json` key
 * `gitlab-duo-agent` (1 row, sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c). Regenerate with
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
  version: '18.12.3',
  file: 'src/models.json',
  key: 'gitlab-duo-agent',
  sourceHash: 'sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c',
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
