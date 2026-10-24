/**
 * Generated Factory Droid model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.12.3` `src/compat/rules.json`
 * `providers.factory-droid.seed.models` (62 rows, sha256:2688dfbeda4b9c9973a9790784ba0c107b3417eafdaf4a66b45ef000a3fbfcd1).
 * Regenerate with `pnpm -C packages/llm-omp run generate:catalog`.
 *
 * The rows live in the KDL compat registry because the pinned `models.json`
 * carries no `factory-droid` key; the drift gate in
 * `tests/build-factory-droid.test.ts` pins the same package version and source
 * hash, so an omp bump fails there before this table can describe the wrong
 * models.
 *
 * Every row is a zero-cost Factory credit, and the route multiplexes four wire
 * protocols by model id, so the table carries the identity fields the wire
 * header and the family dispatch read rather than a reduced subset.
 *
 * @module dsh-llm-omp-transports/catalog/factory-droid
 */
import type { FactoryDroidModelRow } from '../omp.js'

/** Provenance of {@link FACTORY_DROID_MODELS}. */
export const FACTORY_DROID_CATALOG_SOURCE = {
  package: '@oh-my-pi/pi-catalog',
  version: '18.12.3',
  file: 'src/compat/rules.json',
  key: 'factory-droid',
  sourceHash: 'sha256:2688dfbeda4b9c9973a9790784ba0c107b3417eafdaf4a66b45ef000a3fbfcd1',
  rowCount: 62,
} as const

/** Every Factory Droid model the pinned registry seed declares, sorted by id. */
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelRow[] = [
  {
    "id": "aster-07-15",
    "name": "Aster 07/15 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "atlas-07-21",
    "name": "Atlas 07/21 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-fable-5",
    "name": "Fable 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-fable-5.1",
    "name": "Fable 5.1",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "name": "Haiku 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 180000,
    "maxTokens": 32000,
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
    "reasoning": true
  },
  {
    "id": "claude-haiku-5-5",
    "name": "Haiku 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 872000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-4-5-20251101",
    "name": "Opus 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 180000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-4-6",
    "name": "Opus 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-4-7",
    "name": "Opus 4.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-4-8",
    "name": "Opus 4.8",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-4-8-fast",
    "name": "Opus 4.8 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-5",
    "name": "Opus 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-5-5",
    "name": "Opus 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 872000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-5-5-fast",
    "name": "Opus 5.5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 872000,
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
    "reasoning": true
  },
  {
    "id": "claude-opus-5-fast",
    "name": "Opus 5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 867000,
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
    "reasoning": true
  },
  {
    "id": "claude-sonnet-4-5-20250929",
    "name": "Sonnet 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 180000,
    "maxTokens": 32000,
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
    "reasoning": true
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Sonnet 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 931000,
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
    "reasoning": true
  },
  {
    "id": "claude-sonnet-5",
    "name": "Sonnet 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 872000,
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
    "reasoning": true
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Sonnet 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 872000,
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
    "reasoning": true
  },
  {
    "id": "deepseek-v4-flash-0731",
    "name": "DeepSeek V4 Flash 0731",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 908928,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 908928,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "DeepSeek V4.1 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 908928,
    "maxTokens": 131072,
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
    "reasoning": true
  },
  {
    "id": "garnet-07-15",
    "name": "Garnet 07/15 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3-flash-preview",
    "name": "Gemini 3 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3.1-pro-preview",
    "name": "Gemini 3.1 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1000000,
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
    "reasoning": true
  },
  {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 908928,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "glm-5.2-fast",
    "name": "GLM-5.2 Fast",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 393216,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "glm-5.3",
    "name": "GLM-5.3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 908928,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "glm-5.3-flash",
    "name": "GLM-5.3-Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 917504,
    "maxTokens": 131072,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.2",
    "name": "GPT-5.2",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 272000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.3-codex",
    "name": "GPT-5.3-Codex",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 272000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.3-codex-fast",
    "name": "GPT-5.3-Codex Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 272000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.4-fast",
    "name": "GPT-5.4 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 Mini",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 272000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.4-mini-fast",
    "name": "GPT-5.4 Mini Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 272000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.5-fast",
    "name": "GPT-5.5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.5-pro",
    "name": "GPT-5.5 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.6-sol-fast",
    "name": "GPT-5.6 Sol Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-6-astra",
    "name": "GPT-6 Astra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-6-luna",
    "name": "GPT-6 Luna",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-6-sol",
    "name": "GPT-6 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 922000,
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
    "reasoning": true
  },
  {
    "id": "grok-4.5",
    "name": "Grok 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 200000,
    "maxTokens": 63356,
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
    "reasoning": true
  },
  {
    "id": "grok-4.6",
    "name": "Grok 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 200000,
    "maxTokens": 63356,
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
    "reasoning": true
  },
  {
    "id": "grok-4.7",
    "name": "Grok 4.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 436644,
    "maxTokens": 63356,
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
    "reasoning": true
  },
  {
    "id": "inkling",
    "name": "Inkling",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 1007232,
    "maxTokens": 32768,
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
    "reasoning": true
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 196608,
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
    "reasoning": true
  },
  {
    "id": "minimax-m2.7",
    "name": "MiniMax M2.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 196600,
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
    "reasoning": true
  },
  {
    "id": "minimax-m3",
    "name": "MiniMax M3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 448000,
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
    "reasoning": true
  },
  {
    "id": "mistral-large-4",
    "name": "Mistral Large 4",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 524288,
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
    "reasoning": true
  },
  {
    "id": "mistral-medium-3.5",
    "name": "Mistral Medium 3.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 192000,
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
    "reasoning": true
  },
  {
    "id": "nemotron-3-ultra",
    "name": "Nemotron 3 Ultra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 136464,
    "maxTokens": 65536,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
  {
    "id": "qwen3.8-max",
    "name": "Qwen3.8 Max",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
    "contextWindow": 131072,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "reasoning": true
  },
]
