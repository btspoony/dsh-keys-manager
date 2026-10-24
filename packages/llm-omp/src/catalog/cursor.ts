/**
 * Generated Cursor model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.12.6` `src/models.json` key `cursor`
 * (123 rows, sha256:b0d9516e8c6cb4254b720e1e2983635776f272057ea6624f753498a3ea883152). Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The drift gate in `tests/build.test.ts` pins the same package version and
 * source hash, so an omp bump fails there before this table can describe the
 * wrong models.
 *
 * Rows that advertise efforts without routing them are carried unchanged, and
 * on each of them every advertised effort resolves to the same wire id (the
 * row's own, `requestModelId ?? id`): selecting one is a wire-level no-op,
 * exactly as in omp. No row's effort list is filtered.
 *
 * @module dsh-llm-omp-transports/catalog/cursor
 */
import type { CursorModelRow } from '../omp.js'

/** Provenance of {@link CURSOR_MODELS}. */
export const CURSOR_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.12.6',
  file: 'src/models.json',
  key: 'cursor',
  sourceHash: 'sha256:b0d9516e8c6cb4254b720e1e2983635776f272057ea6624f753498a3ea883152',
  rowCount: 123,
} as const

/** Every Cursor model the pinned catalog serves, sorted by id. */
export const CURSOR_MODELS: readonly CursorModelRow[] = [
  {
    "id": "claude-4-sonnet",
    "name": "Claude Sonnet 4",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4-sonnet-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4-sonnet",
        "minimal": "claude-4-sonnet-thinking",
        "low": "claude-4-sonnet-thinking",
        "medium": "claude-4-sonnet-thinking",
        "high": "claude-4-sonnet-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-4.5-opus-high",
    "name": "Claude Opus 4.5",
    "baseUrl": "https://api2.cursor.sh",
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4.5-opus-high-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4.5-opus-high",
        "minimal": "claude-4.5-opus-high-thinking",
        "low": "claude-4.5-opus-high-thinking",
        "medium": "claude-4.5-opus-high-thinking",
        "high": "claude-4.5-opus-high-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-4.5-sonnet",
    "name": "Claude Sonnet 4.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4.5-sonnet-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4.5-sonnet",
        "minimal": "claude-4.5-sonnet-thinking",
        "low": "claude-4.5-sonnet-thinking",
        "medium": "claude-4.5-sonnet-thinking",
        "high": "claude-4.5-sonnet-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-4.6-opus-high",
    "name": "Claude Opus 4.6 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4.6-opus-high-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4.6-opus-high",
        "minimal": "claude-4.6-opus-high-thinking",
        "low": "claude-4.6-opus-high-thinking",
        "medium": "claude-4.6-opus-high-thinking",
        "high": "claude-4.6-opus-high-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-4.6-opus-max",
    "name": "Claude Opus 4.6 1M Max",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4.6-opus-max-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4.6-opus-max",
        "minimal": "claude-4.6-opus-max-thinking",
        "low": "claude-4.6-opus-max-thinking",
        "medium": "claude-4.6-opus-max-thinking",
        "high": "claude-4.6-opus-max-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-4.6-sonnet-medium",
    "name": "Claude Sonnet 4.6 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-4.6-sonnet-medium-thinking": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-4.6-sonnet-medium",
        "minimal": "claude-4.6-sonnet-medium-thinking",
        "low": "claude-4.6-sonnet-medium-thinking",
        "medium": "claude-4.6-sonnet-medium-thinking",
        "high": "claude-4.6-sonnet-medium-thinking"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-fable-5-1-high",
    "name": "Claude Fable 5.1 1M (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-1-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-1-high",
        "minimal": "claude-fable-5-1-thinking-high",
        "low": "claude-fable-5-1-thinking-high",
        "medium": "claude-fable-5-1-thinking-high",
        "high": "claude-fable-5-1-thinking-high"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-1-low",
    "name": "Claude Fable 5.1 1M Low (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-1-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-1-low",
        "minimal": "claude-fable-5-1-thinking-low",
        "low": "claude-fable-5-1-thinking-low",
        "medium": "claude-fable-5-1-thinking-low",
        "high": "claude-fable-5-1-thinking-low"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-1-max",
    "name": "Claude Fable 5.1 1M Max (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-1-thinking-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-1-max",
        "minimal": "claude-fable-5-1-thinking-max",
        "low": "claude-fable-5-1-thinking-max",
        "medium": "claude-fable-5-1-thinking-max",
        "high": "claude-fable-5-1-thinking-max"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-1-medium",
    "name": "Claude Fable 5.1 1M Medium (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-1-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-1-medium",
        "minimal": "claude-fable-5-1-thinking-medium",
        "low": "claude-fable-5-1-thinking-medium",
        "medium": "claude-fable-5-1-thinking-medium",
        "high": "claude-fable-5-1-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-1-xhigh",
    "name": "Claude Fable 5.1 1M Extra High (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-1-thinking-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-1-xhigh",
        "minimal": "claude-fable-5-1-thinking-xhigh",
        "low": "claude-fable-5-1-thinking-xhigh",
        "medium": "claude-fable-5-1-thinking-xhigh",
        "high": "claude-fable-5-1-thinking-xhigh"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-high",
    "name": "Claude Fable 5 1M (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-high",
        "minimal": "claude-fable-5-thinking-high",
        "low": "claude-fable-5-thinking-high",
        "medium": "claude-fable-5-thinking-high",
        "high": "claude-fable-5-thinking-high"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-low",
    "name": "Claude Fable 5 1M Low (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-low",
        "minimal": "claude-fable-5-thinking-low",
        "low": "claude-fable-5-thinking-low",
        "medium": "claude-fable-5-thinking-low",
        "high": "claude-fable-5-thinking-low"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-max",
    "name": "Claude Fable 5 1M Max (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-thinking-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-max",
        "minimal": "claude-fable-5-thinking-max",
        "low": "claude-fable-5-thinking-max",
        "medium": "claude-fable-5-thinking-max",
        "high": "claude-fable-5-thinking-max"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-medium",
    "name": "Claude Fable 5 1M Medium (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-medium",
        "minimal": "claude-fable-5-thinking-medium",
        "low": "claude-fable-5-thinking-medium",
        "medium": "claude-fable-5-thinking-medium",
        "high": "claude-fable-5-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-fable-5-xhigh",
    "name": "Claude Fable 5 1M Extra High (NO ZDR)",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-fable-5-thinking-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-fable-5-xhigh",
        "minimal": "claude-fable-5-thinking-xhigh",
        "low": "claude-fable-5-thinking-xhigh",
        "medium": "claude-fable-5-thinking-xhigh",
        "high": "claude-fable-5-thinking-xhigh"
      }
    },
    "requiresGlyphTokenization": true,
    "requiresCursorToolSchemaProjection": true
  },
  {
    "id": "claude-opus-4-7-high",
    "name": "Claude Opus 4.7 1M High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-high",
        "minimal": "claude-opus-4-7-thinking-high",
        "low": "claude-opus-4-7-thinking-high",
        "medium": "claude-opus-4-7-thinking-high",
        "high": "claude-opus-4-7-thinking-high"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-high-fast",
    "name": "Claude Opus 4.7 1M High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 30,
      "output": 150,
      "cacheRead": 3,
      "cacheWrite": 37.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-high-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-high-fast",
        "minimal": "claude-opus-4-7-thinking-high-fast",
        "low": "claude-opus-4-7-thinking-high-fast",
        "medium": "claude-opus-4-7-thinking-high-fast",
        "high": "claude-opus-4-7-thinking-high-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-low",
    "name": "Claude Opus 4.7 1M Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-low",
        "minimal": "claude-opus-4-7-thinking-low",
        "low": "claude-opus-4-7-thinking-low",
        "medium": "claude-opus-4-7-thinking-low",
        "high": "claude-opus-4-7-thinking-low"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-low-fast",
    "name": "Claude Opus 4.7 1M Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 30,
      "output": 150,
      "cacheRead": 3,
      "cacheWrite": 37.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-low-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-low-fast",
        "minimal": "claude-opus-4-7-thinking-low-fast",
        "low": "claude-opus-4-7-thinking-low-fast",
        "medium": "claude-opus-4-7-thinking-low-fast",
        "high": "claude-opus-4-7-thinking-low-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-max",
    "name": "Claude Opus 4.7 1M Max",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-max",
        "minimal": "claude-opus-4-7-thinking-max",
        "low": "claude-opus-4-7-thinking-max",
        "medium": "claude-opus-4-7-thinking-max",
        "high": "claude-opus-4-7-thinking-max"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-max-fast",
    "name": "Claude Opus 4.7 1M Max Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 30,
      "output": 150,
      "cacheRead": 3,
      "cacheWrite": 37.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-max-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-max-fast",
        "minimal": "claude-opus-4-7-thinking-max-fast",
        "low": "claude-opus-4-7-thinking-max-fast",
        "medium": "claude-opus-4-7-thinking-max-fast",
        "high": "claude-opus-4-7-thinking-max-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-medium",
    "name": "Claude Opus 4.7 1M Medium",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-medium",
        "minimal": "claude-opus-4-7-thinking-medium",
        "low": "claude-opus-4-7-thinking-medium",
        "medium": "claude-opus-4-7-thinking-medium",
        "high": "claude-opus-4-7-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-medium-fast",
    "name": "Claude Opus 4.7 1M Medium Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 30,
      "output": 150,
      "cacheRead": 3,
      "cacheWrite": 37.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-medium-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-medium-fast",
        "minimal": "claude-opus-4-7-thinking-medium-fast",
        "low": "claude-opus-4-7-thinking-medium-fast",
        "medium": "claude-opus-4-7-thinking-medium-fast",
        "high": "claude-opus-4-7-thinking-medium-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-xhigh",
    "name": "Claude Opus 4.7 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-xhigh",
        "minimal": "claude-opus-4-7-thinking-xhigh",
        "low": "claude-opus-4-7-thinking-xhigh",
        "medium": "claude-opus-4-7-thinking-xhigh",
        "high": "claude-opus-4-7-thinking-xhigh"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-7-xhigh-fast",
    "name": "Claude Opus 4.7 1M Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 30,
      "output": 150,
      "cacheRead": 3,
      "cacheWrite": 37.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-7-thinking-xhigh-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-7-xhigh-fast",
        "minimal": "claude-opus-4-7-thinking-xhigh-fast",
        "low": "claude-opus-4-7-thinking-xhigh-fast",
        "medium": "claude-opus-4-7-thinking-xhigh-fast",
        "high": "claude-opus-4-7-thinking-xhigh-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-high",
    "name": "Claude Opus 4.8 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-high",
        "minimal": "claude-opus-4-8-thinking-high",
        "low": "claude-opus-4-8-thinking-high",
        "medium": "claude-opus-4-8-thinking-high",
        "high": "claude-opus-4-8-thinking-high"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-high-fast",
    "name": "Claude Opus 4.8 1M Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-high-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-high-fast",
        "minimal": "claude-opus-4-8-thinking-high-fast",
        "low": "claude-opus-4-8-thinking-high-fast",
        "medium": "claude-opus-4-8-thinking-high-fast",
        "high": "claude-opus-4-8-thinking-high-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-low",
    "name": "Claude Opus 4.8 1M Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-low",
        "minimal": "claude-opus-4-8-thinking-low",
        "low": "claude-opus-4-8-thinking-low",
        "medium": "claude-opus-4-8-thinking-low",
        "high": "claude-opus-4-8-thinking-low"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-low-fast",
    "name": "Claude Opus 4.8 1M Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-low-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-low-fast",
        "minimal": "claude-opus-4-8-thinking-low-fast",
        "low": "claude-opus-4-8-thinking-low-fast",
        "medium": "claude-opus-4-8-thinking-low-fast",
        "high": "claude-opus-4-8-thinking-low-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-max",
    "name": "Claude Opus 4.8 1M Max",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-max",
        "minimal": "claude-opus-4-8-thinking-max",
        "low": "claude-opus-4-8-thinking-max",
        "medium": "claude-opus-4-8-thinking-max",
        "high": "claude-opus-4-8-thinking-max"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-max-fast",
    "name": "Claude Opus 4.8 1M Max Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-max-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-max-fast",
        "minimal": "claude-opus-4-8-thinking-max-fast",
        "low": "claude-opus-4-8-thinking-max-fast",
        "medium": "claude-opus-4-8-thinking-max-fast",
        "high": "claude-opus-4-8-thinking-max-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-medium",
    "name": "Claude Opus 4.8 1M Medium",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-medium",
        "minimal": "claude-opus-4-8-thinking-medium",
        "low": "claude-opus-4-8-thinking-medium",
        "medium": "claude-opus-4-8-thinking-medium",
        "high": "claude-opus-4-8-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-medium-fast",
    "name": "Claude Opus 4.8 1M Medium Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-medium-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-medium-fast",
        "minimal": "claude-opus-4-8-thinking-medium-fast",
        "low": "claude-opus-4-8-thinking-medium-fast",
        "medium": "claude-opus-4-8-thinking-medium-fast",
        "high": "claude-opus-4-8-thinking-medium-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-xhigh",
    "name": "Claude Opus 4.8 1M Extra High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-xhigh",
        "minimal": "claude-opus-4-8-thinking-xhigh",
        "low": "claude-opus-4-8-thinking-xhigh",
        "medium": "claude-opus-4-8-thinking-xhigh",
        "high": "claude-opus-4-8-thinking-xhigh"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-4-8-xhigh-fast",
    "name": "Claude Opus 4.8 1M Extra High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-4-8-thinking-xhigh-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-4-8-xhigh-fast",
        "minimal": "claude-opus-4-8-thinking-xhigh-fast",
        "low": "claude-opus-4-8-thinking-xhigh-fast",
        "medium": "claude-opus-4-8-thinking-xhigh-fast",
        "high": "claude-opus-4-8-thinking-xhigh-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-5-5-low": false,
      "claude-opus-5-5-medium": false,
      "claude-opus-5-5-high": false,
      "claude-opus-5-5-xhigh": false,
      "claude-opus-5-5-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "low": "claude-opus-5-5-low",
        "medium": "claude-opus-5-5-medium",
        "high": "claude-opus-5-5-high",
        "xhigh": "claude-opus-5-5-xhigh",
        "max": "claude-opus-5-5-max"
      }
    },
    "requestModelId": "claude-opus-5-5-low",
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-5-fast",
    "name": "Claude Opus 5.5 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
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
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-5-5-low-fast": true,
      "claude-opus-5-5-medium-fast": true,
      "claude-opus-5-5-high-fast": true,
      "claude-opus-5-5-xhigh-fast": true,
      "claude-opus-5-5-max-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "low": "claude-opus-5-5-low-fast",
        "medium": "claude-opus-5-5-medium-fast",
        "high": "claude-opus-5-5-high-fast",
        "xhigh": "claude-opus-5-5-xhigh-fast",
        "max": "claude-opus-5-5-max-fast"
      }
    },
    "requestModelId": "claude-opus-5-5-low-fast",
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-high",
    "name": "Claude Opus 5 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-high",
        "minimal": "claude-opus-5-thinking-high",
        "low": "claude-opus-5-thinking-high",
        "medium": "claude-opus-5-thinking-high",
        "high": "claude-opus-5-thinking-high"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-high-fast",
    "name": "Claude Opus 5 1M Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-high-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-high-fast",
        "minimal": "claude-opus-5-thinking-high-fast",
        "low": "claude-opus-5-thinking-high-fast",
        "medium": "claude-opus-5-thinking-high-fast",
        "high": "claude-opus-5-thinking-high-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-low",
    "name": "Claude Opus 5 1M Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-low",
        "minimal": "claude-opus-5-thinking-low",
        "low": "claude-opus-5-thinking-low",
        "medium": "claude-opus-5-thinking-low",
        "high": "claude-opus-5-thinking-low"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-low-fast",
    "name": "Claude Opus 5 1M Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-low-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-low-fast",
        "minimal": "claude-opus-5-thinking-low-fast",
        "low": "claude-opus-5-thinking-low-fast",
        "medium": "claude-opus-5-thinking-low-fast",
        "high": "claude-opus-5-thinking-low-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-medium",
    "name": "Claude Opus 5 1M Medium",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-medium",
        "minimal": "claude-opus-5-thinking-medium",
        "low": "claude-opus-5-thinking-medium",
        "medium": "claude-opus-5-thinking-medium",
        "high": "claude-opus-5-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-medium-fast",
    "name": "Claude Opus 5 1M Medium Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "claude-opus-5-thinking-medium-fast": true
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-opus-5-medium-fast",
        "minimal": "claude-opus-5-thinking-medium-fast",
        "low": "claude-opus-5-thinking-medium-fast",
        "medium": "claude-opus-5-thinking-medium-fast",
        "high": "claude-opus-5-thinking-medium-fast"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-thinking-max",
    "name": "Claude Opus 5 1M Max Thinking",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-thinking-max-fast",
    "name": "Claude Opus 5 1M Max Thinking Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": true,
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-thinking-xhigh",
    "name": "Claude Opus 5 1M Extra High Thinking",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": false,
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-opus-5-thinking-xhigh-fast",
    "name": "Claude Opus 5 1M Extra High Thinking Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
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
    "cursorMaxMode": true,
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-sonnet-5-high",
    "name": "Claude Sonnet 5 1M",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-sonnet-5-thinking-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-5-high",
        "minimal": "claude-sonnet-5-thinking-high",
        "low": "claude-sonnet-5-thinking-high",
        "medium": "claude-sonnet-5-thinking-high",
        "high": "claude-sonnet-5-thinking-high"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-sonnet-5-low",
    "name": "Claude Sonnet 5 1M Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-sonnet-5-thinking-low": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-5-low",
        "minimal": "claude-sonnet-5-thinking-low",
        "low": "claude-sonnet-5-thinking-low",
        "medium": "claude-sonnet-5-thinking-low",
        "high": "claude-sonnet-5-thinking-low"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-sonnet-5-max",
    "name": "Claude Sonnet 5 1M Max",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-sonnet-5-thinking-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-5-max",
        "minimal": "claude-sonnet-5-thinking-max",
        "low": "claude-sonnet-5-thinking-max",
        "medium": "claude-sonnet-5-thinking-max",
        "high": "claude-sonnet-5-thinking-max"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-sonnet-5-medium",
    "name": "Claude Sonnet 5 1M Medium",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-sonnet-5-thinking-medium": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-5-medium",
        "minimal": "claude-sonnet-5-thinking-medium",
        "low": "claude-sonnet-5-thinking-medium",
        "medium": "claude-sonnet-5-thinking-medium",
        "high": "claude-sonnet-5-thinking-medium"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "claude-sonnet-5-xhigh",
    "name": "Claude Sonnet 5 1M Extra High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "claude-sonnet-5-thinking-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "off": "claude-sonnet-5-xhigh",
        "minimal": "claude-sonnet-5-thinking-xhigh",
        "low": "claude-sonnet-5-thinking-xhigh",
        "medium": "claude-sonnet-5-thinking-xhigh",
        "high": "claude-sonnet-5-thinking-xhigh"
      }
    },
    "requiresGlyphTokenization": true
  },
  {
    "id": "composer-1",
    "name": "Composer 1",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "composer-1.5",
    "name": "Composer 1.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "composer-2.5",
    "name": "Composer 2.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.5,
      "output": 2.5,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "composer-2.5-fast",
    "name": "Composer 2.5 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "cursor-grok-4.5",
    "name": "Grok 4.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "cursor-grok-4.5-low": false,
      "cursor-grok-4.5-medium": false,
      "cursor-grok-4.5-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "cursor-grok-4.5-low",
        "medium": "cursor-grok-4.5-medium",
        "high": "cursor-grok-4.5-high"
      }
    },
    "requestModelId": "cursor-grok-4.5-medium",
    "requiresGlyphTokenization": false
  },
  {
    "id": "cursor-grok-4.5-fast",
    "name": "Grok 4.5 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 18,
      "cacheRead": 1,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "cursor-grok-4.5-low-fast": false,
      "cursor-grok-4.5-medium-fast": false,
      "cursor-grok-4.5-high-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "cursor-grok-4.5-low-fast",
        "medium": "cursor-grok-4.5-medium-fast",
        "high": "cursor-grok-4.5-high-fast"
      }
    },
    "requestModelId": "cursor-grok-4.5-medium-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "cursor-grok-4.6",
    "name": "Grok 4.6",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "cursor-grok-4.6-low": false,
      "cursor-grok-4.6-medium": false,
      "cursor-grok-4.6-high": false,
      "cursor-grok-4.6-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "low": "cursor-grok-4.6-low",
        "medium": "cursor-grok-4.6-medium",
        "high": "cursor-grok-4.6-high",
        "xhigh": "cursor-grok-4.6-xhigh"
      }
    },
    "requestModelId": "cursor-grok-4.6-medium",
    "requiresGlyphTokenization": false
  },
  {
    "id": "cursor-grok-4.6-fast",
    "name": "Grok 4.6 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 12,
      "cacheRead": 1,
      "cacheWrite": 0
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "cursor-grok-4.6-low-fast": false,
      "cursor-grok-4.6-medium-fast": false,
      "cursor-grok-4.6-high-fast": false,
      "cursor-grok-4.6-xhigh-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "low": "cursor-grok-4.6-low-fast",
        "medium": "cursor-grok-4.6-medium-fast",
        "high": "cursor-grok-4.6-high-fast",
        "xhigh": "cursor-grok-4.6-xhigh-fast"
      }
    },
    "requestModelId": "cursor-grok-4.6-medium-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "default",
    "name": "Auto",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
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
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3-flash",
    "name": "Gemini 3 Flash",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.5,
      "output": 3,
      "cacheRead": 0.05,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3-pro",
    "name": "Gemini 3 Pro",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1048576,
    "maxTokens": 65536,
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
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3.1-pro",
    "name": "Gemini 3.1 Pro Preview",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1048576,
    "maxTokens": 65536,
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
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.5,
      "output": 7.5,
      "cacheRead": 0.15,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gemini-3.6-flash-minimal": false,
      "gemini-3.6-flash-low": false,
      "gemini-3.6-flash-medium": false,
      "gemini-3.6-flash-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "minimal": "gemini-3.6-flash-minimal",
        "low": "gemini-3.6-flash-low",
        "medium": "gemini-3.6-flash-medium",
        "high": "gemini-3.6-flash-high"
      }
    },
    "requestModelId": "gemini-3.6-flash-minimal",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.5,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gemini-3.7-flash-low": false,
      "gemini-3.7-flash-medium": false,
      "gemini-3.7-flash-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "gemini-3.7-flash-low",
        "medium": "gemini-3.7-flash-medium",
        "high": "gemini-3.7-flash-high"
      }
    },
    "requestModelId": "gemini-3.7-flash-low",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 3.5,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gemini-3.8-flash-low": false,
      "gemini-3.8-flash-medium": false,
      "gemini-3.8-flash-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "effortRouting": {
        "low": "gemini-3.8-flash-low",
        "medium": "gemini-3.8-flash-medium",
        "high": "gemini-3.8-flash-high"
      }
    },
    "requestModelId": "gemini-3.8-flash-low",
    "requiresGlyphTokenization": false
  },
  {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "glm-5.2-high": false,
      "glm-5.2-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "high",
        "max"
      ],
      "effortRouting": {
        "high": "glm-5.2-high",
        "max": "glm-5.2-max"
      }
    },
    "requestModelId": "glm-5.2-high",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5-mini",
    "name": "GPT-5 Mini",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.25,
      "output": 2,
      "cacheRead": 0.025,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1",
    "name": "GPT-5.1",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
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
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1-codex-max",
    "name": "GPT-5.1 Codex Max",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 128000,
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
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1-codex-max-high",
    "name": "GPT-5.1 Codex Max High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 128000,
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
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1-codex-mini",
    "name": "GPT-5.1 Codex Mini",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.25,
      "output": 2,
      "cacheRead": 0.025,
      "cacheWrite": 0
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1-high",
    "name": "GPT-5.1 High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.1-low",
    "name": "GPT-5.1 Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
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
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2",
    "name": "GPT-5.2",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex",
    "name": "GPT-5.2 Codex",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-fast",
    "name": "GPT-5.2 Codex Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-high",
    "name": "GPT-5.2 Codex High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-high-fast",
    "name": "GPT-5.2 Codex High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-low",
    "name": "GPT-5.2 Codex Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-low-fast",
    "name": "GPT-5.2 Codex Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-xhigh",
    "name": "GPT-5.2 Codex Extra High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-codex-xhigh-fast",
    "name": "GPT-5.2 Codex Extra High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-fast",
    "name": "GPT-5.2 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-high",
    "name": "GPT-5.2 High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-high-fast",
    "name": "GPT-5.2 High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-low",
    "name": "GPT-5.2 Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-low-fast",
    "name": "GPT-5.2 Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-xhigh",
    "name": "GPT-5.2 Extra High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.2-xhigh-fast",
    "name": "GPT-5.2 Extra High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex",
    "name": "GPT-5.3 Codex",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 128000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-fast",
    "name": "Codex 5.3 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-high",
    "name": "Codex 5.3 High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-high-fast",
    "name": "Codex 5.3 High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-low",
    "name": "Codex 5.3 Low",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-low-fast",
    "name": "Codex 5.3 Low Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-spark-preview",
    "name": "GPT-5.3 Codex Spark",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-xhigh",
    "name": "Codex 5.3 Extra High",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.3-codex-xhigh-fast",
    "name": "Codex 5.3 Extra High Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2.5,
      "output": 15,
      "cacheRead": 0.25,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.4-low": false,
      "gpt-5.4-medium": false,
      "gpt-5.4-high": false,
      "gpt-5.4-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "low": "gpt-5.4-low",
        "medium": "gpt-5.4-medium",
        "high": "gpt-5.4-high",
        "xhigh": "gpt-5.4-xhigh"
      }
    },
    "requestModelId": "gpt-5.4-low",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.4-fast",
    "name": "GPT-5.4 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.4-medium-fast": false,
      "gpt-5.4-high-fast": false,
      "gpt-5.4-xhigh-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "medium": "gpt-5.4-medium-fast",
        "high": "gpt-5.4-high-fast",
        "xhigh": "gpt-5.4-xhigh-fast"
      }
    },
    "requestModelId": "gpt-5.4-medium-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 mini",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.75,
      "output": 4.5,
      "cacheRead": 0.075,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.4-mini-none": false,
      "gpt-5.4-mini-low": false,
      "gpt-5.4-mini-medium": false,
      "gpt-5.4-mini-high": false,
      "gpt-5.4-mini-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "off": "gpt-5.4-mini-none",
        "low": "gpt-5.4-mini-low",
        "medium": "gpt-5.4-mini-medium",
        "high": "gpt-5.4-mini-high",
        "xhigh": "gpt-5.4-mini-xhigh"
      }
    },
    "requestModelId": "gpt-5.4-mini-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.4-nano",
    "name": "GPT-5.4 nano",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.2,
      "output": 1.25,
      "cacheRead": 0.02,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.4-nano-none": false,
      "gpt-5.4-nano-low": false,
      "gpt-5.4-nano-medium": false,
      "gpt-5.4-nano-high": false,
      "gpt-5.4-nano-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "off": "gpt-5.4-nano-none",
        "low": "gpt-5.4-nano-low",
        "medium": "gpt-5.4-nano-medium",
        "high": "gpt-5.4-nano-high",
        "xhigh": "gpt-5.4-nano-xhigh"
      }
    },
    "requestModelId": "gpt-5.4-nano-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.5-none": false,
      "gpt-5.5-low": false,
      "gpt-5.5-medium": false,
      "gpt-5.5-high": false,
      "gpt-5.5-extra-high": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "off": "gpt-5.5-none",
        "low": "gpt-5.5-low",
        "medium": "gpt-5.5-medium",
        "high": "gpt-5.5-high",
        "xhigh": "gpt-5.5-extra-high"
      }
    },
    "requestModelId": "gpt-5.5-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.5-fast",
    "name": "GPT-5.5 Extra Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "gpt-5.5-none-fast": false,
      "gpt-5.5-low-fast": false,
      "gpt-5.5-medium-fast": false,
      "gpt-5.5-high-fast": false,
      "gpt-5.5-extra-high-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "off": "gpt-5.5-none-fast",
        "low": "gpt-5.5-low-fast",
        "medium": "gpt-5.5-medium-fast",
        "high": "gpt-5.5-high-fast",
        "xhigh": "gpt-5.5-extra-high-fast"
      }
    },
    "requestModelId": "gpt-5.5-none-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-luna-none": false,
      "gpt-5.6-luna-low": false,
      "gpt-5.6-luna-medium": false,
      "gpt-5.6-luna-high": false,
      "gpt-5.6-luna-xhigh": false,
      "gpt-5.6-luna-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-luna-none",
        "low": "gpt-5.6-luna-low",
        "medium": "gpt-5.6-luna-medium",
        "high": "gpt-5.6-luna-high",
        "xhigh": "gpt-5.6-luna-xhigh",
        "max": "gpt-5.6-luna-max"
      }
    },
    "requestModelId": "gpt-5.6-luna-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-luna-fast",
    "name": "GPT-5.6 Luna Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.4,
      "output": 2.4,
      "cacheRead": 0.04,
      "cacheWrite": 0.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-luna-none-fast": false,
      "gpt-5.6-luna-low-fast": false,
      "gpt-5.6-luna-medium-fast": false,
      "gpt-5.6-luna-high-fast": false,
      "gpt-5.6-luna-xhigh-fast": false,
      "gpt-5.6-luna-max-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-luna-none-fast",
        "low": "gpt-5.6-luna-low-fast",
        "medium": "gpt-5.6-luna-medium-fast",
        "high": "gpt-5.6-luna-high-fast",
        "xhigh": "gpt-5.6-luna-xhigh-fast",
        "max": "gpt-5.6-luna-max-fast"
      }
    },
    "requestModelId": "gpt-5.6-luna-none-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 20,
      "cacheRead": 0.4,
      "cacheWrite": 5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-sol-none": false,
      "gpt-5.6-sol-low": false,
      "gpt-5.6-sol-medium": false,
      "gpt-5.6-sol-high": false,
      "gpt-5.6-sol-xhigh": false,
      "gpt-5.6-sol-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-sol-none",
        "low": "gpt-5.6-sol-low",
        "medium": "gpt-5.6-sol-medium",
        "high": "gpt-5.6-sol-high",
        "xhigh": "gpt-5.6-sol-xhigh",
        "max": "gpt-5.6-sol-max"
      }
    },
    "requestModelId": "gpt-5.6-sol-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-sol-fast",
    "name": "GPT-5.6 Sol Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.8,
      "cacheWrite": 10
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-sol-none-fast": false,
      "gpt-5.6-sol-low-fast": false,
      "gpt-5.6-sol-medium-fast": false,
      "gpt-5.6-sol-high-fast": false,
      "gpt-5.6-sol-xhigh-fast": false,
      "gpt-5.6-sol-max-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-sol-none-fast",
        "low": "gpt-5.6-sol-low-fast",
        "medium": "gpt-5.6-sol-medium-fast",
        "high": "gpt-5.6-sol-high-fast",
        "xhigh": "gpt-5.6-sol-xhigh-fast",
        "max": "gpt-5.6-sol-max-fast"
      }
    },
    "requestModelId": "gpt-5.6-sol-none-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-terra-none": false,
      "gpt-5.6-terra-low": false,
      "gpt-5.6-terra-medium": false,
      "gpt-5.6-terra-high": false,
      "gpt-5.6-terra-xhigh": false,
      "gpt-5.6-terra-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-terra-none",
        "low": "gpt-5.6-terra-low",
        "medium": "gpt-5.6-terra-medium",
        "high": "gpt-5.6-terra-high",
        "xhigh": "gpt-5.6-terra-xhigh",
        "max": "gpt-5.6-terra-max"
      }
    },
    "requestModelId": "gpt-5.6-terra-none",
    "requiresGlyphTokenization": false
  },
  {
    "id": "gpt-5.6-terra-fast",
    "name": "GPT-5.6 Terra Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 272000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 24,
      "cacheRead": 0.4,
      "cacheWrite": 5
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "gpt-5.6-terra-none-fast": false,
      "gpt-5.6-terra-low-fast": false,
      "gpt-5.6-terra-medium-fast": false,
      "gpt-5.6-terra-high-fast": false,
      "gpt-5.6-terra-xhigh-fast": false,
      "gpt-5.6-terra-max-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "off": "gpt-5.6-terra-none-fast",
        "low": "gpt-5.6-terra-low-fast",
        "medium": "gpt-5.6-terra-medium-fast",
        "high": "gpt-5.6-terra-high-fast",
        "xhigh": "gpt-5.6-terra-xhigh-fast",
        "max": "gpt-5.6-terra-max-fast"
      }
    },
    "requestModelId": "gpt-5.6-terra-none-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "grok-4.7",
    "name": "Grok 4.7",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "grok-4.7-low": false,
      "grok-4.7-medium": false,
      "grok-4.7-high": false,
      "grok-4.7-xhigh": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "low": "grok-4.7-low",
        "medium": "grok-4.7-medium",
        "high": "grok-4.7-high",
        "xhigh": "grok-4.7-xhigh"
      }
    },
    "requestModelId": "grok-4.7-medium",
    "requiresGlyphTokenization": false
  },
  {
    "id": "grok-4.7-fast",
    "name": "Grok 4.7 Fast",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 4,
      "output": 12,
      "cacheRead": 1,
      "cacheWrite": 0
    },
    "cursorMaxMode": true,
    "cursorMaxModeRoutes": {
      "grok-4.7-low-fast": false,
      "grok-4.7-medium-fast": false,
      "grok-4.7-high-fast": false,
      "grok-4.7-xhigh-fast": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "effortRouting": {
        "low": "grok-4.7-low-fast",
        "medium": "grok-4.7-medium-fast",
        "high": "grok-4.7-high-fast",
        "xhigh": "grok-4.7-xhigh-fast"
      }
    },
    "requestModelId": "grok-4.7-medium-fast",
    "requiresGlyphTokenization": false
  },
  {
    "id": "grok-code-fast-1",
    "name": "Grok Code Fast 1",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 256000,
    "maxTokens": 10000,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "kimi-k2.5",
    "name": "kimi-k2.5",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 262144,
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
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 262000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.19,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "kimi-k3-high",
    "name": "Kimi K3 High",
    "baseUrl": "https://api2.cursor.sh",
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
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "kimi-k3-low",
    "name": "Kimi K3 Low",
    "baseUrl": "https://api2.cursor.sh",
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
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "kimi-k3-max",
    "name": "Kimi K3",
    "baseUrl": "https://api2.cursor.sh",
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
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "thinking": {
      "mode": "effort",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    "requiresGlyphTokenization": false
  },
  {
    "id": "muse-spark-1.3",
    "name": "Muse Spark 1.3",
    "baseUrl": "https://api2.cursor.sh",
    "contextWindow": 1000000,
    "maxTokens": 64000,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 1.25,
      "output": 4.25,
      "cacheRead": 0.15,
      "cacheWrite": 0
    },
    "cursorMaxMode": false,
    "cursorMaxModeRoutes": {
      "muse-spark-1.3-minimal": false,
      "muse-spark-1.3-low": false,
      "muse-spark-1.3-medium": false,
      "muse-spark-1.3-high": false,
      "muse-spark-1.3-xhigh": false,
      "muse-spark-1.3-max": false
    },
    "thinking": {
      "mode": "effort",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "effortRouting": {
        "minimal": "muse-spark-1.3-minimal",
        "low": "muse-spark-1.3-low",
        "medium": "muse-spark-1.3-medium",
        "high": "muse-spark-1.3-high",
        "xhigh": "muse-spark-1.3-xhigh",
        "max": "muse-spark-1.3-max"
      }
    },
    "requestModelId": "muse-spark-1.3-minimal",
    "requiresGlyphTokenization": false
  },
]
