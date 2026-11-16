/**
 * Generated Antigravity CLI model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.20.3` `src/models.json` key `antigravity-cli`
 * (7 rows, sha256:d183025c204d185d1a002fccfc2bd7afd39407c3b96062fa373e56947e1ccdaf). Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The drift gate in `tests/build-google.test.ts` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * These rows belong to the ACP route: the CLI decides the endpoint, so a row's
 * `baseUrl` is not sent anywhere, and `id` is the ACP model id.
 *
 * @module dsh-llm-omp-transports/catalog/antigravity-cli
 */
import type { GoogleModelRow } from '../omp.js'

/** Provenance of {@link ANTIGRAVITY_CLI_MODELS}. */
export const ANTIGRAVITY_CLI_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.20.3',
  file: 'src/models.json',
  key: 'antigravity-cli',
  sourceHash: 'sha256:d183025c204d185d1a002fccfc2bd7afd39407c3b96062fa373e56947e1ccdaf',
  rowCount: 7,
} as const

/** Every Antigravity CLI model the pinned catalog serves, sorted by id. */
export const ANTIGRAVITY_CLI_MODELS: readonly GoogleModelRow[] = [
  {
    "id": "claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "opus",
      "revision": "5.5.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "prefixBinding": true
    }
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "sonnet",
      "revision": "5.5.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "prefixBinding": true
    }
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "3.8.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-4-argon",
    "name": "Gemini 4 Argon",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "revision": "4.0.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-4-carbon",
    "name": "Gemini 4 Carbon",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1048576,
    "maxTokens": 262144,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "revision": "4.0.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-4-hydrogen",
    "name": "Gemini 4 Hydrogen",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 1048576,
    "maxTokens": 262144,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "revision": "4.0.0"
    },
    "compat": {},
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gpt-oss-120b-medium",
    "name": "GPT-OSS 120B (Medium)",
    "baseUrl": "https://antigravity.google",
    "contextWindow": 131072,
    "maxTokens": 32768,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": false,
    "identity": {
      "class": "gpt-oss",
      "family": "120b"
    },
    "compat": {}
  },
]
