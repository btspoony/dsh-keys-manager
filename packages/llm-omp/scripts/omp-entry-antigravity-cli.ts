/**
 * Bundle entry for omp's Antigravity ACP transport.
 *
 * The route runs the official `agy` CLI over ACP; the bundle carries the provider
 * graph (host, reconcile, MCP bridge) and the managed-install path, and the
 * artifact still imports nothing but Node builtins.
 *
 * @module dsh-llm-omp-transports/omp-entry-antigravity-cli
 */
import { streamAntigravityCli } from '@oh-my-pi/pi-ai/providers/antigravity-cli'

export { streamAntigravityCli }
