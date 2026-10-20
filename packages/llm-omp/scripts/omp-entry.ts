/**
 * Bundle entry for the omp Cursor transport.
 *
 * esbuild resolves `@oh-my-pi/pi-ai` from the workspace root's hoisted
 * `node_modules`; the build script swaps `@oh-my-pi/pi-utils` and `bun:*` for
 * the Node shims in `./omp-shim/`. Only the transport entry point is exported:
 * the artifact is an implementation detail of this plugin, not a public API.
 *
 * The type-only assertions at the bottom tie the hand-written mirror in
 * `src/omp.ts` to omp's real signatures, so drift fails `pnpm typecheck`
 * instead of surfacing when Task 3 wires the transport.
 *
 * @module @dsh-keys-manager/llm-omp/omp-entry
 */
import { streamCursor } from '@oh-my-pi/pi-ai/providers/cursor'
import type { CursorOptions } from '@oh-my-pi/pi-ai/providers/cursor'
import type { Model } from '@oh-my-pi/pi-catalog/types'

import type {
  CursorModelThinking,
  OmpAssistantMessageEvent,
  OmpCursorContext,
  OmpCursorModel,
  OmpCursorOptions,
} from '../src/omp.js'

export { streamCursor }

/** Fails typecheck while `T` is not `never`; `Drift` names the offending keys. */
type AssertNever<T extends never> = T

/** Keys `T` declares that `U` lacks or types incompatibly, ignoring optionality. */
type Drift<T, U> = Exclude<
  { [K in keyof T]: K extends keyof U ? (T[K] extends U[K] ? never : K) : K }[keyof T],
  undefined
>

type RealArgs = Parameters<typeof streamCursor>
type RealEvents = ReturnType<typeof streamCursor> extends AsyncIterable<infer E> ? E : never

/**
 * omp's thinking metadata with its closed unions relaxed: `mode` is
 * `ThinkingControlMode` and `efforts` is the nominal `Effort` const enum, while
 * the mirror keeps both as strings because the plugin only compares and
 * forwards them.
 */
type ThinkingMirror = Omit<NonNullable<Model['thinking']>, 'mode' | 'efforts'> & {
  readonly mode: string
  readonly efforts: readonly string[]
}

/* Every field the mirror builds or reads must still exist, with a type omp
 * still accepts. The transport reads no other `Model` field, so the mirror is a
 * subset on purpose and full `Model` assignability is not the contract. */
type _modelDrift = AssertNever<Drift<Omit<OmpCursorModel, 'thinking'>, Model<'cursor-agent'>>>
type _thinkingDrift = AssertNever<Drift<CursorModelThinking, ThinkingMirror>>
type _optionsDrift = AssertNever<Drift<OmpCursorOptions, CursorOptions>>
type _contextKeys = AssertNever<Exclude<keyof OmpCursorContext, keyof RealArgs[1]>>
type _eventTypes = AssertNever<Exclude<OmpAssistantMessageEvent['type'], RealEvents['type']>>
