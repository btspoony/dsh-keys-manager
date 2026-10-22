/**
 * Build-time stub for `@oh-my-pi/pi-natives`' `NativeOAuthCallback`.
 *
 * omp's callback server imports the native desktop helper at module scope to
 * capture a custom URI scheme (`zcode://…`). The copied `zai-coding-plan` rule
 * sets `callback.nativeScheme: false`, and the flow is `manualOnly`, so the
 * helper is never constructed: the user pastes the redirect URL instead. This
 * stub keeps the module graph resolvable on a headless host without shipping a
 * native addon.
 *
 * Constructing it fails loudly, which is the correct outcome: it would mean a
 * rule asked for an OS URI handler this host cannot provide.
 *
 * @module dsh-keys-manager/omp-oauth/overrides/pi-natives
 */

/** Unreachable native callback receiver; throws when a rule asks for one. */
export class NativeOAuthCallback {
  constructor(_options: { scheme: string }) {
    throw new Error('omp-oauth: native URI-scheme callbacks are not available on this host')
  }
}
