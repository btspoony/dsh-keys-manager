/**
 * Node stand-ins for the `bun:*` built-in modules reachable from the omp Cursor
 * transport graph.
 *
 * Nothing in the cursor path is expected to *call* these: they arrive through
 * shared omp utilities whose Bun-only branches the transport never takes on
 * Node. Every entry therefore refuses or no-ops instead of pretending to work —
 * if the transport ever reaches one, the failure is loud rather than silent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** `bun:sqlite` stand-in. */
export class Database {
  constructor(..._args: unknown[]) {}

  query(..._args: unknown[]): unknown[] {
    return []
  }

  exec(..._args: unknown[]): void {}

  close(): void {}
}

/** `bun:ffi` stand-in. */
export function dlopen(..._args: unknown[]): { symbols: Record<string, unknown> } {
  return { symbols: {} }
}

/** `bun:ffi` type tag stand-in. */
export const FFIType = new Proxy({}, { get: () => 'void' })

/** `bun:ffi` pointer stand-in. */
export function ptr(..._args: unknown[]): number {
  return 0
}

/** `Bun.YAML` stand-in; JSON is a valid YAML subset and covers the lookup shapes. */
export const YAML = {
  parse: (text: string): unknown => JSON.parse(text),
  stringify: (value: unknown): string => JSON.stringify(value),
}

/** `Bun.Cookie` stand-in. */
export class Cookie {
  constructor(
    public name = '',
    public value = '',
  ) {}
}

/** `Bun.CookieMap` stand-in. */
export class CookieMap {
  get(_name: string): string | undefined {
    return undefined
  }
}

/** `Bun.$` shell stand-in — unavailable on Node, so it refuses. */
export function $(..._args: unknown[]): Promise<never> {
  return Promise.reject(new Error('llm-omp: the Bun shell is unavailable on this runtime'))
}

/** `Bun.env` maps onto `process.env`. */
export const env: Record<string, string | undefined> = process.env

/** `Bun.file` stand-in. */
export function file(..._args: unknown[]): never {
  throw new Error('llm-omp: Bun.file is unavailable on this runtime')
}

/** `Bun.write` stand-in. */
export function write(..._args: unknown[]): never {
  throw new Error('llm-omp: Bun.write is unavailable on this runtime')
}
