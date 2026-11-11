/*
 * MIT License
 *
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * This file carries code from the `@oh-my-pi/pi-catalog` package's
 * `src/model-catalog-format.ts` (MIT), ported to plain JavaScript. The notice
 * above and this permission text are reproduced as the licence requires; the
 * port itself is described in the module note below.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The compact model-catalog format the pinned `@oh-my-pi/pi-catalog` ships.
 *
 * Ported from `@oh-my-pi/pi-catalog@18.18.8` `src/model-catalog-format.ts` (MIT,
 * © oh-my-pi contributors): `encodeModelCatalog`, `openModelCatalog`,
 * `getCatalogProviders`, `getCatalogProvider` and the decode helpers they use.
 * The logic is kept line-for-line with upstream so a row decoded here is the row
 * upstream would produce; only the TypeScript types are dropped, because this is
 * plain Node ESM build tooling with no build step of its own.
 *
 * Why a copy: the pin's `exports` map points `import` at its `.ts` sources and
 * ships no JS `dist` entry, and both generators run under plain `node`, so they
 * cannot import the implementation. It is build tooling — no shipped module
 * imports it at runtime and `@oh-my-pi/*` stays a build-time pin — but the root
 * package publishes `scripts/`, so this file ships and carries the licence above.
 *
 * Shape (upstream's own encoding): a catalog is `{version: 1, keys,
 * booleanShapes, nodes, compat, providers}`. Nested objects and arrays are
 * interned into `nodes` and referenced by a one-element array `[id]`; `[-1]` is
 * an explicitly present `undefined`; a provider row is `[name, constants,
 * [[id, row, compatDelta?]]]`; and a row's `compat` is stored as a delta against
 * the most common `compat` object for its `api`.
 *
 * @module dsh-keys-manager/model-catalog-format
 */

/** `@oh-my-pi/pi-utils` `isRecord`, inlined: it is the only helper this port needs. */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// JSON serialization with sorted object keys gives both deterministic ordering
// and value-based interning, independent of the input objects' insertion order.
function canonical(value) {
  if (value === undefined) return 'u'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Encode a model catalog into a deterministic, compact JSON representation.
 * @param {Record<string, Record<string, unknown>>} models - provider → model id → row.
 * @returns {string} the catalog JSON text.
 */
export function encodeModelCatalog(models) {
  // Match JSON's treatment of undefined and non-finite numbers in generated rows.
  models = JSON.parse(JSON.stringify(models))
  const keys = []
  const keyIds = new Map()
  const booleanShapes = []
  const shapeIds = new Map()
  const nodes = []
  const nodeIds = new Map()
  const keyId = key => {
    let id = keyIds.get(key)
    if (id === undefined) {
      id = keys.length
      keys.push(key)
      keyIds.set(key, id)
    }
    return id
  }
  const encode = value => {
    if (value === undefined) return [-1]
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }
    const signature = canonical(value)
    const existing = nodeIds.get(signature)
    if (existing !== undefined) return [existing]
    let node
    if (Array.isArray(value)) {
      node = [1, value.map(encode)]
    } else if (isRecord(value)) {
      const properties = []
      const boolKeys = []
      const masks = []
      for (const key of Object.keys(value).sort()) {
        const entry = value[key]
        if (typeof entry === 'boolean') {
          const bit = boolKeys.length
          boolKeys.push(keyId(key))
          const word = Math.floor(bit / 32)
          masks[word] ??= 0
          if (entry) masks[word] = (masks[word] | (1 << (bit % 32))) >>> 0
        } else {
          properties.push(keyId(key), encode(entry))
        }
      }
      const shape = boolKeys.join(',')
      let shapeId = shapeIds.get(shape)
      if (shapeId === undefined) {
        shapeId = booleanShapes.length
        booleanShapes.push(boolKeys)
        shapeIds.set(shape, shapeId)
      }
      node = [0, properties, shapeId, masks]
    } else {
      throw new TypeError('Model catalog values must be JSON-compatible')
    }
    const id = nodes.length
    nodes.push(node)
    nodeIds.set(signature, id)
    return [id]
  }

  // Select the most common complete compat object for each API. A row's
  // delta records changed properties and explicitly removed base properties.
  const compatCounts = new Map()
  for (const provider of Object.keys(models).sort()) {
    for (const id of Object.keys(models[provider]).sort()) {
      const model = models[provider][id]
      if (typeof model.api !== 'string' || !isRecord(model.compat)) continue
      let counts = compatCounts.get(model.api)
      if (!counts) compatCounts.set(model.api, (counts = new Map()))
      const signature = canonical(model.compat)
      const entry = counts.get(signature)
      if (entry) entry.count++
      else counts.set(signature, { value: model.compat, count: 1 })
    }
  }
  const bases = new Map()
  for (const api of [...compatCounts.keys()].sort()) {
    const choices = [...compatCounts.get(api).entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )
    bases.set(api, choices[0][1].value)
  }
  const compat = [...bases].map(([api, value]) => [api, encode(value)])
  const providers = []
  for (const provider of Object.keys(models).sort()) {
    const entries = Object.entries(models[provider]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const constants = Object.create(null)
    if (entries.length) {
      const first = entries[0][1]
      for (const key of Object.keys(first).sort()) {
        const value = first[key]
        if (key === 'id' || key === 'compat' || (value !== null && typeof value === 'object')) continue
        if (entries.every(([, model]) => Object.hasOwn(model, key) && model[key] === value)) {
          constants[key] = value
        }
      }
    }
    const encodedConstants = encode(constants)
    const rows = []
    for (const [id, model] of entries) {
      const rest = Object.create(null)
      const source = model
      const base = typeof model.api === 'string' ? bases.get(model.api) : undefined
      const useBase = base !== undefined && isRecord(model.compat)
      for (const key of Object.keys(source).sort()) {
        if (Object.hasOwn(constants, key) || (key === 'id' && source.id === id) || (key === 'compat' && useBase))
          continue
        rest[key] = source[key]
      }
      const row = [id, encode(rest)]
      if (useBase) {
        const value = model.compat
        const removed = Object.keys(base)
          .filter(key => !Object.hasOwn(value, key))
          .sort()
          .map(keyId)
        const changed = Object.create(null)
        for (const key of Object.keys(value).sort()) {
          if (!Object.hasOwn(base, key) || canonical(value[key]) !== canonical(base[key])) changed[key] = value[key]
        }
        row.push([removed, encode(changed)])
      }
      rows.push(row)
    }
    providers.push([provider, encodedConstants, rows])
  }
  return JSON.stringify({ version: 1, keys, booleanShapes, nodes, compat, providers })
}

/**
 * Open a parsed catalog without materializing its provider models.
 * @param {unknown} value - the parsed `models.json`.
 * @returns the catalog handle the accessors below take.
 */
export function openModelCatalog(value) {
  const data = value
  if (data.version !== 1) throw new Error('Unsupported model catalog version')
  return {
    data,
    values: [],
    decoded: [],
    providers: new Map(),
    compatBases: new Map(data.compat),
    compatValues: new Map(),
  }
}

// Assignment is safe for ordinary keys, but __proto__ must remain an own key.
function setProperty(object, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    object[key] = value
  }
}

function decodeObject(catalog, object, node) {
  for (let i = 0; i < node[1].length; i += 2) {
    setProperty(object, catalog.data.keys[node[1][i]], decode(catalog, node[1][i + 1]))
  }
  const shape = catalog.data.booleanShapes[node[2]]
  for (let i = 0; i < shape.length; i++) {
    setProperty(object, catalog.data.keys[shape[i]], ((node[3][i >>> 5] >>> (i % 32)) & 1) !== 0)
  }
}

function decode(catalog, value) {
  if (!Array.isArray(value)) return value
  const id = value[0]
  if (id === -1) return undefined
  if (catalog.decoded[id]) return catalog.values[id]
  const node = catalog.data.nodes[id]
  let result
  if (node[0] === 1) {
    result = node[1].map(entry => decode(catalog, entry))
  } else {
    const object = {}
    decodeObject(catalog, object, node)
    result = object
  }
  catalog.values[id] = result
  catalog.decoded[id] = true
  return result
}

/**
 * List catalog provider keys in deterministic order.
 * @param {object} catalog - an opened catalog.
 */
export function getCatalogProviders(catalog) {
  return catalog.data.providers.map(provider => provider[0])
}

/**
 * Materialize and cache one provider, or return undefined if it is absent.
 * @param {object} catalog - an opened catalog.
 * @param {string} provider - the provider id.
 */
export function getCatalogProvider(catalog, provider) {
  const cached = catalog.providers.get(provider)
  if (cached) return cached
  const entry = catalog.data.providers.find(row => row[0] === provider)
  if (!entry) return undefined
  const constants = decode(catalog, entry[1])
  const models = {}
  for (const [id, encoded, delta] of entry[2]) {
    if (!Array.isArray(encoded) || encoded[0] < 0) throw new Error('Invalid compact model row')
    const row = catalog.data.nodes[encoded[0]]
    if (!row || row[0] !== 0) throw new Error('Invalid compact model row')
    const model = { id, ...constants }
    decodeObject(catalog, model, row)
    if (delta) {
      const api = model.api
      const changeId = delta[1][0]
      const changeNode = catalog.data.nodes[changeId]
      const base = decode(catalog, catalog.compatBases.get(api))
      let compat
      if (
        delta[0].length === 0 &&
        changeNode[1].length === 0 &&
        catalog.data.booleanShapes[changeNode[2]].length === 0
      ) {
        compat = base
      } else {
        let byChange = catalog.compatValues.get(api)
        if (!byChange) catalog.compatValues.set(api, (byChange = new Map()))
        let byRemoved = byChange.get(changeId)
        if (!byRemoved) byChange.set(changeId, (byRemoved = new Map()))
        const removedKey = delta[0].join(',')
        const cachedCompat = byRemoved.get(removedKey)
        if (cachedCompat) {
          compat = cachedCompat
        } else {
          compat = { ...base }
          for (const key of delta[0]) delete compat[catalog.data.keys[key]]
          const changes = decode(catalog, delta[1])
          for (const key in changes) {
            if (Object.hasOwn(changes, key)) setProperty(compat, key, changes[key])
          }
          byRemoved.set(removedKey, compat)
        }
      }
      model.compat = compat
    }
    setProperty(models, id, model)
  }
  catalog.providers.set(provider, models)
  return models
}