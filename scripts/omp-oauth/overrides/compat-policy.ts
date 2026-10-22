/**
 * Build-time stub for `@oh-my-pi/pi-catalog/compat/behavior`.
 *
 * omp's `utils/retry-after.ts` (reached from the shared error graph) asks the
 * compiled catalog for a provider's retry-reset timezone. Answering it for real
 * drags `rules.json` — 467 KB of unrelated provider policy — into this bundle,
 * and the only consumer is a retry hint that decorates an error message the
 * sign-in surface renders as plain text. DSH owns retry policy for the routes
 * these credentials feed.
 *
 * Returning `undefined` means "no catalog timezone rule", which is exactly what
 * omp answers for a provider without one. If a future flow branches on this
 * value, drop the substitution and accept the catalog bytes instead.
 *
 * @module dsh-keys-manager/omp-oauth/overrides/compat-policy
 */

/** No catalog-declared retry-reset timezone; retry hints stay unparsed. */
export function retryResetTimezoneOffsetFor(_provider: string): string | undefined {
  return undefined
}
