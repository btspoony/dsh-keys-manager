/**
 * The lean substitute for `pi-ai/src/env-api-key`, used by the factory-droid
 * entry only (build substitution S2c, accepted by the PM as a substitution of an
 * unreachable path — **not** a shim).
 *
 * `env-api-key.ts` builds its `serviceProviderMap` at module scope from
 * `PROVIDER_REGISTRY`, which imports `pi-ai/src/registry/index` → the OAuth hook
 * table → `providers/gitlab-duo` → `stream` → all thirteen builtin providers. That
 * one spread is what kept the registry, `cursor.ts`, `cursor-proto.ts`,
 * `openai-codex-responses.ts`, `gitlab-duo-workflow.ts` and `amazon-bedrock.ts` in
 * this otherwise four-provider graph (3.75 MB of artifact for them).
 *
 * **What is dropped:** the registry-derived half of the map — the computed env-key
 * resolvers for providers that need a probe rather than a plain variable
 * (`foundry`/ADC, `bedrock` credential chains, the OAuth-backed providers). The
 * catalog half (`providerEntries()` from the KDL registry) and the legacy
 * hand-written keys stay, so every provider whose env fallback is a plain variable
 * still resolves exactly as before.
 *
 * **Why that is unreachable for this route:** `providers/factory-droid.ts` never
 * calls `getEnvApiKey`. It requires `options.apiKey` (the credential record's
 * token), trims it at `factory-droid.ts:540` and hands it to every wire as
 * `apiKey`; the three streams it consumes (`anthropic`, `openai-completions`,
 * `openai-responses`) only reach `getEnvApiKey` through their own
 * `options.apiKey ?? getEnvApiKey(model.provider)` fallback, which the supplied key
 * always short-circuits. `tests/build-factory-droid.test.ts` proves this at the
 * artifact boundary: with a poisoned environment and an explicit key, no env
 * variable is read and the wire carries the explicit key.
 *
 * On an omp bump the hashes of `env-api-key.ts`, `anthropic.ts`,
 * `openai-completions.ts` and `openai-responses.ts` change (drift gate), and the
 * re-copy is mechanical. If a bump ever makes this route rely on env resolution,
 * the contributing test below fails first.
 *
 * @module dsh-llm-omp-transports/omp-shim/env-api-key-lean
 */
import { providerEntries } from '@oh-my-pi/pi-catalog/compat/providers'

// From the shim module, not the bare package: imports that start inside
// `omp-shim/` are not redirected (that guard exists so the shims can re-export
// omp's real algorithms), so a bare specifier here would pull the real barrel —
// and with it `dirs`, `procmgr` and the native-addon loader.
import { $env, $pickenv } from './pi-utils'

type KeyResolver = string | (() => string | undefined)

/** Keys that are not modeled as registry provider defs (copied from the pin). */
const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  jina: 'JINA_API_KEY',
  brave: 'BRAVE_API_KEY',
  tinyfish: 'TINYFISH_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}

/** Env fallbacks derived from the catalog provider entries, as the pin does. */
const CATALOG_ENTRY_ENV_KEYS = Object.values(providerEntries()).flatMap(provider => {
  const envVars = provider.envVars
  if (!envVars || envVars.length === 0) return []
  const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars)
  return [[provider.id, resolver] as [string, KeyResolver]]
})

/** The pin's map minus the `PROVIDER_REGISTRY` spread (the dropped resolvers). */
const serviceProviderMap: Record<string, KeyResolver> = {
  ...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
  ...LEGACY_ENV_KEYS,
}

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}
// --- END PINNED REGION ------------------------------------------------------

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}
// --- END PINNED REGION ------------------------------------------------------

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}
// --- END PINNED REGION ------------------------------------------------------
