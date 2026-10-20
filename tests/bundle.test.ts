/**
 * Bundle wiring gate: the published `dsh-keys-manager` bundle mounts exactly
 * two components — itself and the separately published `dsh-llm-omp-transports`
 * package — and that package resolves from the workspace (it is a regular
 * dependency, not a devDependency, so installing keys-manager installs it) and
 * packs as a publishable package.
 *
 * The patch is read with a real YAML loader rather than matched as text: which
 * rows mount is a load decision, so any spelling the loader accepts must pass.
 * The loader-level proof — a packed profile's `--dump-config` tree — lives in
 * tests/install.test.ts.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The components one loader patch mounts, from its parsed `insert:` list. */
function mountedComponents(file: string): { id: string; name: string }[] {
  const [patch] = parse(readFileSync(file, 'utf8')) as [
    { insert?: { id: string; name: string }[] } | undefined,
  ]
  return (patch?.insert ?? []).map(row => ({ id: row.id, name: row.name }))
}

describe('bundle composition', () => {
  it('mounts the keys-manager plugin and the llm-omp transports component', () => {
    expect(mountedComponents(join(repoRoot, 'bundle/cordis.patch.yml'))).toEqual([
      { id: 'dsh-keys-manager', name: 'dsh-keys-manager' },
      { id: 'llm-omp-transports', name: 'dsh-llm-omp-transports' },
    ])
  })

  it('keeps the transports package mountable on its own', () => {
    expect(mountedComponents(join(repoRoot, 'packages/llm-omp/bundle/cordis.patch.yml'))).toEqual([
      { id: 'llm-omp-transports', name: 'dsh-llm-omp-transports' },
    ])
  })

  it('resolves and packs the published transports package', () => {
    const manifestPath = createRequire(import.meta.url).resolve('dsh-llm-omp-transports/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string }
    expect(manifest.name).toBe('dsh-llm-omp-transports')
    // Publishability by behaviour, not by manifest spelling: npm's own pack of
    // the package directory accepts the manifest and names the tarball the
    // manifest declares. `--ignore-scripts` keeps the test off the package's
    // prepack build; the packed contents are gated by packages/llm-omp's own
    // build test.
    const pack = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
      cwd: dirname(manifestPath),
      encoding: 'utf8',
    })
    const output = `${pack.stdout ?? ''}${pack.stderr ?? ''}`
    expect(pack.status, output).toBe(0)
    expect(output).toContain(`${manifest.name}-${manifest.version}.tgz`)
  })
})
