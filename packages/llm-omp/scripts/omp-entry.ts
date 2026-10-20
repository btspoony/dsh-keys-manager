/**
 * Bundle entry for the omp Cursor transport.
 *
 * esbuild resolves `@oh-my-pi/pi-ai` from the workspace root's hoisted
 * `node_modules`; the build script swaps `@oh-my-pi/pi-utils` and `bun:*` for
 * the Node shims in `./omp-shim/`. Only the transport entry point is exported:
 * the artifact is an implementation detail of this plugin, not a public API.
 *
 * @module @dsh-keys-manager/llm-omp/omp-entry
 */
import { streamCursor } from '@oh-my-pi/pi-ai/providers/cursor'

export { streamCursor }
