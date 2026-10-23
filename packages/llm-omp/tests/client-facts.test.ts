/**
 * The routes' OAuth client identity is derived from the pinned rules, not copied
 * into tracked source.
 *
 * Google's installed-app client id/secret are public, but GitHub push protection
 * treats them as secrets, so `src/google/route.ts` reads them from the generated
 * `client-facts.generated.ts` module. This test pins the chain: what the routes
 * advertise must equal what the pinned KDL declares, decoded the same way. It
 * never spells the values itself, so the suite stays secret-free.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { GOOGLE_ANTIGRAVITY_FACTS, GOOGLE_GEMINI_CLI_FACTS } from '../src/google/route.js'

/** The installed root of the pinned catalog, by its own manifest. */
function pinnedCatalogRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve('@oh-my-pi/pi-catalog')))
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@oh-my-pi/pi-catalog') {
      return dir
    }
    dir = dirname(dir)
  }
  throw new Error('cannot locate the installed @oh-my-pi/pi-catalog')
}

/** Decode one base64 field out of a pinned auth rule. */
function fromRule(route: string, field: 'client-id' | 'client-secret'): string {
  const path = join(pinnedCatalogRoot(), 'src', 'compat', 'rules', 'auth', `${route}.kdl`)
  const rule = readFileSync(path, 'utf8')
  const match = new RegExp(`${field}\\s+"([^"]+)"\\s+encoding="base64"`).exec(rule)
  if (match === null) throw new Error(`${path}: no base64 "${field}"`)
  return Buffer.from(match[1], 'base64').toString('utf8')
}

describe('google client facts', () => {
  it('derives both routes from their pinned auth rules', () => {
    expect(GOOGLE_GEMINI_CLI_FACTS.clientId).toBe(fromRule('google-gemini-cli', 'client-id'))
    expect(GOOGLE_GEMINI_CLI_FACTS.clientSecret).toBe(fromRule('google-gemini-cli', 'client-secret'))
    expect(GOOGLE_ANTIGRAVITY_FACTS.clientId).toBe(fromRule('google-antigravity', 'client-id'))
    expect(GOOGLE_ANTIGRAVITY_FACTS.clientSecret).toBe(fromRule('google-antigravity', 'client-secret'))
    // The two rules use different clients; a copy-paste slip would show here.
    expect(GOOGLE_GEMINI_CLI_FACTS.clientId).not.toBe(GOOGLE_ANTIGRAVITY_FACTS.clientId)
  })
})
