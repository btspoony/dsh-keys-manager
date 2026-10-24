/**
 * The `@oh-my-pi/pi-utils` surface the omp **GitLab Duo** proxy graph needs on top
 * of {@link module:dsh-llm-omp-transports/omp-shim/pi-utils}.
 *
 * The route bundles three production wire transports (Anthropic Messages, OpenAI
 * Responses, Chat Completions) and their shared helpers, so it reaches more of the
 * utility package than any other entry. Every member is re-exported from omp's
 * **real** implementation rather than reimplemented, matching the base shim's
 * rule; they live in this per-entry extension so the released artifacts stay
 * byte-identical.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-utils-gitlab-duo
 */
export { untilAborted } from '@oh-my-pi/pi-utils/abortable'
export {
  APP_NAME,
  APP_URL,
  USER_AGENT,
  getAppName,
  getInstallId,
  getProviderInFlightRoot,
} from './pi-utils-factory-droid'
export { $envpos } from '@oh-my-pi/pi-utils/env'
export { fetchWithRetry } from '@oh-my-pi/pi-utils/fetch-retry'
export { parseStreamingJson } from '@oh-my-pi/pi-utils/json-parse'
export { parseImageMetadata } from '@oh-my-pi/pi-utils/mime'
export { slugify } from '@oh-my-pi/pi-utils/slugify'
export { readJsonl, readSseEvents, readSseJson, readSseJsonOrText } from '@oh-my-pi/pi-utils/stream'
export { resolveExtraCa, withExtraCaInit } from '@oh-my-pi/pi-utils/tls-fetch'
export { asRecord } from '@oh-my-pi/pi-utils/type-guards'
// `cloneJsonTree` lives in the package barrel, whose import drags half of
// pi-utils; the base shim's `structuredCloneJSON` is the same operation for JSON
// data (the pin itself falls back to `structuredClone` for non-JSON values).
export { structuredCloneJSON as cloneJsonTree } from './pi-utils'

export * from './pi-utils'
