/**
 * Configured-provider entry tests.
 *
 * `settings.describe()` projects a plugin's resolved config through
 * `volatileForm` + `projectForm` over `plainConfig(cordis config)`: only fields
 * below a `.volatile()` node are visible, and the descriptor's `value` carries
 * the schema defaults. Consumers that list *configured* providers decide by
 * `getPath(namespace.value, ['providers', 'cursor'])`, so this file reproduces
 * that projection structurally — `@deepseek-ai/dsh-settings` exposes only its
 * seam, not the form helpers, and this package does not depend on it.
 */
import { describe, expect, it } from 'vitest'

import { Config, cursorCatalogModels } from '../src/index.js'
import { CURSOR_MODELS } from '../src/catalog/cursor.js'

/** The accessor key a schemastery volatile value carries (cosmokit). */
const VOLATILE = Symbol.for('cosmokit.volatile.write')

/** `plainConfig` from dsh-settings: detach the config and unwrap volatile nodes. */
function plainConfig(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && VOLATILE in value) {
    return plainConfig((value as unknown as { get(): unknown }).get())
  }
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/** The descriptor `value` settings projects for one user config. */
function describeValue(user: Record<string, unknown>): unknown {
  return plainConfig(Config(user))
}

/** Read a nested value by path, like the configured-provider predicate. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

describe('Config', () => {
  it('projects a default providers.cursor profile with no user write', () => {
    const value = describeValue({})

    expect(value).toEqual({ providers: { cursor: { models: [] } } })
    expect(getPath(value, ['providers', 'cursor'])).toBeDefined()
    // `configuredProvidersOf` keeps a provider when its settings path resolves.
    expect(getPath(value, ['providers', 'cursor']) !== undefined).toBe(true)
  })

  it('hands the running plugin a live providers reference', () => {
    // The loader updates a volatile reference in place instead of re-running
    // `apply`, so `apply` must read the allow-list through it.
    const resolved = Config({}) as unknown as { providers: { get(): unknown } }

    expect(resolved.providers.get()).toEqual({ cursor: { models: [] } })
  })

  it('keeps the providers node volatile so settings.describe projects it', () => {
    // volatileForm returns undefined for an object with no volatile field: the
    // descriptor would disappear and Cursor with it.
    expect((Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict.providers.meta.volatile).toBe(true)
  })

  it('resolves a user allow-list unchanged', () => {
    const models = [{ id: 'claude-4.5-sonnet', name: 'Claude Sonnet 4.5' }]

    expect(getPath(describeValue({ providers: { cursor: { models } } }), ['providers', 'cursor', 'models'])).toEqual(models)
  })
})

describe('cursorCatalogModels', () => {
  it('projects every catalog row as an id/name pair', () => {
    const models = cursorCatalogModels()

    expect(models).toHaveLength(CURSOR_MODELS.length)
    expect(models[0]).toEqual({ id: CURSOR_MODELS[0]!.id, name: CURSOR_MODELS[0]!.name })
    expect(Object.keys(models[0]!)).toEqual(['id', 'name'])
  })
})
