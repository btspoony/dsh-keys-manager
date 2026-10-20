/**
 * llm-omp-transports Host half — the transport plugin for providers whose wire protocols
 * cannot be expressed through DSH's provider *configuration* surfaces.
 *
 * The plugin registers its own routes on the `llm` seam, so nothing here
 * depends on an upstream DSH change. This module holds the plugin identity
 * only: the `cursor` adapter, its authorization flow and its credential reads
 * are registered by Task 3 of the plan that owns this increment.
 *
 * @module dsh-llm-omp-transports
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

export const name = 'llm-omp-transports'

/**
 * Sibling services this plugin reads. It registers adapter routes on `llm`;
 * `credentials` and `authorization` are added by the tasks that use them.
 */
export const inject = ['llm']

export function apply(_ctx: Context, _config: Config = {}): void {
  // Intentionally inert in this increment: the adapter, the projection and the
  // catalog are in place, and Task 3 registers the adapter and its
  // authorization flow here.
}
