/**
 * Assert the built package contains every path the bundle manifest and the
 * Web module loader resolve at runtime.
 */
import { access, readFile } from 'node:fs/promises'

const REQUIRED = [
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client/index.d.ts',
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

console.log(`verified ${REQUIRED.length} artifacts`)
