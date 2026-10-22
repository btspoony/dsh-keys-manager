/**
 * Assert the built package contains every path the bundle manifest and the
 * Web module loader resolve at runtime, and that no runtime artifact carries a
 * build-time omp import.
 */
import { access, readFile } from 'node:fs/promises'

const REQUIRED = [
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client/index.d.ts',
  'lib/omp-oauth/oauth.mjs',
  'bundle/cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]

for (const path of REQUIRED) {
  try {
    await access(path)
  } catch {
    throw new Error(`missing built artifact: ${path}`)
  }
}

const client = await readFile('lib/client.js', 'utf8')
if (!client.includes('dsh-keys-manager')) throw new Error('lib/client.js does not identify the bundle')
if (!client.includes('__ModuleLoader__')) throw new Error('lib/client.js is not a module-loader bundle')

// `@oh-my-pi/*` is a build-time pin: it is inlined into `lib/omp-oauth/oauth.mjs`
// and must never be resolvable from a published file. A specifier that survives
// the build would fail at the user's machine, not here — so check every module
// specifier in the shipped runtime files.
for (const path of ['lib/index.js', 'lib/omp-oauth/oauth.mjs']) {
  const source = await readFile(path, 'utf8')
  for (const match of source.matchAll(/(?:^|[^\w$])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (specifier.startsWith('node:')) continue
    if (/^@oh-my-pi\/|^bun:/.test(specifier)) {
      throw new Error(`${path} imports the build-time package ${specifier}`)
    }
  }
}

console.log(`verified ${REQUIRED.length} artifacts`)
