/**
 * llm-omp Host half — the transport plugin for providers whose wire protocols
 * cannot be expressed through DSH's provider *configuration* surfaces.
 *
 * The plugin registers its own routes on the `llm` seam, so nothing here
 * depends on an upstream DSH change. This module holds the plugin identity
 * only: the `cursor` route, its authorization flow and its credential reads
 * land with the tasks that own them.
 *
 * @module @dsh-keys-manager/llm-omp
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * Plugin configuration.
 *
 * @remarks
 * Empty on purpose: a transport declares its endpoints and its pinned
 * client identity in code, so there is nothing for a profile to configure
 * yet. The runtime schema below keeps that contract explicit and gives the
 * loader a validated (empty) surface.
 */
export interface Config {}

/** Runtime schema for {@link Config}. */
export const Config = z.object({})

export const name = 'llm-omp'

/**
 * Sibling services this plugin reads. It registers adapter routes on `llm`;
 * `credentials` and `authorization` are added by the tasks that use them.
 */
export const inject = ['llm']

export function apply(_ctx: Context, _config: Config = {}): void {
  // Routes are registered per transport task; the skeleton intentionally
  // mounts as a no-op fiber so the bundle patch and the seam wiring can be
  // verified before any wire code exists.
}
