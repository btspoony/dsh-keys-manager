/**
 * Generated Gemini CLI model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.18.8` `src/models.json` key `google-gemini-cli`
 * (7 rows, sha256:3256ca28d788655c098b346dadb4d1317a1d9f591e42fc499641533c78e05612). Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The drift gate in `tests/build-google.test.ts` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Both Google routes share the generated row shape because they share one
 * bundled transport; `identity.class` decides the wire family and `compat`
 * carries the per-model wire flags whole.
 *
 * @module dsh-llm-omp-transports/catalog/google-gemini-cli
 */
import type { GoogleModelRow } from '../omp.js'

/** Provenance of {@link GOOGLE_GEMINI_CLI_MODELS}. */
export const GOOGLE_GEMINI_CLI_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.18.8',
  file: 'src/models.json',
  key: 'google-gemini-cli',
  sourceHash: 'sha256:3256ca28d788655c098b346dadb4d1317a1d9f591e42fc499641533c78e05612',
  rowCount: 7,
} as const

/** Every Gemini CLI model the pinned catalog serves, sorted by id. */
export const GOOGLE_GEMINI_CLI_MODELS: readonly GoogleModelRow[] = [
  {
    "id": "gemini-2.0-flash",
    "name": "Gemini 2.0 Flash",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 8192,
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
    "reasoning": false,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "2.0.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": true,
      "multimodalFunctionResponse": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "stripImageInput": false,
      "supportsFunctionPartId": false,
      "streamFirstEventTimeoutMs": 60000
    }
  },
  {
    "id": "gemini-2.5-flash",
    "name": "Gemini 2.5 Flash",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
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
      "revision": "2.5.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": true,
      "multimodalFunctionResponse": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "stripImageInput": false,
      "supportsFunctionPartId": false,
      "streamFirstEventTimeoutMs": 60000
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "high": "gemini-2.5-flash-thinking",
        "low": "gemini-2.5-flash-thinking",
        "medium": "gemini-2.5-flash-thinking",
        "minimal": "gemini-2.5-flash-thinking",
        "off": "gemini-2.5-flash"
      }
    }
  },
  {
    "id": "gemini-2.5-pro",
    "name": "Gemini 2.5 Pro",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
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
      "family": "pro",
      "revision": "2.5.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": false,
      "multimodalFunctionResponse": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "stripImageInput": false,
      "supportsFunctionPartId": false
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-3-flash-preview",
    "name": "Gemini 3 Flash Preview",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
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
      "revision": "3.0.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": true,
      "multimodalFunctionResponse": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "stripImageInput": false,
      "supportsFunctionPartId": false,
      "streamFirstEventTimeoutMs": 60000
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-3-pro-preview",
    "name": "Gemini 3 Pro Preview",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
    "contextWindow": 1000000,
    "maxTokens": 64000,
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
      "family": "pro",
      "revision": "3.0.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": false,
      "multimodalFunctionResponse": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "stripImageInput": false,
      "supportsFunctionPartId": false
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-3.1-flash-lite-preview",
    "name": "Gemini 3.1 Flash Lite Preview",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
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
      "family": "lite",
      "revision": "3.1.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": false,
      "multimodalFunctionResponse": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "stripImageInput": false,
      "supportsFunctionPartId": false
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "requiresEffort": true
    }
  },
  {
    "id": "gemini-3.1-pro-preview",
    "name": "Gemini 3.1 Pro Preview",
    "baseUrl": "https://cloudcode-pa.googleapis.com",
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
      "family": "pro",
      "revision": "3.1.0"
    },
    "compat": {
      "antigravityClaudeToolMode": false,
      "ccaLegacyParametersSchema": false,
      "claudeThinkingBetaHeader": false,
      "dropUnsignedThinking": false,
      "flashStreamLeakWorkaround": false,
      "multimodalFunctionResponse": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "stripImageInput": false,
      "supportsFunctionPartId": false
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "requiresEffort": true
    }
  },
]
