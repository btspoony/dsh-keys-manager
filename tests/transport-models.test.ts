/**
 * Transport model picker shaping: the host payload becomes picker rows, the
 * empty allow-list keeps its "all models" meaning, and the copy the collapsed
 * area renders exists in both packaged locales.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { modelPickerRows, shapeTransportModels } from '../src/client/format'
import { LOCALE_DICTS } from '../src/client/locales'

describe('transport model picker shaping', () => {
  test('preselects the configured allow-list over the full catalog', () => {
    const view = shapeTransportModels({
      catalog: [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }, { id: 'c', name: 'Model C' }],
      models: ['b'],
    })

    expect(view).toEqual({
      catalog: [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }, { id: 'c', name: 'Model C' }],
      models: ['b'],
    })
    expect(modelPickerRows(view)).toEqual([
      { id: 'a', name: 'Model A', selected: false },
      { id: 'b', name: 'Model B', selected: true },
      { id: 'c', name: 'Model C', selected: false },
    ])
  })

  test('an empty allow-list means every model', () => {
    const view = shapeTransportModels({ catalog: [{ id: 'a', name: 'Model A' }], models: [] })

    expect(view.models).toEqual([])
    expect(modelPickerRows(view)).toEqual([{ id: 'a', name: 'Model A', selected: false }])
  })

  test('a failed read has no view to shape, so nothing looks like all models', () => {
    // The host rejects an unreadable settings store; the store turns that into
    // `{ ok: false }` and the component renders its error branch, never this.
    expect(shapeTransportModels(undefined)).toEqual({ catalog: [], models: [] })
  })

  test('malformed wire rows never reach the picker', () => {
    const view = shapeTransportModels({
      catalog: [{ id: '', name: 'No id' }, { id: 'a' }, null, 'row', { id: 'c', name: 'Model C' }],
      models: ['c', 7, null],
    })

    expect(view).toEqual({ catalog: [{ id: 'c', name: 'Model C' }], models: ['c'] })
  })

  test('configured ids outside the catalog render no row', () => {
    const view = shapeTransportModels({ catalog: [{ id: 'a', name: 'Model A' }], models: ['retired'] })

    expect(modelPickerRows(view)).toEqual([{ id: 'a', name: 'Model A', selected: false }])
  })

  test('an absent payload shapes to an empty picker', () => {
    expect(shapeTransportModels(null)).toEqual({ catalog: [], models: [] })
  })

  test('carries the missing-catalog explanation only when the wire has one', () => {
    expect(shapeTransportModels({ catalog: [], models: [], warning: 'ships no catalog' }).warning)
      .toBe('ships no catalog')
    // A malformed or blank field is not an explanation the picker should show.
    expect(shapeTransportModels({ catalog: [], models: [], warning: 7 })).toEqual({ catalog: [], models: [] })
    expect(shapeTransportModels({ catalog: [], models: [], warning: '' })).toEqual({ catalog: [], models: [] })
  })
})

describe('transport model picker copy', () => {
  const KEYS = [
    'transportModels',
    'transportModelsAll',
    'transportModelsSelected',
    'transportModelsLoading',
    'transportModelsClear',
    'transportModelsHint',
    'transportModelsMissingCatalog',
  ] as const

  test('exists in both dictionaries and mirrors locale/*.json', () => {
    const enJson = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')) as Record<string, string>
    const zhJson = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8')) as Record<string, string>

    for (const key of KEYS) {
      expect(LOCALE_DICTS.en[key]).toBe(enJson[key])
      expect(LOCALE_DICTS.zh[key]).toBe(zhJson[key])
      expect(LOCALE_DICTS.en[key]!.length).toBeGreaterThan(0)
      expect(LOCALE_DICTS.zh[key]!.length).toBeGreaterThan(0)
      expect(LOCALE_DICTS.zh[key]).not.toBe(LOCALE_DICTS.en[key])
    }
    expect(LOCALE_DICTS.en.transportModelsSelected).toContain('{n}')
    expect(LOCALE_DICTS.zh.transportModelsSelected).toContain('{n}')
    expect(LOCALE_DICTS.en.transportModelsSelected).toContain('{total}')
    expect(LOCALE_DICTS.zh.transportModelsSelected).toContain('{total}')
  })
})
