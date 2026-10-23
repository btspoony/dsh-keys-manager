/**
 * Generated Antigravity model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.12.3` `src/models.json` key `google-antigravity`
 * (22 rows, sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c). Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The drift gate in `tests/build-google.test.ts` pins the same package version
 * and source hash, so an omp bump fails there before this table can describe
 * the wrong models.
 *
 * Rows reach the same bundled transport as the Gemini CLI table; the route is
 * the row's `provider`, and `requestModelId` routes an effort to its wire id.
 *
 * @module dsh-llm-omp-transports/catalog/google-antigravity
 */
import type { GoogleModelRow } from '../omp.js'

/** Provenance of {@link GOOGLE_ANTIGRAVITY_MODELS}. */
export const GOOGLE_ANTIGRAVITY_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.12.3',
  file: 'src/models.json',
  key: 'google-antigravity',
  sourceHash: 'sha256:39fb09654ee3812043bc062e426d8e7aa13cd273435fa7b8a203a76246c8735c',
  rowCount: 22,
} as const

/** Every Antigravity model the pinned catalog serves, sorted by id. */
export const GOOGLE_ANTIGRAVITY_MODELS: readonly GoogleModelRow[] = [
  {
    "id": "claude-opus-4-5",
    "name": "Claude Opus 4.5",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "opus",
      "revision": "4.5.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "antigravityUsageLabel": "true"
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
        "off": "claude-opus-4-5",
        "minimal": "claude-opus-4-5-thinking",
        "low": "claude-opus-4-5-thinking",
        "medium": "claude-opus-4-5-thinking",
        "high": "claude-opus-4-5-thinking"
      }
    },
    "requestModelId": "claude-opus-4-5-thinking"
  },
  {
    "id": "claude-opus-4-6",
    "name": "Claude Opus 4.6",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 250000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "opus",
      "revision": "4.6.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "antigravityUsageLabel": "true"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requestModelId": "claude-opus-4-6-thinking"
  },
  {
    "id": "claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 20,
      "cacheRead": 0.2,
      "cacheWrite": 5
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "opus",
      "revision": "5.5.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "supportsSamplingParams": false,
      "antigravityUsageLabel": "true"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "claude-opus-5-5-low",
        "medium": "claude-opus-5-5-medium",
        "high": "claude-opus-5-5-high"
      },
      "requiresEffort": true,
      "prefixBinding": true
    },
    "requestModelId": "claude-opus-5-5-low"
  },
  {
    "id": "claude-sonnet-4-5",
    "name": "Claude Sonnet 4.5",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "sonnet",
      "revision": "4.5.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "antigravityUsageLabel": "true"
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
        "off": "claude-sonnet-4-5",
        "minimal": "claude-sonnet-4-5-thinking",
        "low": "claude-sonnet-4-5-thinking",
        "medium": "claude-sonnet-4-5-thinking",
        "high": "claude-sonnet-4-5-thinking"
      }
    },
    "requestModelId": "claude-sonnet-4-5"
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Claude Sonnet 4.6",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 250000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "sonnet",
      "revision": "4.6.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "antigravityUsageLabel": "true"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    }
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5
    },
    "reasoning": true,
    "identity": {
      "class": "anthropic",
      "family": "sonnet",
      "revision": "5.5.0"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": true,
      "ccaLegacyParametersSchema": true,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": true,
      "antigravityClaudeToolMode": true,
      "stripImageInput": false,
      "maxImageDimension": 8000,
      "maxImagePayloadBytes": 5242880,
      "supportsSamplingParams": false,
      "antigravityUsageLabel": "true"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "claude-sonnet-5-5-low",
        "medium": "claude-sonnet-5-5-medium",
        "high": "claude-sonnet-5-5-high"
      },
      "requiresEffort": true,
      "prefixBinding": true
    },
    "requestModelId": "claude-sonnet-5-5-low"
  },
  {
    "id": "gemini-2.5-flash",
    "name": "Gemini 2.5 Flash",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.3,
      "output": 2.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "2.5.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
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
        "off": "gemini-2.5-flash",
        "minimal": "gemini-2.5-flash-thinking",
        "low": "gemini-2.5-flash-thinking",
        "medium": "gemini-2.5-flash-thinking",
        "high": "gemini-2.5-flash-thinking"
      }
    }
  },
  {
    "id": "gemini-2.5-flash-lite",
    "name": "Gemini 2.5 Flash-Lite",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.4,
      "cacheRead": 0.01,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "lite",
      "revision": "2.5.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    }
  },
  {
    "id": "gemini-2.5-pro",
    "name": "Gemini 2.5 Pro",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.25,
      "output": 10,
      "cacheRead": 0.125,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "pro",
      "revision": "2.5.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
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
    "id": "gemini-3-pro",
    "name": "Gemini 3 Pro",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "pro",
      "revision": "3.0.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "high"
      ],
      "effortRouting": {
        "off": "gemini-3-pro-low",
        "low": "gemini-3-pro-low",
        "high": "gemini-3-pro-high"
      },
      "requiresEffort": true,
      "suppressWhenOff": true
    },
    "requestModelId": "gemini-3-pro-low"
  },
  {
    "id": "gemini-3-pro-image",
    "name": "Nano Banana Pro",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 65536,
    "maxTokens": 32768,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 120,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": false,
    "identity": {
      "class": "gemini",
      "family": "pro",
      "revision": "3.0.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "id": "gemini-3.1-flash-image",
    "name": "Nano Banana 2",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 65536,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.5,
      "output": 60,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": false,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "3.1.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    }
  },
  {
    "id": "gemini-3.1-flash-lite",
    "name": "Gemini 3.1 Flash Lite",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.25,
      "output": 1.5,
      "cacheRead": 0.025,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "lite",
      "revision": "3.1.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
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
    "id": "gemini-3.1-pro",
    "name": "Gemini 3.1 Pro Preview",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "pro",
      "revision": "3.1.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "low",
        "high"
      ],
      "effortRouting": {
        "off": "gemini-3.1-pro-low",
        "low": "gemini-3.1-pro-low",
        "high": "gemini-pro-agent"
      },
      "requiresEffort": true,
      "suppressWhenOff": true,
      "effortBudgets": {
        "low": 1001,
        "high": 10001
      }
    },
    "requestModelId": "gemini-3.1-pro-low"
  },
  {
    "id": "gemini-3.5-flash-lite",
    "name": "Gemini 3.5 Flash Lite",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.3,
      "output": 2.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "lite",
      "revision": "3.5.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
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
    "id": "gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.75,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "3.6.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "minimal": "gemini-3.6-flash-low",
        "low": "gemini-3.6-flash-low",
        "medium": "gemini-3.6-flash-medium",
        "high": "gemini-3.6-flash-high"
      },
      "requiresEffort": true
    },
    "requestModelId": "gemini-3.6-flash-low"
  },
  {
    "id": "gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.75,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "3.7.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "minimal": "gemini-3.7-flash-low",
        "low": "gemini-3.7-flash-low",
        "medium": "gemini-3.7-flash-medium",
        "high": "gemini-3.7-flash-high"
      },
      "requiresEffort": true
    },
    "requestModelId": "gemini-3.7-flash-low"
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.75,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "family": "flash",
      "revision": "3.8.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": true,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "streamFirstEventTimeoutMs": 60000,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "minimal": "gemini-3.8-flash-low",
        "low": "gemini-3.8-flash-low",
        "medium": "gemini-3.8-flash-medium",
        "high": "gemini-3.8-flash-high"
      },
      "requiresEffort": true
    },
    "requestModelId": "gemini-3.8-flash-low"
  },
  {
    "id": "gemini-4-argon",
    "name": "Gemini 4 Argon",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 0
    },
    "reasoning": true,
    "identity": {
      "class": "gemini",
      "revision": "4.0.0"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": true,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": true,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false,
      "thinkingLoopGuard": "gemini"
    },
    "thinking": {
      "mode": "google-level",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "gemini-4-argon-low",
        "medium": "gemini-4-argon-medium",
        "high": "gemini-4-argon-high"
      },
      "requiresEffort": true
    },
    "requestModelId": "gemini-4-argon-low"
  },
  {
    "id": "gpt-oss-120b",
    "name": "GPT OSS 120B",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
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
    "reasoning": true,
    "identity": {
      "class": "gpt-oss",
      "family": "120b"
    },
    "compat": {
      "supportsFunctionPartId": true,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    },
    "thinking": {
      "mode": "budget",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requestModelId": "gpt-oss-120b-medium"
  },
  {
    "id": "tab_flash_lite_preview",
    "name": "tab_flash_lite_preview",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 16384,
    "maxTokens": 4096,
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
      "class": "unknown"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    }
  },
  {
    "id": "tab_jump_flash_lite_preview",
    "name": "tab_jump_flash_lite_preview",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "contextWindow": 16384,
    "maxTokens": 4096,
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
      "class": "unknown"
    },
    "compat": {
      "supportsFunctionPartId": false,
      "requiresSkipThoughtSignature": false,
      "requiresSkipThoughtSignatureOnFirstFunctionCall": false,
      "dropUnsignedThinking": false,
      "ccaLegacyParametersSchema": false,
      "multimodalFunctionResponse": false,
      "flashStreamLeakWorkaround": false,
      "claudeThinkingBetaHeader": false,
      "antigravityClaudeToolMode": false,
      "stripImageInput": false
    }
  },
]
