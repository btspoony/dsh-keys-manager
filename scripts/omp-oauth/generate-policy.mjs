/**
 * Generate the omp auth-policy slice for the two Keys Manager sign-in clients.
 *
 * omp compiles its `rules/auth/*.kdl` files into one `rules.json` blob. The
 * bundle needs exactly two entries from it: `kilo` (a `custom` hook) and
 * `zai-coding-plan` (a declarative `oauth-code` rule). Inlining the whole blob
 * would pull the 467 KB catalog into the artifact, so this module extracts the
 * two entries into a checked-in TypeScript module instead.
 *
 * The extraction is a *verbatim copy* with one documented local edit:
 * `zai-coding-plan.login.callback.nativeScheme` becomes `false`. omp sets it
 * `true` to capture the `zcode://` callback through its native desktop helper;
 * a headless host has no such helper, so the flow must not construct it. The
 * edit is recorded in the generated file's header and in the manifest facts.
 *
 * Determinism: the emitted text is a pure function of the installed
 * `rules.json` bytes, so `tests/omp-oauth-build.test.ts` can regenerate it in
 * memory and compare byte-for-byte.
 *
 * @module dsh-keys-manager/omp-oauth/generate-policy
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))

/** `scripts/omp-oauth` → package root. */
export const packageRoot = dirname(dirname(scriptsDir))

/** Where the generated policy slice is checked in. */
export const POLICY_FILE = join(scriptsDir, 'omp-oauth-policy.ts')

/** The generated narrowed hook registry the bundle substitutes for omp's. */
export const HOOKS_FILE = join(scriptsDir, 'overrides', 'hooks.gen.ts')

/** The two providers this bundle understands. */
const KILO_ID = 'kilo'
const ZAI_CODING_PLAN_ID = 'zai-coding-plan'

/** The single local edit applied to the copied rule. */
const LOCAL_EDITS = [
  'zai-coding-plan.login.callback.nativeScheme: true → false (no OS URI handler on a headless host)',
]

/**
 * Resolve the on-disk root of an installed package (its `package.json` owner).
 * @param name - the package name, resolved through Node's own resolver.
 */
export function installedPackageRoot(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === name) return dir
    }
    dir = dirname(dir)
  }
  throw new Error(`omp-oauth: cannot locate the installed package ${name}`)
}

/** The installed `rules.json` the slice is generated from. */
export function rulesFilePath() {
  return join(installedPackageRoot('@oh-my-pi/pi-catalog'), 'src', 'compat', 'rules.json')
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Extract the two provider policies from the compiled rules.
 * @param rulesText - the `rules.json` source text.
 * @returns the copied (and locally edited) entries plus the edit list.
 */
export function policySlice(rulesText) {
  const rules = JSON.parse(rulesText)
  const providers = rules?.auth?.providers
  if (!Array.isArray(providers)) throw new Error('omp-oauth: rules.json has no auth.providers array')
  const find = id => {
    const found = providers.find(provider => provider?.id === id)
    if (found === undefined) throw new Error(`omp-oauth: rules.json has no auth.providers entry for ${id}`)
    return found
  }
  const kilo = find(KILO_ID)
  const zai = structuredClone(find(ZAI_CODING_PLAN_ID))
  if (zai?.login?.callback === undefined) throw new Error('omp-oauth: zai-coding-plan has no login.callback')
  zai.login.callback.nativeScheme = false
  return { kilo, zai, edits: LOCAL_EDITS }
}

/**
 * The policy facts a reviewer (and the host) can read without parsing rules.
 *
 * Every value here is copied from the generated slice, so a rules.json bump
 * that changes a client id, endpoint or credential path produces a named
 * manifest diff instead of a silent behaviour change.
 * @param slice - the {@link policySlice} result.
 */
export function policyFactsOf(slice) {
  const login = slice.zai.login
  return {
    kilo: {
      id: slice.kilo.id,
      name: slice.kilo.name,
      apiKeyFormat: slice.kilo.apiKeyFormat,
      loginKind: slice.kilo.login.kind,
      loginHook: slice.kilo.login.hook,
    },
    zaiCodingPlan: {
      id: slice.zai.id,
      name: slice.zai.name,
      storeAs: slice.zai.storeAs,
      apiKeyFormat: slice.zai.apiKeyFormat,
      loginKind: login.kind,
      clientId: login.clientId?.value,
      authorizeUrl: login.authorizeUrl?.value,
      tokenUrl: login.token.url?.value,
      tokenBody: login.token.body,
      redirectUri: login.callback.redirectUri?.value,
      state: login.state,
      pkce: login.pkce,
      scopes: login.scopes,
      manualOnly: login.callback.manualOnly,
      nativeScheme: login.callback.nativeScheme,
      afterExchange: login.afterExchange,
      accessPath: login.credential.access?.path,
      emailPath: login.credential.email?.path,
      accountIdPath: login.credential.accountId?.path,
      expiresMode: login.credential.expires?.mode,
      refreshKind: slice.zai.refresh?.kind,
      /** Provider-level `paste-code` fact; unrelated to the engine's `pasteKey` branch. */
      pasteCode: slice.zai.pasteCode ?? false,
      /** Whether the engine's api-key short-circuit is reachable for this rule. */
      pasteKey: login.pasteKey !== undefined,
    },
  }
}

/**
 * Render `omp-oauth-policy.ts`.
 * @param rulesText - the `rules.json` source text.
 * @returns the generated TypeScript module.
 */
export function renderPolicy(rulesText) {
  const slice = policySlice(rulesText)
  const header = [
    '/**',
    ' * GENERATED by scripts/omp-oauth/generate-policy.mjs — do not edit by hand.',
    ' *',
    ' * Source: `@oh-my-pi/pi-catalog/src/compat/rules.json`',
    ` *   ${sha256(rulesText)}`,
    ' *',
    ' * Local edits to the copied rule:',
    ...slice.edits.map(edit => ` *   - ${edit}`),
    ' */',
  ].join('\n')
  return [
    header,
    "import type { CompiledAuthProvider, CompiledOAuthCodeLogin } from '@oh-my-pi/pi-catalog/compat/types'",
    '',
    `export const KILO_POLICY: CompiledAuthProvider = ${JSON.stringify(slice.kilo, null, 2)}`,
    '',
    `export const ZAI_CODING_PLAN_POLICY: CompiledAuthProvider = ${JSON.stringify(slice.zai, null, 2)}`,
    '',
    '/** The declarative `oauth-code` login rule the zai driver runs. */',
    'export const ZAI_CODING_PLAN_RULE: CompiledOAuthCodeLogin =',
    '  ZAI_CODING_PLAN_POLICY.login as CompiledOAuthCodeLogin',
    '',
  ].join('\n')
}

/**
 * Render `overrides/hooks.gen.ts`: a *narrowed* copy of omp's hook registry.
 *
 * omp's registry eagerly imports every provider hook, which drags the model
 * catalog into the bundle. The engine only ever looks up the names its rule
 * declares, so the generated table contains exactly those names, each bound to
 * the real omp implementation. It is a narrowed registry, not a
 * reimplementation.
 * @param slice - the {@link policySlice} result.
 */
export function renderHooks(slice) {
  const afterExchange = slice.zai.login.afterExchange
  const lines = [
    '/**',
    ' * GENERATED by scripts/omp-oauth/generate-policy.mjs — do not edit by hand.',
    ' *',
    ' * The omp hook registry narrowed to the names the copied policy declares.',
    ' * Each entry resolves to the real omp implementation; no behaviour is',
    ' * reimplemented here. Anything else stays absent on purpose, so a rule that',
    ' * starts referencing a new hook fails the build instead of silently running',
    ' * a degenerate flow.',
    ' */',
    "import type { HookTables } from '@oh-my-pi/pi-ai/registry/hooks/types'",
    '',
    'export const HOOKS: HookTables = {',
    '  env: {},',
    '  headers: {},',
    '  value: {},',
    '  login: {},',
    '  refresh: {},',
    '  afterExchange: {',
    ...(afterExchange === undefined
      ? []
      : [
          `    ${JSON.stringify(afterExchange)}: () =>`,
          "      import('@oh-my-pi/pi-ai/oauth/zai').then(module => module.zaiMintKeyHook),",
        ]),
    '  },',
    '}',
    '',
  ]
  return lines.join('\n')
}

/** Read the installed rules and return every generated source in memory. */
export function generateAll() {
  const rulesText = readFileSync(rulesFilePath(), 'utf8')
  return { rulesText, policy: renderPolicy(rulesText), hooks: renderHooks(policySlice(rulesText)) }
}

// The generator runs only when this file is the script; the build and the drift
// test import the functions above and must not rewrite the checked-in files.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { policy, hooks } = generateAll()
  mkdirSync(dirname(HOOKS_FILE), { recursive: true })
  writeFileSync(POLICY_FILE, policy)
  writeFileSync(HOOKS_FILE, hooks)
  console.log(`omp-oauth: wrote ${POLICY_FILE}`)
  console.log(`omp-oauth: wrote ${HOOKS_FILE}`)
}
