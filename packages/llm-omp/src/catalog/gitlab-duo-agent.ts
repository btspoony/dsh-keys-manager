/**
 * Generated GitLab Duo agent model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.18.8` `src/models.json` key
 * `gitlab-duo-agent` (1 row, sha256:3256ca28d788655c098b346dadb4d1317a1d9f591e42fc499641533c78e05612). Regenerate with
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
  version: '18.18.8',
  file: 'src/models.json',
  key: 'gitlab-duo-agent',
  sourceHash: 'sha256:3256ca28d788655c098b346dadb4d1317a1d9f591e42fc499641533c78e05612',
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
