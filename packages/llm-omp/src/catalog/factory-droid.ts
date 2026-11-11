/**
 * Generated Factory Droid model table — do not edit by hand.
 *
 * Source: `@oh-my-pi/pi-catalog@18.18.8` `src/compat/rules.json`
 * `providers.factory-droid.seed.models` (77 rows, sha256:2411edf732aa8e4162b9c871578d8abdcdb4ff00679ca1a5edacf5ee4756dd8a).
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
  version: '18.18.8',
  file: 'src/compat/rules.json',
  key: 'factory-droid',
  sourceHash: 'sha256:2411edf732aa8e4162b9c871578d8abdcdb4ff00679ca1a5edacf5ee4756dd8a',
  rowCount: 77,
} as const

/** Every Factory Droid model the pinned registry seed declares, sorted by id. */
export const FACTORY_DROID_MODELS: readonly FactoryDroidModelRow[] = [
  {
    "id": "aster-07-15",
    "name": "Aster 07/15 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "atlas-07-21",
    "name": "Atlas 07/21 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "beam-1.0",
    "name": "Beam 1.0",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1015808,
    "maxTokens": 32768
  },
  {
    "id": "claude-fable-5",
    "name": "Fable 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-fable-5.1",
    "name": "Fable 5.1",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "name": "Haiku 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 180000,
    "maxTokens": 32000
  },
  {
    "id": "claude-haiku-5-5",
    "name": "Haiku 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 872000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-5-20251101",
    "name": "Opus 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 180000,
    "maxTokens": 64000
  },
  {
    "id": "claude-opus-4-6",
    "name": "Opus 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-7",
    "name": "Opus 4.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-8",
    "name": "Opus 4.8",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-4-8-fast",
    "name": "Opus 4.8 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5",
    "name": "Opus 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5-5",
    "name": "Opus 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 872000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5-5-fast",
    "name": "Opus 5.5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 872000,
    "maxTokens": 128000
  },
  {
    "id": "claude-opus-5-fast",
    "name": "Opus 5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 867000,
    "maxTokens": 128000
  },
  {
    "id": "claude-sonnet-4-5-20250929",
    "name": "Sonnet 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 180000,
    "maxTokens": 32000
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Sonnet 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 931000,
    "maxTokens": 64000
  },
  {
    "id": "claude-sonnet-5",
    "name": "Sonnet 5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 872000,
    "maxTokens": 128000
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Sonnet 5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 872000,
    "maxTokens": 128000
  },
  {
    "id": "deepseek-v4-flash-0731",
    "name": "DeepSeek V4 Flash 0731",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "DeepSeek V4.1 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "deepseek-v4.1-flash-1017",
    "name": "DeepSeek V4.1 Flash 1017",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "garnet-07-15",
    "name": "Garnet 07/15 (Preview)",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3-flash-preview",
    "name": "Gemini 3 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3-pro-image-preview",
    "name": "Gemini 3 Pro Image",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "reasoning": false
  },
  {
    "id": "gemini-3.1-pro-preview",
    "name": "Gemini 3.1 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1000000,
    "maxTokens": 65536
  },
  {
    "id": "gemini-4-argon",
    "name": "Gemini 4 Argon",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 934464,
    "maxTokens": 65536
  },
  {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "glm-5.2-fast",
    "name": "GLM-5.2 Fast",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 393216,
    "maxTokens": 131072
  },
  {
    "id": "glm-5.3",
    "name": "GLM-5.3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "glm-5.3-flash",
    "name": "GLM-5.3-Flash",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 917504,
    "maxTokens": 131072
  },
  {
    "id": "gpt-5.2",
    "name": "GPT-5.2",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 272000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.3-codex",
    "name": "GPT-5.3-Codex",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 272000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.3-codex-fast",
    "name": "GPT-5.3-Codex Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 272000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.4-fast",
    "name": "GPT-5.4 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 Mini",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 272000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.4-mini-fast",
    "name": "GPT-5.4 Mini Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 272000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.5-fast",
    "name": "GPT-5.5 Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.5-pro",
    "name": "GPT-5.5 Pro",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.6-sol-fast",
    "name": "GPT-5.6 Sol Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-astra",
    "name": "GPT-6 Astra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-astra-ultrafast",
    "name": "GPT-6 Astra Ultra Fast",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-luna",
    "name": "GPT-6 Luna",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-luna-fast",
    "name": "GPT-6 Luna Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-sol",
    "name": "GPT-6 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6-sol-fast",
    "name": "GPT-6 Sol Fast Mode",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6.1-sol-ultrafast",
    "name": "GPT-6.1 Sol Ultra Fast",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-6.1-terra",
    "name": "GPT-6.1 Terra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 922000,
    "maxTokens": 128000
  },
  {
    "id": "gpt-image-2.5-flare",
    "name": "GPT Image 2.5 Flare",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "reasoning": false
  },
  {
    "id": "gpt-image-2.5-sunburst",
    "name": "GPT Image 2.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "reasoning": false
  },
  {
    "id": "grok-4.5",
    "name": "Grok 4.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 200000,
    "maxTokens": 63356
  },
  {
    "id": "grok-4.6",
    "name": "Grok 4.6",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 200000,
    "maxTokens": 63356
  },
  {
    "id": "grok-4.7",
    "name": "Grok 4.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 436644,
    "maxTokens": 63356
  },
  {
    "id": "inkling",
    "name": "Inkling",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 1007232,
    "maxTokens": 32768
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 196608,
    "maxTokens": 65536
  },
  {
    "id": "minimax-m2.7",
    "name": "MiniMax M2.7",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 196600,
    "maxTokens": 64000
  },
  {
    "id": "minimax-m3",
    "name": "MiniMax M3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 448000,
    "maxTokens": 64000
  },
  {
    "id": "mistral-large-4",
    "name": "Mistral Large 4",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 524288,
    "maxTokens": 64000
  },
  {
    "id": "mistral-medium-3.5",
    "name": "Mistral Medium 3.5",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 192000,
    "maxTokens": 64000
  },
  {
    "id": "muse-spark-1.2",
    "name": "Muse Spark 1.2",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "muse-spark-1.3",
    "name": "Muse Spark 1.3",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "muse-spark-open",
    "name": "Muse Spark Open",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 908928,
    "maxTokens": 131072
  },
  {
    "id": "nemotron-3-ultra",
    "name": "Nemotron 3 Ultra",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 136464,
    "maxTokens": 65536
  },
  {
    "id": "nemotron-3.5-super",
    "name": "Nemotron 3.5 Super",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 934464,
    "maxTokens": 65536
  },
  {
    "id": "qwen3.8-max",
    "name": "Qwen3.8 Max",
    "api": "factory-droid-agent",
    "provider": "factory-droid",
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
    "contextWindow": 131072,
    "maxTokens": 131072
  },
]
