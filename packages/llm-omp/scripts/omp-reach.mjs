/**
 * Which shim symbols the bundled graph reaches, derived from an esbuild
 * metafile.
 *
 * The shim surface in `omp-manifest.json` proves the shim file still provides
 * what the build expects; it cannot say whether a deliberately degraded
 * `simplify:` member is on the hot path. Reach is the missing half: an omp bump
 * that starts calling such a member must show up as a manifest diff instead of
 * a silent behaviour change.
 *
 * The metafile does not record imported symbol names (its `imports[]` entries
 * carry `path`, `kind` and the pre-resolution `original`, nothing more), so each
 * edge to a shim is resolved through the importing module's own source: the
 * `import { ... } from "<original>"` clause is exactly the reached set.
 *
 * Two limits are deliberate and documented rather than hidden:
 *
 * - A shim resolved for a *free global* (`Bun`, injected by esbuild) has no
 *   `original` specifier; the metafile only proves the injected object is
 *   reached, so such a shim records the binding name, not the members read off
 *   it.
 * - A namespace or star import reaches every export; it is recorded as `*`.
 *
 * @module dsh-llm-omp-transports/omp-reach
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Collapse `a/../b` so a resolved edge compares equal to the shim's own key. */
function normalizePath(path) {
  const parts = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Package-root-relative key for one import edge's resolved target.
 *
 * esbuild keys metafile paths (`inputs` keys and `imports[].path`) against the
 * build's working directory; a path a plugin resolved itself (`onResolve`
 * returning an absolute path) stays absolute.
 * @param packageRoot - the build's `absWorkingDir`.
 * @param importPath - the edge's resolved path.
 */
function edgeTarget(packageRoot, importPath) {
  if (importPath.startsWith('/')) return normalizePath(relative(packageRoot, importPath).split('\\').join('/'))
  return normalizePath(importPath)
}

/**
 * Named bindings one module takes from `specifier`.
 * @param source - the importing module's source text.
 * @param specifier - the specifier the edge resolved, as written in the source.
 * @returns the imported/exported names; `*` for a namespace or star form.
 */
function namedImports(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `[^;"']*?` keeps the clause inside one statement: import clauses cannot
  // contain quotes, and stopping at a semicolon prevents matching across
  // statements in modules that use them.
  const pattern = new RegExp(
    `(?:^|[\\n;])\\s*(?:import|export)\\s+(?:type\\s+)?([^;"']*?)\\s*from\\s*["']${escaped}["']`,
    'g',
  )
  const names = new Set()
  for (const [, clause] of source.matchAll(pattern)) {
    if (/\*\s*(?:as\s+\w+\s*)?$/.test(clause.trim())) names.add('*')
    const braces = /\{([\s\S]*?)\}/.exec(clause)
    if (!braces) continue
    for (const part of braces[1].split(',')) {
      const item = part.trim()
      // `type X` is erased before bundling, so it never reaches the shim.
      if (item === '' || item.startsWith('type ')) continue
      names.add(item.split(/\s+as\s+/)[0].trim())
    }
  }
  return names
}

/**
 * Record every shim symbol the metafile's import edges reach.
 * @param metafile - the `metafile` returned by `esbuild.build`.
 * @param options - `packageRoot` (metafile path base) and `shimPaths` (name → key).
 * @returns shim name → sorted reached names.
 */
export function shimImportsOf(metafile, { packageRoot, shimPaths }) {
  const reached = new Map(Object.keys(shimPaths).map(name => [name, new Set()]))
  const shimByPath = new Map(Object.entries(shimPaths).map(([name, path]) => [path, name]))
  const sources = new Map()
  for (const [importerPath, input] of Object.entries(metafile.inputs)) {
    for (const edge of input.imports) {
      const shim = shimByPath.get(edgeTarget(packageRoot, edge.path))
      if (!shim) continue
      if (!edge.original) {
        reached.get(shim).add('Bun')
        continue
      }
      const file = importerPath.startsWith('/') ? importerPath : join(packageRoot, importerPath)
      if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'))
      for (const name of namedImports(sources.get(file), edge.original)) reached.get(shim).add(name)
    }
  }
  return Object.fromEntries([...reached].map(([name, names]) => [name, [...names].sort()]))
}
