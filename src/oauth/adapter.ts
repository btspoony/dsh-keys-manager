/**
 * The one module that knows where the build-time omp sign-in bundle lives.
 *
 * `scripts/omp-oauth/build-oauth.mjs` inlines the two omp login flows into
 * `lib/omp-oauth/oauth.mjs`; nothing else in `src/` may reference that artifact.
 * The specifier is built from `import.meta.url` and held in a variable so `tsc`
 * and any bundler cannot follow it: from `lib/oauth/adapter.js` it resolves to
 * `lib/omp-oauth/oauth.mjs`, and under `vitest` (which runs `src/`) it resolves
 * to a path that does not exist — which is exactly why the host takes an
 * injectable adapter and no unit test ever loads the real artifact.
 *
 * The load is cached: a sign-in attempt may run repeatedly, and the artifact is
 * one static module. A failed load is cached too — a missing artifact is a
 * packaging defect, not a transient condition.
 *
 * @module dsh-keys-manager/oauth/adapter
 */

/** The controller surface omp's flows call back into. */
export interface OmpOAuthController {
  onAuth?: (info: { url: string; launchUrl?: string; instructions?: string }) => void
  onProgress?: (message: string) => void
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>
  onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean }) => Promise<string>
  signal?: AbortSignal
  fetch?: typeof fetch
}

/** The credential omp's flows resolve with (static tokens carry `refresh: ''`). */
export interface OmpOAuthCredentials {
  access: string
  refresh: string
  expires: number
}

/** The two drivers the artifact exports, and nothing else. */
export interface OmpOAuthAdapter {
  loginKilo(controller: OmpOAuthController): Promise<OmpOAuthCredentials>
  loginZaiCodingPlan(controller: OmpOAuthController): Promise<OmpOAuthCredentials>
}

/** The artifact is absent or does not export the expected drivers. */
export class OmpOAuthBundleMissingError extends Error {
  constructor(cause: unknown) {
    super(
      'The bundled omp sign-in flows are missing from this build; run `pnpm build` (lib/omp-oauth/oauth.mjs) '
        + 'or reinstall the package',
      { cause },
    )
    this.name = 'OmpOAuthBundleMissingError'
  }
}

/** Variable specifier: `tsc` and bundlers must not resolve the build artifact. */
const ARTIFACT = new URL('../omp-oauth/oauth.mjs', import.meta.url).href

let load: Promise<OmpOAuthAdapter> | undefined

async function loadArtifact(): Promise<OmpOAuthAdapter> {
  let module: Partial<OmpOAuthAdapter>
  try {
    module = (await import(ARTIFACT)) as Partial<OmpOAuthAdapter>
  } catch (cause) {
    throw new OmpOAuthBundleMissingError(cause)
  }
  if (typeof module.loginKilo !== 'function' || typeof module.loginZaiCodingPlan !== 'function') {
    throw new OmpOAuthBundleMissingError(new Error('the artifact does not export both sign-in drivers'))
  }
  return { loginKilo: module.loginKilo, loginZaiCodingPlan: module.loginZaiCodingPlan }
}

/** Load (once) and return the bundled omp sign-in drivers. */
export function ompOAuthAdapter(): Promise<OmpOAuthAdapter> {
  load ??= loadArtifact()
  return load
}
