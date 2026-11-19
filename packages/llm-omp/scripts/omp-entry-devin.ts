/**
 * Bundle entry for the omp Devin transport.
 *
 * The twin of `omp-entry.ts`: esbuild resolves `@oh-my-pi/pi-ai` from the
 * workspace root's hoisted `node_modules`, the build script swaps
 * `@oh-my-pi/pi-utils` and `bun:*` for the Node shims in `./omp-shim/`, and
 * only the transport's two entry points are exported: the chat stream and the
 * account-scoped catalog read (`GetCliModelConfigs`) the route's roster comes
 * from.
 *
 * The type-only assertions tie the hand-written mirror in `src/omp.ts` to
 * omp's real signatures, so drift fails `pnpm typecheck` instead of surfacing
 * when the adapter wires the transport.
 *
 * @module dsh-llm-omp-transports/omp-entry-devin
 */
import { fetchDevinModels } from '@oh-my-pi/pi-catalog/discovery/devin'
import type { DevinModelDiscoveryOptions } from '@oh-my-pi/pi-catalog/discovery/devin'
import { streamDevin } from '@oh-my-pi/pi-ai/providers/devin'
import type { DevinOptions } from '@oh-my-pi/pi-ai/providers/devin'
import type { Model, ModelSpec } from '@oh-my-pi/pi-catalog/types'

import type {
  DevinModelCompat,
  OmpAssistantMessageEvent,
  OmpContext,
  OmpDevinDiscoveredModel,
  OmpDevinDiscoveryOptions,
  OmpDevinModel,
  OmpDevinOptions,
} from '../src/omp.js'

/*
 * Two exports: the chat stream, and the account-scoped catalog read
 * (`GetCliModelConfigs`). The route's model table is credential-scoped, so the
 * committed catalog can only hold the seed; the real roster is discovered here
 * at runtime with the signed-in grant.
 */
export { fetchDevinModels, streamDevin }

/** Fails typecheck while `T` is not `never`; `Drift` names the offending keys. */
type AssertNever<T extends never> = T

/** Keys `T` declares that `U` lacks or types incompatibly, ignoring optionality. */
type Drift<T, U> = Exclude<
  { [K in keyof T]: K extends keyof U ? (T[K] extends U[K] ? never : K) : K }[keyof T],
  undefined
>

type RealArgs = Parameters<typeof streamDevin>
type RealEvents = ReturnType<typeof streamDevin> extends AsyncIterable<infer E> ? E : never
type RealDiscovered = NonNullable<Awaited<ReturnType<typeof fetchDevinModels>>>[number]

/* Every field the mirror builds or reads must still exist, with a type omp
 * still accepts. The transport reads no other `Model` field, so the mirror is a
 * subset on purpose and full `Model` assignability is not the contract. */
type _modelDrift = AssertNever<Drift<OmpDevinModel, Model<'devin-agent'>>>
/* `ResolvedDevinCompat` must keep exactly the trio the generated rows carry. */
type _compatDrift = AssertNever<Drift<DevinModelCompat, Model<'devin-agent'>['compat']>>
type _optionsDrift = AssertNever<Drift<OmpDevinOptions, DevinOptions>>
type _contextKeys = AssertNever<Exclude<keyof OmpContext, keyof RealArgs[1]>>
type _eventTypes = AssertNever<Exclude<OmpAssistantMessageEvent['type'], RealEvents['type']>>
/* The discovered-row mirror is a subset of what the RPC returns. */
type _discoveredDrift = AssertNever<Drift<OmpDevinDiscoveredModel, RealDiscovered>>
type _discoveryOptionsDrift = AssertNever<Drift<OmpDevinDiscoveryOptions, DevinModelDiscoveryOptions>>
