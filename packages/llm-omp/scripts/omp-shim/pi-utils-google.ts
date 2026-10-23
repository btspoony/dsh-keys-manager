/**
 * The `@oh-my-pi/pi-utils` surface the omp **Google** transport graph needs on
 * top of {@link module:dsh-llm-omp-transports/omp-shim/pi-utils}.
 *
 * The Cloud Code Assist provider reads two helpers the Cursor and Devin graphs
 * never reach — `readSseJson` (SSE `data:` framing) and `fetchWithRetry`
 * (bounded retries with `Retry-After` handling). Both are re-exported from
 * omp's real implementations rather than reimplemented, for the same reason the
 * JSON parser is: a stand-in that framed events or retried differently would
 * surface as a dropped turn, not as a decode error.
 *
 * They live in this per-entry extension instead of the shared shim so an entry
 * that never calls them (cursor, devin) does not even import their modules —
 * which keeps those artifacts byte-identical to the release that predates the
 * Google route.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-utils-google
 */
export { fetchWithRetry } from '@oh-my-pi/pi-utils/fetch-retry'
export { readSseJson } from '@oh-my-pi/pi-utils/stream'

export * from './pi-utils'
