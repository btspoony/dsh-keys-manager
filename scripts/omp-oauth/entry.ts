/**
 * Bundle entry for the two omp sign-in flows this plugin drives.
 *
 * This file is the *only* place the root package reaches into `@oh-my-pi/*`,
 * and it never runs at plugin runtime: esbuild inlines the graph into
 * `lib/omp-oauth/oauth.mjs`, which `src/oauth/adapter.ts` loads lazily inside a
 * sign-in attempt. The published package depends on nothing from omp.
 *
 * Two exports, deliberately:
 *
 * - `loginKilo` — omp's device-style poll (`registry/oauth/kilo.ts`).
 * - `loginZaiCodingPlan` — omp's `oauth-code` engine bound to the *generated*
 *   `zai-coding-plan` policy slice (see `generate-policy.mjs`): authorize →
 *   paste the redirect URL → token exchange → `zai-mint-key` hook.
 *
 * The type assertions at the bottom tie both exports to omp's real controller /
 * credential contracts, so an omp bump that changes either shape fails
 * `pnpm typecheck` before it can fail mid-sign-in.
 *
 * @module dsh-keys-manager/omp-oauth/entry
 */
import { loginKilo } from '@oh-my-pi/pi-ai/oauth/kilo'
import { createOAuthCodeLogin } from '@oh-my-pi/pi-ai/registry/engine/oauth-code'
import type { OAuthController, OAuthCredentials } from '@oh-my-pi/pi-ai/registry/oauth/types'

import { ZAI_CODING_PLAN_POLICY, ZAI_CODING_PLAN_RULE } from './omp-oauth-policy.js'

export { loginKilo }

/** The declarative engine bound to the generated `zai-coding-plan` rule. */
export const loginZaiCodingPlan = createOAuthCodeLogin(ZAI_CODING_PLAN_RULE, ZAI_CODING_PLAN_POLICY)

/* The artifact's runtime contract: one controller in, one credential out. A
 * widening of omp's controller (a new required callback) would make these
 * assignments fail to compile, which is the drift signal this bundle needs. */
const _loginKiloContract: (ctrl: OAuthController) => Promise<OAuthCredentials> = loginKilo
const _loginZaiCodingPlanContract: (ctrl: OAuthController) => Promise<OAuthCredentials> = loginZaiCodingPlan
void _loginKiloContract
void _loginZaiCodingPlanContract
