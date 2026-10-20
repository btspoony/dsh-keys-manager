/**
 * Node implementation of the `Bun` global object that the omp Cursor transport
 * graph reads directly (esbuild `inject` rewrites every free `Bun` identifier
 * to this module's export).
 *
 * Only the members the transport graph actually reaches are implemented, and
 * each one is faithful where its value is observable:
 *
 * - `env` / `write` / `SHA256` / `CryptoHasher` keep their real semantics and
 *   their container types — blob ids and content keys are SHA-256 digests the
 *   server round-trips, so a stand-in that produced different bytes (or handed
 *   back a `Uint8Array` where Bun returns an `ArrayBuffer`) would break
 *   blob-addressed turns and `instanceof ArrayBuffer` checks.
 * - `hash` is the one deliberate substitution: Bun hashes with wyhash, and this
 *   build chains FNV-1a. The transport uses that value only as an in-process
 *   turn digest (replay-vs-rebuild decisions), so a different-but-deterministic
 *   value degrades to "rebuild from content" across restarts instead of
 *   replaying a stale checkpoint. Upgrade path: vendor Bun's wyhash if a
 *   durable cross-process digest ever becomes load-bearing.
 *   The *value* is substituted; the *contract* is not: it returns a `number`
 *   like Bun (the u64 bit pattern as a double), so a digest serializes with
 *   `JSON.stringify` and compares numerically at every call site.
 *
 * @module @dsh-keys-manager/llm-omp/omp-shim/bun-global
 */
import { createHash, type BinaryLike, type BinaryToTextEncoding, type Hash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

/** Values Bun's hashing members accept as input. */
type HashInput = string | ArrayBuffer | ArrayBufferView

function toBytes(value: HashInput): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value)
}

function binaryLike(value: HashInput): BinaryLike {
  return typeof value === 'string' ? value : toBytes(value)
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/**
 * Coerce a Bun-style seed to the chain's `bigint` input.
 * `Math.trunc` keeps a fractional seed working, where `BigInt(seed)` alone throws.
 */
function toSeed(seed: number | bigint): bigint {
  return BigInt(Math.trunc(Number(seed)))
}

/** Deterministic 64-bit FNV-1a chain; `seed` continues a previous hash. */
function fnv1a64(value: HashInput, seed: number | bigint = 0): bigint {
  let hash = (FNV_OFFSET_BASIS ^ toSeed(seed)) & MASK_64
  for (const byte of toBytes(value)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64
  }
  return hash
}

/** The digest's own bytes as the `ArrayBuffer` Bun's hashing members return. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** SHA-256 helper mirroring `Bun.SHA256` (static `hash`, and an incremental form). */
export class SHA256 {
  readonly #hash = createHash('sha256')

  /**
   * Digest `data`; a `Uint8Array` target receives the raw bytes, a string target
   * is a `node:crypto` output encoding, and no target yields the digest's bytes
   * as an `ArrayBuffer` like Bun.
   */
  static hash(data: HashInput, target?: Uint8Array | string): string | Uint8Array | ArrayBuffer {
    const digest = createHash('sha256').update(binaryLike(data)).digest()
    if (target instanceof Uint8Array) {
      target.set(digest.subarray(0, target.length))
      return target
    }
    if (typeof target === 'string') return digest.toString(target as BinaryToTextEncoding)
    return exactBuffer(digest)
  }

  update(data: HashInput): this {
    this.#hash.update(binaryLike(data))
    return this
  }

  digest(encoding?: string): string | ArrayBuffer {
    if (encoding === undefined) return exactBuffer(this.#hash.digest())
    return this.#hash.digest(encoding as BinaryToTextEncoding)
  }
}

/** `Bun.CryptoHasher` stand-in backed by `node:crypto`. */
export class CryptoHasher {
  readonly #hash: Hash

  constructor(algorithm = 'sha256') {
    this.#hash = createHash(algorithm)
  }

  update(data: HashInput): this {
    this.#hash.update(binaryLike(data))
    return this
  }

  digest(encoding?: string): string | ArrayBuffer {
    if (encoding === undefined) return exactBuffer(this.#hash.digest())
    return this.#hash.digest(encoding as BinaryToTextEncoding)
  }
}

/** The `Bun` global surface the transport graph reads. */
export const Bun = {
  env: process.env,
  /**
   * See the module note: deterministic FNV-1a instead of wyhash, with Bun's
   * `number` return contract (the u64 bit pattern, not a `bigint`).
   */
  hash: (value: HashInput, seed: number | bigint = 0): number => Number(fnv1a64(value, seed) & MASK_64),
  SHA256,
  CryptoHasher,
  /** Write a file and report the byte count, like `Bun.write`. */
  write: async (destination: string, data: HashInput): Promise<number> => {
    const bytes = toBytes(data)
    await writeFile(destination, bytes)
    return bytes.byteLength
  },
}

export default Bun
