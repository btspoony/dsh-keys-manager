/**
 * pi-utils surface the Antigravity ACP transport reaches: the base shim plus the
 * helpers and the ACP client that `host.ts`, `binary.ts` and `reconcile.ts`
 * import.
 *
 * The ACP client has no Bun dependency of its own, so it is re-exported from the
 * pin rather than reimplemented — same rule as the JSON/SSE helpers in the base
 * shim. The build's resolver skips imports that originate inside this directory,
 * so these specifiers still reach the real package.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-utils-antigravity
 */
export { ClientSideConnection, ndJsonStream, RequestError } from '@oh-my-pi/pi-utils/acp'
export * as prompt from '@oh-my-pi/pi-utils/prompt'
export { stableStringifyJson } from '@oh-my-pi/pi-utils/json'
export { $which } from '@oh-my-pi/pi-utils/which'
export { withFileLock } from '@oh-my-pi/pi-utils/file-lock'
export { getAntigravityCliDir } from '@oh-my-pi/pi-utils/dirs'

export * from './pi-utils'
