/**
 * The `pi-ai/src/stream` facade as the GitLab Duo entry needs it.
 *
 * `providers/gitlab-duo.ts` takes `ANTHROPIC_THINKING` and
 * `mapAnthropicToolChoice` from the facade, while the facade itself imports the
 * whole `providers/register-builtins` dispatch table. This module re-exports the
 * factory-droid lean copy (verbatim `OUTPUT_FALLBACK_BUFFER` and
 * `mapAnthropicToolChoice`) and adds `ANTHROPIC_THINKING` copied verbatim, so the
 * registry stays out of this graph.
 *
 * Both files are hashed in the manifest and the copied regions are asserted
 * verbatim by `tests/build-gitlab.test.ts`; on an omp bump the fix is a
 * mechanical re-copy.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-ai-stream-gitlab-duo
 */
import type { Effort } from '@oh-my-pi/pi-catalog/effort'

export { OUTPUT_FALLBACK_BUFFER, mapAnthropicToolChoice } from './pi-ai-stream-lean'

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};
// --- END PINNED REGION ------------------------------------------------------
