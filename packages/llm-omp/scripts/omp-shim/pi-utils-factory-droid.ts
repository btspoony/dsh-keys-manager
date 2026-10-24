/**
 * The `@oh-my-pi/pi-utils` surface the omp **Factory Droid** transport graph needs
 * on top of {@link module:dsh-llm-omp-transports/omp-shim/pi-utils}.
 *
 * The provider multiplexes four wires, so it reaches more of the utility package
 * than the cursor/devin/google graphs: the SSE framers (`readSseJson`,
 * `readSseEvents`, `readSseJsonOrText` for its native Gemini wire), bounded
 * retries (`fetchWithRetry`), the extra-CA TLS wrappers, image metadata for the
 * vision guard, streaming JSON, app/install identity and the slugifier. Every
 * member is re-exported from omp's **real** implementation rather than
 * reimplemented — the same rule the base shim states — so the bundled behaviour
 * is the pinned behaviour.
 *
 * They live in this per-entry extension instead of the shared shim so the three
 * released artifacts stay byte-identical (the Google precedent).
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-utils-factory-droid
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { getAgentDir } from './pi-utils'

export { untilAborted } from '@oh-my-pi/pi-utils/abortable'

/**
 * The six `dirs` members this graph reads, implemented here instead of importing
 * `@oh-my-pi/pi-utils/dirs`.
 *
 * `dirs.ts` pulls `@oh-my-pi/pi-natives`, whose module scope loads a platform
 * native addon: bundled, that is a `bun:ffi` import that cannot run under plain
 * Node, and this artifact must import with `Bun` absent. The values are the
 * pinned ones, not new policy: `APP_NAME`/`APP_URL` are the pin's constants and
 * `USER_AGENT` is the pin's `omp/<version>` string built from its own manifest,
 * so a header this graph sends is byte-identical to omp's.
 *
 * `getInstallId` is a `simplify:` stand-in: the pin persists a UUID at
 * `~/.omp/install-id`; this process keeps one in memory, because the transport
 * must not write to a user's home directory for an id that only feeds telemetry
 * attribution.
 */
/** App label omp stamps into usage-attribution headers. */
export const APP_NAME: string = 'omp'
/** Public homepage omp credits its traffic to. */
export const APP_URL: string = 'https://omp.sh/'
/**
 * Default `User-Agent`, exactly the pin's `omp/<version>`.
 *
 * The literal is drift-gated: `tests/build-factory-droid.test.ts` asserts the
 * artifact carries `omp/<manifest.piUtilsVersion>`, so a pin bump that changes
 * the version fails the gate instead of shipping a stale identity. (This route's
 * own wire sends `factory-cli/<version>`; the value is only read by the shared
 * header helpers of the providers it borrows.)
 */
export const USER_AGENT = 'omp/18.12.3'

/** Application label for usage attribution, honouring the pin's `OMP_APP_NAME`. */
export function getAppName(): string {
  const value = process.env.OMP_APP_NAME?.trim()
  return value ? value : APP_NAME
}

let cachedInstallId: string | undefined

/** Per-process install id (the pin persists one; this does not write disk). */
export function getInstallId(): string {
  cachedInstallId ??= randomUUID()
  return cachedInstallId
}

/** The provider in-flight directory, under the agent dir this shim resolves. */
export function getProviderInFlightRoot(): string {
  return join(getAgentDir(), 'run', 'provider-inflight')
}
export { $envpos } from '@oh-my-pi/pi-utils/env'
export { fetchWithRetry } from '@oh-my-pi/pi-utils/fetch-retry'
// `cloneJsonTree` lives in the package barrel, and importing the barrel drags
// `dirs`, `file-lock`, `procmgr`, `sqlite` and the native-addon loader into the
// graph. The base shim's `structuredCloneJSON` is the same operation for JSON
// data (and the pin itself falls back to `structuredClone` for non-JSON values),
// so the name is mapped onto it instead.
export { structuredCloneJSON as cloneJsonTree } from './pi-utils'
export { parseStreamingJson } from '@oh-my-pi/pi-utils/json-parse'
export { parseImageMetadata } from '@oh-my-pi/pi-utils/mime'
export { slugify } from '@oh-my-pi/pi-utils/slugify'
export { readJsonl, readSseEvents, readSseJson, readSseJsonOrText } from '@oh-my-pi/pi-utils/stream'
export { resolveExtraCa, withExtraCaInit } from '@oh-my-pi/pi-utils/tls-fetch'
export { asRecord } from '@oh-my-pi/pi-utils/type-guards'

export * from './pi-utils'
