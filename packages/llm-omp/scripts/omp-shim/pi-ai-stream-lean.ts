/**
 * The lean substitute for omp's `pi-ai/src/stream` facade, used by the Factory
 * Droid entry and — through the GitLab Duo copy that adds `ANTHROPIC_THINKING` —
 * the Duo proxy entry (build substitution S2b).
 *
 * `providers/factory-droid.ts` and `providers/anthropic.ts` take one helper each
 * from the facade (`mapAnthropicToolChoice`, `OUTPUT_FALLBACK_BUFFER`), but the
 * facade also imports the whole `providers/register-builtins` dispatch table —
 * which is the second half of the retention edge S2 prunes. Redirecting those two
 * imports here keeps the facade (and the ten providers behind it) out of the
 * graph while the copied code stays omp's own.
 *
 * Nothing is reimplemented: the block between the markers is a
 * character-for-character copy of `@oh-my-pi/pi-ai/src/stream.ts`, asserted by
 * `tests/build-factory-droid.test.ts`, and both source hashes are drift-gated.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-ai-stream-lean
 */
import type { AnthropicOptions } from '@oh-my-pi/pi-ai/providers/anthropic'
import type { ToolChoice } from '@oh-my-pi/pi-ai/types'

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export const OUTPUT_FALLBACK_BUFFER = 4000;
// --- END PINNED REGION ------------------------------------------------------

// --- BEGIN PINNED REGION (verbatim; do not edit by hand) ---------------------
export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}
// --- END PINNED REGION ------------------------------------------------------
