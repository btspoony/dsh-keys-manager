/**
 * Build-time stub for omp's `registry/api-key-validation` module.
 *
 * `registry/engine/oauth-code.ts` imports it for the `pasteKey` short-circuit:
 * a pasted value that starts with the rule's key prefix is validated against a
 * models endpoint instead of being exchanged for a token. The copied
 * `zai-coding-plan` rule declares no `pasteKey` (asserted by the drift test),
 * so that branch is unreachable in this bundle; carrying the real module would
 * add a second HTTP path with its own model list for no reachable behaviour.
 *
 * A reachable call therefore fails loudly instead of pretending to validate.
 *
 * @module dsh-keys-manager/omp-oauth/overrides/api-key-validation
 */

/** Unreachable `pasteKey` validation; throws when a rule starts declaring one. */
export async function validateApiKeyAgainstModelsEndpoint(): Promise<void> {
  throw new Error('omp-oauth: api-key paste validation is not bundled (no sign-in rule declares pasteKey)')
}
