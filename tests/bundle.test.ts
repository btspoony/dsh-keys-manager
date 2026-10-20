/**
 * Bundle wiring gate: the published `dsh-keys-manager` bundle mounts exactly
 * two components — itself and the separately published `dsh-llm-omp-transports`
 * package — and that package resolves from the workspace (it is a regular
 * dependency, not a devDependency, so installing keys-manager installs it).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read the `- id:` / `name:` rows of a loader patch (`insert:` list). */
function insertRows(file: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = []
  let id: string | undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const nextId = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (nextId) {
      id = nextId[1]
      continue
    }
    const name = /^\s+name:\s*'([^']+)'\s*$/.exec(line)
    if (name && id !== undefined) {
      rows.push({ id, name: name[1] })
      id = undefined
    }
  }
  return rows
}

describe('bundle composition', () => {
  it('mounts the keys-manager plugin and the llm-omp transports component', () => {
    expect(insertRows(join(repoRoot, 'bundle/cordis.patch.yml'))).toEqual([
      { id: 'dsh-keys-manager', name: 'dsh-keys-manager' },
      { id: 'llm-omp-transports', name: 'dsh-llm-omp-transports' },
    ])
  })

  it('keeps the transports package mountable on its own', () => {
    expect(insertRows(join(repoRoot, 'packages/llm-omp/bundle/cordis.patch.yml'))).toEqual([
      { id: 'llm-omp-transports', name: 'dsh-llm-omp-transports' },
    ])
  })

  it('resolves the published transports package from the workspace', () => {
    const manifestPath = createRequire(import.meta.url).resolve('dsh-llm-omp-transports/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string
      version?: string
      private?: boolean
      publishConfig?: { access?: string }
    }
    expect(manifest.name).toBe('dsh-llm-omp-transports')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig).toEqual({ access: 'public' })
  })
})
