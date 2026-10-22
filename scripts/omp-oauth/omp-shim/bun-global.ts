/**
 * Node implementation of the `Bun` global object the omp sign-in graph reads
 * directly (esbuild `inject` rewrites every free `Bun` identifier to this
 * module's export).
 *
 * The sign-in paths need one member — `Bun.sleep` in the Kilo device poll — and
 * the members the shared omp modules touch on load. Each is faithful where its
 * value is observable; the hashing members keep Bun's container types (an
 * `ArrayBuffer` where Bun returns one), because call sites compare them.
 *
 * `BUN_MEMBERS` is the recorded surface: the build writes it into
 * `omp-manifest.json.bunSurface`, so a member disappearing is a manifest diff.
 *
 * @module dsh-keys-manager/omp-oauth/omp-shim/bun-global
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

/** The digest's own bytes as the `ArrayBuffer` Bun's hashing members return. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** SHA-256 helper mirroring `Bun.SHA256`. */
export class SHA256 {
  readonly #hash = createHash('sha256')

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

/** The `Bun` global surface the sign-in graph reads. */
export const Bun = {
  env: process.env,
  /** Resolve after `ms`; the Kilo device poll paces itself with this. */
  sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
  /**
   * Deterministic 64-bit hash. `simplify:` Bun uses wyhash; this chains
   * SHA-256 into a `number` (Bun's return contract). The sign-in flows only
   * read it through shared helpers that no flow branches on.
   */
  hash: (value: HashInput): number => {
    const digest = createHash('sha256').update(binaryLike(value)).digest()
    return digest.readUInt32BE(0)
  },
  SHA256,
  CryptoHasher,
  /** Write a file and report the byte count, like `Bun.write`. */
  write: async (destination: string, data: HashInput): Promise<number> => {
    const bytes = toBytes(data)
    await writeFile(destination, bytes)
    return bytes.byteLength
  },
}

/** The members {@link Bun} provides; the build records this as `bunSurface`. */
export const BUN_MEMBERS = ['env', 'sleep', 'hash', 'SHA256', 'CryptoHasher', 'write'] as const

export default Bun
