/**
 * Recorded-event fixture helpers for the Cursor adapter tests.
 *
 * Each fixture is a JSONL script of omp `AssistantMessageEvent`s: one event per
 * line, in stream order. A script stands for one recorded turn — the same shape
 * omp pushes over a real `Run` stream, with the wire frames already decoded:
 * a text/reasoning block lifecycle plus the terminal `done`/`error` carrying
 * the assembled message and usage.
 *
 * The transport is scripted, not recorded from the network: the plan forbids
 * live endpoints, and the adapter under test only consumes this event level.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  OmpAssistantMessageEvent,
  OmpCursorContext,
  OmpCursorModel,
  OmpCursorOptions,
  OmpCursorTransport,
} from '../src/omp.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** One transport invocation, captured for assertions about the projected request. */
export interface TransportCall {
  readonly model: OmpCursorModel
  readonly context: OmpCursorContext
  readonly options: OmpCursorOptions
}

/** Parse one JSONL fixture into its event script. */
export function recordedScript(name: string): OmpAssistantMessageEvent[] {
  return readFileSync(join(fixturesDir, name), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as OmpAssistantMessageEvent
      } catch {
        throw new Error(`fixture ${name} line ${index + 1} is not JSON`)
      }
    })
}

/**
 * Build a transport that replays one fixture and records each invocation.
 * @param name - fixture file name under `tests/fixtures/`.
 * @returns the scripted transport plus the calls it received.
 */
export function scriptedTransport(name: string): { transport: OmpCursorTransport; calls: TransportCall[] } {
  const script = recordedScript(name)
  const calls: TransportCall[] = []
  return {
    calls,
    transport: async function* (model, context, options) {
      calls.push({ model, context, options })
      yield* script
    },
  }
}
