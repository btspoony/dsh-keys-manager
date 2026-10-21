/**
 * Install/load integration: the packed `dsh-keys-manager` tarball installs into
 * a temp DSH profile, resolves its `dsh-llm-omp-transports` dependency, and the
 * composed `--dump-config` tree carries BOTH loader rows — the loader-level
 * proof that one installed plugin mounts two components.
 *
 * Not covered: the plugin-manager detail page/toggles (DSH's own Web UI) and
 * any Cursor network behavior.
 *
 * Skips when `pnpm` or `dsh` is missing unless `INSTALL_PROOF=required`, which
 * only the dedicated CI proof step sets — there a missing one fails the run
 * instead (see the prerequisite test below), because that proof is evidence, not
 * an optional convenience. Release workflows run the plain suite without that
 * flag, so they skip the proof rather than fail before publishing. The run needs
 * no registry access: both
 * tarballs are packed locally, the root's transports dependency range is
 * overridden to the local tarball, and DSH peers are not auto-installed.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
/** The transport versions independently; the packed range must follow it. */
const transportsVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages/llm-omp/package.json'), 'utf8'),
).version as string
const missing = ['pnpm', 'dsh'].filter(
  command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0,
)
const canInstall = missing.length === 0

if (!canInstall) console.warn(`install.test: skipped — not on PATH: ${missing.join(', ')}`)

describe('install/load proof prerequisites', () => {
  it('has pnpm and dsh on PATH when the proof is required', () => {
    // Only the dedicated CI proof step sets INSTALL_PROOF=required; it installs a
    // pinned dsh beforehand, so a missing one means the only install/load
    // evidence would be skipped: fail instead. Everywhere else (local runs, the
    // release workflows' plain `pnpm run test`) a missing tool is just a skip.
    if (process.env.INSTALL_PROOF !== 'required') return
    expect(missing, `install/load proof cannot run: missing ${missing.join(', ')}`).toEqual([])
  })
})

describe.skipIf(!canInstall)('install/load integration (packed profile)', () => {
  it('mounts both bundle components in a fresh profile', () => {
    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-install.mjs')], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    })
    const report = `${run.stdout ?? ''}${run.stderr ?? ''}`

    expect(run.status, report).toBe(0)

    // 1. `pnpm pack` rewrote the workspace dependency to a registry range.
    expect(report).toContain(`install-proof: packed dependency dsh-llm-omp-transports -> ^${transportsVersion}`)

    // 2. The profile's dependency tree has both packages.
    expect(report).toContain('install-proof: both components installed: dsh-keys-manager@')
    expect(report).toContain(' + dsh-llm-omp-transports@')

    // 3. The loader composes exactly two rows, not a single component only.
    expect(report).toContain('  - id: dsh-keys-manager\n    name: dsh-keys-manager')
    expect(report).toContain('  - id: llm-omp-transports\n    name: dsh-llm-omp-transports')
    expect(report).toContain('install-proof: OK')
  }, 600_000)
})
