/**
 * `@oh-my-pi/pi-natives` surface the ACP entry reaches: the OS file lock that
 * `withFileLock` takes around an agy install, and the Windows long-path helper
 * `dirs.ts` imports.
 *
 * Both are implemented here because the published artifact must not load a
 * native addon. The lock is a real exclusive create (`O_EXCL`) with the same
 * acquire/release contract; `expandWindowsLongPath` is the identity, which is
 * what the helper does for every path that is not a Windows long path — the
 * managed agy directory is short.
 *
 * @module dsh-llm-omp-transports/omp-shim/pi-natives
 */
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs'

/** Identity on every platform: the agy install path never hits the 260-char limit. */
export function expandWindowsLongPath(path: string): string {
  return path
}

/** One held lock: an exclusively created file that is removed on release. */
export class FileLock {
  readonly #path: string
  readonly #fd: number

  private constructor(path: string, fd: number) {
    this.#path = path
    this.#fd = fd
  }

  /** Take the lock, or `null` when another holder has it. */
  static tryAcquire(path: string): FileLock | null {
    try {
      return new FileLock(path, openSync(path, 'wx'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
  }

  /** Whether some holder owns the lock path. */
  static isHeld(path: string): boolean {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  }

  release(): void {
    try {
      closeSync(this.#fd)
    } catch {
      // A closed descriptor is already released.
    }
    try {
      unlinkSync(this.#path)
    } catch {
      // A lock removed by the OS is still released.
    }
  }
}
