/**
 * `bun:sqlite` surface the Antigravity ACP transport reaches: agy's own
 * conversation store, read for checkpoints and copied on a rewind.
 *
 * Backed by Node's `node:sqlite`, which is the same SQLite engine, so the reads
 * see the bytes agy wrote. The wrapper keeps Bun's call shapes —
 * `db.query(sql).all()/.get()`, `db.transaction(fn)`, `db.close()` — because the
 * transport uses those, not Node's `prepare` form.
 *
 * @module dsh-llm-omp-transports/omp-shim/bun-sqlite
 */
import { DatabaseSync } from 'node:sqlite'

/** Options Bun accepts when opening a store. */
export interface DatabaseOptions {
  readonly?: boolean
  create?: boolean
  readwrite?: boolean
}

/** One prepared statement, in the shape the transport calls. */
interface Query {
  all(): unknown[]
  get(): unknown
}

/** `bun:sqlite`'s `Database`, backed by `node:sqlite`. */
export class Database {
  readonly #db: DatabaseSync

  constructor(path: string, options: DatabaseOptions = {}) {
    this.#db = new DatabaseSync(path, {
      readOnly: options.readonly === true,
    })
  }

  query(sql: string): Query {
    const statement = this.#db.prepare(sql)
    return {
      all: () => statement.all() as unknown[],
      get: () => statement.get() as unknown,
    }
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  /** Run `fn` inside one transaction, as Bun's `db.transaction(fn)()` does. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.#db.exec('BEGIN')
      try {
        const result = fn()
        this.#db.exec('COMMIT')
        return result
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    this.#db.close()
  }
}
