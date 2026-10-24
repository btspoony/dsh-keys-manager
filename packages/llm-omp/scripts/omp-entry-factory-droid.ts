/**
 * Bundle entry for the omp Factory Droid transport.
 *
 * The fourth entry: esbuild inlines the pinned `providers/factory-droid` graph,
 * the build swaps `@oh-my-pi/pi-utils` and `bun:*` for the shims in
 * `./omp-shim/`, and only the transport entry point is exported. This entry
 * additionally runs the two entry-scoped build substitutions in
 * `build-omp.mjs` (empty catalog data, lean provider registry), which is why its
 * graph is 4 MB instead of 17 MB; see `tests/build-factory-droid.test.ts`.
 *
 * @module dsh-llm-omp-transports/omp-entry-factory-droid
 */
import { streamFactoryDroid } from '@oh-my-pi/pi-ai/providers/factory-droid'

export { streamFactoryDroid }
