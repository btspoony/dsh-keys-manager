/**
 * Which providers this plugin can sign in to, and with which omp driver.
 *
 * This table is the *second* source of the account-capability verdict in
 * `src/index.ts`: the first is the Harness authorization seam's flow list
 * (`llm-pi-ai/<provider>`). A sign-in listed here runs in-process — see
 * `.mstar/sdd/issue15-batch2/oauth-clients-design.md` §4.6 for why the seam's
 * `registerFlow` cannot express a per-account-row pool.
 *
 * Both drivers mint a *static* credential (a one-year bearer, a durable
 * `id.secret` key), so their output lands in the pool as an ordinary api-key
 * row and never as a refreshable grant.
 *
 * @module dsh-keys-manager/oauth/providers
 */

/** One sign-in-capable provider: the omp driver it runs and its display label. */
export interface SignInProvider {
  /** The exported driver inside `lib/omp-oauth/oauth.mjs`. */
  readonly driver: 'kilo' | 'zai-coding-plan'
  /** Human label used in notices and the default row alias. */
  readonly label: string
}

/**
 * Provider id → its sign-in. The ids are the *routes* the credentials serve,
 * which for `zai` is the shipped DSH route (the omp flow is `zai-coding-plan`).
 */
export const SIGN_IN_PROVIDERS: Readonly<Record<string, SignInProvider>> = Object.freeze({
  kilo: { driver: 'kilo', label: 'Kilo' },
  zai: { driver: 'zai-coding-plan', label: 'Z.AI (GLM Coding Plan)' },
})

/** Whether this plugin can obtain a credential for `provider` by signing in. */
export function signInCapable(provider: string): boolean {
  // Own-property check: a plain-object index would answer `true` for
  // `constructor`, `toString` or `__proto__` and hand a function to the driver.
  return Object.hasOwn(SIGN_IN_PROVIDERS, provider)
}

/** The sign-in driver for `provider`, or `undefined` when it is not supported. */
export function signInProvider(provider: string): SignInProvider | undefined {
  return Object.hasOwn(SIGN_IN_PROVIDERS, provider) ? SIGN_IN_PROVIDERS[provider] : undefined
}
