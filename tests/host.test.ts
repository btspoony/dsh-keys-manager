import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { HostContext, RequestErrorPayload } from '../src/host-types'
import type { ExtraProvider, KeyRecord, ProviderRecord, ProviderView, StateView } from '../src/domain'
import { accountRef, applyFailureCooldown, DEFAULT_SETTINGS, KEY_LIMIT, statusOfKey } from '../src/core'
import { apply, FLUSH_ROLLBACK_COMPENSATION_FAILED, isFlushRollbackCompensationFailure, KeysManagerService } from '../src/index'
import { EXTRA_PROVIDER_MAP } from '../src/providers'
import { KeysManagerStore } from '../src/store'

const ORIGINAL = Symbol.for('cordis.original')

function applyOps(root: any, ops: any): any {
  let next = structuredClone(root)
  for (const op of ops) {
    if (op.path.length === 0) {
      next = op.op === 'set' ? structuredClone(op.value) : {}
      continue
    }
    let cursor = next
    for (let index = 0; index < op.path.length - 1; index += 1) {
      const part = op.path[index]
      if (cursor[part] === undefined || cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {}
      cursor = cursor[part]
    }
    const last = op.path[op.path.length - 1]
    if (op.op === 'set') cursor[last] = structuredClone(op.value)
    else delete cursor[last]
  }
  return next
}

/**
 * The credential-store key grammar the real seam enforces on both segments
 * (packages/credentials/credentials/src/index.ts:22 `KEY_SEGMENT_PATTERN`).
 * The fake mirrors it so a test cannot write a record the real store would
 * reject, and vice versa.
 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** One stored credential record, mirroring the real seam's record union. */
export interface FakeCredentialRecord {
  kind: 'api-key' | 'grant'
  key?: string
  env?: Record<string, string>
  payload?: unknown
}

function assertRecordKey(key: string): void {
  const segments = key.split('/')
  if (segments.length !== 2 || !segments.every(segment => KEY_SEGMENT_PATTERN.test(segment))) {
    throw new TypeError(`credential key "${key}" must be two ${String(KEY_SEGMENT_PATTERN)} segments`)
  }
}

function fakeCredentials(initial: Record<string, string> = {}): {
  raw: any
  refs: Map<string, string>
  records: Map<string, FakeCredentialRecord>
  emitRecordUpdated: (key: string) => void
  recordUpdatedListeners: Array<(key: string) => void>
} {
  const refs = new Map(Object.entries(initial))
  const records = new Map<string, FakeCredentialRecord>()
  const recordUpdatedListeners: Array<(key: string) => void> = []
  const raw = {
    failResolve: false,
    failUnset: false,
    failUnsetRefs: new Set<string>(),
    failRefs: new Set<string>(),
    failModifyRecord: false,
    failDeleteRecord: false,
    /** Simulated readRecord latency, for harvest-timing tests (SF1). */
    readRecordDelayMs: 0,
    async resolve(ref: string) {
      if (raw.failResolve || raw.failRefs.has(ref)) throw new Error('credential store unavailable')
      const value = refs.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async describe(ref: string) {
      return { configured: refs.has(ref), ...(refs.has(ref) ? { source: 'test' } : {}), writable: true }
    },
    async set(ref: string, value: string) {
      if (typeof value !== 'string' || value.length === 0) throw new Error('empty credential')
      refs.set(ref, value)
    },
    async unset(ref: string) {
      if (raw.failUnset || raw.failUnsetRefs.has(ref)) throw new Error('credential store locked')
      refs.delete(ref)
    },
    async readRecord(key: string): Promise<FakeCredentialRecord | undefined> {
      assertRecordKey(key)
      // Resolve across a microtask hop: the real credential store reads
      // async I/O, so the echo handler's continuation always resumes after
      // any pending microtasks. The old same-tick resolution encoded an
      // optimistic ordering production does not guarantee.
      await Promise.resolve()
      if (raw.readRecordDelayMs > 0) await new Promise(resolve => setTimeout(resolve, raw.readRecordDelayMs))
      return records.get(key)
    },
    async modifyRecord(
      key: string,
      mutate: (current: FakeCredentialRecord | undefined) => Promise<FakeCredentialRecord | undefined>,
    ): Promise<FakeCredentialRecord | undefined> {
      assertRecordKey(key)
      if (raw.failModifyRecord) throw new Error('credential store locked')
      const current = records.get(key)
      const next = await mutate(current === undefined ? undefined : structuredClone(current))
      if (next === undefined) return current
      records.set(key, structuredClone(next))
      raw.emitRecordUpdated(key)
      return structuredClone(next)
    },
    async deleteRecord(key: string): Promise<void> {
      assertRecordKey(key)
      if (raw.failDeleteRecord) throw new Error('credential store locked')
      records.delete(key)
      // Real consumers observe a removal through the seam's post-commit
      // `credentials/record-updated` fan-out too, so deletions echo here as
      // well — exactly the shape the manager's own-projection guard must
      // stay silent on.
      raw.emitRecordUpdated(key)
    },
    // Mirrors the seam's post-commit `credentials/record-updated` fan-out;
    // tests fire it by hand for out-of-band (pi-ai side) writes.
    onRecordUpdated(listener: (key: string) => void): () => void {
      recordUpdatedListeners.push(listener)
      return () => {
        const index = recordUpdatedListeners.indexOf(listener)
        if (index >= 0) recordUpdatedListeners.splice(index, 1)
      }
    },
    emitRecordUpdated(key: string): void {
      for (const listener of [...recordUpdatedListeners]) listener(key)
    },
  }
  Object.defineProperty(raw, ORIGINAL, { value: raw })
  return { raw, refs, records, emitRecordUpdated: key => raw.emitRecordUpdated(key), recordUpdatedListeners }
}

function fakeSettings(): any {
  const namespaces = [
    {
      ns: 'llm-pi-ai',
      value: { providers: { 'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } } },
      revision: 1,
    },
    { ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1 },
  ]
  return {
    writable: true,
    failMutate: false,
    failDescribe: false,
    namespaces,
    describe() {
      if (this.failDescribe) throw new Error('settings unavailable')
      return namespaces.map(entry => ({
        ns: entry.ns,
        autoGenerate: false,
        schema: {},
        value: structuredClone(entry.value),
        revision: entry.revision,
        applies: 'live',
      }))
    },
    async mutate(ns: string, ops: any[], expectedRevision?: number) {
      if (this.failMutate) throw new Error('revision conflict')
      const entry = namespaces.find(candidate => candidate.ns === ns)
      if (!entry) throw new Error(`missing namespace ${ns}`)
      if (expectedRevision !== undefined && expectedRevision !== entry.revision) throw new Error('revision conflict')
      entry.value = applyOps(entry.value, ops)
      entry.revision += 1
    },
    valueOf(ns: string) {
      return namespaces.find(entry => entry.ns === ns)?.value
    },
  }
}

function fakeLlm(): any {
  return {
    listConfigurableProviders() {
      return [
        {
          provider: 'zai-coding-cn',
          displayName: 'Z.AI Coding CN',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'zai-coding-cn'],
          nativeAuth: { env: ['ZAI_CODING_CN_API_KEY'], oauth: false },
          defaultBaseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        },
        {
          provider: 'deepseek-official',
          displayName: 'DeepSeek',
          settingsNs: 'llm-deepseek-api-key',
          settingsPath: [],
          nativeAuth: { env: ['DEEPSEEK_API_KEY'], oauth: false },
        },
        {
          provider: 'openai-codex',
          displayName: 'OpenAI Codex',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openai-codex'],
          nativeAuth: { env: [], oauth: true },
        },
        {
          provider: 'amazon-bedrock',
          displayName: 'Amazon Bedrock',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'amazon-bedrock'],
          nativeAuth: {
            env: [
              'AWS_BEARER_TOKEN_BEDROCK',
              'AWS_PROFILE',
              'AWS_ACCESS_KEY_ID',
              'AWS_SECRET_ACCESS_KEY',
              'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
              'AWS_CONTAINER_CREDENTIALS_FULL_URI',
              'AWS_WEB_IDENTITY_TOKEN_FILE',
            ],
            oauth: false,
          },
        },
        {
          provider: 'anthropic',
          displayName: 'Anthropic',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'anthropic'],
          nativeAuth: {
            env: [
              'ANTHROPIC_AUTH_TOKEN',
              'ANTHROPIC_OAUTH_TOKEN',
              'ANTHROPIC_API_KEY',
              'ANTHROPIC_FEDERATION_RULE_ID',
              'ANTHROPIC_ORGANIZATION_ID',
              'ANTHROPIC_IDENTITY_TOKEN_FILE',
              'ANTHROPIC_SERVICE_ACCOUNT_ID',
              'ANTHROPIC_WORKSPACE_ID',
            ],
            oauth: true,
          },
          defaultBaseURL: 'https://api.anthropic.com',
        },
        // The remaining pi-ai OAuth providers this build registers flows
        // for. Kept in the directory fixture so the account-capability
        // verdicts are asserted for the whole supported set, not only the
        // two routes other tests adopt.
        {
          provider: 'github-copilot',
          displayName: 'GitHub Copilot',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'github-copilot'],
          nativeAuth: { env: [], oauth: true },
        },
        {
          provider: 'kimi-coding',
          displayName: 'Kimi Coding',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'kimi-coding'],
          nativeAuth: { env: [], oauth: true },
        },
        {
          provider: 'openrouter',
          displayName: 'OpenRouter',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openrouter'],
          nativeAuth: { env: ['OPENROUTER_API_KEY'], oauth: true },
        },
        {
          provider: 'radius',
          displayName: 'Radius',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'radius'],
          nativeAuth: { env: [], oauth: true },
        },
        {
          provider: 'xai',
          displayName: 'xAI',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'xai'],
          nativeAuth: { env: ['XAI_API_KEY'], oauth: true },
        },
        // C6-2 fixture: an OAuth-capable catalog route whose flow is NOT
        // registered (extension-backed OAuth is deferred from this
        // increment). It must report key- AND account-unsupported.
        {
          provider: 'google-gemini-cli',
          displayName: 'Google Gemini CLI',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'google-gemini-cli'],
          nativeAuth: { env: [], oauth: true },
        },
        {
          provider: 'cloudflare-ai-gateway',
          displayName: 'Cloudflare AI Gateway',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'cloudflare-ai-gateway'],
          nativeAuth: { env: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'], oauth: false },
        },
        {
          provider: 'cloudflare-workers-ai',
          displayName: 'Cloudflare Workers AI',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'cloudflare-workers-ai'],
          nativeAuth: { env: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'], oauth: false },
        },
      ]
    },
    listProviders() {
      return [{ id: 'zai-coding-cn', name: 'Z.AI Coding CN' }, { id: 'deepseek-official', name: 'DeepSeek' }]
    },
    async discoverModels() {
      return [
        { id: 'discovered-chat', name: 'Discovered Chat', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text'] },
        { id: 'discovered-vision', name: 'Discovered Vision', inputModalities: ['text', 'image'] },
      ]
    },
  }
}

interface Harness {
  dir: string
  store: KeysManagerStore
  credentials: ReturnType<typeof fakeCredentials>
  settings: any
  llm: any
  authorization: any
  service: KeysManagerService
  /** The raw fake host context, for constructing restarted service instances. */
  ctx: HostContext
  emitEvent: (name: string, ...args: unknown[]) => void
  close: () => Promise<void>
}

/**
 * The flows `llm-pi-ai/login.ts:131-171` registers: one flow per installed
 * catalog provider, keyed `recordKeyFor(providerId)` = `llm-pi-ai/<id>`
 * (auth.ts:29,36-38). The oauth members are the pin the login driver
 * depends on; the fixture's method order is not asserted (N2).
 */
const OAUTH_PROVIDERS = ['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex', 'openrouter', 'radius', 'xai'] as const

function piAiFlows(): Array<{ key: string; label: string; methods: Array<{ id: string; label: string }> }> {
  const flows: Array<{ key: string; label: string; methods: Array<{ id: string; label: string }> }> = []
  for (const id of OAUTH_PROVIDERS) {
    const methods = [{ id: 'oauth', label: `Sign in ${id}` }]
    // anthropic ships both login methods; openai-codex is oauth-only, as its
    // provider data declares no interactive api-key login.
    if (id === 'anthropic') methods.push({ id: 'api-key', label: 'Anthropic API key' })
    flows.push({ key: `llm-pi-ai/${id}`, label: id, methods })
  }
  return flows
}

function fakeAuthorization(flows: Array<{ key: string; label: string; methods: Array<{ id: string; label: string }> }> = piAiFlows()): any {
  return {
    flows,
    failBegin: undefined as Error | undefined,
    beganRequests: [] as Array<Record<string, unknown>>,
    /** The single in-flight begin, for tests to settle by hand. */
    pending: undefined as undefined | { request: Record<string, unknown>; resolve: (outcome: { status: string }) => void; reject: (error: Error) => void },
    list() {
      return this.flows.map((flow: any) => ({ ...flow, methods: [...flow.methods], inFlight: false }))
    },
    describe(key: string) {
      const flow = this.flows.find((candidate: any) => candidate.key === key)
      return flow === undefined ? undefined : { ...flow, methods: [...flow.methods], inFlight: false }
    },
    begin(request: Record<string, unknown>) {
      this.beganRequests.push(request)
      if (this.failBegin !== undefined) return Promise.reject(this.failBegin)
      return new Promise((resolve, reject) => {
        this.pending = { request, resolve: resolve as (outcome: { status: string }) => void, reject: reject as (error: Error) => void }
      })
    },
  }
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-host-'))
  const store = new KeysManagerStore(join(dir, 'state.json'))
  const credentials = fakeCredentials({
    ZAI_CODING_CN_API_KEY: 'sk-existing-zai',
    DEEPSEEK_API_KEY: 'sk-existing-deepseek',
    ANTHROPIC_AUTH_TOKEN: 'oauth-auth-token',
    ANTHROPIC_API_KEY: 'sk-ant-api',
  })
  const settings = fakeSettings()
  const llm = fakeLlm()
  const authorization = fakeAuthorization()
  const eventListeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    llm,
    authorization,
    logger: { warn() {}, info() {} },
    get(name: string) {
      if (name === 'credentials') return credentials.raw
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      if (name === 'authorization') return authorization
      return undefined
    },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      const chain = eventListeners.get(name) ?? []
      chain.push(listener)
      eventListeners.set(name, chain)
      // The credential seam's post-commit broadcast reaches service
      // listeners through ctx.on; wire the fake store's emit to the same
      // listeners so tests can fire rotations by hand.
      let disposeRecord: (() => void) | undefined
      if (name === 'credentials/record-updated') {
        disposeRecord = credentials.raw.onRecordUpdated((key: string) => listener(key))
      }
      return () => {
        const list = eventListeners.get(name)
        const index = list?.indexOf(listener) ?? -1
        if (index >= 0) list!.splice(index, 1)
        disposeRecord?.()
      }
    },
  }
  const service = new KeysManagerService(ctx as unknown as HostContext, store)
  service.settings = settings
  service.attachCredentials(credentials.raw)
  return {
    dir,
    store,
    credentials,
    settings,
    llm,
    authorization,
    service,
    ctx: ctx as unknown as HostContext,
    emitEvent(name: string, ...args: unknown[]) {
      for (const listener of [...(eventListeners.get(name) ?? [])]) listener(...args)
    },
    async close() {
      service.detachCredentials(credentials.raw)
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function linkFailure(
  h: Harness,
  provider: string,
  session: string,
  keyId: string | undefined,
  failure: object,
  used = true,
): void {
  ;(h.service as any).recordStreamAttempt(provider, session, keyId, used, failure)
}

function streamFailure(
  h: Harness,
  provider: string,
  session: string,
  failure: object,
): AsyncIterable<unknown> {
  return h.service.streamListener(
    { provider, model: 'model', sessionId: session, messages: [] },
    async function* () {
      // Resolve inside the wrapped scope so the broker marks this request as
      // having actually used a managed credential.
      await h.credentials.raw.resolve(h.store.provider(provider)!.brokerRef)
      yield { type: 'finish', reason: { kind: 'error', failure } }
    } as any,
  )
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iterable) {
    // consume
  }
}

interface PluginHarness {
  dir: string
  credentials: { raw: any; refs: Map<string, string> }
  settings: any
  llm: any
  service: KeysManagerService
  /** Typert contributions the plugin registered through `apply()`. */
  typertRegistrations: Array<{ package: string; face: string; invocations: Array<{ method: string; parameters: Array<{ name: string }> }> }>
  /** Run the installed waterfall for one event; `terminal` is the host fallback. */
  emit(name: string, payload: unknown, terminal: () => unknown): unknown
  close(): Promise<void>
}

/**
 * Install the real plugin through `apply()`, so waterfall regressions exercise
 * the same listeners the host installs instead of private service helpers.
 * State lives under a temp `DSH_HOME`; `close()` disposes effects in reverse
 * order and restores the environment.
 */
async function pluginHarness(): Promise<PluginHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-plugin-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const credentials = fakeCredentials({
    ZAI_CODING_CN_API_KEY: 'sk-existing-zai',
    DEEPSEEK_API_KEY: 'sk-existing-deepseek',
  })
  const settings = fakeSettings()
  const llm = fakeLlm()
  const cleanups: Array<() => unknown> = []
  const chains = new Map<string, Array<(payload: any, next: () => any) => any>>()
  const typertRegistrations: NonNullable<PluginHarness['typertRegistrations']> = []
  let service: KeysManagerService | undefined
  const ctx: any = {
    llm,
    credentials: credentials.raw,
    settings,
    typert: { register: (contribution: never) => { typertRegistrations.push(contribution); return () => {} } },
    logger: { warn() {}, info() {} },
    get(name: string) {
      if (name === 'credentials') return credentials.raw
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      return undefined
    },
    effect(fn: () => unknown) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      return cleanup
    },
    inject(_deps: string[], fn: (child: unknown) => unknown) {
      const disposer = fn(ctx)
      if (typeof disposer === 'function') cleanups.push(disposer as () => unknown)
    },
    on(name: string, listener: (payload: any, next: () => any) => any, options?: boolean | { prepend?: boolean }) {
      const chain = chains.get(name) ?? []
      const prepend = options === true || (typeof options === 'object' && options !== null && options.prepend === true)
      if (prepend) chain.unshift(listener)
      else chain.push(listener)
      chains.set(name, chain)
      return () => {
        const list = chains.get(name)
        const index = list?.indexOf(listener) ?? -1
        if (index >= 0) list!.splice(index, 1)
      }
    },
    provide(name: string, value: unknown) {
      if (name === 'keysManager') service = value as KeysManagerService
      return () => {}
    },
  }
  apply(ctx as HostContext)
  if (service === undefined) throw new Error('plugin did not provide the keysManager service')
  return {
    dir,
    credentials,
    settings,
    llm,
    service,
    typertRegistrations,
    emit(name: string, payload: unknown, terminal: () => unknown): unknown {
      const chain = [...(chains.get(name) ?? [])]
      const call = (index: number): unknown =>
        index >= chain.length ? terminal() : chain[index](payload, () => call(index + 1))
      return call(0)
    },
    async close() {
      for (const cleanup of cleanups.reverse()) {
        const result = cleanup()
        if (result instanceof Promise) await result
      }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('provider state marks OAuth-only routes unsupported and lists extras', async () => {
  const h = await harness()
  try {
    const state = h.service.buildState()
    const zai = state.providers.find(provider => provider.provider === 'zai-coding-cn')!
    const codex = state.providers.find(provider => provider.provider === 'openai-codex')!
    const deepseek = state.providers.find(provider => provider.provider === 'deepseek-official')!
    const extra = state.providers.find(provider => provider.provider === 'deepinfra')!!
    const anthropic = state.providers.find(provider => provider.provider === 'anthropic')!
    const cloudflareGateway = state.providers.find(provider => provider.provider === 'cloudflare-ai-gateway')!
    const cloudflareWorkers = state.providers.find(provider => provider.provider === 'cloudflare-workers-ai')!
    const bedrock = state.providers.find(provider => provider.provider === 'amazon-bedrock')!
    assert.equal(zai.supported, true)
    assert.equal(zai.origin, 'dsh')
    assert.equal(extra.origin, 'plugin')
    assert.equal(anthropic.origin, 'dsh')
    assert.equal(bedrock.supported, false)
    assert.match(String(bedrock.reason), /AWS/)
    // The key-pool exclusion is mode-scoped: bedrock stays unreachable for
    // accounts too, while an OAuth-only route is account-adoptable.
    assert.equal(bedrock.accountSupported, false)
    assert.equal(codex.supported, false)
    assert.match(String(codex.reason), /OAuth/)
    assert.equal(codex.accountSupported, true)
    assert.equal(deepseek.supported, true)
    assert.equal(anthropic.supported, true)
    assert.equal(anthropic.accountSupported, true)
    assert.equal(cloudflareGateway.supported, false)
    assert.match(String(cloudflareGateway.reason), /Cloudflare/)
    assert.equal(cloudflareWorkers.supported, false)
    assert.match(String(cloudflareWorkers.reason), /Cloudflare/)
    assert.equal(extra.extra, true)
    assert.equal(extra.managed, false)
    assert.ok(state.providers.length > 10)
  } finally {
    await h.close()
  }
})

test('adoption imports the existing credential and points the profile at the broker', async () => {
  const h = await harness()
  try {
    const state = await h.service.adoptProvider('zai-coding-cn')
    const zai = state.providers.find(provider => provider.provider === 'zai-coding-cn')!
    assert.equal(zai.managed, true)
    assert.equal(zai.keyCount, 1)
    assert.equal(zai.keys[0].alias, 'Imported')
    assert.equal(zai.bindingHealthy, true)
    assert.match(zai.brokerRef!, /^KEYSMGR_ZAI_CODING_CN_/)
    const brokerRef = zai.brokerRef
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, brokerRef)
    const keyRef = h.store.provider('zai-coding-cn')!.keys[0].ref
    assert.equal(h.credentials.refs.get(keyRef), 'sk-existing-zai')
    // The original credential is deliberately left in place for release.
    assert.equal(h.credentials.refs.get('ZAI_CODING_CN_API_KEY'), 'sk-existing-zai')
  } finally {
    await h.close()
  }
})

// MF1: account management is a capability distinct from key-pool support.
// An OAuth-only route (openai-codex) must be adoptable for accounts — as a
// managed provider with zero keys — while the key entry path stays refused.

test('an OAuth-only provider is adoptable for accounts with zero keys', async () => {
  const h = await harness()
  try {
    const state = await h.service.adoptProvider('openai-codex')
    const codex = state.providers.find(provider => provider.provider === 'openai-codex')!
    assert.equal(codex.managed, true)
    assert.equal(codex.keyCount, 0)
    assert.equal(codex.bindingHealthy, true)
    // Key-pool support stays refused for the adopted route; the account
    // capability is the separate verdict that made adoption possible.
    assert.equal(codex.supported, false)
    assert.match(String(codex.reason), /OAuth/)
    assert.equal(codex.accountSupported, true)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, codex.brokerRef)
  } finally {
    await h.close()
  }
})

test('beginAccountLogin succeeds on an adopted OAuth-only provider', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    const codexGrantKey = 'llm-pi-ai/openai-codex'
    h.credentials.records.set(codexGrantKey, grantPayload({ accountId: 'acc-codex', email: 'codex@example.com' }))
    const view = await h.service.beginAccountLogin('openai-codex', 'Codex account')
    h.emitEvent('authorization/settled', codexGrantKey, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    const row = h.store.provider('openai-codex')!.keys.find(key => key.kind === 'oauth')!
    assert.equal(row.oauth!.provider, 'openai-codex')
    assert.equal(row.oauth!.accountId, 'acc-codex')
    assert.equal(h.credentials.records.has(row.oauth!.grantRef), true)
  } finally {
    await h.close()
  }
})

test('Add key stays refused on an adopted OAuth-only provider', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    await assert.rejects(
      () => h.service.addKey('openai-codex', 'second', 'sk-second'),
      /OAuth|API key|API-key/,
    )
    assert.equal(h.store.provider('openai-codex')!.keys.length, 0)
  } finally {
    await h.close()
  }
})

test('the credential broker answers per request, lists without moving state, and refuses overwrite', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const provider = h.store.provider('zai-coding-cn')!
    const first = provider!.keys[0]
    const listHit = await h.credentials.raw.resolve(provider.brokerRef)
    assert.equal(listHit!.value, 'sk-existing-zai')
    const requestHit = await (h.service as any).als.run({ provider: 'zai-coding-cn', keyValue: 'sk-request-scoped' }, () => h.credentials.raw.resolve(provider.brokerRef))
    assert.equal(requestHit!.value, 'sk-request-scoped')
    const noKey = await (h.service as any).als.run({ provider: 'zai-coding-cn', keyValue: null }, () => h.credentials.raw.resolve(provider.brokerRef))
    assert.equal(noKey, undefined)
    const description = await h.credentials.raw.describe(provider.brokerRef)
    assert.deepEqual(description, { configured: true, source: 'keys-manager', writable: false })
    await assert.rejects(() => h.credentials.raw.set(provider.brokerRef, 'nope'), /managed by Keys Manager/)
    await assert.rejects(() => h.credentials.raw.unset(provider.brokerRef), /managed by Keys Manager/)
    // The password is not exposed in state.
    const persisted = JSON.stringify(h.service.buildState())
    assert.ok(!persisted.includes('sk-existing-zai'))
    assert.ok(first.ref)
  } finally {
    await h.close()
  }
})

test('sticky sessions round-robin across keys and pause shifts new sessions', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    let state = await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider!.keys
    const a = await h.service.selectKey('zai-coding-cn', 'session-a')
    const b = await h.service.selectKey('zai-coding-cn', 'session-b')
    const aAgain = await h.service.selectKey('zai-coding-cn', 'session-a')
    assert.equal(a.key!.id, first.id)
    assert.equal(b.key!.id, second.id)
    assert.equal(aAgain.key!.id, first.id)
    await h.service.updateKey('zai-coding-cn', first.id, { enabled: false })
    const c = await h.service.selectKey('zai-coding-cn', 'session-c')
    assert.equal(c.key!.id, second.id)
    state = h.service.getState()
    assert.equal(state.providers.find(entry => entry.provider === 'zai-coding-cn')!.status, 'active')
  } finally {
    await h.close()
  }
})

test('retry budget, key switch, cooldown, and success reset', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider!.keys
    const selection = await h.service.selectKey('zai-coding-cn', 'session-fail')
    assert.equal(selection.key!.id, first.id)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-fail' } },
    } as unknown as RequestErrorPayload;
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure, true)
    linkFailure(h, 'zai-coding-cn', 'session-fail', first.id, payload.failure)
    const retryOne = await h.service.requestErrorListener(payload, async () => undefined)
    assert.deepEqual(retryOne, { kind: 'retry' })
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure, true)
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-fail', first.id, true)
    const retryTwo = await h.service.requestErrorListener(payload, async () => undefined)
    assert.deepEqual(retryTwo, { kind: 'retry' })
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure, true)
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-fail', first.id, true)
    const retryThree = await h.service.requestErrorListener(payload, async () => undefined)
    assert.deepEqual(retryThree, { kind: 'retry' })
    assert.ok(first.cooldownUntil > Date.now() - 1000)
    const binding = h.store.binding('session-fail', 'zai-coding-cn')!
    assert.equal(binding!.keyId, second.id)
    // A successful request on the new key clears retry accounting.
    ;(h.service as any).recordSuccess('zai-coding-cn', 'session-fail', second.id)
    assert.equal(h.store.binding('session-fail', 'zai-coding-cn')!.keyId, second.id)
    const after = h.service.getState()
    const view = after.providers.find(entry => entry.provider === 'zai-coding-cn')!
    assert.equal(view.keys.find(key => key.id === first.id)!.status, 'cooling')
  } finally {
    await h.close()
  }
})

test('request-shaped failures are delegated without cooling a key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const provider = h.store.provider('zai-coding-cn')!
    const selection = await h.service.selectKey('zai-coding-cn', 'session-context')
    assert.equal(selection.key!.id, provider!.keys[0].id)
    let nextCalled = false
    const result = await h.service.requestErrorListener({
      provider: 'zai-coding-cn',
      turn: 2,
      step: 1,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' },
      signal: { aborted: false },
      agent: { session: { id: 'session-context' } },
    } as unknown as RequestErrorPayload, async () => {
      nextCalled = true
      return undefined
    })
    assert.equal(result, undefined)
    assert.equal(nextCalled, true)
    assert.equal(provider.keys[0].cooldownUntil, 0)
  } finally {
    await h.close()
  }
})

test('deleting the last key restores the original apiKeyEnv and removes management', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const provider = h.store.provider('zai-coding-cn')!
    const brokerRef = provider.brokerRef
    const keyRef = provider.keys[0].ref
    const state = await h.service.deleteKey('zai-coding-cn', provider.keys[0].id)
    const zai = state.providers.find(entry => entry.provider === 'zai-coding-cn')!
    assert.equal(zai.managed, false)
    assert.equal(h.store.provider('zai-coding-cn')!, undefined)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, 'ZAI_CODING_CN_API_KEY')
    assert.equal(h.credentials.refs.has(keyRef), false)
    assert.equal(h.credentials.refs.has(brokerRef), false)
    assert.equal(h.credentials.refs.get('ZAI_CODING_CN_API_KEY'), 'sk-existing-zai')
  } finally {
    await h.close()
  }
})

test('extra provider installation writes a complete pi-ai profile and release removes it', async () => {
  const h = await harness()
  try {
    const state = await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra')
    const view = state.providers.find(entry => entry.provider === 'deepinfra')!
    assert.equal(view.managed, true)
    assert.equal(view.extra, true)
    assert.equal(view.createdProfile, true)
    assert.equal(view.keyCount, 1)
    const profile = h.settings.valueOf('llm-pi-ai').providers.deepinfra
    assert.equal(profile.api, 'openai-completions')
    assert.equal(profile.baseURL, 'https://api.deepinfra.com/v1/openai')
    assert.match(profile.apiKeyEnv, /^KEYSMGR_DEEPINFRA_/)
    assert.equal(profile.models[0].id, 'discovered-chat')
    assert.equal(profile.models[1].id, 'discovered-vision')
    const keyRef = h.store.provider('deepinfra')!.keys[0].ref
    assert.equal(h.credentials.refs.get(keyRef), 'sk-deepinfra')
    const released = await h.service.releaseProvider('deepinfra')
    assert.equal(released.providers.find(entry => entry.provider === 'deepinfra')!.managed, false)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.deepinfra, undefined)
    assert.equal(h.credentials.refs.has(keyRef), false)
  } finally {
    await h.close()
  }
})

/** Restore COREWEAVE_PROJECT around one body; `undefined` means "not set". */
async function withCoreweaveProject<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env.COREWEAVE_PROJECT
  if (value === undefined) delete process.env.COREWEAVE_PROJECT
  else process.env.COREWEAVE_PROJECT = value
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env.COREWEAVE_PROJECT
    else process.env.COREWEAVE_PROJECT = saved
  }
}

test('adding coreweave without COREWEAVE_PROJECT refuses before any write', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject(undefined, async () => {
      await assert.rejects(
        () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave'),
        /coreweave requires the COREWEAVE_PROJECT environment variable \(OpenAI-Project header/,
      )
    })
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.coreweave, undefined)
    assert.equal(h.store.provider('coreweave'), undefined)
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE')), [])
  } finally {
    await h.close()
  }
})

test('coreweave writes its env-sourced header into the new profile', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', async () => {
      const state = await h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave')
      assert.equal(state.providers.find(entry => entry.provider === 'coreweave')!.managed, true)
    })
    const profile = h.settings.valueOf('llm-pi-ai').providers.coreweave
    assert.deepEqual(profile.headers, { 'OpenAI-Project': 'team/project' })
    assert.match(profile.apiKeyEnv, /^KEYSMGR_COREWEAVE_/)
    const keyRef = h.store.provider('coreweave')!.keys[0].ref
    assert.equal(h.credentials.refs.get(keyRef), 'sk-coreweave')
  } finally {
    await h.close()
  }
})

test('adopting an existing coreweave profile fills only the missing header', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const profile = h.settings.valueOf('llm-pi-ai').providers.coreweave
    assert.deepEqual(profile.headers, { 'OpenAI-Project': 'team/project' })
    assert.equal(profile.baseURL, 'https://proxy.example/v1')
    assert.deepEqual(profile.models, [{ id: 'preseeded-model' }])
    assert.match(profile.apiKeyEnv, /^KEYSMGR_COREWEAVE_/)
  } finally {
    await h.close()
  }
})

test('an extra provider without headerEnv writes no headers key', async () => {
  const h = await harness()
  try {
    await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra')
    const profile = h.settings.valueOf('llm-pi-ai').providers.deepinfra
    assert.equal('headers' in profile, false)
    // The whole profile, not just the absent key, keeps its pre-carrier shape.
    assert.deepEqual(profile, {
      displayName: 'DeepInfra',
      api: 'openai-completions',
      baseURL: 'https://api.deepinfra.com/v1/openai',
      apiKeyEnv: profile.apiKeyEnv,
      models: [
        { id: 'discovered-chat', name: 'Discovered Chat', contextWindow: 128000, maxTokens: 8192, input: ['text'] },
        { id: 'discovered-vision', name: 'Discovered Vision', input: ['text', 'image'] },
      ],
    })
  } finally {
    await h.close()
  }
})

test('adopting a stored coreweave profile fills only the declared headers it lacks', async () => {
  const scenarios = [
    { seed: {}, expected: { 'OpenAI-Project': 'team/project' } },
    { seed: { 'X-Trace': 'keep-me' }, expected: { 'X-Trace': 'keep-me', 'OpenAI-Project': 'team/project' } },
    { seed: { 'OpenAI-Project': 'user/own' }, expected: { 'OpenAI-Project': 'user/own' } },
  ]
  for (const scenario of scenarios) {
    const h = await harness()
    try {
      const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
      namespace.value.providers.coreweave = {
        api: 'openai-completions',
        baseURL: 'https://proxy.example/v1',
        models: [{ id: 'preseeded-model' }],
        headers: scenario.seed,
      }
      await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
      assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, scenario.expected)
    } finally {
      await h.close()
    }
  }
})

test('releasing an adopted coreweave profile removes the injected header and restores apiKeyEnv', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      apiKeyEnv: 'COREWEAVE_API_KEY',
      models: [{ id: 'preseeded-model' }],
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'team/project' })
    const keyRef = h.store.provider('coreweave')!.keys[0].ref
    await withCoreweaveProject('team/project', () => h.service.releaseProvider('coreweave').then(() => undefined))
    const profile = h.settings.valueOf('llm-pi-ai').providers.coreweave
    // The block the plugin wrote is gone; the rest of the adopted profile stays.
    assert.equal('headers' in profile, false)
    assert.equal(profile.apiKeyEnv, 'COREWEAVE_API_KEY')
    assert.deepEqual(profile.models, [{ id: 'preseeded-model' }])
    assert.equal(h.store.provider('coreweave'), undefined)
    assert.equal(h.credentials.refs.has(keyRef), false)
  } finally {
    await h.close()
  }
})

test('releasing an adopted coreweave profile keeps headers the plugin did not inject', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
      headers: { 'X-Trace': 'keep-me' },
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, {
      'X-Trace': 'keep-me',
      'OpenAI-Project': 'team/project',
    })
    await withCoreweaveProject('team/project', () => h.service.releaseProvider('coreweave').then(() => undefined))
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'X-Trace': 'keep-me' })
  } finally {
    await h.close()
  }
})

test('releasing an adopted coreweave profile keeps a declared header the user authored', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
      headers: { 'OpenAI-Project': 'user/own' },
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    // Adoption never overwrote the stored value, so release must not delete it.
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'user/own' })
    await withCoreweaveProject('team/project', () => h.service.releaseProvider('coreweave').then(() => undefined))
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'user/own' })
  } finally {
    await h.close()
  }
})

test('adding a managed coreweave again restores a declared header a Models edit dropped', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave.headers
    await withCoreweaveProject('team/project', async () => {
      const state = await h.service.addExtraProvider('coreweave', 'main', 'sk-second')
      // Pinned order: the managed-route notice precedes the repair notice, so a
      // future reorder of the user-visible warnings cannot pass silently.
      assert.deepEqual(state.warnings, [
        'Provider is already managed; the key was added instead.',
        'Restored the missing OpenAI-Project header on the managed profile.',
      ])
    })
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'team/project' })
    assert.equal(h.store.provider('coreweave')!.keys.length, 2)
  } finally {
    await h.close()
  }
})

test('adding a managed coreweave again refuses when COREWEAVE_PROJECT is gone', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    await withCoreweaveProject(undefined, async () => {
      await assert.rejects(
        () => h.service.addExtraProvider('coreweave', 'main', 'sk-second'),
        /coreweave requires the COREWEAVE_PROJECT environment variable \(OpenAI-Project header/,
      )
    })
    assert.equal(h.store.provider('coreweave')!.keys.length, 1)
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'team/project' })
  } finally {
    await h.close()
  }
})

test('adding a key through the managed path restores a declared header a Models edit dropped', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave.headers
    await withCoreweaveProject('team/project', async () => {
      const state = await h.service.addKey('coreweave', 'second', 'sk-second')
      assert.match(state.warnings.join('\n'), /Restored the missing OpenAI-Project header/)
    })
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'team/project' })
    assert.equal(h.store.provider('coreweave')!.keys.length, 2)
  } finally {
    await h.close()
  }
})

test('a failed header repair degrades to a warning and keeps the added key', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave.headers
    // The repair's settings write fails the way a read-only or conflicting
    // profile does; the key and its credential are already written by then.
    h.settings.failMutate = true
    await withCoreweaveProject('team/project', async () => {
      const added = await h.service.addKey('coreweave', 'second', 'sk-second')
      assert.deepEqual(added.warnings, [
        'Did not restore the OpenAI-Project header on the coreweave route: revision conflict',
      ])
      // The managed add-provider surface degrades the same way, with its own
      // notice still first (M-2 order pin).
      const managed = await h.service.addExtraProvider('coreweave', 'third', 'sk-third')
      assert.deepEqual(managed.warnings, [
        'Provider is already managed; the key was added instead.',
        'Did not restore the OpenAI-Project header on the coreweave route: revision conflict',
      ])
    })
    assert.equal(h.store.provider('coreweave')!.keys.length, 3)
    assert.equal([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE')).length, 3)
    // The repair stayed pending: the header is still absent, not half-written.
    assert.equal('headers' in h.settings.valueOf('llm-pi-ai').providers.coreweave, false)
  } finally {
    await h.close()
  }
})

test('a refused managed key add writes no declared header', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const record = h.store.provider('coreweave')!
    while (record.keys.length < KEY_LIMIT) {
      await h.service.addKey('coreweave', `filler ${record.keys.length}`, `sk-filler-${record.keys.length}`)
    }
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave.headers
    const refsBefore = [...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE'))
    assert.equal(refsBefore.length, KEY_LIMIT)
    await withCoreweaveProject('team/project', async () => {
      await assert.rejects(
        () => h.service.addKey('coreweave', 'overflow', 'sk-overflow'),
        new RegExp(`A provider may have at most ${KEY_LIMIT} keys`),
      )
    })
    assert.equal('headers' in h.settings.valueOf('llm-pi-ai').providers.coreweave, false)
    // The capacity refusal precedes the credential write too, so a reorder
    // that minted the credential before the cap check cannot pass silently.
    assert.deepEqual(
      [...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE')),
      refsBefore,
    )
  } finally {
    await h.close()
  }
})

test('a capability-refused managed key add writes no credential', async () => {
  const h = await harness()
  try {
    // MF1: adoption manages the OAuth-only route for accounts, so it is a
    // managed provider whose key pool is refused by capability alone.
    await h.service.adoptProvider('openai-codex')
    const refsBefore = [...h.credentials.refs.keys()]
    await assert.rejects(
      () => h.service.addKey('openai-codex', 'second', 'sk-second'),
      /OAuth|API key|API-key/,
    )
    // The capability refusal precedes createKeyRecord: no credential is
    // minted for an add that never becomes a key.
    assert.deepEqual([...h.credentials.refs.keys()], refsBefore)
    assert.equal(h.store.provider('openai-codex')!.keys.length, 0)
  } finally {
    await h.close()
  }
})

test('adopting a stored coreweave profile without the variable writes nothing', async () => {
  const h = await harness()
  try {
    const seeded = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      apiKeyEnv: 'COREWEAVE_API_KEY',
      models: [{ id: 'preseeded-model' }],
      headers: { 'X-Trace': 'keep-me' },
    }
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = structuredClone(seeded)
    await withCoreweaveProject(undefined, async () => {
      await assert.rejects(
        () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave'),
        /coreweave requires the COREWEAVE_PROJECT environment variable \(OpenAI-Project header/,
      )
    })
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave, seeded)
    assert.equal(h.store.provider('coreweave'), undefined)
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE')), [])
  } finally {
    await h.close()
  }
})

test('adding coreweave installs the seed catalog without running model discovery', async () => {
  const h = await harness()
  try {
    const discover = vi.spyOn(h.llm, 'discoverModels')
    const state = await withCoreweaveProject('team/project', () =>
      h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave'),
    )
    // Discovery cannot carry the declared header, so the probe would only fail.
    assert.equal(discover.mock.calls.length, 0)
    const profile = h.settings.valueOf('llm-pi-ai').providers.coreweave
    assert.equal(profile.models.length, 44)
    assert.doesNotMatch(state.warnings.join('\n'), /Model discovery failed/)
  } finally {
    await h.close()
  }
})

test('adding a managed coreweave again leaves a deleted Models profile alone', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave
    const state = await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-second'))
    // No header-only half-profile is created for a route whose profile is gone.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.coreweave, undefined)
    assert.match(
      state.warnings.join('\n'),
      /Did not restore the OpenAI-Project header on the coreweave route: its Models profile no longer exists/,
    )
    assert.equal(h.store.provider('coreweave')!.keys.length, 2)
  } finally {
    await h.close()
  }
})

test('adding a managed coreweave again skips the repair on a replaced profile', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    delete namespace.value.providers.coreweave.headers
    namespace.value.providers.coreweave.apiKeyEnv = 'HAND_WRITTEN_REF'
    const state = await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-second'))
    // A mismatch binding is the state release refuses to touch; repair skips it too.
    assert.equal('headers' in h.settings.valueOf('llm-pi-ai').providers.coreweave, false)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.coreweave.apiKeyEnv, 'HAND_WRITTEN_REF')
    assert.match(state.warnings.join('\n'), /Did not restore the OpenAI-Project header on the coreweave route: its Models profile was replaced/)
    assert.equal(h.store.provider('coreweave')!.keys.length, 2)
  } finally {
    await h.close()
  }
})

test('a stored declared header that disagrees with the environment is reported and kept', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    const state = await withCoreweaveProject('team/new', () => h.service.addExtraProvider('coreweave', 'second', 'sk-second'))
    assert.match(
      state.warnings.join('\n'),
      /The stored OpenAI-Project header on the coreweave route differs from the value COREWEAVE_PROJECT now supplies; the stored value was kept\./,
    )
    // The stored value is never overwritten by drift reporting.
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'team/project' })
  } finally {
    await h.close()
  }
})

test('adopting a profile whose declared header disagrees with the environment reports the drift', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
      headers: { 'OpenAI-Project': 'user/own' },
    }
    const state = await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave'))
    assert.match(
      state.warnings.join('\n'),
      /The stored OpenAI-Project header on the coreweave route differs from the value COREWEAVE_PROJECT now supplies; the stored value was kept\./,
    )
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'user/own' })
  } finally {
    await h.close()
  }
})

test('releasing a profile whose declared header cannot be attributed reports it in the state warnings', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
      headers: { 'OpenAI-Project': 'user/own' },
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    // The variable is gone, so the kept header must surface in the UI state.
    const state = await withCoreweaveProject(undefined, () => h.service.releaseProvider('coreweave'))
    assert.match(
      state.warnings.join('\n'),
      /Release left the OpenAI-Project header in the coreweave profile: COREWEAVE_PROJECT is no longer set, so an injected value cannot be identified\./,
    )
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'OpenAI-Project': 'user/own' })
  } finally {
    await h.close()
  }
})

test('header identity is case-insensitive for filling and release attribution', async () => {
  const h = await harness()
  try {
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers.coreweave = {
      api: 'openai-completions',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'preseeded-model' }],
      headers: { 'openai-project': 'team/project' },
    }
    await withCoreweaveProject('team/project', () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave').then(() => undefined))
    // A stored lowercase variant is the same Fetch field: no second variant.
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.coreweave.headers, { 'openai-project': 'team/project' })
    await withCoreweaveProject('team/project', () => h.service.releaseProvider('coreweave').then(() => undefined))
    const profile = h.settings.valueOf('llm-pi-ai').providers.coreweave
    assert.equal('headers' in profile, false)
  } finally {
    await h.close()
  }
})

test('a header value Fetch cannot carry is refused before any write', async () => {
  const h = await harness()
  try {
    await withCoreweaveProject('team\nproject', async () => {
      await assert.rejects(
        () => h.service.addExtraProvider('coreweave', 'main', 'sk-coreweave'),
        /coreweave cannot carry the COREWEAVE_PROJECT value as the OpenAI-Project header: it is not a valid Fetch header value/,
      )
    })
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.coreweave, undefined)
    assert.equal(h.store.provider('coreweave'), undefined)
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_COREWEAVE')), [])
  } finally {
    await h.close()
  }
})

test('a catalog entry that declares a credential header is refused', async () => {
  const h = await harness()
  const synthetic: ExtraProvider = {
    id: 'synthetic-secret-header',
    name: 'Synthetic Secret Header',
    api: 'openai-completions',
    baseURL: 'https://synthetic.example/v1',
    env: ['SYNTHETIC_SECRET'],
    headerEnv: { Authorization: 'SYNTHETIC_SECRET' },
    models: [{ id: 'synthetic-model', name: 'Synthetic Model' }],
  }
  const catalog = EXTRA_PROVIDER_MAP as Map<string, ExtraProvider>
  catalog.set(synthetic.id, synthetic)
  process.env.SYNTHETIC_SECRET = 'sk-synthetic'
  try {
    await assert.rejects(
      () => h.service.addExtraProvider(synthetic.id, 'main', 'sk-synthetic'),
      /synthetic-secret-header declares the credential header Authorization; only non-secret metadata headers can be carried/,
    )
    assert.equal(h.settings.valueOf('llm-pi-ai').providers[synthetic.id], undefined)
    assert.equal(h.store.provider(synthetic.id), undefined)
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_SYNTHETIC')), [])
  } finally {
    delete process.env.SYNTHETIC_SECRET
    catalog.delete(synthetic.id)
    await h.close()
  }
})

test('a catalog entry that declares a bare api-key header is refused', async () => {
  const h = await harness()
  const catalog = EXTRA_PROVIDER_MAP as Map<string, ExtraProvider>
  process.env.SYNTHETIC_SECRET = 'sk-synthetic'
  try {
    for (const header of ['Api-Key', 'ApiKey']) {
      const id = `synthetic-${header.toLowerCase()}-header`
      catalog.set(id, {
        id,
        name: 'Synthetic Bare Api-Key Header',
        api: 'openai-completions',
        baseURL: 'https://synthetic.example/v1',
        env: ['SYNTHETIC_SECRET'],
        headerEnv: { [header]: 'SYNTHETIC_SECRET' },
        models: [{ id: 'synthetic-model', name: 'Synthetic Model' }],
      })
      await assert.rejects(
        () => h.service.addExtraProvider(id, 'main', 'sk-synthetic'),
        new RegExp(`${id} declares the credential header ${header}; only non-secret metadata headers can be carried`),
      )
      assert.equal(h.settings.valueOf('llm-pi-ai').providers[id], undefined)
      assert.equal(h.store.provider(id), undefined)
    }
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_SYNTHETIC')), [])
  } finally {
    delete process.env.SYNTHETIC_SECRET
    for (const id of ['synthetic-api-key-header', 'synthetic-apikey-header']) catalog.delete(id)
    await h.close()
  }
})

test('settings update validates and persists retry policy', async () => {
  const h = await harness()
  try {
    const state = await h.service.setSettings({ retryCount: 3, baseCooldownMs: 60_000, recoveryGraceMs: 120_000 })
    assert.equal(state.settings.retryCount, 3)
    assert.equal(state.settings.baseCooldownMs, 60_000)
    assert.equal(state.settings.recoveryGraceMs, 120_000)
    await assert.rejects(() => h.service.setSettings({ retryCount: 0 }), /retryCount/)
  } finally {
    await h.close()
  }
})

test('a profile changed outside the manager reports a binding warning', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const namespace = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai')!
    namespace.value.providers['zai-coding-cn'].apiKeyEnv = 'SOME_OTHER_REF'
    const state = h.service.getState()
    const zai = state.providers.find(entry => entry.provider === 'zai-coding-cn')!
    assert.equal(zai.bindingHealthy, false)
    assert.match(String(zai.warning), /Re-adopt/)
  } finally {
    await h.close()
  }
})

test('native release keeps Models edits and only clears apiKeyEnv', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('anthropic')
    const edited = h.settings.valueOf('llm-pi-ai').providers.anthropic
    edited.baseURL = 'https://proxy.example/v1'
    edited.models = [{ id: 'claude-edited' }]
    await h.service.releaseProvider('anthropic')
    assert.equal(h.store.provider('anthropic'), undefined)
    const retained = h.settings.valueOf('llm-pi-ai').providers.anthropic
    assert.equal(retained.baseURL, 'https://proxy.example/v1')
    assert.deepEqual(retained.models, [{ id: 'claude-edited' }])
    assert.equal(retained.apiKeyEnv, undefined)
  } finally {
    await h.close()
  }
})

test('state stays secret-free after mutations and reload', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'extra', 'sk-very-secret')
    await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra-secret')
    await h.store.flush()
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(join(h.dir, 'state.json'), 'utf8')
    assert.ok(!text.includes('sk-very-secret'))
    assert.ok(!text.includes('sk-deepinfra-secret'))
    assert.ok(!text.includes('sk-existing-zai'))
    assert.ok(text.includes('KEYSMGR_'))
  } finally {
    await h.close()
  }
})


test('anthropic import prefers ANTHROPIC_API_KEY over bearer/OAuth tokens', async () => {
  const h = await harness()
  try {
    const state = await h.service.adoptProvider('anthropic')
    const view = state.providers.find(provider => provider.provider === 'anthropic')!
    const record = h.store.provider('anthropic')!
    assert.equal(view.keyCount, 1)
    assert.equal(view.keys[0].importedFrom, 'ANTHROPIC_API_KEY')
    assert.equal(h.credentials.refs.get(record.keys[0].ref), 'sk-ant-api')
  } finally {
    await h.close()
  }
})

test('a single-key pool preserves its key when delegation requests a retry', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.setSettings({ retryCount: 1 })
    const selected = await h.service.selectKey('zai-coding-cn', 'session-only')
    ;(h.service as any).attempts.set('session-only\u0000zai-coding-cn', {
      keyId: selected.key!.id,
      retries: 0,
      at: Date.now(),
      turn: 7,
      step: 1,
      usedManagedKey: true,
    })
    const payload = {
      provider: 'zai-coding-cn',
      turn: 7,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-only' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const state = h.service.getState()
    const view = state.providers.find(provider => provider.provider === 'zai-coding-cn')!
    assert.equal(view.keys[0].status, 'active')
    assert.equal(view.keys[0].cooldownUntil, 0)
    const again = await h.service.selectKey('zai-coding-cn', 'session-only')
    assert.equal(again.key!.id, selected.key!.id)
  } finally {
    await h.close()
  }
})

test('terminal delegation cools the exhausted key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.setSettings({ retryCount: 1 })
    const selected = await h.service.selectKey('zai-coding-cn', 'session-terminal')
    const terminalFailure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-terminal', selected.key!.id, terminalFailure)
    ;(h.service as any).attempts.set('session-terminal\u0000zai-coding-cn', {
      keyId: selected.key!.id,
      retries: 0,
      at: Date.now(),
      turn: 8,
      step: 1,
      usedManagedKey: true,
    })
    const payload = {
      provider: 'zai-coding-cn',
      turn: 8,
      step: 1,
      failure: terminalFailure,
      signal: { aborted: false },
      agent: { session: { id: 'session-terminal' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-terminal', selected.key!.id, true)
    assert.equal(await h.service.requestErrorListener(payload, async () => undefined), undefined)
    const state = h.service.getState()
    const view = state.providers.find(provider => provider.provider === 'zai-coding-cn')!
    assert.equal(view.keys[0].status, 'cooling')
    assert.ok(view.keys[0].cooldownUntil > Date.now())
  } finally {
    await h.close()
  }
})

test('a failed credential unset keeps the key metadata for retry', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const record = h.store.provider('zai-coding-cn')!
    const first = record.keys[0]
    h.credentials.raw.failUnset = true
    await assert.rejects(() => h.service.deleteKey('zai-coding-cn', first.id), /credential store locked/)
    assert.equal(record.keys.length, 2)
    assert.equal(h.credentials.refs.has(first.ref), true)
    h.credentials.raw.failUnset = false
    await h.service.deleteKey('zai-coding-cn', first.id)
    assert.equal(record.keys.length, 1)
    assert.equal(h.credentials.refs.has(first.ref), false)
  } finally {
    await h.close()
  }
})

test('an already-absent credential is still removable when unset rejects', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const record = h.store.provider('zai-coding-cn')!
    const first = record.keys[0]
    h.credentials.refs.delete(first.ref)
    h.credentials.raw.failUnset = true
    await h.service.deleteKey('zai-coding-cn', first.id)
    assert.equal(record.keys.length, 1)
  } finally {
    await h.close()
  }
})

test('a failed credential unset keeps the provider manageable', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    h.credentials.raw.failUnset = true
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /credential store locked/)
    const record = h.store.provider('zai-coding-cn')!
    assert.notEqual(record, undefined)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, record.brokerRef)
    assert.equal(h.service.getState().managedCount, 1)
    h.credentials.raw.failUnset = false
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
  } finally {
    await h.close()
  }
})

test('re-adding a key to an already-managed extra provider persists it', async () => {
  const h = await harness()
  try {
    await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra')
    await h.store.flush()
    const state = await h.service.addExtraProvider('deepinfra', 'backup', 'sk-backup')
    const view = state.providers.find(provider => provider.provider === 'deepinfra')!
    assert.equal(view.keyCount, 2)
    await h.store.flush()
    const persisted = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8')) as {
      providers: Record<string, { keys: unknown[] }>
    }
    assert.equal(persisted.providers.deepinfra?.keys.length, 2)
  } finally {
    await h.close()
  }
})


test('non-sticky round-robin preserves the retry budget across key changes', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 1 // make the next round-robin pick the second key
    const attemptKey = 'session-round\u0000zai-coding-cn'
    ;(h.service as any).attempts.set(attemptKey, {
      keyId: first.id,
      retries: 1,
      at: Date.now(),
      turn: 3,
      step: 1,
    })
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-round', messages: [] },
      async function* () {
        ;(h.service as any).als.getStore().keyUsed = true
        yield { type: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
      } as any,
    )
    for await (const _chunk of iterable) {
      // consume the wrapped stream
    }
    const attempt = (h.service as any).attempts.get(attemptKey)
    assert.equal(attempt.keyId, second.id)
    assert.equal(attempt.retries, 1)
  } finally {
    await h.close()
  }
})


test('a transient credential read failure does not permanently mark a key missing', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    h.credentials.raw.failResolve = true
    assert.equal((await h.service.selectKey('zai-coding-cn', 'session-transient')).key, undefined)
    assert.equal(key.valueMissing, false)
    h.credentials.raw.failResolve = false
    const selected = await h.service.selectKey('zai-coding-cn', 'session-transient')
    assert.equal(selected.key!.id, key.id)
    assert.equal(key.valueMissing, false)
  } finally {
    await h.close()
  }
})

test('a restored missing credential is re-probed on selection', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    h.credentials.refs.delete(key.ref)
    assert.equal((await h.service.selectKey('zai-coding-cn', 'session-missing')).key, undefined)
    assert.equal(key.valueMissing, true)
    h.credentials.refs.set(key.ref, 'sk-restored')
    const selected = await h.service.selectKey('zai-coding-cn', 'session-missing')
    assert.equal(selected.key!.id, key.id)
    assert.equal(key.valueMissing, false)
  } finally {
    await h.close()
  }
})


test('a read-only profile fails release before deleting credentials', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const ref = record.keys[0].ref
    h.settings.writable = false
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /read-only/)
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(ref), true)
    h.settings.writable = true
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(ref), false)
  } finally {
    await h.close()
  }
})

test('adoption stops on a credential-store read error instead of creating an empty pool', async () => {
  const h = await harness()
  try {
    const before = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv
    h.credentials.raw.failResolve = true
    await assert.rejects(() => h.service.adoptProvider('zai-coding-cn'), /credential store is unavailable/)
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, before)
    h.credentials.raw.failResolve = false
  } finally {
    await h.close()
  }
})

test('a broken broker binding skips request selection and error handling', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    profile.apiKeyEnv = 'SOME_OTHER_REF'
    const selectSpy = vi.spyOn(h.service, 'selectKey')
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-broken', messages: [] },
      async function* () {
        yield { type: 'text' }
      } as any,
    )
    for await (const _chunk of iterable) {
      // consume
    }
    assert.equal(selectSpy.mock.calls.length, 0)
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    const next = vi.fn(async () => undefined)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 11,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-broken' } },
    } as unknown as RequestErrorPayload
    assert.equal(await h.service.requestErrorListener(payload, next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.equal(key.cooldownUntil, 0)
    selectSpy.mockRestore()
  } finally {
    await h.close()
  }
})

test('stale switch counters are pruned', async () => {
  const h = await harness()
  try {
    ;(h.service as any).switches.set('s\u0000p\u0000t\u0000s', { count: 1, at: Date.now() - 2 * 60 * 60 * 1000 })
    ;(h.service as any).pruneAttempts(Date.now())
    assert.equal((h.service as any).switches.has('s\u0000p\u0000t\u0000s'), false)
  } finally {
    await h.close()
  }
})


test('a transient probe failure on a bound key still tries another healthy key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const record = h.store.provider('zai-coding-cn')!
    const [first, second] = record.keys
    const bound = await h.service.selectKey('zai-coding-cn', 'session-bound')
    assert.equal(bound.key!.id, first.id)
    record.cursor = 0
    h.credentials.raw.failRefs.add(first.ref)
    const selected = await h.service.selectKey('zai-coding-cn', 'session-bound')
    assert.equal(selected.key!.id, second.id)
  } finally {
    await h.close()
  }
})

test('a settings mutation refusal keeps credentials before release', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const ref = record.keys[0].ref
    h.settings.failMutate = true
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /revision conflict/)
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(ref), true)
    h.settings.failMutate = false
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
  } finally {
    await h.close()
  }
})


test('a failed unset restores a plugin-created extra route', async () => {
  const h = await harness()
  try {
    await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra')
    const record = h.store.provider('deepinfra')!
    const live = h.settings.valueOf('llm-pi-ai').providers.deepinfra
    live.baseURL = 'https://edited.example/v1'
    live.models = [{ id: 'edited-model' }]
    h.credentials.raw.failUnset = true
    await assert.rejects(() => h.service.releaseProvider('deepinfra'), /credential store locked/)
    const profile = h.settings.valueOf('llm-pi-ai').providers.deepinfra
    assert.equal(profile.apiKeyEnv, record.brokerRef)
    assert.equal(profile.baseURL, 'https://edited.example/v1')
    assert.deepEqual(profile.models, [{ id: 'edited-model' }])
    assert.notEqual(h.store.provider('deepinfra'), undefined)
    h.credentials.raw.failUnset = false
    await h.service.releaseProvider('deepinfra')
    assert.equal(h.store.provider('deepinfra'), undefined)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.deepinfra, undefined)
  } finally {
    await h.close()
  }
})

test('an unreadable settings snapshot keeps managed selection active', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    ;(h.service as any).bindingCache.clear()
    h.settings.failDescribe = true
    const selectSpy = vi.spyOn(h.service, 'selectKey')
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-unknown', messages: [] },
      async function* () {
        yield { type: 'text' }
      } as any,
    )
    for await (const _chunk of iterable) {
      // consume
    }
    assert.equal(selectSpy.mock.calls.length, 1)
    const unknownAttempt = (h.service as any).attempts.get('session-unknown\u0000zai-coding-cn')
    unknownAttempt.usedManagedKey = true
    const unknownFailure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-unknown', unknownAttempt.keyId, unknownFailure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure: unknownFailure,
      signal: { aborted: false },
      agent: { session: { id: 'session-unknown' } },
    } as unknown as RequestErrorPayload
    const next = vi.fn(async () => ({ kind: 'retry' as const }))
    const result = await h.service.requestErrorListener(payload, next)
    assert.deepEqual(result, { kind: 'retry' })
    assert.equal(next.mock.calls.length, 0)
    selectSpy.mockRestore()
    h.settings.failDescribe = false
  } finally {
    await h.close()
  }
})

test('a failure with no selected key keeps the retry budget', async () => {
  const h = await harness()
  try {
    const attemptKey = 'session-none\u0000zai-coding-cn'
    ;(h.service as any).attempts.set(attemptKey, {
      keyId: 'k-first',
      retries: 1,
      at: Date.now(),
      turn: 1,
      step: 1,
    })
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-none', undefined, { code: 'RATE_LIMIT' }, true)
    const attempt = (h.service as any).attempts.get(attemptKey)
    assert.equal(attempt.keyId, 'k-first')
    assert.equal(attempt.retries, 1)
  } finally {
    await h.close()
  }
})

test('active switch budgets survive wall-clock pruning', async () => {
  const h = await harness()
  try {
    const switchKey = 's\u0000p\u00001\u00001'
    const at = Date.now() - 2 * 60 * 60 * 1000
    ;(h.service as any).switches.set(switchKey, { count: 1, at })
    ;(h.service as any).stepAttempts.set(switchKey, {
      keyId: 'k',
      retries: 0,
      at,
      turn: 1,
      step: 1,
      usedManagedKey: true,
    })
    ;(h.service as any).pruneAttempts(Date.now())
    assert.equal((h.service as any).switches.has(switchKey), true)
    ;(h.service as any).stepAttempts.delete(switchKey)
    ;(h.service as any).pruneAttempts(Date.now())
    assert.equal((h.service as any).switches.has(switchKey), false)
  } finally {
    await h.close()
  }
})


test('release leaves an externally replaced native profile untouched', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const ref = record.keys[0].ref
    const live = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    live.apiKeyEnv = 'SOME_OTHER_REF'
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, 'SOME_OTHER_REF')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(ref), false)
  } finally {
    await h.close()
  }
})

test('release leaves an externally replaced extra route untouched', async () => {
  const h = await harness()
  try {
    await h.service.addExtraProvider('deepinfra', 'main', 'sk-deepinfra')
    const record = h.store.provider('deepinfra')!
    const live = h.settings.valueOf('llm-pi-ai').providers.deepinfra
    live.apiKeyEnv = 'SOME_OTHER_REF'
    await h.service.releaseProvider('deepinfra')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.deepinfra.apiKeyEnv, 'SOME_OTHER_REF')
    assert.equal(h.store.provider('deepinfra'), undefined)
    assert.equal(h.credentials.refs.has(record.keys[0].ref), false)
  } finally {
    await h.close()
  }
})

test('a partially deleted pool records per-key deletion progress', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const record = h.store.provider('zai-coding-cn')!
    h.credentials.raw.failUnsetRefs.add(record.keys[1].ref)
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /credential store locked/)
    assert.equal(record.keys[0].valueMissing, true)
    assert.equal(record.keys[1].valueMissing, false)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, record.brokerRef)
    h.credentials.raw.failUnsetRefs.clear()
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
  } finally {
    await h.close()
  }
})

test('concurrent first selections bind one sticky key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const [first, second] = await Promise.all([
      h.service.selectKey('zai-coding-cn', 'session-concurrent'),
      h.service.selectKey('zai-coding-cn', 'session-concurrent'),
    ])
    assert.equal(first.key!.id, second.key!.id)
    assert.equal(h.store.binding('session-concurrent', 'zai-coding-cn')!.keyId, first.key!.id)
  } finally {
    await h.close()
  }
})

test('attempt pruning keeps an active step whose latest switch is recent', async () => {
  const h = await harness()
  try {
    const now = Date.now()
    const activeAttempt = 's\u0000p'
    const activeSwitch = 's\u0000p\u00001\u00001'
    ;(h.service as any).attempts.set(activeAttempt, {
      keyId: 'k',
      retries: 0,
      at: now - 2 * 60 * 60 * 1000,
      turn: 1,
      step: 1,
      usedManagedKey: true,
    })
    ;(h.service as any).switches.set(activeSwitch, { count: 1, at: now - 1000 })
    for (let index = 0; index < 128; index += 1) {
      ;(h.service as any).attempts.set(`d${index}\u0000p`, {
        keyId: 'k',
        retries: 0,
        at: now - 2 * 60 * 60 * 1000,
        turn: 2,
        step: 1,
        usedManagedKey: true,
      })
    }
    ;(h.service as any).pruneAttempts(now)
    assert.equal((h.service as any).attempts.has(activeAttempt), true)
    assert.equal((h.service as any).switches.has(activeSwitch), true)
  } finally {
    await h.close()
  }
})


test('an unreadable snapshot does not re-enable a known binding mismatch', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv = 'SOME_OTHER_REF'
    h.service.getState() // populate the confirmed mismatch cache
    h.settings.failDescribe = true
    const selectSpy = vi.spyOn(h.service, 'selectKey')
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-known-mismatch', messages: [] },
      async function* () {
        yield { type: 'text' }
      } as any,
    )
    for await (const _chunk of iterable) {
      // consume
    }
    assert.equal(selectSpy.mock.calls.length, 0)
    selectSpy.mockRestore()
    h.settings.failDescribe = false
  } finally {
    await h.close()
  }
})

test('release refuses to proceed when settings are unreadable', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const ref = record.keys[0].ref
    h.settings.failDescribe = true
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /unreadable/)
    assert.equal(h.credentials.refs.has(ref), true)
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined)
    h.settings.failDescribe = false
  } finally {
    await h.close()
  }
})


test('an alternate with a removed credential does not cool the current key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 1 })
    const record = h.store.provider('zai-coding-cn')!
    const [current, alternate] = record.keys
    const selected = await h.service.selectKey('zai-coding-cn', 'session-alternate')
    assert.equal(selected.key!.id, current.id)
    ;(h.service as any).attempts.set('session-alternate\u0000zai-coding-cn', {
      keyId: current.id,
      retries: 0,
      at: Date.now(),
      turn: 9,
      step: 1,
      usedManagedKey: true,
    })
    h.credentials.refs.delete(alternate.ref)
    const alternateFailure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-alternate', current.id, alternateFailure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 9,
      step: 1,
      failure: alternateFailure,
      signal: { aborted: false },
      agent: { session: { id: 'session-alternate' } },
    } as unknown as RequestErrorPayload
    const next = vi.fn(async () => ({ kind: 'retry' as const }))
    assert.deepEqual(await h.service.requestErrorListener(payload, next), { kind: 'retry' })
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-alternate', current.id, true)
    assert.deepEqual(await h.service.requestErrorListener(payload, next), { kind: 'retry' })
    assert.equal(next.mock.calls.length, 1)
    assert.equal(current.cooldownUntil, 0)
    assert.equal(alternate.valueMissing, true)
    assert.equal(h.store.binding('session-alternate', 'zai-coding-cn')!.keyId, current.id)
  } finally {
    await h.close()
  }
})


test('concurrent steps keep separate retry budgets', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.setSettings({ retryCount: 1 })
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    ;(h.service as any).attempts.set('session-steps\u0000zai-coding-cn', {
      keyId: key.id,
      retries: 0,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
    })
    const failureA = { code: 'RATE_LIMIT', message: 'busy-a' }
    const failureB = { code: 'RATE_LIMIT', message: 'busy-b' }
    linkFailure(h, 'zai-coding-cn', 'session-steps', key.id, failureA)
    linkFailure(h, 'zai-coding-cn', 'session-steps', key.id, failureB)
    const payload = (failure: object, turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-steps' } },
    }) as unknown as RequestErrorPayload
    const next = vi.fn(async () => undefined)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureA, 1), next), { kind: 'retry' })
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB, 2), next), { kind: 'retry' })
    assert.equal(await h.service.requestErrorListener(payload(failureA, 1), next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.equal((h.service as any).stepAttempts.get('session-steps\u0000zai-coding-cn\u00001\u00001'), undefined)
    assert.equal((h.service as any).stepAttempts.get('session-steps\u0000zai-coding-cn\u00002\u00001').retries, 1)
  } finally {
    await h.close()
  }
})

test('a finish without broker evidence is not attributed to a managed key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-no-evidence', messages: [] },
      async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
      } as any,
    )
    for await (const _chunk of iterable) {
      // consume
    }
    assert.equal((h.service as any).attempts.has('session-no-evidence\u0000zai-coding-cn'), false)
    const next = vi.fn(async () => undefined)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-no-evidence' } },
    } as unknown as RequestErrorPayload
    assert.equal(await h.service.requestErrorListener(payload, next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.equal(key.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})


test('root-namespace compensation restores the live apiKeyEnv', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('deepseek-official')
    const record = h.store.provider('deepseek-official')!
    h.credentials.raw.failUnset = true
    await assert.rejects(() => h.service.releaseProvider('deepseek-official'), /credential store locked/)
    assert.equal(h.settings.valueOf('llm-deepseek-api-key').apiKeyEnv, record.brokerRef)
    h.credentials.raw.failUnset = false
    await h.service.releaseProvider('deepseek-official')
    assert.equal(h.settings.valueOf('llm-deepseek-api-key').apiKeyEnv, 'DEEPSEEK_API_KEY')
  } finally {
    await h.close()
  }
})

test('a mismatch release records partial deletion without touching the profile', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const record = h.store.provider('zai-coding-cn')!
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv = 'SOME_OTHER_REF'
    h.credentials.raw.failUnsetRefs.add(record.keys[1].ref)
    await assert.rejects(() => h.service.releaseProvider('zai-coding-cn'), /credential store locked/)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, 'SOME_OTHER_REF')
    assert.equal(record.keys[0].valueMissing, true)
    assert.equal(record.keys[1].valueMissing, false)
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined)
    h.credentials.raw.failUnsetRefs.clear()
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, 'SOME_OTHER_REF')
  } finally {
    await h.close()
  }
})


test('a retried step refreshes attribution to the key it actually used', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 1 })
    const record = h.store.provider('zai-coding-cn')!
    const [first, second] = record.keys
    ;(h.service as any).attempts.set('session-retry\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
    })
    const failureOne = { code: 'RATE_LIMIT', message: 'busy-one' }
    const failureTwo = { code: 'RATE_LIMIT', message: 'busy-two' }
    const failureThree = { code: 'RATE_LIMIT', message: 'busy-three' }
    linkFailure(h, 'zai-coding-cn', 'session-retry', first.id, failureOne)
    const payload = (failure: object) => ({
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-retry' } },
    }) as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload(failureOne), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    linkFailure(h, 'zai-coding-cn', 'session-retry', second.id, failureTwo)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureTwo), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    linkFailure(h, 'zai-coding-cn', 'session-retry', second.id, failureThree)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureThree), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal(second.cooldownUntil > 0, true)
    assert.equal(first.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})

test('a retry on an external credential does not cool a managed key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.setSettings({ retryCount: 1 })
    const key = h.store.provider('zai-coding-cn')!.keys[0]
    ;(h.service as any).attempts.set('session-external\u0000zai-coding-cn', {
      keyId: key.id,
      retries: 0,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
    })
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-external' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-external', undefined, false)
    const next = vi.fn(async () => undefined)
    assert.equal(await h.service.requestErrorListener(payload, next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.equal(key.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})

test('first errors of concurrent steps claim separate stream attempts', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 2 })
    const [first, second] = h.store.provider('zai-coding-cn')!.keys
    ;(h.service as any).attempts.set('session-concurrent-events\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-concurrent-events', first.id, true)
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-concurrent-events', second.id, true)
    const payload = (turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-concurrent-events' } },
    }) as unknown as RequestErrorPayload
    await h.service.requestErrorListener(payload(1), async () => ({ kind: 'retry' as const }))
    await h.service.requestErrorListener(payload(2), async () => ({ kind: 'retry' as const }))
    assert.equal((h.service as any).stepAttempts.get('session-concurrent-events\u0000zai-coding-cn\u00001\u00001').keyId, first.id)
    assert.equal((h.service as any).stepAttempts.get('session-concurrent-events\u0000zai-coding-cn\u00002\u00001').keyId, second.id)
  } finally {
    await h.close()
  }
})


test('unscoped broker resolution skips paused keys', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    await h.service.updateKey('zai-coding-cn', first.id, { enabled: false })
    const paused = await h.credentials.raw.resolve(provider.brokerRef)
    assert.equal(paused!.value, 'sk-second')
    await h.service.updateKey('zai-coding-cn', second.id, { enabled: false })
    assert.equal(await h.credentials.raw.resolve(provider.brokerRef), undefined)
  } finally {
    await h.close()
  }
})

test('a delegated non-failover failure is consumed before the next attribution', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 1 })
    const [first, second] = h.store.provider('zai-coding-cn')!.keys
    const failureA = { code: 'INVALID_REQUEST', message: 'bad request' }
    const failureB = { code: 'RATE_LIMIT', message: 'busy' }
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-linked', first.id, true, failureA)
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-linked', second.id, true, failureB)
    const payload = (failure: object, turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-linked' } },
    }) as unknown as RequestErrorPayload
    const next = vi.fn(async () => undefined)
    assert.equal(await h.service.requestErrorListener(payload(failureA, 1), next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB, 2), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal((h.service as any).stepAttempts.get('session-linked\u0000zai-coding-cn\u00002\u00001').keyId, second.id)
  } finally {
    await h.close()
  }
})

test('linked failures are attributed even when callbacks arrive out of order', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 2 })
    const [first, second] = h.store.provider('zai-coding-cn')!.keys
    const failureA = { code: 'RATE_LIMIT', message: 'busy-a' }
    const failureB = { code: 'RATE_LIMIT', message: 'busy-b' }
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-reversed', first.id, true, failureA)
    ;(h.service as any).recordStreamAttempt('zai-coding-cn', 'session-reversed', second.id, true, failureB)
    const payload = (failure: object, turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-reversed' } },
    }) as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB, 2), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.deepEqual(await h.service.requestErrorListener(payload(failureA, 1), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal((h.service as any).stepAttempts.get('session-reversed\u0000zai-coding-cn\u00002\u00001').keyId, second.id)
    assert.equal((h.service as any).stepAttempts.get('session-reversed\u0000zai-coding-cn\u00001\u00001').keyId, first.id)
  } finally {
    await h.close()
  }
})


test('a skipped production stream failure does not pollute the next attribution', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 0
    const failureA = { code: 'UNKNOWN_MODEL', message: 'unknown model' }
    const failureB = { code: 'RATE_LIMIT', message: 'busy' }
    await consume(streamFailure(h, 'zai-coding-cn', 'session-production', failureA))
    const next = vi.fn(async () => undefined)
    const payload = (failure: object, turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-production' } },
    }) as unknown as RequestErrorPayload
    assert.equal(await h.service.requestErrorListener(payload(failureA, 1), next), undefined)
    assert.equal(next.mock.calls.length, 1)
    await consume(streamFailure(h, 'zai-coding-cn', 'session-production', failureB))
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB, 2), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal((h.service as any).stepAttempts.get('session-production\u0000zai-coding-cn\u00002\u00001').keyId, second.id)
    assert.equal(first.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})

test('production stream failures keep their own attribution when callbacks reverse', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 2 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 0
    const failureA = { code: 'RATE_LIMIT', message: 'busy-a' }
    const failureB = { code: 'RATE_LIMIT', message: 'busy-b' }
    await consume(streamFailure(h, 'zai-coding-cn', 'session-production-reversed', failureA))
    await consume(streamFailure(h, 'zai-coding-cn', 'session-production-reversed', failureB))
    const payload = (failure: object, turn: number) => ({
      provider: 'zai-coding-cn',
      turn,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-production-reversed' } },
    }) as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB, 2), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.deepEqual(await h.service.requestErrorListener(payload(failureA, 1), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal((h.service as any).stepAttempts.get('session-production-reversed\u0000zai-coding-cn\u00002\u00001').keyId, second.id)
    assert.equal((h.service as any).stepAttempts.get('session-production-reversed\u0000zai-coding-cn\u00001\u00001').keyId, first.id)
  } finally {
    await h.close()
  }
})

test('a successful mutation surfaces a durable state write failure', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await rm(h.dir, { recursive: true, force: true })
    await writeFile(h.dir, 'blocked')
    await assert.rejects(() => h.service.setSettings({ retryCount: 3 }), /EEXIST|ENOTDIR|not a directory/i)
    await rm(h.dir, { force: true })
    await mkdir(h.dir, { recursive: true })
    await h.store.flush()
    const persisted = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8')) as { settings: { retryCount: number } }
    assert.equal(persisted.settings.retryCount, 3)
  } finally {
    await h.close()
  }
})


test('an existing step without request evidence delegates and clears its budget', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 2 })
    const [first] = h.store.provider('zai-coding-cn')!.keys
    ;(h.service as any).attempts.set('session-no-evidence-step\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failureOne = { code: 'RATE_LIMIT', message: 'busy-one' }
    linkFailure(h, 'zai-coding-cn', 'session-no-evidence-step', first.id, failureOne)
    const payload = (failure: object) => ({
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-no-evidence-step' } },
    }) as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload(failureOne), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const next = vi.fn(async () => undefined)
    assert.equal(await h.service.requestErrorListener(payload({ code: 'RATE_LIMIT', message: 'unlinked' }), next), undefined)
    assert.equal(next.mock.calls.length, 1)
    assert.equal((h.service as any).stepAttempts.get('session-no-evidence-step\u0000zai-coding-cn\u00001\u00001'), undefined)
    assert.equal(first.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})

test('a non-sticky retry uses the key selected for the attempt', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 1
    ;(h.service as any).attempts.set('session-pin\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-pin', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-pin' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const retry = await h.service.selectKey('zai-coding-cn', 'session-pin', { turn: 1, step: 1 })
    assert.equal(retry.key!.id, first.id)
    const fresh = await h.service.selectKey('zai-coding-cn', 'session-pin')
    assert.equal(fresh.key!.id, second.id)
  } finally {
    await h.close()
  }
})

test('shutdown drains a blocked mutation before the final snapshot', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const originalFlush = h.store.flush.bind(h.store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ;(h.store as any).flush = async () => {
      await gate
      return originalFlush()
    }
    const pending = h.service.setSettings({ retryCount: 3 })
    await new Promise(resolve => setTimeout(resolve, 0))
    const closing = h.service.close()
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(closed, false)
    release()
    await pending
    await closing
    await assert.rejects(() => h.service.setSettings({ retryCount: 1 }), /shutting down/)
    const persisted = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8')) as {
      settings: { retryCount: number }
    }
    assert.equal(persisted.settings.retryCount, 3)
  } finally {
    await h.close()
  }
})


test('a non-sticky failover retry uses the verified alternate', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 0
    ;(h.service as any).attempts.set('session-switch-pin\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failureOne = { code: 'RATE_LIMIT', message: 'busy-one' }
    const failureTwo = { code: 'RATE_LIMIT', message: 'busy-two' }
    const payload = (failure: object) => ({
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-switch-pin' } },
    }) as unknown as RequestErrorPayload
    linkFailure(h, 'zai-coding-cn', 'session-switch-pin', first.id, failureOne)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureOne), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    linkFailure(h, 'zai-coding-cn', 'session-switch-pin', first.id, failureTwo)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureTwo), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const retry = await h.service.selectKey('zai-coding-cn', 'session-switch-pin', { turn: 1, step: 1 })
    assert.equal(retry.key!.id, second.id)
    assert.equal(first.cooldownUntil > 0, true)
  } finally {
    await h.close()
  }
})


test('step-scoped retry pins are consumed only for the matching step', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 0
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-pins', 1, 1, first.id)
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-pins', 2, 1, second.id)
    const firstStep = await h.service.selectKey('zai-coding-cn', 'session-pins', { turn: 1, step: 1 })
    assert.equal(firstStep.key!.id, first.id)
    assert.equal((h.service as any).retryBindings.size, 1)
    const secondStep = await h.service.selectKey('zai-coding-cn', 'session-pins', { turn: 2, step: 1 })
    assert.equal(secondStep.key!.id, second.id)
    assert.equal((h.service as any).retryBindings.size, 0)
  } finally {
    await h.close()
  }
})

test('rebuilding another provider preserves unrelated retry pins', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const pinKey = 'session-rebuild\u0000zai-coding-cn\u00001\u00001'
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-rebuild', 1, 1, h.store.provider('zai-coding-cn')!.keys[0].id)
    assert.equal((h.service as any).retryBindings.has(pinKey), true)
    await h.service.adoptProvider('anthropic')
    assert.equal((h.service as any).retryBindings.has(pinKey), true)
    await h.service.releaseProvider('anthropic')
    assert.equal((h.service as any).retryBindings.has(pinKey), true)
  } finally {
    await h.close()
  }
})

test('retry budgets are tracked per key within one step', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 1 })
    const [first, second] = h.store.provider('zai-coding-cn')!.keys
    const switchKey = 'session-per-key\u0000zai-coding-cn\u00001\u00001'
    ;(h.service as any).stepAttempts.set(switchKey, {
      keyId: first.id,
      retries: 1,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
      keyRetries: { [first.id]: 1 },
    })
    const failureB = { code: 'RATE_LIMIT', message: 'busy-b1' }
    const failureA = { code: 'RATE_LIMIT', message: 'busy-a2' }
    const payload = (failure: object) => ({
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-per-key' } },
    }) as unknown as RequestErrorPayload
    linkFailure(h, 'zai-coding-cn', 'session-per-key', second.id, failureB)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureB), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const afterB = (h.service as any).stepAttempts.get(switchKey)
    assert.equal(afterB.keyId, second.id)
    assert.equal(afterB.retries, 1)
    assert.equal(afterB.keyRetries[second.id], 1)
    linkFailure(h, 'zai-coding-cn', 'session-per-key', first.id, failureA)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureA), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal(first.cooldownUntil > 0, true)
    assert.equal(second.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})


test('a production retry consumes the pending step pin and clears it on success', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 1
    ;(h.service as any).attempts.set('session-production-pin\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-production-pin', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-production-pin' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    h.service.noteRequestStep({ agent: { session: { id: 'session-production-pin' } }, turn: 1, step: 1 }, 'zai-coding-cn')
    let seen: { value?: string } | undefined
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-production-pin', messages: [] },
      async function* () {
        seen = await h.credentials.raw.resolve(provider.brokerRef)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(iterable)
    assert.equal(seen!.value, 'sk-existing-zai')
    assert.equal((h.service as any).retryBindings.size, 0)
  } finally {
    await h.close()
  }
})

test('failover carries a candidate key already-spent retry budget', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ retryCount: 1 })
    const [first, second] = h.store.provider('zai-coding-cn')!.keys
    const switchKey = 'session-carry\u0000zai-coding-cn\u00001\u00001'
    ;(h.service as any).stepAttempts.set(switchKey, {
      keyId: first.id,
      retries: 1,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
      keyRetries: { [first.id]: 1, [second.id]: 1 },
    })
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-carry', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-carry' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    const switched = (h.service as any).stepAttempts.get(switchKey)
    assert.equal(switched.keyId, second.id)
    assert.equal(switched.retries, 1)
  } finally {
    await h.close()
  }
})


test('a selection without the recovery context does not steal a step pin', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first] = provider.keys
    ;(h.service as any).attempts.set('session-not-stolen\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-not-stolen', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-not-stolen' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    ;(h.service as any).requestSteps.delete('session-not-stolen')
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-not-stolen', messages: [] },
      async function* () {
        await h.credentials.raw.resolve(provider.brokerRef)
        yield { type: 'text' }
      } as any,
    )
    await consume(iterable)
    assert.equal((h.service as any).retryBindings.size, 1)
    const pinned = await h.service.selectKey('zai-coding-cn', 'session-not-stolen', { turn: 1, step: 1 })
    assert.equal(pinned.key!.id, first.id)
  } finally {
    await h.close()
  }
})


test('a non-sticky three-key failover retry uses the verified alternate', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.addKey('zai-coding-cn', 'third', 'sk-third')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    const switchKey = 'session-three\u0000zai-coding-cn\u00001\u00001'
    ;(h.service as any).stepAttempts.set(switchKey, {
      keyId: first.id,
      retries: 1,
      at: Date.now(),
      turn: 1,
      step: 1,
      usedManagedKey: true,
      keyRetries: { [first.id]: 1 },
    })
    provider.cursor = 1
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-three', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-three' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    h.service.noteRequestStep({ agent: { session: { id: 'session-three' } }, turn: 1, step: 1 }, 'zai-coding-cn')
    let seen: { value?: string } | undefined
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-three', messages: [] },
      async function* () {
        seen = await h.credentials.raw.resolve(provider.brokerRef)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(iterable)
    assert.equal(seen!.value, 'sk-second')
    assert.equal(second.totalUses, 1)
  } finally {
    await h.close()
  }
})

test('a new step preserves another in-flight step retry pin', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const [first] = h.store.provider('zai-coding-cn')!.keys
    ;(h.service as any).attempts.set('session-abandon\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    linkFailure(h, 'zai-coding-cn', 'session-abandon', first.id, failure)
    const payload = {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-abandon' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    h.service.noteRequestStep({ agent: { session: { id: 'session-abandon' } }, turn: 2, step: 1 }, 'zai-coding-cn')
    // The pin recorded for turn 1 must still be consumable by its own step
    // after a newer step has been noted.
    const pinned = await h.service.selectKey('zai-coding-cn', 'session-abandon', { turn: 1, step: 1 })
    assert.equal(pinned.key!.id, first.id)
  } finally {
    await h.close()
  }
})


test('request steps are keyed per provider', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.adoptProvider('anthropic')
    h.service.noteRequestStep({ agent: { session: { id: 'session-provider' } }, turn: 1, step: 1 }, 'zai-coding-cn')
    h.service.noteRequestStep({ agent: { session: { id: 'session-provider' } }, turn: 2, step: 1 }, 'anthropic')
    assert.equal((h.service as any).requestSteps.get('session-provider\u0000zai-coding-cn').turn, 1)
    assert.equal((h.service as any).requestSteps.get('session-provider\u0000anthropic').turn, 2)
  } finally {
    await h.close()
  }
})


test('a purpose-scoped stream leaves the agent step pin untouched', async () => {
  const h = await pluginHarness()
  try {
    const service = h.service
    await service.adoptProvider('zai-coding-cn')
    await service.addKey('zai-coding-cn', 'second', 'sk-second')
    await service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = service.store.provider('zai-coding-cn')!
    provider.cursor = 0
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    const seen: Array<string | undefined> = []
    const request = (): unknown =>
      h.emit('agent/request', { agent: { session: { id: 'session-bypass' } }, turn: 1, step: 1 }, () => ({ provider: 'zai-coding-cn' }))
    const stream = (chunks: unknown[], purpose?: string): Promise<void> => consume(h.emit('llm/stream', {
      provider: 'zai-coding-cn',
      model: 'model',
      sessionId: 'session-bypass',
      ...(purpose === undefined ? {} : { purpose }),
      messages: [],
    }, async function* () {
      seen.push((await h.credentials.raw.resolve(provider.brokerRef))?.value)
      yield* chunks
    }) as AsyncIterable<unknown>)

    // A failing step pins the first key for its retry.
    await request()
    await stream([{ type: 'finish', reason: { kind: 'error', failure } }])
    assert.deepEqual(await h.emit('agent/request-error', {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-bypass' } },
    }, async () => undefined), { kind: 'retry' })

    // A compaction bypass on the same session and provider must neither
    // consume nor clear the pending pin.
    await stream([{ type: 'finish', reason: { kind: 'stop' } }], 'compaction')

    // The retry stream still consumes the untouched pin.
    await request()
    provider.cursor = 1 // without the pin, round-robin would now pick the second key
    await stream([{ type: 'finish', reason: { kind: 'stop' } }])
    assert.deepEqual(seen, ['sk-existing-zai', 'sk-second', 'sk-existing-zai'])
  } finally {
    await h.close()
  }
})

test('unmanaged provider requests do not create step records', async () => {
  const h = await pluginHarness()
  try {
    const service = h.service
    await service.adoptProvider('zai-coding-cn')
    await service.setSettings({ stickySession: false })
    const managed = service.store.provider('zai-coding-cn')!
    // A step is noted for an unmanaged provider route, but the plugin keeps
    // no record: the stream passes through unwrapped and the broker supplies
    // no credential for it.
    await h.emit('agent/request', { agent: { session: { id: 'session-unmanaged' } }, turn: 1, step: 1 }, () => ({ provider: 'openai-codex' }))
    let resolved: { value?: string } | undefined
    const passthrough = h.emit('llm/stream', {
      provider: 'openai-codex',
      model: 'model',
      sessionId: 'session-unmanaged',
      messages: [],
    }, async function* () {
      resolved = await h.credentials.raw.resolve('OPENAI_CODEX_API_KEY')
      yield { type: 'text' }
    }) as AsyncIterable<unknown>
    await consume(passthrough)
    assert.equal(resolved, undefined)
    // Its request errors are delegated untouched: no retry is requested and
    // no pin is recorded.
    const next = vi.fn(async () => undefined)
    const action = await h.emit('agent/request-error', {
      provider: 'openai-codex',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-unmanaged' } },
    }, next)
    assert.equal(action, undefined)
    assert.equal(next.mock.calls.length, 1)
    // The same session's managed provider still resolves through the broker.
    await h.emit('agent/request', { agent: { session: { id: 'session-unmanaged' } }, turn: 1, step: 1 }, () => ({ provider: 'zai-coding-cn' }))
    let seen: { value?: string } | undefined
    const managedStream = h.emit('llm/stream', {
      provider: 'zai-coding-cn',
      model: 'model',
      sessionId: 'session-unmanaged',
      messages: [],
    }, async function* () {
      seen = await h.credentials.raw.resolve(managed.brokerRef)
      yield { type: 'text' }
    }) as AsyncIterable<unknown>
    await consume(managedStream)
    assert.equal(seen!.value, 'sk-existing-zai')
  } finally {
    await h.close()
  }
})

test('transient pruning drops expired request steps without UI traffic', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    await h.service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 1
    h.service.noteRequestStep({ agent: { session: { id: 'session-expire' } }, turn: 1, step: 1 }, 'zai-coding-cn')
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-expire', 1, 1, first.id)

    // The 60-second pin window is shorter than the 1-hour request-step
    // window: after 90 seconds the pin is gone while the step record stays.
    h.service.pruneTransient(Date.now() + 90 * 1000)
    const unpinned = await h.service.selectKey('zai-coding-cn', 'session-expire', { turn: 1, step: 1 })
    assert.equal(unpinned.key!.id, second.id)

    // After 2 hours the step record is gone as well: a waterfall stream no
    // longer carries step context, so a fresh pin survives for an explicit
    // step-scoped selection instead of being consumed by the next stream.
    h.service.pruneTransient(Date.now() + 2 * 60 * 60 * 1000)
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-expire', 2, 1, first.id)
    provider.cursor = 1
    let seen: { value?: string } | undefined
    const iterable = h.service.streamListener(
      { provider: 'zai-coding-cn', model: 'model', sessionId: 'session-expire', messages: [] },
      async function* () {
        seen = await h.credentials.raw.resolve(provider.brokerRef)
        yield { type: 'text' }
      } as any,
    )
    await consume(iterable)
    assert.equal(seen!.value, 'sk-second')
    const explicit = await h.service.selectKey('zai-coding-cn', 'session-expire', { turn: 2, step: 1 })
    assert.equal(explicit.key!.id, first.id)
  } finally {
    await h.close()
  }
})

test('a retry waterfall consumes exactly its own pin and lands the switched key', async () => {
  const h = await pluginHarness()
  try {
    const service = h.service
    await service.adoptProvider('zai-coding-cn')
    await service.addKey('zai-coding-cn', 'second', 'sk-second')
    await service.setSettings({ stickySession: false, retryCount: 1 })
    const provider = service.store.provider('zai-coding-cn')!
    provider.cursor = 1 // plain round-robin starts at the second key
    const failure = { code: 'RATE_LIMIT', message: 'busy' }
    const seen: Array<string | undefined> = []
    const request = (): unknown =>
      h.emit('agent/request', { agent: { session: { id: 'session-fallback' } }, turn: 1, step: 1 }, () => ({ provider: 'zai-coding-cn' }))
    const stream = (chunks: unknown[]): Promise<void> => consume(h.emit('llm/stream', {
      provider: 'zai-coding-cn',
      model: 'model',
      sessionId: 'session-fallback',
      messages: [],
    }, async function* () {
      seen.push((await h.credentials.raw.resolve(provider.brokerRef))?.value)
      yield* chunks
    }) as AsyncIterable<unknown>)
    const reportFailure = (): unknown => h.emit('agent/request-error', {
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-fallback' } },
    }, async () => undefined)

    // First attempt: round-robin picks the second key, which fails once.
    await request()
    await stream([{ type: 'finish', reason: { kind: 'error', failure } }])
    assert.deepEqual(await reportFailure(), { kind: 'retry' })
    // The retry stream must land on the pinned key, not drift with the cursor.
    await request()
    await stream([{ type: 'finish', reason: { kind: 'error', failure } }])
    assert.deepEqual(await reportFailure(), { kind: 'retry' })
    // Retry budget spent: the listener switches, pins the first key, and the
    // retry stream consumes exactly that pin before finishing cleanly.
    await request()
    await stream([{ type: 'finish', reason: { kind: 'stop' } }])
    assert.deepEqual(seen, ['sk-second', 'sk-second', 'sk-existing-zai'])
  } finally {
    await h.close()
  }
})

test('a retry pin expires after 60 seconds', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const h = await harness()
    try {
      await h.service.adoptProvider('zai-coding-cn')
      await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
      await h.service.setSettings({ stickySession: false, retryCount: 1 })
      const provider = h.store.provider('zai-coding-cn')!
      const [first, second] = provider.keys
      provider.cursor = 1
      ;(h.service as any).pinRetry('zai-coding-cn', 'session-pin-ttl', 1, 1, first.id)
      const within = await h.service.selectKey('zai-coding-cn', 'session-pin-ttl', { turn: 1, step: 1 })
      assert.equal(within.key!.id, first.id)
      // Re-pin, then age past the 60-second window: the pin is ignored and
      // the plain round-robin answer comes back instead.
      ;(h.service as any).pinRetry('zai-coding-cn', 'session-pin-ttl', 2, 1, first.id)
      vi.setSystemTime(Date.now() + 60_001)
      const expired = await h.service.selectKey('zai-coding-cn', 'session-pin-ttl', { turn: 2, step: 1 })
      assert.equal(expired.key!.id, second.id)
    } finally {
      await h.close()
    }
  } finally {
    vi.useRealTimers()
  }
})


function recordWithKeys(keys: KeyRecord[]): ProviderRecord {
  return {
    provider: 'anthropic',
    displayName: 'Anthropic',
    source: 'dsh',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'anthropic'],
    adapter: 'pi-ai',
    brokerRef: 'KEYSMGR_ANTHROPIC_AAAAAA',
    originalApiKeyEnv: null,
    createdProfile: false,
    hadProfile: true,
    extraId: null,
    api: null,
    baseURL: null,
    models: [],
    adoptedAt: 0,
    cursor: 0,
    keys,
  }
}

function accountRow(oauth: KeyRecord['oauth']): KeyRecord {
  return {
    id: 'acct',
    alias: 'Work account',
    ref: 'KEYSMGR_ANTHROPIC_AAAAAA_K_3FA2C1',
    kind: 'oauth',
    enabled: true,
    createdAt: 0,
    lastUsedAt: 0,
    valueMissing: false,
    cooldownUntil: 0,
    lastFailureAt: 0,
    lastFailureCode: '',
    failureLevel: 0,
    consecutiveFailures: 0,
    totalUses: 0,
    totalFailures: 0,
    importedFrom: null,
    oauth,
  }
}

test('an oauth account row round-trips through the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-oauth-'))
  try {
    const file = join(dir, 'state.json')
    const store = new KeysManagerStore(file)
    store.state.providers.anthropic = recordWithKeys([
      accountRow({
        provider: 'anthropic',
        email: 'dev@example.com',
        accountId: 'acc-1',
        expiresAt: 1_700_060_000_000,
        grantRef: 'keys-manager/anthropic-3fa2c1',
      }),
    ])
    store.touch()
    await store.flush()
    const reloaded = new KeysManagerStore(file)
    const row = reloaded.provider('anthropic')!.keys[0]
    assert.equal(row.kind, 'oauth')
    assert.deepEqual(row.oauth, {
      provider: 'anthropic',
      email: 'dev@example.com',
      accountId: 'acc-1',
      expiresAt: 1_700_060_000_000,
      grantRef: 'keys-manager/anthropic-3fa2c1',
    })
    await reloaded.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an oauth demotion marker survives a restart while an api-key read flag does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-oauth-demotion-'))
  try {
    const file = join(dir, 'state.json')
    const store = new KeysManagerStore(file)
    const cooldownUntil = Date.now() + 60_000
    // A demoted account row: the projection is gone, so `valueMissing` is the
    // only persisted indication that this row no longer serves the provider.
    const demoted = accountRow({
      provider: 'anthropic',
      grantRef: 'keys-manager/anthropic-3fa2c1',
    })
    demoted.valueMissing = true
    demoted.cooldownUntil = cooldownUntil
    // An api-key row still uses the flag for a transient read failure.
    const apiKey: KeyRecord = {
      id: 'k1',
      alias: 'Imported',
      ref: 'KEYSMGR_ANTHROPIC_AAAAAA_K_111111',
      kind: 'api-key',
      enabled: true,
      createdAt: 0,
      lastUsedAt: 0,
      cooldownUntil: 0,
      lastFailureAt: 0,
      lastFailureCode: '',
      failureLevel: 0,
      consecutiveFailures: 0,
      totalUses: 0,
      totalFailures: 0,
      valueMissing: true,
      importedFrom: null,
      oauth: null,
    }
    store.state.providers.anthropic = recordWithKeys([demoted, apiKey])
    store.touch()
    await store.flush()
    const reloaded = new KeysManagerStore(file)
    const oauthRow = reloaded.provider('anthropic')!.keys.find(row => row.kind === 'oauth')!
    assert.equal(oauthRow.valueMissing, true)
    // The marker outlives its cooldown: a restarted process cannot re-identify
    // an owner, so the row must stay missing instead of turning active again.
    assert.equal(statusOfKey(oauthRow, Date.now()), 'missing')
    assert.equal(statusOfKey(oauthRow, cooldownUntil + 1), 'missing')
    // Legacy api-key semantics are unchanged: re-probe instead of persisting.
    assert.equal(reloaded.provider('anthropic')!.keys.find(row => row.kind === 'api-key')!.valueMissing, false)
    await reloaded.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * R10 closure: persisting the marker is only half the contract — it must
 * clear through a RECOVERY action and nowhere else. `valueMissing` is the
 * sole durable evidence that a demoted row stopped serving (its projection is
 * gone), so a reload that dropped it, or a process that cleared it on its
 * own, would re-advertise a dead account as active. This pins both product
 * recovery paths (manual re-activation and a re-authentication harvest) and,
 * by asserting the marker still reads true immediately after each reload,
 * that the reload itself is not the thing that clears it.
 */
test('the oauth demotion marker clears only through the recovery path and stays cleared', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  const accountOf = (store: KeysManagerStore): KeyRecord =>
    store.provider('anthropic')!.keys.find(row => row.id === rowId)!
  // Reload the durable document the way a restarted process would, and run
  // the checks against exactly what landed on disk.
  const reload = async (check: (row: KeyRecord) => void): Promise<void> => {
    const store = new KeysManagerStore(join(h.dir, 'state.json'))
    try {
      check(accountOf(store))
    } finally {
      await store.close()
    }
  }
  try {
    // Setup: the account owns the live projection, so the demotion below runs
    // through the product path a rotation failure takes rather than mutating
    // a flag by hand.
    await h.service.activateAccount('anthropic', rowId)
    assert.equal(statusOfKey(accountOf(h.store), Date.now()), 'active')

    // Demote: the projection is deleted and the row is marked missing.
    await h.service.fallbackToKeys('anthropic')
    assert.equal(accountOf(h.store).valueMissing, true)
    assert.equal(statusOfKey(accountOf(h.store), Date.now()), 'missing')

    // Durability boundary 1: the marker survives a restart, and so does the
    // status it renders. Recovery is manual, so a reload must NOT clear it.
    await h.store.flush()
    await reload(row => {
      assert.equal(row.valueMissing, true)
      assert.equal(statusOfKey(row, Date.now()), 'missing')
    })
    // Reading the durable document is not a recovery for the live instance
    // either: the unmarshal path is not a reset path.
    assert.equal(accountOf(h.store).valueMissing, true)

    // Recovery path 1: manual re-activation clears the marker, and the
    // cleared state is what the next restart loads.
    await h.service.activateAccount('anthropic', rowId)
    assert.equal(accountOf(h.store).valueMissing, false)
    assert.equal(statusOfKey(accountOf(h.store), Date.now()), 'active')
    await h.store.flush()
    await reload(row => {
      assert.equal(row.valueMissing, false)
      assert.equal(statusOfKey(row, Date.now()), 'active')
    })

    // Recovery path 2: a re-authentication harvest for the same row resets
    // the demotion marker the same way (the second product recovery path).
    await h.service.fallbackToKeys('anthropic')
    assert.equal(accountOf(h.store).valueMissing, true)
    await h.store.flush()
    await reload(row => assert.equal(row.valueMissing, true))
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-recovered-value', access: 'at-recovered-value' }))
    const view = await h.service.beginAccountLogin('anthropic', undefined, rowId)
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    assert.equal(accountOf(h.store).valueMissing, false)
    assert.equal(statusOfKey(accountOf(h.store), Date.now()), 'active')
    await h.store.flush()
    await reload(row => {
      assert.equal(row.valueMissing, false)
      assert.equal(statusOfKey(row, Date.now()), 'active')
    })
  } finally {
    await h.close()
  }
})

test('the persisted state document serializes without oauth token payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-oauth-secret-'))
  try {
    const file = join(dir, 'state.json')
    const store = new KeysManagerStore(file)
    // Simulate a buggy writer handing the account a full grant payload: the
    // sanitizer must keep only the typed reference + metadata fields.
    store.state.providers.anthropic = recordWithKeys([
      accountRow({
        provider: 'anthropic',
        grantRef: 'keys-manager/anthropic-3fa2c1',
        accessToken: 'at-secret-value',
        refreshToken: 'rt-secret-value',
        idToken: 'id-secret-value',
      } as KeyRecord['oauth']),
    ])
    store.touch()
    await store.flush()
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('at-secret-value'))
    assert.ok(!text.includes('rt-secret-value'))
    assert.ok(!text.includes('id-secret-value'))
    assert.ok(text.includes('keys-manager/anthropic-3fa2c1'))
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('old state documents without account rows load unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-oauth-legacy-'))
  try {
    const file = join(dir, 'state.json')
    const legacy = {
      version: 1,
      settings: { retryCount: 2, baseCooldownMs: 300_000, recoveryGraceMs: 600_000, maxCooldownMs: 604_800_000, stickySession: true, autoSwitch: true },
      providers: {
        anthropic: {
          provider: 'anthropic',
          displayName: 'Anthropic',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'anthropic'],
          brokerRef: 'KEYSMGR_ANTHROPIC_AAAAAA',
          hadProfile: true,
          keys: [{ id: 'k1', alias: 'Imported', ref: 'KEYSMGR_ANTHROPIC_AAAAAA_K_111111' }],
        },
      },
      sessionBindings: {},
    }
    await writeFile(file, JSON.stringify(legacy), 'utf8')
    const store = new KeysManagerStore(file)
    const row = store.provider('anthropic')!.keys[0]
    assert.equal(row.id, 'k1')
    assert.equal(row.kind, 'api-key')
    assert.equal(row.oauth, null)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


/**
 * Flow-key pin. The authorization flow `llm-pi-ai/login.ts:149-171` registers
 * for a provider is keyed by `recordKeyFor(providerId)`, which is
 * `credentialKey(RECORD_SCOPE, providerId)` with `RECORD_SCOPE = 'llm-pi-ai'`
 * (`packages/llm/llm-pi-ai/src/auth.ts:29,36-38`) — i.e. the exact string
 * `llm-pi-ai/<providerId>`. Methods are sorted oauth-first
 * (login.ts:40-47: `{ id: 'oauth', ... }` is pushed before the api-key
 * method). These pins are what let the manager address
 * `ctx.authorization.begin({ key: 'llm-pi-ai/<provider>', method: 'oauth' })`
 * without probing the seam at runtime.
 */
test('the service resolves the oauth flow for every pi-ai oauth provider', async () => {
  const h = await harness()
  try {
    for (const provider of OAUTH_PROVIDERS) {
      assert.deepEqual(h.service.oauthFlowFor(provider), { key: `llm-pi-ai/${provider}`, method: 'oauth' })
    }
    // A provider with no oauth method (not in the flow table, or oauth: false
    // upstream) yields nothing: the manager must not begin a flow it cannot name.
    assert.equal(h.service.oauthFlowFor('zai-coding-cn'), undefined)
    assert.equal(h.service.oauthFlowFor('amazon-bedrock'), undefined)
    assert.equal(h.service.oauthFlowFor('no-such-provider'), undefined)
  } finally {
    await h.close()
  }
})

// C6-2: account capability requires an actually-beginable pi-ai flow, not
// merely the catalog's nativeAuth.oauth flag. The full supported set must
// stay account-capable; a nativeAuth.oauth route without a flow must be
// reported key- and account-unsupported with the truthful reason.

test('every pi-ai OAuth provider this build registers stays account-capable (C6-2)', async () => {
  const h = await harness()
  try {
    // M2 (r6): the expected set is written out HERE, independently of both
    // the fixture's flow source (`piAiFlows`) and `OAUTH_PROVIDERS` above.
    // Deriving the expectation from the same array the fixture serves only
    // proves the fixture agrees with itself: a shipped flow source that drops,
    // adds or renames a provider would stay green. This literal list is the
    // drift detector.
    const expectedFlowProviders = [
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'openai-codex',
      'openrouter',
      'radius',
      'xai',
    ]
    // The flow set the seam advertises is exactly the pinned set — no extra
    // OAuth provider silently becomes account-capable.
    assert.deepEqual(
      h.authorization.list().map((flow: { key: string }) => flow.key).sort(),
      expectedFlowProviders.map(provider => `llm-pi-ai/${provider}`).sort(),
    )
    const state = h.service.buildState()
    for (const provider of expectedFlowProviders) {
      const view = state.providers.find(entry => entry.provider === provider)
      assert.ok(view !== undefined, `${provider} is missing from the directory`)
      assert.equal(view!.nativeAuth?.oauth, true)
      assert.equal(view!.accountSupported, true, `${provider} must remain account-capable`)
      assert.deepEqual(h.service.oauthFlowFor(provider), { key: `llm-pi-ai/${provider}`, method: 'oauth' })
    }
  } finally {
    await h.close()
  }
})

test('an OAuth-capable route with no registered flow is key- and account-unsupported (C6-2)', async () => {
  const h = await harness()
  try {
    const view = h.service.buildState().providers.find(entry => entry.provider === 'google-gemini-cli')!
    assert.equal(view.nativeAuth?.oauth, true)
    assert.equal(view.supported, false)
    assert.equal(view.accountSupported, false)
    assert.match(String(view.reason), /no OAuth sign-in flow/)
    assert.equal(h.service.oauthFlowFor('google-gemini-cli'), undefined)
    // Adoption is reachable through either capability; neither exists here,
    // so the route is refused up front with the flow gap as the reason.
    await assert.rejects(
      () => h.service.adoptProvider('google-gemini-cli'),
      /no OAuth sign-in flow/,
    )
    assert.equal(h.store.provider('google-gemini-cli'), undefined)
  } finally {
    await h.close()
  }
})

test('account capability is resolved lazily from the live flow list (C6-2 ordering)', async () => {
  const h = await harness()
  try {
    // Construction order can mount the authorization seam after this
    // plugin: while no flow is enumerable the route stays account-unsupported
    // instead of caching the catalog flag.
    const flows = h.authorization.flows
    h.authorization.flows = []
    try {
      const hidden = h.service.buildState().providers.find(entry => entry.provider === 'openai-codex')!
      assert.equal(hidden.accountSupported, false)
      assert.match(String(hidden.reason), /no OAuth sign-in flow/)
    } finally {
      h.authorization.flows = flows
    }
    // Once the flows are live, the next state build re-evaluates and the
    // same route is account-capable again.
    const visible = h.service.buildState().providers.find(entry => entry.provider === 'openai-codex')!
    assert.equal(visible.accountSupported, true)
  } finally {
    await h.close()
  }
})

/**
 * modifyRecord scope-acceptance pin (T1 review "Cannot verify (b)"),
 * asserted through the product write path rather than the fake's internals:
 * the manager writes both scopes it addresses — the llm-pi-ai activation
 * projection (activateAccount) and its own plugin-scope grant records
 * (harvestLogin) — through the seam's `modifyRecord`, and a subsequent
 * `readRecord` returns what was written. The real credential provider
 * imposes no ownership check on modifyRecord: it is an abstract
 * read-modify-write over any two-segment key (index.ts:236-256); scope
 * ownership ("the scope names the owning plugin", authorization
 * types.ts:126-127) is a convention between writers, which is exactly the
 * D1 arbitration contract this manager implements with shape checks. The
 * fake's mirrored key grammar also refuses digit-leading ids, which is why
 * accountRef guards digit-leading stems (commit 980b7a6); that refusal is
 * the fake's own behaviour and is no longer asserted here.
 */
test('the service writes record keys in both scopes and reads the projection back', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // Product write path 1: activation projects the account grant into the
    // llm-pi-ai scope through modifyRecord.
    await h.service.activateAccount('anthropic', rowId)
    const projected = await h.credentials.raw.readRecord('llm-pi-ai/anthropic')
    assert.equal(projected?.kind, 'grant')
    assert.equal((projected!.payload as Record<string, unknown>).refresh, 'rt-seed-value')
    assert.equal((projected!.payload as Record<string, unknown>).accountId, 'acc-9')
    // Product write path 2: a fresh login persists its grant in the
    // manager's own plugin scope, readable back afterwards.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    const newAccountId = h.service.getAccountAttempt(view.id)!.accountId!
    const newRow = h.store.provider('anthropic')!.keys.find(key => key.id === newAccountId)!
    const stored = await h.credentials.raw.readRecord(newRow.oauth!.grantRef)
    assert.notEqual(newRow.oauth!.grantRef, grantRef)
    assert.equal(stored?.kind, 'grant')
    assert.equal((stored!.payload as Record<string, unknown>).refresh, 'rt-secret-value')
  } finally {
    await h.close()
  }
})

/** Poll an async transition; the final check throws if it never happened. */
async function eventually(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      check()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  check()
}

const GRANT_KEY = 'llm-pi-ai/anthropic'

function grantPayload(overrides: Record<string, unknown> = {}): FakeCredentialRecord {
  return {
    kind: 'grant',
    payload: {
      type: 'oauth',
      refresh: 'rt-secret-value',
      access: 'at-secret-value',
      expires: 1_800_000_000_000,
      accountId: 'acc-9',
      email: 'dev@example.com',
      ...overrides,
    },
  }
}

async function harnessWithManagedAnthropic() {
  const h = await harness()
  await h.service.adoptProvider('anthropic')
  return h
}

test('beginAccountLogin drives the seam with the pinned flow key and bridges the interaction', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    assert.equal(view.status, 'pending')
    assert.ok(view.id.length > 0)
    const request = h.authorization.beganRequests[0]!
    // The pinned flow key + method (see the flow-key pin test and
    // llm-pi-ai/login.ts:149-171).
    assert.equal(request.key, 'llm-pi-ai/anthropic')
    assert.equal(request.method, 'oauth')
    const interaction = request.interaction as { notify: (n: unknown) => void; prompt: (p: unknown) => Promise<string> }
    assert.equal(typeof interaction.notify, 'function')
    assert.equal(typeof interaction.prompt, 'function')

    // notify lands in the attempt state, never as a secret.
    interaction.notify({ message: 'Open this page to continue signing in.', url: 'https://example.com/authorize' })
    interaction.notify({ message: 'Enter this code on the verification page.', url: 'https://example.com/verify', code: 'ABC-123' })
    let current = h.service.getAccountAttempt(view.id)!
    assert.deepEqual(current.notices, [
      { message: 'Open this page to continue signing in.', url: 'https://example.com/authorize' },
      { message: 'Enter this code on the verification page.', url: 'https://example.com/verify', code: 'ABC-123' },
    ])

    // prompt parks the attempt; answerAccountPrompt resolves the flow.
    const flowAnswer = interaction.prompt({ kind: 'text', message: 'Paste the verification code' })
    current = h.service.getAccountAttempt(view.id)!
    assert.equal(current.status, 'prompt')
    assert.deepEqual(current.prompt, { kind: 'text', message: 'Paste the verification code' })
    await h.service.answerAccountPrompt(view.id, '123-456')
    assert.equal(await flowAnswer, '123-456')
    current = h.service.getAccountAttempt(view.id)!
    assert.equal(current.status, 'pending')
    assert.equal(current.prompt, undefined)

    // The attempt is listed for T3 surfaces.
    assert.ok(h.service.listAccountAttempts().some(entry => entry.id === view.id))
  } finally {
    await h.close()
  }
})

// F3 (I-000082): reopening the sign-in dialog must resume the provider's
// in-flight attempt instead of minting a competing second flow; terminal
// attempts are never resumed.

test('a second begin for a pending attempt resumes the same flow (I-000082)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const first = await h.service.beginAccountLogin('anthropic')
    // Reopening the dialog: same provider, same in-flight attempt.
    const second = await h.service.beginAccountLogin('anthropic')
    assert.equal(second.id, first.id)
    // The resume started no competing seam flow and no second attempt.
    assert.equal(h.authorization.beganRequests.length, 1)
    assert.equal(h.service.listAccountAttempts().length, 1)
    // Both handles observe the one flow's terminal.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(first.id)!.status, 'ready'))
    assert.equal(h.service.getAccountAttempt(second.id)!.status, 'ready')
  } finally {
    await h.close()
  }
})

test('a terminal attempt is not resumed — a new begin starts a fresh flow (I-000082)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const first = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'cancelled')
    await eventually(() => assert.equal(h.service.getAccountAttempt(first.id)!.status, 'cancelled'))
    const second = await h.service.beginAccountLogin('anthropic')
    assert.notEqual(second.id, first.id)
    assert.equal(second.status, 'pending')
    assert.equal(h.service.listAccountAttempts().filter(entry => entry.status === 'pending').length, 1)
  } finally {
    await h.close()
  }
})

test('a settled login harvests the stored grant into an oauth account row', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))

    const providerRecord = h.store.provider('anthropic')!
    const row = providerRecord.keys.find(key => key.kind === 'oauth')!
    assert.equal(row.alias, 'Work account')
    assert.match(row.ref, /^keys-manager\/anthropic-[a-z0-9]+$/)
    assert.equal(row.oauth!.provider, 'anthropic')
    assert.equal(row.oauth!.email, 'dev@example.com')
    assert.equal(row.oauth!.accountId, 'acc-9')
    assert.equal(row.oauth!.expiresAt, 1_800_000_000_000)
    // The grant payload is persisted under the plugin-scope ref, and the
    // account metadata mirrors what the store actually holds.
    const stored = h.credentials.records.get(row.oauth!.grantRef)!
    assert.equal(stored.kind, 'grant')
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-secret-value')
    assert.equal((row.oauth!.expiresAt), (stored.payload as Record<string, unknown>).expires)
    // The activation projection record itself is untouched by harvest.
    assert.equal(h.credentials.records.get(GRANT_KEY)!.kind, 'grant')
    // The attempt carries the pool member id, serializable for T3.
    const settled = h.service.getAccountAttempt(view.id)!
    assert.equal(settled.accountId, row.id)
    assert.equal(settled.prompt, undefined)
  } finally {
    await h.close()
  }
})

test('harvest keeps the state document free of token payloads', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    h.store.touch()
    await h.store.flush()
    const text = await readFile(join(h.dir, 'state.json'), 'utf8')
    assert.ok(!text.includes('rt-secret-value'))
    assert.ok(!text.includes('at-secret-value'))
  } finally {
    await h.close()
  }
})

test('a repeated login refreshes the existing account row instead of duplicating it', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const first = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(first.id)!.status, 'ready'))

    h.credentials.records.set(GRANT_KEY, grantPayload({ expires: 1_900_000_000_000, email: 'renamed@example.com' }))
    const second = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(second.id)!.status, 'ready'))

    const rows = h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.oauth!.expiresAt, 1_900_000_000_000)
    assert.equal(rows[0]!.oauth!.email, 'renamed@example.com')
  } finally {
    await h.close()
  }
})

// Round-9 review (I-000110, must-fix): the harvest's row lookup still ran the
// pre-fix array-order matcher — one `find` ORing grantRef, exact accountId and
// the guarded email. With an earlier email-only row and a later row carrying
// the same email plus an accountId, signing in the later account adopted the
// earlier row: it was repointed at the new grant and its own (superseded)
// record was then deleted, losing another account's credential. The harvest
// must apply the same ordered ownership matcher as the rotation reconciler:
// ref → exact accountId → guarded email.
test('a login harvest adopts the exact-accountId row, not an earlier email-only row (I-000110)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const emailOnly = seedOAuthAccount(h, 'anthropic', { email: 'shared@example.com', refresh: 'rt-email-only' })
    const exact = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-later', email: 'shared@example.com', refresh: 'rt-later-row' })
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-later-login', accountId: 'acc-later', email: 'shared@example.com' }))
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))

    // The row the payload's accountId names owns the harvested grant.
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, exact.rowId)
    const rows = h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth')
    const adopted = rows.find(key => key.id === exact.rowId)!
    const untouched = rows.find(key => key.id === emailOnly.rowId)!
    assert.equal(adopted.oauth!.accountId, 'acc-later')
    assert.equal(adopted.oauth!.email, 'shared@example.com')
    assert.notEqual(adopted.oauth!.grantRef, exact.grantRef)
    // The earlier email-only row keeps its grant, its ref and its identity.
    assert.equal(untouched.oauth!.grantRef, emailOnly.grantRef)
    assert.equal(untouched.oauth!.accountId, undefined)
    assert.equal(untouched.oauth!.email, 'shared@example.com')
    // No other account's credential record was deleted as "superseded": the
    // email-only row's record survives, and only the adopted row's previous
    // generation was replaced.
    assert.equal(h.credentials.records.has(emailOnly.grantRef), true)
    assert.equal(h.credentials.records.has(exact.grantRef), false)
    assert.equal(h.credentials.records.has(adopted.oauth!.grantRef), true)
  } finally {
    await h.close()
  }
})

test('a failed or cancelled login marks the attempt with a reason', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())

    const failed = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'failed')
    await eventually(() => assert.equal(h.service.getAccountAttempt(failed.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(failed.id)!.error ?? '', /failed/)

    const cancelled = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'cancelled')
    await eventually(() => assert.equal(h.service.getAccountAttempt(cancelled.id)!.status, 'cancelled'))

    const thrown = await h.service.beginAccountLogin('anthropic')
    h.authorization.failBegin = new Error('seam refused the attempt')
    // The seam rejection surfaces as a failed attempt with the reason.
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    try {
      await h.authorization.pending!.reject(new Error('seam refused the attempt'))
    } catch {
      // fake rejection bookkeeping
    }
    await eventually(() => assert.equal(h.service.getAccountAttempt(thrown.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(thrown.id)!.error ?? '', /seam refused/)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
  } finally {
    await h.close()
  }
})

// SF1: the success terminal state is published only at the END of the
// harvest; begin resolving is non-terminal, so a slow or failing harvest
// can never surface "Signed in." without an account row.

test('a slow harvest keeps the login attempt pending until the grant is captured', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    h.credentials.raw.readRecordDelayMs = 60
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    // begin resolved long ago; the attempt stays pending while the harvest
    // is still reading the grant record.
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    h.credentials.raw.readRecordDelayMs = 0
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 1)
  } finally {
    await h.close()
  }
})

test('a failing harvest flips the settled login to failed instead of ready', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // A committed record that is not a pi-ai oauth credential: the harvest
    // must fail the attempt loudly instead of leaving "ready" with no row.
    h.credentials.records.set(GRANT_KEY, { kind: 'grant', payload: { type: 'unknown-shape' } })
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /pi-ai OAuth credential/)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
  } finally {
    await h.close()
  }
})

// Round-2 review step 3: the ready terminal publishes only after the
// state persistence step resolves. A rejected flush must fail the attempt
// — the terminal guard must not swallow it behind an already-published
// "Signed in.".

test('a rejected state flush fails the settled login instead of publishing ready', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    // Every flush rejects: the harvest mutation itself succeeds, but its
    // persistence step (inside `run`) does not.
    ;(h.store as unknown as { flush: () => Promise<void> }).flush = async () => {
      throw new Error('disk full')
    }
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /disk full/)
  } finally {
    await h.close()
  }
})

// Codex P2: `store.flush()` can reject AFTER the harvest callback resolved
// (the state disk filled up between the mutation and its write). The row
// upsert is already in memory and `attempt.accountId` is set, so the old
// compensation condition skipped the rollback and left a committed
// plugin-scope grant — and a live projection — with no durable owner.

test('a rejected state flush rolls the harvested account row back instead of orphaning its grant', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    const realFlush = h.store.flush.bind(h.store)
    let rejectFlush = true
    ;(h.store as unknown as { flush: () => Promise<void> }).flush = async () => {
      if (rejectFlush) throw new Error('disk full')
      await realFlush()
    }
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /disk full/)
    // The terminal failure advertises no row that was rolled back.
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, undefined)
    // The in-memory row upsert is undone...
    await eventually(() => assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0))
    // ...the plugin-scope copy the harvest wrote is gone (no orphan)...
    await eventually(() => assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0))
    // ...and the projection this login committed was demoted with it, so no
    // credential outlives the rolled-back row without a pool owner.
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    // A later successful flush must not resurrect the rolled-back row: the
    // state document (what a restart loads) stays clean.
    rejectFlush = false
    await h.store.flush()
    const reloaded = new KeysManagerStore(join(h.dir, 'state.json'))
    try {
      assert.equal(reloaded.provider('anthropic')?.keys.filter(key => key.kind === 'oauth').length ?? 0, 0)
    } finally {
      await reloaded.close()
    }
  } finally {
    await h.close()
  }
})

// Round-8 review hardening: the flush rollback can itself fail to write. A
// caller must be able to tell "flush failed, credential surface restored"
// apart from "flush failed AND the rollback could not restore it", so the
// terminal reason carries a stable code. The in-memory rollback runs before
// any await and must therefore hold while the store keeps failing.

test('a rollback whose compensation writes fail carries the structured failure code', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // A record this login never wrote: the failing rollback must never
    // delete it in place of its own leftovers.
    const foreignRef = accountRef('openai', '0123456789ab')
    h.credentials.records.set(foreignRef, grantPayload({ refresh: 'rt-foreign-value', access: 'at-foreign-value' }))
    let flushes = 0
    ;(h.store as unknown as { flush: () => Promise<void> }).flush = async () => {
      flushes += 1
      // The state document stays broken for the whole window: the harvest's
      // own credential writes resolved before this first flush, but every
      // compensation write after it must fail too.
      if (h.store.provider('anthropic')!.keys.some(key => key.kind === 'oauth')) {
        h.credentials.raw.failModifyRecord = true
        h.credentials.raw.failDeleteRecord = true
      }
      throw new Error('disk full')
    }
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    const failed = h.service.getAccountAttempt(view.id)!
    assert.ok(
      isFlushRollbackCompensationFailure(failed.error),
      `expected the ${FLUSH_ROLLBACK_COMPENSATION_FAILED} code, got: ${failed.error ?? '<no error>'}`,
    )
    // The code leads the reason; the original flush cause stays after it.
    assert.ok(failed.error!.startsWith(`${FLUSH_ROLLBACK_COMPENSATION_FAILED}: `))
    assert.match(failed.error ?? '', /disk full/)
    // The in-memory rollback does not depend on any flush resolving: the
    // terminal advertises no row and the pool has no harvested account.
    assert.equal(failed.accountId, undefined)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
    // The rollback's own follow-up flush (its touch schedules one) rejects
    // too — the failure is not one-shot — and must not resurrect the row.
    await eventually(() => assert.ok(flushes >= 2))
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
    // The compensation could not delete them, so its own writes survive —
    // exactly this login's committed payload — and the unrelated foreign
    // record is untouched (no silent deletion on a failed rollback).
    const writtenRef = accountRef('anthropic', createHash('sha256').update('rt-secret-value').digest('hex').slice(0, 12))
    assert.equal(h.credentials.records.get(writtenRef)?.kind, 'grant')
    assert.equal((h.credentials.records.get(writtenRef)!.payload as { refresh?: string }).refresh, 'rt-secret-value')
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as { refresh?: string }).refresh, 'rt-secret-value')
    assert.equal(h.credentials.records.has(foreignRef), true)
    assert.equal((h.credentials.records.get(foreignRef)!.payload as { refresh?: string }).refresh, 'rt-foreign-value')
  } finally {
    await h.close()
  }
})

test('a rejected state flush during re-authentication restores the superseded grant reference', async () => {
  const { h, rowId, grantRef: oldRef } = await harnessWithSeededAccount({
    accountId: 'acc-9',
    email: 'dev@example.com',
    refresh: 'rt-old-value',
    expires: 1_800_000_000_000,
  })
  try {
    const realFlush = h.store.flush.bind(h.store)
    let rejectFlush = true
    ;(h.store as unknown as { flush: () => Promise<void> }).flush = async () => {
      if (rejectFlush) throw new Error('disk full')
      await realFlush()
    }
    // The flow commits a rotated grant for the same account.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-new-value',
      access: 'at-new-value',
      expires: 1_900_000_000_000,
    }))
    const view = await h.service.beginAccountLogin('anthropic', undefined, rowId)
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /disk full/)
    const newRef = accountRef('anthropic', createHash('sha256').update('rt-new-value').digest('hex').slice(0, 12))
    assert.notEqual(newRef, oldRef)
    // The harvest deleted the superseded generation before its flush
    // rejected; the rollback restores it, so the reverted row cannot dangle.
    await eventually(() => assert.equal(h.credentials.records.has(oldRef), true))
    assert.equal((h.credentials.records.get(oldRef)!.payload as Record<string, unknown>).refresh, 'rt-old-value')
    // The new generation's copy is gone (no orphan)...
    await eventually(() => assert.equal(h.credentials.records.has(newRef), false))
    // ...and the row is back on the pre-harvest grant it can still resolve.
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.oauth!.grantRef, oldRef)
    assert.equal(row.oauth!.expiresAt, 1_800_000_000_000)
    assert.equal(row.valueMissing, false)
    // Durability boundary: a later successful flush persists the reverted
    // row, which still matches the restored record after a restart.
    rejectFlush = false
    await h.store.flush()
    const reloaded = new KeysManagerStore(join(h.dir, 'state.json'))
    try {
      assert.equal(reloaded.provider('anthropic')!.keys.find(key => key.id === rowId)!.oauth!.grantRef, oldRef)
    } finally {
      await reloaded.close()
    }
  } finally {
    await h.close()
  }
})

test('a resolved state flush keeps the harvested row and both grant records (no rollback)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    let flushes = 0
    const realFlush = h.store.flush.bind(h.store)
    h.store.flush = async () => {
      flushes += 1
      await realFlush()
    }
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The flush resolved before the ready terminal published.
    assert.ok(flushes >= 1)
    const row = h.store.provider('anthropic')!.keys.find(key => key.kind === 'oauth')!
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, row.id)
    assert.equal(h.credentials.records.get(GRANT_KEY)!.kind, 'grant')
    assert.equal(h.credentials.records.get(row.oauth!.grantRef)!.kind, 'grant')
    const text = await readFile(join(h.dir, 'state.json'), 'utf8')
    assert.ok(text.includes(row.id))
  } finally {
    await h.close()
  }
})

test('concurrent logins for one provider resume the in-flight attempt instead of competing (I-000082)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const first = await h.service.beginAccountLogin('anthropic')
    // The single-flight slot is not refused anymore: a repeat begin resumes
    // the pending attempt (same id, no second seam flow). I-000082.
    const resumed = await h.service.beginAccountLogin('anthropic')
    assert.equal(resumed.id, first.id)
    assert.equal(h.authorization.beganRequests.length, 1)
    // Once the attempt settles the slot frees and a fresh begin starts a
    // new flow.
    h.emitEvent('authorization/settled', GRANT_KEY, 'cancelled')
    await eventually(() => assert.equal(h.service.getAccountAttempt(first.id)!.status, 'cancelled'))
    const next = await h.service.beginAccountLogin('anthropic')
    assert.notEqual(next.id, first.id)
    assert.equal(h.authorization.beganRequests.length, 2)
  } finally {
    await h.close()
  }
})

// Round-4 finding 3 (I-000084): the resume short-circuit must not bypass the
// requested target. Reusing A's pending flow for a re-authentication of B
// would bind the new grant to A, so the target is validated first and a
// resume is accepted only for the SAME target.

test('a pending sign-in is not resumed for a different target (I-000084)', async () => {
  const { h, rowId: rowA } = await harnessWithSeededAccount({ accountId: 'acc-a', email: 'a@example.com' })
  try {
    const { rowId: rowB } = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'b@example.com', refresh: 'rt-b-value' })
    const pending = await h.service.beginAccountLogin('anthropic', undefined, rowA)
    // Asking for B while A's flow is pending is refused — never silently
    // resumed as A.
    await assert.rejects(
      () => h.service.beginAccountLogin('anthropic', undefined, rowB),
      /already pending for a different account/,
    )
    // The refusal minted no second flow and left A's attempt untouched.
    assert.equal(h.authorization.beganRequests.length, 1)
    assert.equal(h.service.getAccountAttempt(pending.id)!.status, 'pending')
    // An unknown target is validated (and refused) BEFORE the resume, not
    // hidden behind it.
    await assert.rejects(() => h.service.beginAccountLogin('anthropic', undefined, 'k_missing'), /not found/)
    // The matching target resumes the same attempt and the same seam flow.
    const resumed = await h.service.beginAccountLogin('anthropic', undefined, rowA)
    assert.equal(resumed.id, pending.id)
    assert.equal(h.authorization.beganRequests.length, 1)
  } finally {
    await h.close()
  }
})

test('a targetless begin resumes only a targetless pending sign-in (I-000084)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    const pending = await h.service.beginAccountLogin('anthropic')
    const resumed = await h.service.beginAccountLogin('anthropic')
    assert.equal(resumed.id, pending.id)
    // A target-carrying request cannot adopt a targetless flow: that flow
    // would bind the grant to whatever the harvest's fallback picks, not to
    // the requested row.
    await assert.rejects(
      () => h.service.beginAccountLogin('anthropic', undefined, rowId),
      /already pending without a target account/,
    )
    assert.equal(h.authorization.beganRequests.length, 1)
  } finally {
    await h.close()
  }
})

// Round-2 review step 4: a harvest is compensated and gated. Releasing a
// provider revokes its in-flight sign-in, and a login whose row cannot be
// created (key capacity) never strands the grant records it touched.

test('releasing a provider revokes its in-flight sign-in attempt', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    await h.service.releaseProvider('anthropic')
    const settled = h.service.getAccountAttempt(view.id)!
    assert.equal(settled.status, 'failed')
    assert.match(settled.error ?? '', /released during sign-in/)
    // Re-adopting frees the single-attempt slot again.
    await h.service.adoptProvider('anthropic')
    const next = await h.service.beginAccountLogin('anthropic')
    assert.equal(next.status, 'pending')
  } finally {
    await h.close()
  }
})

test('a release that wins the race still lets the revoked login clean its projection', async () => {
  // Round-3 finding 2: start login → release the provider → authorization
  // settles. The release queues first and removes the provider; the harvest
  // queued behind it passes its settled guard (the settlement arrived before
  // the release ran), then finds no managed provider and fails — and must
  // still revert the pi-ai projection this login committed.
  const h = await harnessWithManagedAnthropic()
  try {
    // pi-ai has already committed this login's grant to the projection key.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // Queue the release, then let the authorized settlement arrive while
    // that release mutation is still parked in the queue.
    const release = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await release
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /released during sign-in/)
    // The harvest running after the release must still clean the
    // projection this login's grant landed in.
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
  } finally {
    await h.close()
  }
})

// Codex P2 (PR #17): a release queued AHEAD of the harvest can finalize the
// attempt and then fail its own preflight (unreadable settings), leaving the
// provider managed. The authorized settlement arrived while that release body
// was still parked, so the harvest's pre-queue settled guard passed and its
// callback ran afterwards — and used to write the grant copy plus the account
// row while the attempt the user sees stayed failed. The callback must
// revalidate settlement immediately before its first credential write.

test('a queued harvest never writes credentials for an attempt a failed release already settled (P2)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // pi-ai has already committed this login's grant to the projection key.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // The release cancels the sign-in and THEN refuses its preflight, so the
    // provider survives and the queued harvest still runs against it.
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    // The authorized settlement arrives while the release body is still
    // parked: the harvest passes its pre-queue settled guard and lands behind
    // the release in the mutation queue.
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    assert.notEqual(h.store.provider('anthropic'), undefined)
    const failed = h.service.getAccountAttempt(view.id)!
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /released during sign-in/)
    // The next queued mutation resolves only after the harvest callback ran,
    // so the absence checks below are deterministic rather than a timing bet.
    await h.service.setSettings({})
    // No credential write and no row upsert: the settled attempt keeps the
    // terminal it already has, and the seam's projection stays untouched
    // because nothing of this harvest was ever written to compensate.
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    const settled = h.service.getAccountAttempt(view.id)!
    assert.equal(settled.status, 'failed')
    assert.equal(settled.accountId, undefined)
    // The normal settlement path is unchanged: a fresh sign-in for the
    // still-managed provider harvests its grant and row exactly as before.
    h.settings.failDescribe = false
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const next = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(next.id)!.status, 'ready'))
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 1)
  } finally {
    await h.close()
  }
})

test('a capacity-exceeded harvest fails loudly and leaves no orphan grant records', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // Fill the pool to the key limit with api-key rows.
    const record = h.store.provider('anthropic')!
    while (record.keys.length < KEY_LIMIT) {
      record.keys.push({
        id: `k_fill_${record.keys.length}`,
        alias: `filler ${record.keys.length}`,
        ref: `FILLER_${record.keys.length}`,
        kind: 'api-key',
        enabled: true,
        createdAt: Date.now(),
        lastUsedAt: 0,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastFailureCode: '',
        failureLevel: 0,
        consecutiveFailures: 0,
        totalUses: 0,
        totalFailures: 0,
        valueMissing: false,
        importedFrom: null,
        oauth: null,
      })
    }
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    assert.match(h.service.getAccountAttempt(view.id)!.error ?? '', /at most 32 keys/)
    // No orphan: the plugin-scope copy was never written, the projection
    // was reverted by the ownership-checked compensation, and no row was
    // created.
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
  } finally {
    await h.close()
  }
})

test('a wedged sign-in attempt times out and releases the provider slot', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const view = await h.service.beginAccountLogin('anthropic')
    // Age the attempt past the sign-in TTL, then run the pruner.
    const internal = (h.service as unknown as { loginAttempts: Map<string, { updatedAt: number }> }).loginAttempts.get(view.id)!
    internal.updatedAt = Date.now() - 11 * 60 * 1000
    h.service.pruneTransient()
    const settled = h.service.getAccountAttempt(view.id)!
    assert.equal(settled.status, 'failed')
    assert.match(settled.error ?? '', /timed out/)
    // The single-attempt slot is free again.
    await h.service.beginAccountLogin('anthropic')
  } finally {
    await h.close()
  }
})

test('login is refused without a managed provider or an oauth flow', async () => {
  const h = await harness()
  try {
    await assert.rejects(() => h.service.beginAccountLogin('anthropic'), /not managed/)
    await h.service.adoptProvider('zai-coding-cn')
    await assert.rejects(() => h.service.beginAccountLogin('zai-coding-cn'), /no OAuth sign-in flow/)
  } finally {
    await h.close()
  }
})

/** Seed one `kind: 'oauth'` pool row plus its plugin-scope grant record. */
function seedOAuthAccount(
  h: Harness,
  provider: string,
  options: { accountId?: string; email?: string; expires?: number; refresh?: string; access?: string; alias?: string } = {},
): { rowId: string; grantRef: string } {
  const record = h.store.provider(provider)!
  const refresh = options.refresh ?? 'rt-seed-value'
  const payload: Record<string, unknown> = {
    type: 'oauth',
    refresh,
    access: options.access ?? 'at-seed-value',
    expires: options.expires ?? 1_800_000_000_000,
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.email === undefined ? {} : { email: options.email }),
  }
  const grantRef = accountRef(provider, createHash('sha256').update(refresh).digest('hex').slice(0, 12))
  h.credentials.records.set(grantRef, { kind: 'grant', payload })
  const row: KeyRecord = {
    id: `k_${randomBytes(4).toString('hex')}`,
    alias: options.alias ?? options.email ?? 'Seeded account',
    ref: grantRef,
    kind: 'oauth',
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: 0,
    cooldownUntil: 0,
    lastFailureAt: 0,
    lastFailureCode: '',
    failureLevel: 0,
    consecutiveFailures: 0,
    totalUses: 0,
    totalFailures: 0,
    valueMissing: false,
    importedFrom: null,
    oauth: {
      provider,
      grantRef,
      ...(options.email === undefined ? {} : { email: options.email }),
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      ...(options.expires === undefined ? {} : { expiresAt: options.expires }),
    },
  }
  record.keys.push(row)
  h.store.touch()
  return { rowId: row.id, grantRef }
}

async function harnessWithSeededAccount(options: Parameters<typeof seedOAuthAccount>[2] = {}) {
  const h = await harnessWithManagedAnthropic()
  const seeded = seedOAuthAccount(h, 'anthropic', options)
  return { h, ...seeded }
}

test('activateAccount projects the grant payload into the llm-pi-ai record', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const record = h.credentials.records.get(GRANT_KEY)!
    assert.equal(record.kind, 'grant')
    assert.equal((record.payload as Record<string, unknown>).refresh, 'rt-seed-value')
    assert.equal((record.payload as Record<string, unknown>).accountId, 'acc-9')
    // The account row is selectable again once its grant is the projection.
    assert.equal(h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!.valueMissing, false)
  } finally {
    await h.close()
  }
})

// Round-8 review (I-000106, must-fix): the activation record read and its
// projection write used to sit outside the per-provider reconciliation chain,
// so a rotation echo landing between them could repoint `row.oauth.grantRef`
// and delete the record activation was about to project. The invariant pinned
// here: at the instant the projection write lands, the row must not already
// name another generation, and the record that generation names must survive.

test('activation projects the generation the row still names when a rotation echo lands mid-read (I-000106)', async () => {
  const { h, rowId, grantRef: generation1 } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  const raw = h.credentials.raw
  const realRead = raw.readRecord.bind(raw)
  const realModify = raw.modifyRecord.bind(raw)
  try {
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The persisted projection is the row's own generation.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-seed-value', access: 'at-seed-value' }))
    let releaseRead: (() => void) | undefined
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
    let readDeferred = false
    raw.readRecord = async (key: string) => {
      if (key === generation1 && !readDeferred) {
        readDeferred = true
        // Snapshot the generation activation is about to project, then park
        // the read so a rotation echo can land before the write.
        const snapshot = structuredClone(h.credentials.records.get(generation1))
        await readReleased
        return snapshot
      }
      return realRead(key)
    }
    // Capture the row's grantRef at the instant activation's projection write
    // returns — before any echo of that write can reconcile.
    let rowRefAtProjection: string | undefined
    let projectedRefresh: string | undefined
    let captureProjection = false
    raw.modifyRecord = async (key: string, mutate: any) => {
      const result = await realModify(key, mutate)
      if (captureProjection && key === GRANT_KEY) {
        captureProjection = false
        rowRefAtProjection = row.oauth!.grantRef
        projectedRefresh = ((result as FakeCredentialRecord | undefined)?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined
      }
      return result
    }
    const activating = h.service.activateAccount('anthropic', rowId)
    await eventually(() => assert.equal(readDeferred, true))
    captureProjection = true
    // An external rotation echo lands while the read is parked: pi-ai wrote a
    // newer generation (the pre-fix reconciler runs outside the mutation queue
    // and adopts it into the row immediately).
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-rotated', access: 'at-rotated', expires: 1_960_000_000_000, accountId: 'acc-9', email: 'dev@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    // Time for the unchained reconciler to repoint the row on the pre-fix
    // tree; on the fixed tree the echo is queued behind the activation body.
    await new Promise(resolve => setTimeout(resolve, 30))
    releaseRead!()
    await activating
    // Every queued reconciliation body has settled.
    await eventually(() => assert.equal(
      (h.service as unknown as { grantReconciliations: Map<string, Promise<void>> }).grantReconciliations.get('anthropic'),
      undefined,
    ))
    // The projection write named the generation the row still pointed at.
    assert.equal(rowRefAtProjection, generation1)
    assert.equal(projectedRefresh, 'rt-seed-value')
    const projectedRecord = h.credentials.records.get(rowRefAtProjection!)
    assert.ok(projectedRecord, 'the projected generation still has its record')
    assert.equal((projectedRecord.payload as Record<string, unknown>).refresh, projectedRefresh)
    // Settled: the projection, the row and the one surviving plugin-scope
    // record all agree on the same generation.
    const projection = h.credentials.records.get(GRANT_KEY)!
    const rowRecord = h.credentials.records.get(row.oauth!.grantRef)!
    assert.ok(rowRecord, 'the row names a live grant record')
    assert.deepEqual(projection.payload, rowRecord.payload)
    const pluginRecords = [...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/anthropic-'))
    assert.deepEqual(pluginRecords, [row.oauth!.grantRef])
  } finally {
    raw.readRecord = realRead
    raw.modifyRecord = realModify
    await h.close()
  }
})

// Round-2 review step 6: the projection owner is surfaced through the
// state view — the provider names the owning row, and exactly one account
// row is badged as the projected one.

test('buildState surfaces the projection owner on the provider and badges exactly one account row', async () => {
  const { h, rowId, grantRef: refA } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // A second account competes for the same provider.
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-8', email: 'other@example.com', refresh: 'rt-other-account' })
    let state = h.service.buildState()
    const provider = state.providers.find(entry => entry.provider === 'anthropic')!
    // Round-3 N3: the per-key flag is the only wire carrier of ownership —
    // exactly one row is badged.
    const projected = provider.keys.filter(key => key.projected === true)
    assert.equal(projected.length, 1)
    assert.equal(projected[0]!.id, rowId)
    // After removing the projected account, no row is projected.
    await h.service.removeAccount('anthropic', rowId)
    void refA
    state = h.service.buildState()
    const emptied = state.providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(emptied.keys.some(key => key.projected === true), false)
  } finally {
    await h.close()
  }
})

test('activateAccount refuses unknown rows and api-key rows', async () => {
  const { h, rowId } = await harnessWithSeededAccount()
  try {
    await assert.rejects(() => h.service.activateAccount('anthropic', 'k_missing'), /not found/)
    await assert.rejects(() => h.service.activateAccount('no-such-provider', rowId), /not managed/)
    // An api-key row cannot be activated as an account.
    const apiKeyRow = h.store.provider('anthropic')!.keys.find(key => key.kind === 'api-key')
    if (apiKeyRow !== undefined) {
      await assert.rejects(() => h.service.activateAccount('anthropic', apiKeyRow.id), /not an OAuth account/)
    }
  } finally {
    await h.close()
  }
})

test('fallbackToKeys deletes the projection so resolution reaches the key pool', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    assert.ok(h.credentials.records.has(GRANT_KEY))
    await h.service.fallbackToKeys('anthropic')
    // pi-ai's resolution falls through to the broker apiKeyEnv once the
    // stored credential is gone (resolve.js:26-55 order).
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    // The account keeps its own payload but is not cascade-selectable until
    // it is re-activated or a new login happens (manual recovery, by design:
    // see fallbackToKeys in src/index.ts).
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, true)
    assert.ok(h.credentials.records.has(grantRef))
    // Fallback without any projection is a no-op.
    await h.service.fallbackToKeys('anthropic')
  } finally {
    await h.close()
  }
})

// Round-7 review (R7-MF): a failure is attributed to the row that SERVED the
// request. The demotion is queued, so it must carry that row's identity
// instead of re-resolving "the active account" when it executes: activating
// another account while the failing request is still in flight must never
// delete the new account's healthy projection.

test('a failing account demotes its own projection, never the newly activated one (R7-MF)', async () => {
  const { h, rowId: rowA } = await harnessWithSeededAccount({ accountId: 'acc-a', email: 'a@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowA)
    // Account B takes over the projection while A's request is in flight.
    const b = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'b@example.com', refresh: 'rt-b' })
    await h.service.activateAccount('anthropic', b.rowId)
    const projectedPayload = JSON.stringify(h.credentials.records.get(GRANT_KEY)!.payload)
    const internals = h.service as unknown as {
      markFailure: (provider: string, keyId: string, failure: unknown) => void
      run: (operation: () => Promise<void>) => Promise<void>
    }
    // The in-flight request finally fails with the pinned pi-ai oauth code.
    internals.markFailure('anthropic', rowA, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    // Drain the mutation queue: the queued demotion has actually run by now.
    await internals.run(async () => {})
    // A cools down; B's projection and owner claim survive untouched.
    const rowOfA = h.store.provider('anthropic')!.keys.find(key => key.id === rowA)!
    assert.ok(rowOfA.cooldownUntil > Date.now(), 'the failing account is cooled')
    assert.equal(h.credentials.records.has(GRANT_KEY), true, 'the healthy projection is not deleted')
    assert.equal(JSON.stringify(h.credentials.records.get(GRANT_KEY)!.payload), projectedPayload)
    // The route still serves through B: healthy, unmarked, and badged.
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    const rowOfB = provider.keys.find(key => key.id === b.rowId)!
    assert.equal(rowOfB.valueMissing, false)
    assert.equal(rowOfB.status, 'active')
    assert.equal(rowOfB.projected, true)
    assert.equal(provider.keys.filter(key => key.projected === true).length, 1)
    assert.ok(provider.healthyKeyCount >= 1)
  } finally {
    await h.close()
  }
})

/**
 * Round-3 finding 1: land a native sign-in's grant inside the ownership
 * window. `afterReads` counts how many `readRecord` calls for `key` must
 * pass before the native write lands — 1 puts it right after the legacy
 * ownership read (the read-then-delete window the fix closes); 2 puts it
 * after the harvest compensation's re-read. The fixed decide-and-delete
 * never calls `readRecord` for the projection, so on fixed code the write
 * can only land through the `modifyRecord` hook — i.e. before the locked
 * compare, where the ownership oracle sees the native payload and skips.
 */
function interleaveNativeSignIn(
  h: Harness,
  key: string,
  refresh: string,
  afterReads = 1,
): { landed: () => boolean } {
  let landed = false
  let reads = 0
  const land = (): void => {
    if (landed) return
    landed = true
    h.credentials.records.set(key, {
      kind: 'grant',
      payload: { type: 'oauth', refresh, access: 'at-native-value', expires: 1_800_000_000_000 },
    })
  }
  const raw = h.credentials.raw
  const realRead = raw.readRecord.bind(raw)
  raw.readRecord = async (k: string) => {
    const record = await realRead(k)
    if (k === key) {
      reads += 1
      if (reads >= afterReads) land()
    }
    return record
  }
  const realModify = raw.modifyRecord.bind(raw)
  raw.modifyRecord = async (k: string, mutate: (current: any) => Promise<any>) => {
    if (k === key) land()
    return realModify(k, mutate)
  }
  return { landed: () => landed }
}

test('a re-authentication with an explicit target row re-binds a metadata-poor rotation in place', async () => {
  // Round-3 finding 6: a rotated token carrying no identity metadata
  // matches nothing; the validated target row receives the grant instead of
  // the harvest minting a duplicate account.
  const { h, rowId, grantRef: originalRef } = await harnessWithSeededAccount({ refresh: 'rt-original-token' })
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-rotated-token', access: 'at-rotated', accountId: undefined, email: undefined }))
    const view = await h.service.beginAccountLogin('anthropic', undefined, rowId)
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The SAME row was updated — no duplicate.
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, rowId)
    const rows = h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, rowId)
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-rotated-token').digest('hex').slice(0, 12))
    assert.equal(rows[0]!.oauth!.grantRef, rotatedRef)
    assert.ok(h.credentials.records.has(rotatedRef))
    // The superseded generation's plugin-scope record is gone.
    assert.equal(h.credentials.records.has(originalRef), false)
    // The target row is unknown / not an account: refused up front.
    await assert.rejects(() => h.service.beginAccountLogin('anthropic', undefined, 'k_missing'), /not found/)
  } finally {
    await h.close()
  }
})

test('re-authenticating a demoted account clears the missing flag', async () => {
  // Round-3 finding 5: a demotion marks the row value-missing; a successful
  // re-authentication must recover it — no missing pill, included in the
  // healthy counts.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await h.service.fallbackToKeys('anthropic')
    assert.equal(h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!.valueMissing, true)
    // Re-authentication commits the same account's grant again.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The same row was re-bound, not duplicated.
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, rowId)
    const state = h.service.buildState()
    const provider = state.providers.find(entry => entry.provider === 'anthropic')!
    const row = provider.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, false)
    assert.equal(row.status, 'active')
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
    assert.ok(provider.healthyKeyCount >= 1)
  } finally {
    await h.close()
  }
})

// Round-7 review (R7-SF3): "retiring" (removal in progress) and "demoted"
// (no longer serving, still managed) are different states. The ownership
// check before the claim rejected `valueMissing` rows outright, so a demoted
// row whose projection reappeared — a native sign-in, a pi-ai write — was
// never re-adopted, and the successful path never cleared the flag either.

test('a demoted row is re-adopted when its projection reappears (R7-SF3)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await h.service.fallbackToKeys('anthropic')
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, true)
    assert.equal(h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.some(key => key.projected === true), false)
    // Let the demotion's own echo settle before the projection returns.
    await new Promise(resolve => setTimeout(resolve, 20))
    // A native sign-in / pi-ai write re-projects this exact account's grant.
    h.credentials.records.set(GRANT_KEY, structuredClone(h.credentials.records.get(grantRef)!))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    // The proven owner is re-adopted: claim restored, missing flag cleared.
    await eventually(() => assert.equal(row.valueMissing, false))
    const state = h.service.buildState()
    const provider = state.providers.find(entry => entry.provider === 'anthropic')!
    const revived = provider.keys.find(key => key.id === rowId)!
    assert.equal(revived.projected, true)
    assert.equal(revived.status, 'active')
    assert.ok(provider.healthyKeyCount >= 1)
    assert.equal(provider.keys.filter(key => key.projected === true).length, 1)
    // The cleared flag is persisted, not only held in memory.
    await h.store.flush()
    const saved = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8')) as {
      providers: Record<string, { keys: Array<{ id: string; valueMissing: boolean }> }>
    }
    assert.equal(saved.providers['anthropic']!.keys.find(key => key.id === rowId)!.valueMissing, false)
  } finally {
    await h.close()
  }
})

// Round-14 review (R14-SF3): the R7-SF3 re-adoption cleared `valueMissing`
// but not the cooldown the demoting `markFailure` had just written, so the
// resurrected row rendered "cooling" and stayed out of the healthy counts
// until the old window expired — the third instance of the C3/M1 symptom
// (re-authentication and activateAccount both end the window).

test('a demoted-and-cooling row is not cooling after re-adoption (R14-SF3)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // The real demotion path: the failure cools the row AND starts the
    // projection delete.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now())
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    assert.equal(row.valueMissing, true)
    assert.equal(h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.find(key => key.id === rowId)!.status, 'missing')

    // A native sign-in / pi-ai write re-projects this exact account's grant.
    h.credentials.records.set(GRANT_KEY, structuredClone(h.credentials.records.get(grantRef)!))
    h.credentials.emitRecordUpdated(GRANT_KEY)

    // Re-adoption ends the window the demotion earned: the live projection
    // proves the row is serving again.
    await eventually(() => assert.equal(row.valueMissing, false))
    assert.equal(row.cooldownUntil, 0)
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    const revived = provider.keys.find(key => key.id === rowId)!
    assert.equal(revived.projected, true)
    assert.equal(revived.status, 'active')
    assert.ok(provider.healthyKeyCount >= 1)
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
  } finally {
    await h.close()
  }
})

test('re-authenticating a cooling account clears the stale cooldown (C3)', async () => {
  // Round-5 finding C3: the re-auth recovery cleared valueMissing but left the
  // old cooldown timer, so the freshly projected grant still reported cooling
  // and stayed out of the healthy counts until that timer expired.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // The demotion path cools the account AND removes the projection.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now())
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    assert.equal(h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.find(key => key.id === rowId)!.status, 'missing')

    // Re-authentication commits the same account's grant again.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    assert.equal(h.service.getAccountAttempt(view.id)!.accountId, rowId)

    // The current window is over: no cooling state, included in the healthy
    // counts.
    assert.equal(row.cooldownUntil, 0)
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(provider.keys.find(key => key.id === rowId)!.status, 'active')
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
    assert.ok(provider.keys.some(key => key.id === rowId && key.status === 'active'))
    // Round-5 finding M2: the previous assertions here echoed the preserved
    // `failureLevel`/`consecutiveFailures` shape and claimed a later failure
    // would still escalate per the grace window. That claim was false:
    // `applyFailureCooldown` derives the level only from the previous
    // `cooldownUntil`, so zeroing the window also resets escalation. Assert
    // the real behaviour — the next failure starts at level 0 / the base
    // cooldown instead of "previous level + 1".
    const next = applyFailureCooldown(row, h.store.settings, Date.now(), undefined)
    assert.equal(next.level, 0)
    assert.equal(next.cooldownMs, DEFAULT_SETTINGS.baseCooldownMs)
  } finally {
    await h.close()
  }
})

// Round-5 review (R5-SF3): the C3/M1 clear ends the OLD grant's window, but it
// ran unconditionally after the harvest's awaited credential writes. A
// failure of the freshly committed grant landing inside that window found its
// cooldown zeroed, so the route kept retrying a grant that had just failed and
// the healthy counts were wrong. Only a cooldown that predates the harvest's
// own write is cleared.

test('a failure landing inside the harvest write keeps the cooldown it earned (R5-SF3)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // Re-login of the seeded account commits grantPayload()'s refresh token,
    // so the harvest writes the plugin-scope record for that generation.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const committedRef = accountRef('anthropic', createHash('sha256').update('rt-secret-value').digest('hex').slice(0, 12))
    const held = holdRotationWrite(h, committedRef)
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await held.started
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The freshly committed grant already failed while the harvest write is
    // parked: that cooldown belongs to the new generation.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'server_error', message: 'upstream 500' })
    const earned = row.cooldownUntil
    assert.ok(earned > Date.now(), 'the fresh failure cools the row')
    held.release()
    await held.finished
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The harvest must not wipe the window its own grant already earned.
    assert.equal(row.cooldownUntil, earned)
    assert.ok(row.lastFailureAt > 0)
    assert.equal(row.oauth!.grantRef, committedRef)
    assert.equal(h.credentials.records.has(committedRef), true)
  } finally {
    await h.close()
  }
})

// Round-6 review (R6-SF1): the R5-SF3 boundary was the plugin-copy write's
// start time, which sits too late. The harvest also waits behind the mutation
// queue and the settlement-time projection read, and the freshly committed
// grant is already projected and serving during those waits. A failure it
// produces there belongs to the NEW projection generation and must keep its
// window instead of being cleared as the previous grant's.

test('a failure landing while the harvest still waits for the projection keeps its cooldown (R6-SF1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // Park the settlement-time projection read: the harvest cannot start its
    // plugin-copy write until this read resolves, while pi-ai has already
    // committed the grant the seam reported at the settlement broadcast.
    h.credentials.raw.readRecordDelayMs = 80
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 10))
    // Still in the projection wait: the attempt has not reached ready.
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The freshly committed grant already failed while the harvest waits.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'server_error', message: 'upstream 500' })
    const earned = row.cooldownUntil
    assert.ok(earned > Date.now(), 'the fresh failure cools the row')
    h.credentials.raw.readRecordDelayMs = 0
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The window belongs to the projection the harvest just adopted, so the
    // harvest must not wipe it.
    assert.equal(row.cooldownUntil, earned)
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(provider.keys.find(key => key.id === rowId)!.status, 'cooling')
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
  } finally {
    h.credentials.raw.readRecordDelayMs = 0
    await h.close()
  }
})

// Round-6 review (R6-SF1), second half: the old strict "<" comparison kept a
// stale cooldown cooling when the old failure's stamp equalled the harvest
// write's millisecond. Attribution by projection generation does not depend on
// timestamps at all, so recovery must not stall on an equal instant.

test('a stale cooldown stamped in the same millisecond still recovers (R6-SF1)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
    try {
      // Freeze the clock so the old failure and the harvest's write land in
      // exactly the same millisecond.
      const frozen = Date.now()
      const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
      ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
        .markFailure('anthropic', rowId, { code: 'server_error', message: 'upstream 500' })
      assert.equal(row.lastFailureAt, frozen)
      assert.ok(row.cooldownUntil > frozen)

      // Re-authentication re-projects the same account's grant.
      h.credentials.records.set(GRANT_KEY, grantPayload())
      const view = await h.service.beginAccountLogin('anthropic')
      h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
      h.authorization.pending!.resolve({ status: 'authorized' })
      await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
      // The window was the old grant's: recovery must not stall on the equal
      // millisecond.
      assert.equal(row.cooldownUntil, 0)
      const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
      assert.equal(provider.keys.find(key => key.id === rowId)!.status, 'active')
      assert.ok(provider.healthyKeyCount >= 1)
    } finally {
      await h.close()
    }
  } finally {
    vi.useRealTimers()
  }
})

// Round-7 review (R7-SF1): `markFailure` returned inside the 10s dedupe
// window BEFORE stamping `cooldownGenerations`, so a failure of the freshly
// projected grant that arrived while the harvest was still parked kept the
// PREVIOUS generation's stamp — and the harvest then cleared a window the new
// projection had earned. The dedupe may skip extending the cooldown, but the
// attribution stamp must follow the projection.

test('a deduped failure still stamps the new projection generation (R7-SF1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const internals = h.service as unknown as {
      markFailure: (provider: string, keyId: string, failure: unknown) => void
    }
    // The previous projection already earned a cooling window.
    internals.markFailure('anthropic', rowId, { code: 'server_error', message: 'upstream 500' })
    const oldWindow = row.cooldownUntil
    assert.ok(oldWindow > Date.now(), 'the old window is cooling the row')
    // Re-authentication re-projects the account; park the harvest before its
    // plugin-copy write so the new generation is already serving.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    h.credentials.raw.readRecordDelayMs = 80
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // The new grant fails inside the dedupe window: it does not extend the
    // cooldown (that is what the dedupe is for), but the window is now the
    // NEW projection's.
    internals.markFailure('anthropic', rowId, { code: 'server_error', message: 'upstream 500' })
    h.credentials.raw.readRecordDelayMs = 0
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    // The harvest must not wipe a window its freshly projected grant earned.
    assert.ok(row.cooldownUntil > Date.now(), 'the window survives the harvest')
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(provider.keys.find(key => key.id === rowId)!.status, 'cooling')
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
  } finally {
    h.credentials.raw.readRecordDelayMs = 0
    await h.close()
  }
})

// Round-14 review (R14-M1): the 10s dedupe returned BEFORE the OAuth
// demotion branch, so a duplicate oauth failure neither extended the window
// nor re-ran the demotion. When the first demotion's delete threw, the
// projection stayed live while C1's await was attached to that already
// settled attempt; the duplicate must retry the idempotent demotion.

test('a deduped oauth failure still demotes the projection (R14-M1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const internals = h.service as unknown as {
      markFailure: (p: string, k: string, f: unknown) => void
      settleProjectionDemotion: (p: string) => Promise<void>
    }
    const failure = { code: 'oauth', message: 'OAuth refresh failed for anthropic' }
    // First failure: the cooldown lands and the demotion runs, but its
    // projection delete throws, so the grant keeps serving.
    h.credentials.raw.failDeleteRecord = true
    internals.markFailure('anthropic', rowId, failure)
    assert.ok(row.cooldownUntil > Date.now())
    const window = row.cooldownUntil
    await internals.settleProjectionDemotion('anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal(row.valueMissing, false)

    // A duplicate failure inside the dedupe window would previously return
    // before the demotion branch.
    h.credentials.raw.failDeleteRecord = false
    internals.markFailure('anthropic', rowId, failure)
    // The dedupe still suppresses the cooldown extension...
    assert.equal(row.cooldownUntil, window)
    // ...but the demotion is not part of that extension: it re-runs and
    // removes the projection the failed attempt left behind.
    await internals.settleProjectionDemotion('anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(row.valueMissing, true)
    assert.equal(row.cooldownUntil, window)
  } finally {
    h.credentials.raw.failDeleteRecord = false
    await h.close()
  }
})

test('activating a cooling account clears its stale cooldown (M1)', async () => {
  // Round-5 finding M1: re-authentication clears the stale cooldown, but the
  // manual "Set active" recovery did not, so the re-projected grant kept
  // rendering as cooling and stayed out of the healthy counts until the timer
  // expired. Both manual recovery paths must end the window.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // The demotion path cools the account AND removes the projection.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now())
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    assert.equal(h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.find(key => key.id === rowId)!.status, 'missing')

    // Manual recovery: "Set active" re-projects the grant and ends the window.
    await h.service.activateAccount('anthropic', rowId)
    assert.equal(row.cooldownUntil, 0)
    assert.equal(row.valueMissing, false)
    const provider = h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(provider.keys.find(key => key.id === rowId)!.status, 'active')
    assert.equal(provider.healthyKeyCount, provider.keys.filter(key => key.status === 'active').length)
    assert.ok(provider.keys.some(key => key.id === rowId && key.status === 'active'))
  } finally {
    await h.close()
  }
})

test('a successful demotion stops naming the row it stopped serving', async () => {
  // Round-3 finding 4: after the manager's own demotion, no row may still
  // be named the live projection — oauthOwnerFor must resolve to null so
  // the badge and the "Set active" gate fall back to the not-serving state.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    let state = h.service.buildState()
    const serving = state.providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(serving.keys.filter(key => key.projected === true).length, 1)
    await h.service.fallbackToKeys('anthropic')
    state = h.service.buildState()
    const demoted = state.providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(demoted.keys.some(key => key.projected === true), false)
    // The demoted row renders as missing, not as serving.
    const row = demoted.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, true)
    assert.equal(row.status, 'missing')
  } finally {
    await h.close()
  }
})

test('a native sign-in landing between the ownership check and the delete keeps its record', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-seed-value')
    const native = interleaveNativeSignIn(h, GRANT_KEY, 'rt-native-value')
    await h.service.fallbackToKeys('anthropic')
    // The native sign-in won the race: the decide ran inside the seam lock
    // against the native payload, no row owns it, and the delete was
    // skipped — the native record must survive.
    assert.ok(native.landed())
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-native-value')
  } finally {
    await h.close()
  }
})

test('a native replacement landing inside the harvest compensation window keeps its record', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // Fill the pool so the harvest fails after the settlement-time capture.
    const record = h.store.provider('anthropic')!
    while (record.keys.length < KEY_LIMIT) {
      record.keys.push({
        id: `k_fill_${record.keys.length}`,
        alias: `filler ${record.keys.length}`,
        ref: `FILLER_${record.keys.length}`,
        kind: 'api-key',
        enabled: true,
        createdAt: Date.now(),
        lastUsedAt: 0,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastFailureCode: '',
        failureLevel: 0,
        consecutiveFailures: 0,
        totalUses: 0,
        totalFailures: 0,
        valueMissing: false,
        importedFrom: null,
        oauth: null,
      })
    }
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const native = interleaveNativeSignIn(h, GRANT_KEY, 'rt-native-value', 2)
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    // ROUND-4 F2 (I-000083): provenance is the payload captured at the
    // settlement broadcast, not the harvest's live read. The native grant
    // landed after that capture, so the compensation's compare sees a
    // different payload and skips the delete even though the projection is
    // the record the native writer owns.
    assert.ok(native.landed())
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-native-value')
  } finally {
    await h.close()
  }
})

test('a foreign grant written before the queued harvest runs is never compensation-deleted (F2)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const warnings: string[] = []
    ;(h.ctx.logger as { warn: (message: string) => void }).warn = message => warnings.push(message)
    // The attempt's own grant is the projection when the seam settles.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic')
    // Park the release inside its queued mutation (its durability flush),
    // then settle: the harvest is queued behind the release, so its mutation
    // runs AFTER any foreign write that lands meanwhile. A bare timer used
    // to leave this to event-loop luck — the harvest could win the race and
    // compensation would then delete its own projection, making the test
    // flaky. The parked flush makes the interleaving deterministic.
    let releaseFlush!: () => void
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    let parkedResolve!: () => void
    const parked = new Promise<void>(resolve => { parkedResolve = resolve })
    let firstFlush = true
    const realFlush = h.store.flush.bind(h.store)
    h.store.flush = async () => {
      if (firstFlush) {
        firstFlush = false
        parkedResolve()
        await flushGate
      }
      return realFlush()
    }
    const release = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    // The settlement-time provenance capture (not queued) has resolved by
    // now; a foreign native sign-in replaces the projection while the
    // release still holds the queue.
    await parked
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-foreign-grant', access: 'at-foreign', expires: 1_800_000_000_000 },
    })
    releaseFlush()
    await release
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    // Compensation compares the live foreign payload with THIS attempt's
    // committed payload: mismatch → no delete, the foreign grant survives.
    await eventually(() => assert.ok(warnings.some(message => /harvest compensation kept the projection/.test(message))))
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-foreign-grant')
  } finally {
    await h.close()
  }
})

test('compensation refuses to touch the projection when provenance is unknown (F2)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const warnings: string[] = []
    ;(h.ctx.logger as { warn: (message: string) => void }).warn = message => warnings.push(message)
    // The seam settled "authorized" but the projection holds no OAuth grant:
    // there is no payload this attempt can prove it committed.
    h.credentials.records.set(GRANT_KEY, { kind: 'grant', payload: { type: 'unknown-shape' } })
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    // Unknown provenance: no compensation delete, and the refusal is loud.
    await eventually(() => assert.ok(warnings.some(message => /harvest compensation refused/.test(message))))
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.ok(warnings.some(message => /harvest compensation refused/.test(message)))
  } finally {
    await h.close()
  }
})

/**
 * F2 (step-1 removal window): land a native grant AFTER the decide's locked
 * compare resolves and BEFORE the delete — the exact gap the fix narrows.
 * On pre-fix code the delete runs unconditionally after the decide and
 * destroys the native grant; on fixed code the pre-delete re-read sees the
 * native payload and the delete is skipped.
 */
function landNativeAfterFirstModify(
  h: Harness,
  key: string,
  refresh: string,
): { landed: () => boolean } {
  let landed = false
  let modifies = 0
  const land = (): void => {
    if (landed) return
    landed = true
    h.credentials.records.set(key, {
      kind: 'grant',
      payload: { type: 'oauth', refresh, access: 'at-native-value', expires: 1_800_000_000_000 },
    })
  }
  const raw = h.credentials.raw
  const realModify = raw.modifyRecord.bind(raw)
  raw.modifyRecord = async (k: string, mutate: (current: any) => Promise<any>) => {
    const result = await realModify(k, mutate)
    if (k === key) {
      modifies += 1
      if (modifies === 1) land()
    }
    return result
  }
  return { landed: () => landed }
}

test('a native grant landing between decide and delete survives the demotion (step-1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const native = landNativeAfterFirstModify(h, GRANT_KEY, 'rt-native-value')
    await h.service.fallbackToKeys('anthropic')
    // The decide matched this row's own payload, then the native sign-in's
    // grant landed before the delete: the pre-delete re-read must skip the
    // delete so the native record survives.
    assert.ok(native.landed())
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-native-value')
  } finally {
    await h.close()
  }
})

test('without interleaving the demotion still deletes the projection (step-1 control)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await h.service.fallbackToKeys('anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    await h.close()
  }
})

test('a native grant landing between the compensation decide and delete survives (step-1)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // Fill the pool so the harvest fails after reading the projection.
    const record = h.store.provider('anthropic')!
    while (record.keys.length < KEY_LIMIT) {
      record.keys.push({
        id: `k_fill_${record.keys.length}`,
        alias: `filler ${record.keys.length}`,
        ref: `FILLER_${record.keys.length}`,
        kind: 'api-key',
        enabled: true,
        createdAt: Date.now(),
        lastUsedAt: 0,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastFailureCode: '',
        failureLevel: 0,
        consecutiveFailures: 0,
        totalUses: 0,
        totalFailures: 0,
        valueMissing: false,
        importedFrom: null,
        oauth: null,
      })
    }
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const native = landNativeAfterFirstModify(h, GRANT_KEY, 'rt-native-value')
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    // The compensation's decide matched this login's refresh, then the
    // native grant landed before the delete: the re-read skipped it and the
    // native record survived.
    assert.ok(native.landed())
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-native-value')
  } finally {
    await h.close()
  }
})

/**
 * F1 (I-000090 residual): land a native grant in the one gap the seam's
 * primitives cannot close — after the final `projectionStillMatches` re-read
 * released the per-key lock and as the `deleteRecord` queue entry is taken.
 * The decision is already made, so the unconditional delete removes the
 * native grant. This test pins the exact documented outcome; when the seam
 * gains a compare-and-delete / versioned delete primitive (I-000090), the
 * assertion must flip to "the native grant survives".
 */
function landNativeOnDelete(h: Harness, key: string, refresh: string): { landed: () => boolean } {
  let landed = false
  const raw = h.credentials.raw
  const realDelete = raw.deleteRecord.bind(raw)
  raw.deleteRecord = async (k: string) => {
    if (k === key && !landed) {
      landed = true
      h.credentials.records.set(key, {
        kind: 'grant',
        payload: { type: 'oauth', refresh, access: 'at-native-value', expires: 1_800_000_000_000 },
      })
    }
    return realDelete(k)
  }
  return { landed: () => landed }
}

test('a native grant landing after the final comparison is still lost (I-000090 residual)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const native = landNativeOnDelete(h, GRANT_KEY, 'rt-native-value')
    await h.service.fallbackToKeys('anthropic')
    // The injection landed between the final re-read and the delete's own
    // queue entry: the compare had already passed and the seam offers no
    // conditional delete, so the native record is removed. Documented in
    // docs/known-limits.md and tracked as I-000090.
    assert.ok(native.landed())
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    await h.close()
  }
})

test('an oauth failure cools the account down and demotes the cascade to keys', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The pi-ai ModelsError("oauth", …) shape pinned in tests/core.test.ts.
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    assert.ok(row.cooldownUntil > Date.now())
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    // A plain key failure on an oauth row does not demote (only the pinned
    // code does), and api-key rows never demote.
    await h.service.activateAccount('anthropic', rowId)
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'RATE_LIMIT' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
  } finally {
    await h.close()
  }
})

// MF2: a real request served by the projected grant must attribute its
// oauth-coded failure to the owning account row, so the demotion branch is
// reachable from the stream path instead of being dead code.

test('an oauth-coded stream failure under an active projection cools the account and fails over to keys', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // Public stream path: the request scope captures the projection owner,
    // then the stream finishes with the pi-ai oauth failure code.
    await consume(streamFailure(h, 'anthropic', 'session-oauth', { code: 'oauth', message: 'OAuth refresh failed for anthropic' }))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now(), 'the owning account row must be cooled')
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    // The next selection lands on the broker key pool, not the demoted account.
    const selection = await h.service.selectKey('anthropic', 'session-oauth-next')
    assert.equal(selection.key!.kind, 'api-key')
  } finally {
    await h.close()
  }
})

test('a non-oauth stream failure on the same path does not demote the projection', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await consume(streamFailure(h, 'anthropic', 'session-plain', { code: 'RATE_LIMIT', message: 'rate limited' }))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.cooldownUntil, 0)
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
  } finally {
    await h.close()
  }
})

// Codex P2: symmetric to the failure attribution — a request served by the
// projected grant records its success on the owning account row
// (lastUsedAt/totalUses move, the failure streak resets).

test('a projection-served success records success on the owning account row (Codex P2)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // A stale failure streak proves the success resets it.
    row.consecutiveFailures = 2
    const stream = h.service.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-proj-success', messages: [] },
      async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(stream)
    assert.equal(row.totalUses, 1)
    assert.ok(row.lastUsedAt > 0)
    assert.equal(row.consecutiveFailures, 0)
  } finally {
    await h.close()
  }
})

test('a projection-served request leaves the key pool untouched (C4)', async () => {
  // Round-5 finding C4: pi-ai serves the stored grant while a projection
  // exists, so selecting a key here would only mutate unused key state (the
  // cursor, lastUsedAt, and a sticky binding) on every OAuth-backed request.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const provider = h.store.provider('anthropic')!
    const pool = provider.keys.filter(key => key.kind === 'api-key')
    assert.ok(pool.length > 0, 'the pool must hold a key for the skip to be observable')
    const cursor = provider.cursor
    const lastUsed = pool.map(key => key.lastUsedAt)
    const stream = h.service.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-proj-c4', messages: [] },
      async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(stream)
    // No cursor advance, no lastUsedAt mutation, no sticky binding on any key.
    assert.equal(provider.cursor, cursor)
    assert.deepEqual(pool.map(key => key.lastUsedAt), lastUsed)
    assert.equal(h.store.binding('session-proj-c4', 'anthropic'), undefined)
    // The projection owner still records its own use.
    const owner = provider.keys.find(key => key.id === rowId)!
    assert.ok(owner.lastUsedAt > 0)
    assert.equal(owner.totalUses, 1)
  } finally {
    await h.close()
  }
})

test('a broker-key request still advances the key pool (C4)', async () => {
  // The C4 skip is scoped to projection-served requests: without a
  // projection the broker path selects, marks, and binds exactly as before.
  const h = await harnessWithManagedAnthropic()
  try {
    await h.service.addKey('anthropic', 'second', 'sk-ant-second')
    const provider = h.store.provider('anthropic')!
    const cursor = provider.cursor
    const selected = provider.keys[0]!
    const before = selected.lastUsedAt
    const stream = h.service.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-key-c4', messages: [] },
      async function* () {
        // Resolve inside the wrapped scope so the broker marks this request as
        // having actually used a managed credential.
        await h.credentials.raw.resolve(provider.brokerRef)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(stream)
    assert.notEqual(provider.cursor, cursor)
    assert.ok(selected.lastUsedAt > before)
    assert.equal(h.store.binding('session-key-c4', 'anthropic')!.keyId, selected.id)
  } finally {
    await h.close()
  }
})

/**
 * Hold one projection `deleteRecord` open (C1 ordering pin, round-5 finding
 * M3): the demotion cannot settle until `release()` runs, so a caller that
 * truly awaits `settleProjectionDemotion` stays pending while the gate is
 * shut.
 */
function deferProjectionDelete(h: Harness, key: string): { started: () => boolean; release: () => void } {
  const raw = h.credentials.raw
  const realDelete = raw.deleteRecord.bind(raw)
  let opened = false
  let open = (): void => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  raw.deleteRecord = async (k: string) => {
    if (k === key && !opened) {
      opened = true
      await gate
    }
    return realDelete(k)
  }
  return { started: () => opened, release: () => open() }
}

test('an oauth-coded stream failure fails over to a key within the same request (C1)', async () => {
  // Round-5 finding C1: demoting the projection only helped a LATER request.
  // The failure must carry request-scoped evidence in the same linked form
  // the key paths produce, and the retry decision must wait for the demotion
  // to settle so the retry attempt actually resolves through the key pool.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const failure = { code: 'oauth', message: 'OAuth refresh failed for anthropic' }
    // The public stream path attributes the failure, cools the account, and
    // starts the demotion; the agent loop then forwards this exact failure
    // object to agent/request-error.
    await consume(streamFailure(h, 'anthropic', 'session-c1', failure))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now(), 'the owning account row must be cooled')

    let nextCalled = false
    const action = await h.service.requestErrorListener({
      provider: 'anthropic',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-c1' } },
    } as unknown as RequestErrorPayload, async () => {
      nextCalled = true
      return undefined
    })
    // A retry is requested inside this same request/step.
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(nextCalled, false)
    // The retry decision waited for the demotion: the projection is gone, so
    // the retried attempt resolves through the key pool instead of the grant.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    // The second attempt of the same step lands on a pool key.
    h.service.noteRequestStep({ agent: { session: { id: 'session-c1' } }, turn: 1, step: 1 }, 'anthropic')
    const retry = h.service.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-c1', messages: [] },
      async function* () {
        await h.credentials.raw.resolve(h.store.provider('anthropic')!.brokerRef)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    )
    await consume(retry)
    const bound = h.store.binding('session-c1', 'anthropic')!
    assert.equal(h.store.provider('anthropic')!.keys.find(key => key.id === bound.keyId)!.kind, 'api-key')
    // The account stays demoted: recovery is manual.
    assert.equal(row.valueMissing, true)
  } finally {
    await h.close()
  }
})

test('the retry decision waits for a deferred projection demotion (C1 ordering)', async () => {
  // Round-5 finding M3: the C1 test above observes the ordering only after the
  // fact. Pin the `requestErrorListener` await itself — gate the demotion's
  // `deleteRecord`, fire the oauth failure, and prove the retry decision stays
  // pending (the grant still serves) until the deferred delete resolves.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  let releaseDelete = (): void => {}
  try {
    await h.service.activateAccount('anthropic', rowId)
    const deferred = deferProjectionDelete(h, GRANT_KEY)
    releaseDelete = deferred.release
    const failure = { code: 'oauth', message: 'OAuth refresh failed for anthropic' }
    await consume(streamFailure(h, 'anthropic', 'session-c1-order', failure))
    // The demotion is in flight AND parked on the gate.
    await eventually(() => assert.equal(deferred.started(), true))
    assert.equal(h.credentials.records.has(GRANT_KEY), true)

    let settled = false
    const pending = h.service.requestErrorListener({
      provider: 'anthropic',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-c1-order' } },
    } as unknown as RequestErrorPayload, async () => undefined).then(action => {
      settled = true
      return action
    })
    // Without the `await settleProjectionDemotion` the retry decision resolves
    // in microtasks; it must still be pending after a whole macrotask turn.
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(settled, false)
    // A retry started now would still resolve through the stored grant.
    assert.equal(h.credentials.records.has(GRANT_KEY), true)

    deferred.release()
    assert.deepEqual(await pending, { kind: 'retry' })
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    // The attempt this retry decision authorizes resolves through the pool.
    h.service.noteRequestStep({ agent: { session: { id: 'session-c1-order' } }, turn: 1, step: 1 }, 'anthropic')
    await consume(h.service.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-c1-order', messages: [] },
      async function* () {
        await h.credentials.raw.resolve(h.store.provider('anthropic')!.brokerRef)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    ))
    const bound = h.store.binding('session-c1-order', 'anthropic')!
    assert.equal(h.store.provider('anthropic')!.keys.find(key => key.id === bound.keyId)!.kind, 'api-key')
  } finally {
    releaseDelete()
    await h.close()
  }
})

test('an oauth-coded stream failure with no usable pool key still delegates (C1)', async () => {
  // The C1 evidence is recorded only when the pool can serve the retry: with
  // no candidate, neither the demoted account nor a key can succeed, so the
  // retry would be a phantom loop and delegation stays the answer.
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const provider = h.store.provider('anthropic')!
    for (const key of provider.keys) {
      if (key.kind !== 'oauth') key.enabled = false
    }
    h.store.touch()
    const failure = { code: 'oauth', message: 'OAuth refresh failed for anthropic' }
    await consume(streamFailure(h, 'anthropic', 'session-c1-empty', failure))
    let nextCalled = false
    const action = await h.service.requestErrorListener({
      provider: 'anthropic',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-c1-empty' } },
    } as unknown as RequestErrorPayload, async () => {
      nextCalled = true
      return undefined
    })
    assert.equal(action, undefined)
    assert.equal(nextCalled, true)
  } finally {
    await h.close()
  }
})

test('an oauth-coded stream failure without an active projection attributes to nothing', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    // Seeded but never activated: no projection, no ownership, no demotion.
    await consume(streamFailure(h, 'anthropic', 'session-unowned', { code: 'oauth', message: 'OAuth refresh failed for anthropic' }))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.cooldownUntil, 0)
    const warnings = (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    assert.equal(warnings.includes('demoting'), false)
  } finally {
    await h.close()
  }
})

test('record-updated rotations sync back into the owning account row', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // pi-ai rotated the grant inside its own record (per-request refresh,
    // research resolve.js:62-94): the projection payload changed underneath.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-seed-value', access: 'at-rotated', expires: 1_950_000_000_000, accountId: 'acc-9', email: 'dev@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    await eventually(() => assert.equal(row.oauth!.expiresAt, 1_950_000_000_000))
    assert.equal(row.oauth!.accountId, 'acc-9')
  } finally {
    await h.close()
  }
})

// Round-2 review step 5: the rotation writes the plugin-scope record
// FIRST and commits the row's grantRef only after that write resolves. A
// failed write keeps the old, still-present ref, so Remove still deletes
// the live grant.

test('a failed rotation write keeps the old grantRef so Remove still deletes the live grant', async () => {
  const { h, rowId, grantRef: refA } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // The plugin-scope write itself fails during the rotation echo.
    h.credentials.raw.failModifyRecord = true
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-rotate-fail', access: 'at-rotate-fail', expires: 1_950_000_000_000, accountId: 'acc-9', email: 'dev@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await new Promise(resolve => setTimeout(resolve, 40))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The row still points at the old, still-present record; the failed
    // generation's ref was never materialized.
    assert.equal(row.oauth!.grantRef, refA)
    assert.ok(h.credentials.records.has(refA))
    assert.equal(h.credentials.records.has(accountRef('anthropic', createHash('sha256').update('rt-rotate-fail').digest('hex').slice(0, 12))), false)
    // Remove still works against the old ref: the live grant goes away.
    h.credentials.raw.failModifyRecord = false
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.credentials.records.has(refA), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    await h.close()
  }
})

test('a rotated refresh token re-associates its row and syncs the rotated payload back (W1)', async () => {  const { h, rowId, grantRef: refA } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // pi-ai rotated the refresh token inside its own record: the payload's
    // digest no longer names the row's grantRef.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-rotated-token', access: 'at-rotated-token', expires: 1_950_000_000_000, accountId: 'acc-9', email: 'dev@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    // The row is re-associated via the payload's identity metadata: the
    // grantRef re-hashes to the rotated refresh token. SF2: the superseded
    // generation's plugin-scope record is deleted once the new payload
    // persists, so the old refresh token cannot strand as an orphan.
    const newRef = accountRef('anthropic', createHash('sha256').update('rt-rotated-token').digest('hex').slice(0, 12))
    await eventually(() => {
      assert.equal(row.oauth!.grantRef, newRef)
      assert.equal(h.credentials.records.has(refA), false)
    })
    assert.equal(row.oauth!.accountId, 'acc-9')
    assert.equal(row.oauth!.email, 'dev@example.com')
    assert.equal(row.oauth!.expiresAt, 1_950_000_000_000)
    // The rotated payload itself was written back to the owning
    // plugin-scope grant record, so a later re-activation cannot resurrect
    // the stale harvest-time snapshot.
    const stored = h.credentials.records.get(newRef)!
    assert.equal(stored.kind, 'grant')
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-rotated-token')
    assert.equal((stored.payload as Record<string, unknown>).access, 'at-rotated-token')
    // The write-back is keys-manager/-scope, which the handler's
    // llm-pi-ai/-scope filter ignores — no handler re-entry, and no false
    // native-management or unrecognized-payload warning.
    await new Promise(resolve => setTimeout(resolve, 20))
    const warnings = (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    assert.equal(warnings.includes('managed natively outside'), false)
    assert.equal(warnings.includes('unrecognized payload'), false)
  } finally {
    await h.close()
  }
})

/**
 * C6-1 test hook: defer the plugin-scope write for one key until released,
 * so a removal can be requested while the rotated-record write is in
 * flight. Everything else about the fake store is unchanged.
 */
function holdRotationWrite(h: Harness, key: string, options: { times?: number } = {}): {
  started: Promise<void>
  finished: Promise<void>
  release: () => void
} {
  const limit = options.times ?? Number.POSITIVE_INFINITY
  let held = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let markFinished!: () => void
  const finished = new Promise<void>(resolve => { markFinished = resolve })
  const raw = h.credentials.raw
  const realModify = raw.modifyRecord.bind(raw)
  raw.modifyRecord = async (k: string, mutate: (current: any) => Promise<any>) => {
    const park = k === key && held < limit
    const first = park && held === 0
    if (park) {
      // R5-MF1: a limit of 1 parks exactly the caller's write, so a second
      // writer of the same key (the settled harvest) lands first on purpose.
      held += 1
      if (first) markStarted()
      await gate
    }
    const result = await realModify(k, mutate)
    if (park && first) markFinished()
    return result
  }
  return { started, finished, release }
}

// C6-1 (P1): the reconciliation captures its owning row, then awaits a
// rotated-record write. A removeAccount / releaseProvider that lands in that
// window used to let the write recreate the record for a gone row — an
// orphaned refresh/access-token record nothing owns. The reconciliation now
// revalidates the row before and after the write, compensating with a delete
// when the account was removed. The normal rotation path (no race) is pinned
// by the W1 test above.

/**
 * C6-1/M3 deterministic control: resolve with the first record the seam
 * deletes after installation. The reconciliation's post-write continuation
 * always deletes exactly one grant record — the rotated generation (the
 * compensation branch) or the superseded generation (the commit branch) — so
 * the race tests can await the branch taken by name instead of a timer hop.
 */
function nextDeleteRecord(h: Harness): Promise<string> {
  return new Promise(resolve => {
    const raw = h.credentials.raw
    const realDelete = raw.deleteRecord.bind(raw)
    raw.deleteRecord = async (k: string) => {
      await realDelete(k)
      resolve(k)
    }
  })
}

/**
 * C6-1/I1 test hook: park the seam delete of one record until released, so a
 * multi-row release can be frozen between row X's grant delete and the
 * provider-record delete that ends the release.
 */
function holdDeleteRecord(h: Harness, key: string): {
  started: Promise<void>
  finished: Promise<void>
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let markFinished!: () => void
  const finished = new Promise<void>(resolve => { markFinished = resolve })
  const raw = h.credentials.raw
  const realDelete = raw.deleteRecord.bind(raw)
  raw.deleteRecord = async (k: string) => {
    if (k === key) {
      markStarted()
      await gate
    }
    await realDelete(k)
    if (k === key) markFinished()
  }
  return { started, finished, release }
}

/**
 * R5-SF1 test hook: park one read of `key` and resolve it with the snapshot
 * the read observed when it STARTED, so a removal can complete inside the
 * read's in-flight window and the reader still sees the pre-removal record —
 * exactly what a real store read that began earlier returns.
 */
function holdStaleGrantRead(h: Harness, key: string, occurrence: number): {
  parked: Promise<void>
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let markParked!: () => void
  const parked = new Promise<void>(resolve => { markParked = resolve })
  const raw = h.credentials.raw
  const realRead = raw.readRecord.bind(raw)
  let seen = 0
  raw.readRecord = async (k: string) => {
    const snapshot = await realRead(k)
    if (k !== key) return snapshot
    seen += 1
    if (seen !== occurrence) return snapshot
    markParked()
    await gate
    return snapshot
  }
  return { parked, release }
}

test('a rotation write racing removeAccount leaves no orphan record (C6-1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-raced-token').digest('hex').slice(0, 12))
    const held = holdRotationWrite(h, rotatedRef)
    // pi-ai rotates the grant; the echo's sync-back write is the deferred one.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-raced-token', access: 'at-raced' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await held.started
    // The removal COMPLETES while that write is still in flight: the row and
    // its stored grant are already gone when the write finally lands.
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.credentials.records.has(rotatedRef), false)
    // Await the reconciliation's continuation by name (M3): it always deletes
    // exactly one grant record — the rotated generation when it compensates,
    // the superseded one when it commits — so the branch taken is asserted
    // directly instead of waiting one timer hop.
    const continuationDelete = nextDeleteRecord(h)
    held.release()
    await held.finished
    assert.equal(await continuationDelete, rotatedRef)
    assert.equal(h.credentials.records.has(rotatedRef), false)
    // The removed account leaves no record behind — neither the rotated
    // generation nor its superseded seed, and not the projection.
    assert.equal(h.credentials.records.has(seededRef), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    // Never resurrect the removed row.
    const providerRecord = h.store.provider('anthropic')!
    assert.equal(providerRecord.keys.some(key => key.id === rowId), false)
    assert.equal(providerRecord.keys.filter(key => key.kind === 'oauth').length, 0)
  } finally {
    await h.close()
  }
})

test('a rotation write racing releaseProvider leaves no orphan record (C6-1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-raced-release').digest('hex').slice(0, 12))
    const held = holdRotationWrite(h, rotatedRef)
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-raced-release', access: 'at-raced-release' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await held.started
    // Release the whole provider while that write is still in flight; the
    // release completes before the write lands.
    await h.service.releaseProvider('anthropic')
    assert.equal(h.store.provider('anthropic'), undefined)
    assert.equal(h.credentials.records.has(rotatedRef), false)
    // Same named continuation as the removeAccount case (M3): the branch is
    // awaited through the record it deletes, not a timer hop.
    const continuationDelete = nextDeleteRecord(h)
    held.release()
    await held.finished
    assert.equal(await continuationDelete, rotatedRef)
    assert.equal(h.credentials.records.has(rotatedRef), false)
    assert.equal(h.credentials.records.has(seededRef), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(h.store.provider('anthropic'), undefined)
    // No secret-bearing record outlives the released route.
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
  } finally {
    await h.close()
  }
})

// C6-1/I1: the release of a provider with more than one key is not atomic.
// `releaseLocked` deletes every row's credential first and the provider
// record last, and it never splices the rows, so while it awaits a later row
// the provider record and row X both still look live — even though row X's
// grant is already gone. A rotation write landing in that window used to pass
// the row-identity revalidation, commit `owner.oauth.grantRef = rotatedRef`
// and be orphaned by the release's final provider deletion (no crash needed;
// normal FIFO ordering reaches it). The revalidation is removal-aware now:
// a row is marked before its removal's first awaited delete and a row already
// flagged `valueMissing` is rejected.

test('a rotation write landing mid-release leaves no orphan record (C6-1/I1)', async () => {
  const { h, rowId: rowA, grantRef: seededA } = await harnessWithSeededAccount({
    accountId: 'acc-a', email: 'a@example.com', refresh: 'rt-seed-a',
  })
  try {
    // A second account keeps the release running past row A: the release
    // reaches row B's grant only after row A is fully processed.
    const rowB = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'b@example.com', refresh: 'rt-seed-b' })
    await h.service.activateAccount('anthropic', rowA)
    const rowAObject = h.store.provider('anthropic')!.keys.find(key => key.id === rowA)!
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-mid-release').digest('hex').slice(0, 12))
    const heldWrite = holdRotationWrite(h, rotatedRef)
    // pi-ai rotates account A's grant; the echo's sync-back write is parked.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-mid-release', access: 'at-mid-release', accountId: 'acc-a', email: 'a@example.com' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await heldWrite.started

    // Park the release on row B's grant delete. By then row A's projection
    // and grant are deleted and row A is flagged, while the provider record
    // (deleted last) still exists — the exact mid-release window.
    const heldDelete = holdDeleteRecord(h, rowB.grantRef)
    const release = h.service.releaseProvider('anthropic')
    await heldDelete.started
    assert.notEqual(h.store.provider('anthropic'), undefined)
    assert.equal(h.credentials.records.has(seededA), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    // The parked rotation write now lands inside that window.
    heldWrite.release()
    await heldWrite.finished
    // Removal-aware revalidation: the write must not be committed, and the
    // record it wrote must be compensated. The row is never resurrected.
    await eventually(() => assert.equal(h.credentials.records.has(rotatedRef), false))
    assert.equal(rowAObject.oauth!.grantRef, seededA)

    // Finish the release; the route and every manager record are gone.
    heldDelete.release()
    await heldDelete.finished
    await release
    assert.equal(h.store.provider('anthropic'), undefined)
    assert.equal(h.credentials.records.has(rotatedRef), false)
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
  } finally {
    await h.close()
  }
})

// Round-9 finding P1: reconciliation is fire-and-forget, so two refresh
// echoes for one account arriving before the first write-back settles used to
// run concurrently. Each captured the same old `grantRef`, the writes
// completed out of order, and the older callback committed its generation
// after the newer one — moving the row onto a stale ref and leaving the newer
// record unreachable by normal removal. The bodies are now chained per
// provider and a commit whose observed generation was superseded is rejected
// (the write it made is cleaned up).

test('out-of-order rotation echoes keep the newest generation and leave no unreachable record (P1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const olderRef = accountRef('anthropic', createHash('sha256').update('rt-gen-old').digest('hex').slice(0, 12))
    const newerRef = accountRef('anthropic', createHash('sha256').update('rt-gen-new').digest('hex').slice(0, 12))
    // Park the OLD generation's write-back so the interleaving is exact: the
    // newer echo's body would run and commit first on the unfixed tree.
    const heldOlder = holdRotationWrite(h, olderRef)
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-gen-old', access: 'at-gen-old', accountId: 'acc-9', email: 'dev@example.com' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await heldOlder.started
    // pi-ai refreshes again before the first sync-back settles.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-gen-new', access: 'at-gen-new', accountId: 'acc-9', email: 'dev@example.com' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    // Give the newer echo every chance to overtake the parked body without
    // releasing it — on the unfixed tree it commits here, out of order.
    await new Promise(resolve => setTimeout(resolve, 25))
    heldOlder.release()
    await heldOlder.finished
    // The held write's continuation (row commit) lands a few microtasks after
    // the seam write resolves; give it a turn so the assertion below sees the
    // settled row, not the mid-flight one.
    await new Promise(resolve => setTimeout(resolve, 20))

    await eventually(() => assert.equal(row.oauth!.grantRef, newerRef))
    // The projection plus the newest generation are the only grant records:
    // the older generation was cleaned up instead of stranded.
    assert.deepEqual(
      [...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')),
      [newerRef],
    )
    assert.equal(h.credentials.records.has(olderRef), false)
    assert.equal(h.credentials.records.has(seededRef), false)
    const newest = h.credentials.records.get(newerRef)!
    assert.equal((newest.payload as Record<string, unknown>).refresh, 'rt-gen-new')
    // Removal reaches the record the row names, so nothing is left behind.
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.credentials.records.has(newerRef), false)
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
  } finally {
    await h.close()
  }
})

test('sequential rotation echoes still sync each generation in order (P1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const refOne = accountRef('anthropic', createHash('sha256').update('rt-seq-one').digest('hex').slice(0, 12))
    const refTwo = accountRef('anthropic', createHash('sha256').update('rt-seq-two').digest('hex').slice(0, 12))
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-seq-one', access: 'at-seq-one', accountId: 'acc-9', email: 'dev@example.com' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.equal(row.oauth!.grantRef, refOne))
    assert.equal(h.credentials.records.has(seededRef), false)
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-seq-two', access: 'at-seq-two', accountId: 'acc-9', email: 'dev@example.com' }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.equal(row.oauth!.grantRef, refTwo))
    assert.equal(h.credentials.records.has(refOne), false)
    assert.deepEqual(
      [...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')),
      [refTwo],
    )
    const stored = h.credentials.records.get(refTwo)!
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-seq-two')
  } finally {
    await h.close()
  }
})

// Round-5 review (R5-MF1): the P1 superseded-commit cleanup deletes the
// generation the reconciliation itself wrote. A settled harvest can adopt that
// very generation into the row while the cleanup's staleness probe is in
// flight — the harvest re-authenticates the same account and its committed
// refresh token hashes to the parked ref, so the row's `grantRef` moves onto
// the record the reconciler is about to delete. Deleting it destroys the
// account's own live grant: the row names a record nothing serves and Remove
// can no longer reach it. The cleanup therefore keeps a ref that a live row
// still references.

test('the superseded cleanup keeps a grant the settled harvest adopted (R5-MF1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const adoptedRef = accountRef('anthropic', createHash('sha256').update('rt-adopted-generation').digest('hex').slice(0, 12))
    // Only the reconciler's write is parked (times: 1): the harvest's write of
    // the same generation must land so it can adopt the ref first.
    const held = holdRotationWrite(h, adoptedRef, { times: 1 })
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-adopted-generation',
      access: 'at-adopted-generation',
      accountId: 'acc-9',
      email: 'dev@example.com',
    }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await held.started
    // The settled harvest for the same account commits the same generation,
    // adopts it into the row and claims a newer ownership generation.
    const view = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    assert.equal(row.oauth!.grantRef, adoptedRef)
    // The reconciler now resumes and sees its observed generation superseded.
    // Await its per-provider chain so the branch taken is observed, not a
    // timer hop away.
    const chain = (h.service as unknown as { grantReconciliations: Map<string, Promise<void>> })
      .grantReconciliations.get('anthropic')
    held.release()
    await held.finished
    if (chain !== undefined) await chain
    // The cleanup must keep the record the row serves.
    assert.equal(row.oauth!.grantRef, adoptedRef)
    assert.equal(h.credentials.records.has(adoptedRef), true)
    const stored = h.credentials.records.get(adoptedRef)!
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-adopted-generation')
    assert.equal((stored.payload as Record<string, unknown>).access, 'at-adopted-generation')
    // No unreachable record: the harvest-cleaned seed is gone, and the adopted
    // generation is the only plugin-scope record left.
    assert.equal(h.credentials.records.has(seededRef), false)
    assert.deepEqual(
      [...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')),
      [adoptedRef],
    )
    // Removal reaches the record the row names — nothing was stranded.
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.credentials.records.has(adoptedRef), false)
  } finally {
    await h.close()
  }
})

// Round-5 review (R5-SF1): the removal-aware revalidation ran right after the
// plugin-scope write, but the commit lands after a SECOND awaited credential
// read (the generation staleness probe). A removal that completes during that
// read is invisible to the earlier check, and the stale probe can still
// return the pre-removal record — so the reconciliation used to commit
// `grantRef` onto a detached row and strand the record it wrote. The check
// runs again immediately before the commit and compensates the write.

test('a removal landing inside the final staleness read leaves no orphan rotation record (R5-SF1)', async () => {
  const { h, rowId, grantRef: seededRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-late-removal').digest('hex').slice(0, 12))
    // The second read is the staleness probe; it resolves with the snapshot it
    // started from, so the removal below cannot invalidate it.
    const heldRead = holdStaleGrantRead(h, GRANT_KEY, 2)
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-late-removal',
      access: 'at-late-removal',
      accountId: 'acc-9',
      email: 'dev@example.com',
    }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await heldRead.parked
    // The removal completes while that probe is still in flight.
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === rowId), false)
    heldRead.release()
    // The stale probe cannot prove the row is gone, so the check before the
    // commit must: no grantRef commit onto the detached row, and the record
    // this reconciliation wrote is compensated.
    await eventually(() => assert.equal(h.credentials.records.has(rotatedRef), false))
    assert.equal(row.oauth!.grantRef, seededRef)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === rowId), false)
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
  } finally {
    await h.close()
  }
})

// Round-7 re-review minor: removeOAuthGrant marks the row before its first
// awaited delete so a rotation write landing mid-removal is rejected. When
// that delete THROWS, though, the removal never completes — removeAccount /
// deleteKey rethrow before splicing, a release before its final provider
// delete — so the row is still live and still managed. The mark must not
// outlive the failed removal: keeping it skipped rotation sync for a serving
// row until a restart, which the old "never cleared is safe" comment claimed
// could not happen.

test('a removal whose grant delete throws clears the retiring mark (R7 minor)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // Fail exactly this row's grant delete, once: the projection delete that
    // precedes it succeeds, so the removal reaches the row's own await.
    const raw = h.credentials.raw
    const realDelete = raw.deleteRecord.bind(raw)
    let failures = 1
    raw.deleteRecord = async (key: string): Promise<void> => {
      if (key === grantRef && failures > 0) {
        failures -= 1
        throw new Error('credential store locked')
      }
      return realDelete(key)
    }
    await assert.rejects(h.service.removeAccount('anthropic', rowId), /credential store locked/)
    // The failed removal left a live, still-managed row and its grant.
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)
    assert.ok(row, 'the row survives the failed removal')
    assert.equal(h.credentials.records.has(grantRef), true)
    // Recovery runs through the public re-activation path. After it, a
    // rotation echo must sync into the row again — with a stale retiring
    // mark the echo is silently skipped and the grantRef never moves.
    raw.deleteRecord = realDelete
    await h.service.activateAccount('anthropic', rowId)
    assert.equal(row!.valueMissing, false)
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-after-failed-remove').digest('hex').slice(0, 12))
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-after-failed-remove',
      access: 'at-after-failed-remove',
      accountId: 'acc-9',
      email: 'dev@example.com',
    }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.equal(row!.oauth!.grantRef, rotatedRef))
  } finally {
    await h.close()
  }
})

// F1 (I-000081): an echo-served rotation whose payload matches a pool row
// must REGISTER that row as the projection owner. After a restart the pool
// row is hydrated but no in-process login or activation ran, so nothing
// else claims the owner; without the claim, request attribution
// (oauthOwnerFor), cooling, and demotion all point nowhere while the
// projection serves every request.

test('an echo rotation with no in-process owner registers the matched row as the projection owner (I-000081)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // Post-restart shape: the row exists but nothing projected it in this
    // process (no activation, no login). pi-ai then rewrites its own record
    // with a rotated token and the reconciler sees the echo.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-echo-rotated', access: 'at-echo-rotated', expires: 1_950_000_000_000, accountId: 'acc-9', email: 'dev@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-echo-rotated').digest('hex').slice(0, 12))
    await eventually(() => assert.equal(row.oauth!.grantRef, rotatedRef))
    // Public failure path: the projection now serves requests, so an
    // oauth-coded stream failure must attribute to THIS row — cool it,
    // demote the projection, and fail over to the key pool. That path is
    // reachable only through the registered owner.
    await consume(streamFailure(h, 'anthropic', 'session-echo-owner', { code: 'oauth', message: 'OAuth refresh failed for anthropic' }))
    assert.ok(row.cooldownUntil > Date.now(), 'the echo-registered owner must be cooled')
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    const selection = await h.service.selectKey('anthropic', 'session-echo-owner-next')
    assert.equal(selection.key!.kind, 'api-key')
  } finally {
    await h.close()
  }
})

test('a foreign echo payload is never adopted as the projection owner (I-000081 guard)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // A payload matching no pool row: the round-2 warn-and-clear path must
    // survive F1 — ownership is never adopted for a foreign grant.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-foreign-echo', access: 'at-foreign-echo', expires: 1_950_000_000_000, accountId: 'acc-foreign', email: 'foreign@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const warnings = (): string => (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    await eventually(() => assert.match(warnings(), /managed natively outside/))
    // Attribution resolved to nothing: an oauth-coded stream failure after
    // the foreign echo must not cool or demote the previously active row.
    await consume(streamFailure(h, 'anthropic', 'session-foreign-echo', { code: 'oauth', message: 'OAuth refresh failed for anthropic' }))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.cooldownUntil, 0)
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
  } finally {
    await h.close()
  }
})

test('rotation-sync email fallback skips accountId-bearing rows (harvestLogin parity)', async () => {
  const { h, rowId: idA, grantRef: refA } = await harnessWithSeededAccount({ accountId: 'acc-a', email: 'shared@example.com', refresh: 'rt-a', access: 'at-a' })
  try {
    const { rowId: idB, grantRef: refB } = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'shared@example.com', refresh: 'rt-b', access: 'at-b' })
    const warnings = (): string =>
      (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    // A rotation echo whose payload accountId matches neither row must not
    // be swallowed by the shared email: both rows are accountId-bearing, so
    // the email-only fallback stays guarded exactly as harvestLogin's.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-echo-third', access: 'at-echo-third', expires: 1_950_000_000_000, accountId: 'acc-neither', email: 'shared@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(warnings(), /managed natively outside/))
    const rowA = h.store.provider('anthropic')!.keys.find(key => key.id === idA)!
    const rowB = h.store.provider('anthropic')!.keys.find(key => key.id === idB)!
    // No owner attribution: neither row was re-pointed or synced.
    assert.equal(rowA.oauth!.grantRef, refA)
    assert.equal(rowA.oauth!.expiresAt, undefined)
    assert.equal(rowB.oauth!.grantRef, refB)
    assert.equal(rowB.oauth!.expiresAt, undefined)

    // A payload with no accountId still resolves through the email fallback
    // onto the one row that never carried an accountId.
    const seededC = seedOAuthAccount(h, 'anthropic', { email: 'shared@example.com', refresh: 'rt-c', access: 'at-c' })
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-c-rotated', access: 'at-c-rotated', expires: 1_960_000_000_000, email: 'shared@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const rowC = h.store.provider('anthropic')!.keys.find(key => key.id === seededC.rowId)!
    const refC = accountRef('anthropic', createHash('sha256').update('rt-c-rotated').digest('hex').slice(0, 12))
    await eventually(() => assert.equal(rowC.oauth!.grantRef, refC))
    assert.equal(rowC.oauth!.expiresAt, 1_960_000_000_000)
    // The payload was written back to the owning row's grant record, and the
    // accountId-bearing rows stayed untouched.
    const stored = h.credentials.records.get(refC)!
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-c-rotated')
    assert.equal(rowA.oauth!.grantRef, refA)
    assert.equal(rowB.oauth!.grantRef, refB)
  } finally {
    await h.close()
  }
})

// Round-8 review (I-000107): the guarded email fallback must be a FALLBACK.
// With two rows sharing a login email — an earlier email-only row and a later
// row carrying the exact accountId — the exact match wins regardless of array
// order, so the rotated grant is never written into the wrong account.

test('rotation-sync prefers an exact accountId over an earlier email-only row (I-000107)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    // Seeded first, so it precedes the exact match in the row array.
    const emailOnly = seedOAuthAccount(h, 'anthropic', { email: 'shared@example.com', refresh: 'rt-email-only', access: 'at-email-only' })
    const exact = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'shared@example.com', refresh: 'rt-b', access: 'at-b' })
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-rotated-b').digest('hex').slice(0, 12))
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-rotated-b', access: 'at-rotated-b', expires: 1_960_000_000_000, accountId: 'acc-b', email: 'shared@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const provider = h.store.provider('anthropic')!
    const emailOnlyRow = provider.keys.find(key => key.id === emailOnly.rowId)!
    const exactRow = provider.keys.find(key => key.id === exact.rowId)!
    await eventually(() => assert.equal(exactRow.oauth!.grantRef, rotatedRef))
    // The exact owner was synced; the email-only row was never repointed.
    assert.equal(emailOnlyRow.oauth!.grantRef, emailOnly.grantRef)
    assert.equal(emailOnlyRow.oauth!.expiresAt, undefined)
    assert.ok(h.credentials.records.has(emailOnly.grantRef), 'the email-only row keeps its own grant')
    // The exact owner's superseded generation is gone, its record holds the
    // rotated payload.
    assert.equal(h.credentials.records.has(exact.grantRef), false)
    const stored = h.credentials.records.get(rotatedRef)!
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-rotated-b')
    // The fallback itself still works when no exact row exists (single
    // email-only row, payload without accountId).
    const fallback = seedOAuthAccount(h, 'anthropic', { email: 'fallback@example.com', refresh: 'rt-fallback', access: 'at-fallback' })
    const fallbackRef = accountRef('anthropic', createHash('sha256').update('rt-fallback-rotated').digest('hex').slice(0, 12))
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-fallback-rotated', access: 'at-fallback-rotated', expires: 1_970_000_000_000, email: 'fallback@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    const fallbackRow = provider.keys.find(key => key.id === fallback.rowId)!
    await eventually(() => assert.equal(fallbackRow.oauth!.grantRef, fallbackRef))
  } finally {
    await h.close()
  }
})

test('a re-login with a changed refresh token removes the superseded grant record (W2)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const first = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(first.id)!.status, 'ready'))
    const row = h.store.provider('anthropic')!.keys.find(key => key.kind === 'oauth')!
    const firstRef = row.oauth!.grantRef
    assert.ok(h.credentials.records.has(firstRef))

    // Re-login: pi-ai committed a fresh grant with a rotated refresh token,
    // so harvest hashes a different ref for the same account (matched by
    // accountId).
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-relogin-value', access: 'at-relogin' }))
    const second = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(second.id)!.status, 'ready'))
    const secondRef = row.oauth!.grantRef
    assert.notEqual(secondRef, firstRef)
    // The superseded grant payload is gone; the new one is in place, and
    // the re-login kept exactly one account row.
    assert.equal(h.credentials.records.has(firstRef), false)
    assert.ok(h.credentials.records.has(secondRef))
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 1)
  } finally {
    await h.close()
  }
})

test('a login lands its account as the active projection', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
    const row = h.store.provider('anthropic')!.keys.find(key => key.kind === 'oauth')!
    // The logged-in grant already IS the projection (pi-ai wrote it), so a
    // rotation right after login must sync into the new row.
    h.credentials.records.set(GRANT_KEY, grantPayload({ expires: 1_960_000_000_000 }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.equal(row.oauth!.expiresAt, 1_960_000_000_000))
  } finally {
    await h.close()
  }
})

test('an out-of-band account change surfaces a native-management warning', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    const pendingWarnings = (): string =>
      (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    // Someone signed a different account in through another surface: no row
    // owns that payload and the manager did not write the projection.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-other-account', access: 'at-other', expires: 1_800_000_000_000, accountId: 'acc-out-of-band' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => {
      const warnings = pendingWarnings()
      assert.match(warnings, /anthropic/)
      assert.match(warnings, /native/i)
    })
    // An api-key record landing on an account-managed route is the same story.
    h.credentials.records.set(GRANT_KEY, { kind: 'api-key', key: 'sk-native' })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(pendingWarnings(), /natively managed API-key/i))
    // The warnings ride the next state response.
    assert.match(h.service.buildState().warnings.join('\n'), /native/i)
    // The manager's own fallback deletion is not a warning.
    await h.service.activateAccount('anthropic', rowId)
    await h.service.fallbackToKeys('anthropic')
    assert.equal(h.service.buildState().warnings.join('\n').includes('native'), false)
  } finally {
    await h.close()
  }
})

/**
 * I-1 pin: the fake seam now echoes deletions through
 * `credentials/record-updated` like the real store does. The manager's own
 * fallbackToKeys deletion arrives as that event and must not read back as an
 * out-of-band removal; the guard is one-shot, so a later genuinely
 * out-of-band removal still warns.
 */
test('a fallback deletion echoed as record-updated stays silent and keeps the cascade demoted', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    const pendingWarnings = (): string =>
      (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    await h.service.activateAccount('anthropic', rowId)
    // fallbackToKeys deletes the projection; the seam echoes the deletion.
    // The echoed reconciliation round must not produce the out-of-band
    // warning and must not flip the account row's missing marker.
    await h.service.fallbackToKeys('anthropic')
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(pendingWarnings().includes('removed outside Keys Manager'), false)
    // Cascade skip behavior holds: the account row stays demoted, so
    // selection resolves through the API-key pool, not the deleted
    // projection's account.
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, true)
    const selection = await h.service.selectKey('anthropic', 'session-fallback-echo')
    assert.equal(selection.key!.kind, 'api-key')
    // The guard is one-shot: after re-activation, a genuinely out-of-band
    // removal still surfaces the warning.
    await h.service.activateAccount('anthropic', rowId)
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(pendingWarnings(), /removed outside Keys Manager/))
  } finally {
    await h.close()
  }
})

test('an expired intentional-removal marker no longer masks an out-of-band removal (W5)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    const pendingWarnings = (): string =>
      (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    await h.service.activateAccount('anthropic', rowId)
    // Age the pending marker past its TTL window: whatever the echo
    // scheduling, an entry this old can no longer absorb a removal echo —
    // silence is bounded in time, not decided by a microtask race.
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    markers.set('anthropic', Date.now() - 6_000)
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(pendingWarnings(), /removed outside Keys Manager/))
    // The expired marker was consumed for hygiene.
    assert.equal(markers.has('anthropic'), false)
  } finally {
    await h.close()
  }
})

// Round-7 review (R7-SF2): the intentional-removal marker is set just before
// `deleteRecord` because the removal's own echo must stay silent. A delete
// that THROWS never removed anything, so its marker must be revoked — left in
// place it would consume an unrelated out-of-band removal as the manager's own
// for the whole TTL, hiding the warning, the missing mark, and the stale owner.

test('a failed projection delete does not mask a later out-of-band removal (R7-SF2)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    const pendingWarnings = (): string =>
      (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    await h.service.activateAccount('anthropic', rowId)
    h.credentials.raw.failDeleteRecord = true
    await assert.rejects(() => h.service.fallbackToKeys('anthropic'), /credential store locked/)
    h.credentials.raw.failDeleteRecord = false
    // The failed delete produced no echo and no removal: its marker is gone.
    assert.equal(markers.has('anthropic'), false, 'the failed call revoked its marker')
    // A genuine out-of-band removal inside the TTL still surfaces.
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(pendingWarnings(), /removed outside Keys Manager/))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, true)
    // The stale owner entry is dropped with it.
    assert.equal(h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.some(key => key.projected === true), false)
  } finally {
    h.credentials.raw.failDeleteRecord = false
    await h.close()
  }
})

test('removeAccount drops the row, its plugin-scope payload, and falls back when active', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await h.service.removeAccount('anthropic', rowId)
    const providerRecord = h.store.provider('anthropic')!
    assert.equal(providerRecord.keys.some(key => key.id === rowId), false)
    assert.equal(h.credentials.records.has(grantRef), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    await assert.rejects(() => h.service.removeAccount('anthropic', rowId), /not found/)
  } finally {
    await h.close()
  }
})

// Round-2 review step 1: credential ownership must be PROVEN at delete
// time. A natively replaced projection (another account signed in outside
// the manager) belongs to that account — removing the stale row must not
// delete the native grant, and an oauth-coded failure must not cool the
// stale row or demote the native projection.

test('removing a stale account leaves a natively replaced projection untouched', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    assert.ok(h.credentials.records.has(GRANT_KEY))
    // Native sign-in as account B: pi-ai rewrote the projection with B's
    // grant; the echo surfaces the native-management warning.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-native-b', access: 'at-native-b', expires: 1_950_000_000_000, accountId: 'acc-native-b', email: 'b@example.com' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(
      (h.service as unknown as { warnings: string[] }).warnings.join('\n'),
      /managed natively outside/,
    ))
    // Removing stale account A keeps B's projection and only drops A's own
    // plugin-scope record: ownership is verified against the LIVE record.
    await h.service.removeAccount('anthropic', rowId)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === rowId), false)
    assert.equal(h.credentials.records.has(grantRef), false)
    assert.ok(h.credentials.records.has(GRANT_KEY), 'the natively replaced projection must survive')
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal((live.payload as Record<string, unknown>).accountId, 'acc-native-b')
  } finally {
    await h.close()
  }
})

test('an oauth-coded failure after a native replacement attributes to nothing', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    // Native replacement lands first: the reconciliation echo drops the
    // stale owner entry, so the route is no longer owned by this row.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-native-c', access: 'at-native-c', expires: 1_950_000_000_000, accountId: 'acc-native-c' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(
      (h.service as unknown as { warnings: string[] }).warnings.join('\n'),
      /managed natively outside/,
    ))
    // A projection-served request then fails with the oauth code: the
    // request scope no longer names a manager-owned account, so the stale
    // row is neither cooled nor demoted, and the native grant survives.
    await consume(streamFailure(h, 'anthropic', 'session-stale', { code: 'oauth', message: 'OAuth refresh failed for anthropic' }))
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.cooldownUntil, 0)
    assert.ok(h.credentials.records.has(GRANT_KEY), 'the native projection must survive the stale row failure')
    const warnings = (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    assert.equal(warnings.includes('demoting'), false)
  } finally {
    await h.close()
  }
})

// Round-2 review step 2: removal must not depend on the async hydration
// window. The deletion re-reads the live record inside its own mutation,
// so a removeAccount issued while the constructor hydration is still
// awaiting the credential read still demotes a projection the row owns.

test('removeAccount racing a pending hydration still removes a projection the row owns', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('anthropic')
    const seeded = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-9', email: 'dev@example.com', refresh: 'rt-secret-value', access: 'at-secret-value' })
    // The live projection carries exactly the payload the row owns.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    h.credentials.raw.readRecordDelayMs = 40
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    // removeAccount fires while the hydration read is still pending.
    await restarted.removeAccount('anthropic', seeded.rowId)
    h.credentials.raw.readRecordDelayMs = 0
    // After everything settles: the projection is gone, the row is gone,
    // and the late hydration has not resurrected the removed grant.
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(h.credentials.records.has(seeded.grantRef), false)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === seeded.rowId), false)
  } finally {
    await h.close()
  }
})

// MF3: projection ownership must survive restarts. A fresh service
// re-derives the active projection from the persisted record payload; an
// orphan projection (no matching row) is never adopted and keeps warning.

test('a restarted service rehydrates projection ownership and demotes on removal', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    assert.ok(h.credentials.records.has(GRANT_KEY))
    // "Restart": a fresh service over the same store and seam. The
    // rehydration is observed through product behaviour only: removing the
    // row must drop the projection the hydration re-associated with it.
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await restarted.removeAccount('anthropic', rowId)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === rowId), false)
    // After everything settles nothing resurrects the removed projection.
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    await h.close()
  }
})

test('a hydration read superseded by a newer activation is discarded', async () => {
  // Round-3 finding 3: the hydration read is awaited, and an activation
  // landing while it is in flight must win — the stale read lands last and
  // must not overwrite B's claim with A.
  const h = await harness()
  try {
    await h.service.adoptProvider('anthropic')
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-a', email: 'a@example.com', refresh: 'rt-account-a' })
    const b = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-b', email: 'b@example.com', refresh: 'rt-account-b' })
    // The persisted projection still carries A's grant (pre-restart state).
    const staleRecord = grantPayload({ refresh: 'rt-account-a', access: 'at-account-a', accountId: 'acc-a', email: 'a@example.com' })
    h.credentials.records.set(GRANT_KEY, structuredClone(staleRecord))
    // The hydration read snapshots A at t0 and resolves late — exactly the
    // in-flight window a real credential store's read latency opens. Only
    // THAT first read is stale: a real store's readRecord never returns a
    // value older than an already-resolved write, so later reads (the
    // rotation reconciler's echo re-read) observe the live record.
    const raw = h.credentials.raw
    const realRead = raw.readRecord.bind(raw)
    let grantReads = 0
    raw.readRecord = async (key: string) => {
      if (key === GRANT_KEY) {
        grantReads += 1
        if (grantReads === 1) {
          await new Promise(resolve => setTimeout(resolve, 60))
          return structuredClone(staleRecord)
        }
      }
      return realRead(key)
    }
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    // The user activates B while the hydration read of A is still pending.
    await restarted.activateAccount('anthropic', b.rowId)
    // The stale read lands; after everything settles...
    await new Promise(resolve => setTimeout(resolve, 120))
    // ...exactly B's row is badged, and A's stale read was discarded.
    const state = restarted.buildState()
    const provider = state.providers.find(entry => entry.provider === 'anthropic')!
    const projected = provider.keys.filter(key => key.projected === true)
    assert.equal(projected.length, 1)
    assert.equal(projected[0]!.id, b.rowId)
  } finally {
    await h.close()
  }
})

// Round-8 review (I-000108, high): a restarted process serves a projection
// that outlived the previous run, but the ownership hydration is async. A
// stream running before it settles sees an empty `activeAccounts`, so it
// selects and mutates a key even though pi-ai serves the stored grant, and an
// OAuth failure is attributed as externally authenticated (no cooling, no
// demotion). The first request must await the hydration result.

test('a stream waits for projection hydration before attributing the request (I-000108)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // An API-key row makes a premature selection observable.
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    // The projection persisted by the previous run.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    h.credentials.raw.readRecordDelayMs = 40
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    const provider = h.store.provider('anthropic')!
    const apiKeyRow = provider.keys.find(key => key.kind === 'api-key')!
    const cursorBefore = provider.cursor
    const usedBefore = apiKeyRow.lastUsedAt
    await consume(restarted.streamListener(
      { provider: 'anthropic', model: 'model', sessionId: 'session-hydration', messages: [] },
      async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'oauth', message: 'OAuth refresh failed for anthropic' } } }
      } as any,
    ))
    h.credentials.raw.readRecordDelayMs = 0
    // pi-ai served the stored grant: no key cursor, usage or binding moved.
    assert.equal(provider.cursor, cursorBefore)
    assert.equal(apiKeyRow.lastUsedAt, usedBefore)
    assert.equal(h.store.binding('session-hydration', 'anthropic'), undefined)
    // The failure belongs to the hydrated account: it cools and the stale
    // projection is demoted.
    const row = provider.keys.find(key => key.id === rowId)!
    assert.ok(row.cooldownUntil > Date.now(), 'the hydrated account is cooled')
    await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
  } finally {
    h.credentials.raw.readRecordDelayMs = 0
    await h.close()
  }
})

// Round-9 review (should-fix, I-000110): the hydration promise never rejects,
// but it can stay pending forever — `readRecord` has no timeout and the
// hydration read runs per provider, serially. Awaiting it unbounded let one
// stalled read block every managed stream, API-key-only providers included.
// The attribution wait is now bounded: on timeout the request proceeds with NO
// owner and without selecting/mutating key state (a projection may be serving,
// so mutating would repeat the I-000108 corruption), and the hydration itself
// is never cancelled — a late result still lands through the generation guard.

test('a stalled projection read does not block a stream and attributes no owner (R9 SF)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // The projection persisted by the previous run would belong to this row;
    // the read that would prove it never settles.
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const provider = h.store.provider('anthropic')!
    const row = provider.keys.find(key => key.id === rowId)!
    const rowBefore = structuredClone(row)
    const cursorBefore = provider.cursor
    const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
    let stalled = false
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) {
        stalled = true
        return new Promise<FakeCredentialRecord | undefined>(() => {})
      }
      return realRead(key)
    }
    try {
      const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
      ;(restarted as unknown as { hydrationWaitMs: number }).hydrationWaitMs = 40
      assert.equal(stalled, true, 'the stalled hydration read was exercised')

      const startedAt = Date.now()
      await consume(restarted.streamListener(
        { provider: 'anthropic', model: 'model', sessionId: 'session-stalled', messages: [] },
        async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        } as any,
      ))
      // It returned at all: the wait was bounded, not the stalled read.
      assert.ok(Date.now() - startedAt < 2000, 'the request was not blocked by the stalled read')
      // No owner: attribution stayed unknown, so nothing about the row or the
      // key selection moved.
      assert.deepEqual(row, rowBefore)
      assert.equal(provider.cursor, cursorBefore)
      assert.equal(h.store.binding('session-stalled', 'anthropic'), undefined)
      // The plugin-scope projection is untouched (nothing demoted or deleted).
      assert.equal(h.credentials.records.has(GRANT_KEY), true)
    } finally {
      h.credentials.raw.readRecord = realRead
    }
  } finally {
    await h.close()
  }
})

test('a provider without OAuth rows is not delayed by another provider\'s stalled hydration (R9 SF)', async () => {
  const h = await harness()
  try {
    // A stalled OAuth read for anthropic...
    await h.service.adoptProvider('anthropic')
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-9', email: 'dev@example.com' })
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // ...while the request targets an API-key-only provider that can never
    // own a projection.
    await h.service.adoptProvider('deepseek-official')
    await h.service.addKey('deepseek-official', 'peer', 'sk-deepseek-peer')
    const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) return new Promise<FakeCredentialRecord | undefined>(() => {})
      return realRead(key)
    }
    try {
      const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
      ;(restarted as unknown as { hydrationWaitMs: number }).hydrationWaitMs = 1000
      const startedAt = Date.now()
      await consume(restarted.streamListener(
        { provider: 'deepseek-official', model: 'model', sessionId: 'session-peer', messages: [] },
        async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        } as any,
      ))
      // No OAuth rows means no projection can serve this provider, so it must
      // not wait for hydration (let alone its bound).
      assert.ok(Date.now() - startedAt < 400, `the API-key-only request waited ${Date.now() - startedAt}ms`)
      // It still selected (and marked) a key from the pool as before.
      assert.ok(h.store.provider('deepseek-official')!.keys[0]!.lastUsedAt > 0)
    } finally {
      h.credentials.raw.readRecord = realRead
    }
  } finally {
    await h.close()
  }
})


// Round-10 review (should-fix SF1): hydration writes owners progressively,
// one provider's read at a time, but the bounded wait raced the SINGLE global
// hydration promise. When provider B's read stalled, provider A's already
// confirmed owner was discarded on the timeout: A lost attribution entirely
// (OAuth failures stopped cooling/demoting it). Readiness is decided per
// provider: a provider whose own read has landed needs no wait, and the
// "unknown" fallback applies only while its own read has not landed.

test('a hydrated provider keeps its owner while another provider\'s read stalls (R10 SF1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    // Provider B is adopted after A, so hydration reads A first and then
    // stalls on B. Both providers own a persisted projection.
    await h.service.adoptProvider('xai')
    const b = seedOAuthAccount(h, 'xai', { accountId: 'acc-x', email: 'x@example.com', refresh: 'rt-xai-row' })
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const bGrantKey = 'llm-pi-ai/xai'
    h.credentials.records.set(bGrantKey, grantPayload({ refresh: 'rt-xai-row', access: 'at-xai-row', accountId: 'acc-x', email: 'x@example.com' }))
    const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === bGrantKey) return new Promise<FakeCredentialRecord | undefined>(() => {})
      return realRead(key)
    }
    try {
      const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
      ;(restarted as unknown as { hydrationWaitMs: number }).hydrationWaitMs = 20
      // Let A's own read land while B's stays pending.
      await new Promise(resolve => setTimeout(resolve, 20))
      // A's OAuth failure is attributed to its hydrated owner: it cools and
      // the stale projection is demoted, exactly as before B stalled.
      await consume(restarted.streamListener(
        { provider: 'anthropic', model: 'model', sessionId: 'session-a', messages: [] },
        async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'oauth', message: 'OAuth refresh failed for anthropic' } } }
        } as any,
      ))
      const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
      assert.ok(row.cooldownUntil > Date.now(), 'the hydrated account is cooled while B stalls')
      await eventually(() => assert.equal(h.credentials.records.has(GRANT_KEY), false))
      // B's own read has not landed: its request stays unowned and mutates
      // nothing — the I-000108 guard for a provider whose readiness is unknown.
      const providerB = h.store.provider('xai')!
      const rowB = providerB.keys.find(key => key.id === b.rowId)!
      const rowBBefore = structuredClone(rowB)
      const cursorBefore = providerB.cursor
      await consume(restarted.streamListener(
        { provider: 'xai', model: 'model', sessionId: 'session-b', messages: [] },
        async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        } as any,
      ))
      assert.deepEqual(rowB, rowBBefore)
      assert.equal(providerB.cursor, cursorBefore)
      assert.equal(h.store.binding('session-b', 'xai'), undefined)
      assert.equal(h.credentials.records.has(bGrantKey), true)
    } finally {
      h.credentials.raw.readRecord = realRead
    }
  } finally {
    await h.close()
  }
})

// Round-10 review (should-fix SF2): `raceTimeout` attached one reaction
// (`promise.then`) to the shared hydration promise PER REQUEST and the timeout
// path only cleared its timer, so every timed-out wait left a reaction behind
// on a read that never settles — retained for the life of the process. The
// wait now registers one waiter entry per provider that removes itself when it
// ends (timeout or late landing), and the hydration promise itself is never
// subscribed to per request.

test('a timed-out hydration wait retains nothing per request (R10 SF2)', async () => {
  const { h } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) return new Promise<FakeCredentialRecord | undefined>(() => {})
      return realRead(key)
    }
    try {
      const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
      const seam = restarted as unknown as {
        hydrationWaitMs: number
        projectionHydration: unknown
        hydrationWaiterCount?: () => number
      }
      seam.hydrationWaitMs = 15
      // Count reactions attached to the shared hydration promise: the pre-fix
      // wait called `then` once per request on a promise that never settles.
      let reactions = 0
      seam.projectionHydration = {
        then: () => {
          reactions += 1
          return new Promise(() => {})
        },
      }
      const waits = 5
      const retainedEntries: number[] = []
      for (let attempt = 0; attempt < waits; attempt += 1) {
        const startedAt = Date.now()
        await consume(restarted.streamListener(
          { provider: 'anthropic', model: 'model', sessionId: `session-leak-${attempt}`, messages: [] },
          async function* () {
            yield { type: 'finish', reason: { kind: 'stop' } }
          } as any,
        ))
        // Proves the wait was bounded (the stalled read itself never settles).
        assert.ok(Date.now() - startedAt < 2000, 'the wait was bounded, not the stalled read')
        const counter = (restarted as unknown as { hydrationWaiterCount?: () => number }).hydrationWaiterCount
        retainedEntries.push(typeof counter === 'function' ? counter.call(restarted) : -1)
      }
      assert.equal(reactions, 0, 'no reaction is attached to the shared hydration promise')
      assert.deepEqual(retainedEntries, new Array<number>(waits).fill(0), 'no waiter entry survives its wait')
    } finally {
      h.credentials.raw.readRecord = realRead
    }
  } finally {
    await h.close()
  }
})

test('a restarted service does not adopt an orphan projection and still warns on its updates', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('anthropic')
    // One unrelated account row: the projection's payload matches neither
    // it nor anything else — an orphan (foreign or stale) projection.
    const seeded = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-other-row', email: 'other@example.com', refresh: 'rt-other-row' })
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-foreign', access: 'at-foreign', expires: 1_800_000_000_000, accountId: 'acc-foreign' },
    })
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    // Out-of-band updates on the orphan projection surface the warning.
    h.credentials.records.set(GRANT_KEY, {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-foreign-2', access: 'at-foreign-2', expires: 1_800_000_000_000, accountId: 'acc-foreign' },
    })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => {
      const warnings = (restarted as unknown as { warnings: string[] }).warnings.join('\n')
      assert.match(warnings, /managed natively outside/)
    })
    // Product behaviour instead of a private map: removing the only row
    // must NOT delete the foreign projection it does not own.
    await restarted.removeAccount('anthropic', seeded.rowId)
    assert.ok(h.credentials.records.has(GRANT_KEY), 'the foreign projection is not owned by the removed row')
  } finally {
    await h.close()
  }
})

test('releasing a provider with an active oauth account demotes the projection and removes the grant (W3)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    assert.ok(h.credentials.records.has(GRANT_KEY))
    // Release drops every managed credential: the activation projection
    // first (so the route resolves through the restored apiKeyEnv, never a
    // managerless grant), then each row's plugin-scope grant payload.
    await h.service.releaseProvider('anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(h.credentials.records.has(grantRef), false)
    assert.equal(h.store.provider('anthropic'), undefined)
    // The manager's own demotion echo must not read back as an out-of-band
    // removal warning.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((h.service as unknown as { warnings: string[] }).warnings.join('\n').includes('removed outside Keys Manager'), false)
  } finally {
    await h.close()
  }
})

test('an oauth demotion persists the cooldown even when the projection delete fails (W7)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    h.credentials.raw.failDeleteRecord = true
    ;(h.service as unknown as { markFailure: (p: string, k: string, f: unknown) => void })
      .markFailure('anthropic', rowId, { code: 'oauth', message: 'OAuth refresh failed for anthropic' })
    // The oauth branch applied the cooldown AND marked the store dirty
    // before returning: the deferred fallbackToKeys touch cannot be relied
    // on (its deleteRecord is the thing that just failed), so the demotion
    // branch touches on its own.
    assert.ok(row.cooldownUntil > Date.now())
    assert.equal((h.store as unknown as { dirty: boolean }).dirty, true)
    await assert.rejects(() => h.service.fallbackToKeys('anthropic'), /credential store locked/)
    // The cooldown is durable from the markFailure touch alone.
    await h.store.flush()
    const saved = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8')) as { providers: Record<string, { keys: Array<{ id: string; cooldownUntil: number }> }> }
    const savedRow = saved.providers['anthropic']!.keys.find(key => key.id === rowId)!
    assert.ok(savedRow.cooldownUntil > Date.now() - 60_000)
  } finally {
    await h.close()
  }
})

test('deleting an account through the key surface cleans up its grant payload', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9' })
  try {
    await h.service.activateAccount('anthropic', rowId)
    await h.service.deleteKey('anthropic', rowId)
    assert.equal(h.store.provider('anthropic')!.keys.some(key => key.id === rowId), false)
    assert.equal(h.credentials.records.has(grantRef), false)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    await h.close()
  }
})

test('state views expose oauth identity without the grant reference', async () => {
  const { h } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com', expires: 1_800_000_000_000 })
  try {
    const state = h.service.buildState()
    const view = state.providers.find(provider => provider.provider === 'anthropic')!
    const oauthRow = view.keys.find(key => key.kind === 'oauth')!
    assert.deepEqual(oauthRow.oauth, { provider: 'anthropic', email: 'dev@example.com', accountId: 'acc-9', expiresAt: 1_800_000_000_000 })
    const text = JSON.stringify(state)
    assert.ok(!text.includes('grantRef'))
    assert.ok(!text.includes('rt-seed-value'))
    // API-key rows carry no oauth field at all.
    const apiKeyRow = view.keys.find(key => key.kind === 'api-key')!
    assert.equal(apiKeyRow.oauth, undefined)
  } finally {
    await h.close()
  }
})

test('the endpoint registry exposes the oauth account invocations', async () => {
  const h = await pluginHarness()
  try {
    assert.equal(h.typertRegistrations.length, 1)
    const contribution = h.typertRegistrations[0]!
    assert.equal(contribution.package, 'dsh-keys-manager')
    const invocations = contribution.invocations
    // The pre-existing surface is untouched, and the T2 service methods are
    // each reachable under exactly the parameters the client sends.
    assert.deepEqual(invocations.map(invocation => invocation.method), [
      'getState',
      'adoptProvider',
      'addKey',
      'updateKey',
      'deleteKey',
      'releaseProvider',
      'addExtraProvider',
      'setSettings',
      'beginAccountLogin',
      'answerAccountPrompt',
      'accountAttempt',
      'listAccountAttempts',
      'activateAccount',
      'removeAccount',
    ])
    const params = (method: string): string[] =>
      invocations.find(invocation => invocation.method === method)!.parameters.map(parameter => parameter.name)
    assert.deepEqual(params('beginAccountLogin'), ['provider', 'alias', 'targetAccountId'])
    assert.deepEqual(params('answerAccountPrompt'), ['attemptId', 'value'])
    assert.deepEqual(params('accountAttempt'), ['attemptId'])
    assert.deepEqual(params('listAccountAttempts'), [])
    assert.deepEqual(params('activateAccount'), ['provider', 'accountId'])
    assert.deepEqual(params('removeAccount'), ['provider', 'accountId'])
    // Every registered invocation names a real service method, so the
    // gateway's `service[invocation.method]` dispatch cannot drift from the
    // registry (typertRemote binds the service instance directly).
    for (const invocation of invocations) {
      assert.equal(typeof (h.service as unknown as Record<string, unknown>)[invocation.method], 'function', invocation.method)
    }
  } finally {
    await h.close()
  }
})

test('account endpoints carry the begin → prompt → answer → ready walk and state-returning mutations', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // begin → attempt view (the pollable serializable attempt state).
    const view = await h.service.beginAccountLogin('anthropic', 'Work account')
    assert.equal(view.status, 'pending')
    const interaction = h.authorization.beganRequests[0]!.interaction as { prompt: (p: unknown) => Promise<string> }
    const flowAnswer = interaction.prompt({ kind: 'text', message: 'Paste the verification code' })

    // Poll the attempt exactly as the browser dialog will: the parked prompt
    // (message only, no secret material) is visible through the endpoint method.
    let polled = h.service.accountAttempt(view.id)!
    assert.equal(polled.status, 'prompt')
    assert.deepEqual(polled.prompt, { kind: 'text', message: 'Paste the verification code' })
    assert.equal(polled.id, view.id)

    await h.service.answerAccountPrompt(view.id, '123-456')
    assert.equal(await flowAnswer, '123-456')
    polled = h.service.accountAttempt(view.id)!
    assert.equal(polled.status, 'pending')
    assert.equal(polled.prompt, undefined)
    assert.ok(h.service.listAccountAttempts().some(entry => entry.id === view.id))

    // Settle → harvest → ready with the pool member id attached.
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.accountAttempt(view.id)!.status, 'ready'))
    const settled = h.service.accountAttempt(view.id)!
    const rowId = h.store.provider('anthropic')!.keys.find(key => key.kind === 'oauth')!.id
    assert.equal(settled.accountId, rowId)
    assert.equal(settled.error, undefined)

    // activate/remove return the refreshed StateView so a client mutation
    // updates its snapshot without a second round trip (addKey/deleteKey
    // precedent).
    const activated = await h.service.activateAccount('anthropic', rowId)
    const activatedRow = activated.providers.find(provider => provider.provider === 'anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(activatedRow.valueMissing, false)
    assert.deepEqual(activatedRow.oauth, { provider: 'anthropic', email: 'dev@example.com', accountId: 'acc-9', expiresAt: 1_800_000_000_000 })
    const removed = await h.service.removeAccount('anthropic', rowId)
    assert.equal(removed.providers.find(provider => provider.provider === 'anthropic')!.keys.some(key => key.id === rowId), false)

    // Unknown attempt ids poll to undefined (not an error): the dialog can
    // stop polling on a miss.
    assert.equal(h.service.accountAttempt('la_missing'), undefined)
  } finally {
    await h.close()
  }
})

test('a seam-side prompt-signal abort rejects the parked flow promise (S1)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const view = await h.service.beginAccountLogin('anthropic')
    const interaction = h.authorization.beganRequests[0]!.interaction as { prompt: (p: unknown) => Promise<string> }
    const controller = new AbortController()
    const flowAnswer = interaction.prompt({ kind: 'text', message: 'Paste the verification code', signal: controller.signal })
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'prompt')
    // The seam withdraws the prompt: the awaited promise rejects instead of
    // pending forever.
    controller.abort()
    await assert.rejects(() => flowAnswer, /withdrawn/)
    // The attempt still ends through its own begin outcome; the flow error
    // above already released the human-facing await.
    await h.authorization.pending!.reject(new Error('seam aborted'))
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
  } finally {
    await h.close()
  }
})

test('a TTL-expired attempt rejects its parked prompt and releases the single-flight slot (S1)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const view = await h.service.beginAccountLogin('anthropic')
    const interaction = h.authorization.beganRequests[0]!.interaction as { prompt: (p: unknown) => Promise<string> }
    const flowAnswer = interaction.prompt({ kind: 'text', message: 'Paste the verification code' })
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'prompt')
    // The TTL sweep aborts the wedged attempt: the parked prompt rejects
    // (dropPrompt passes a reason) and the single-flight slot is released.
    h.service.pruneTransient(Date.now() + 11 * 60_000)
    await assert.rejects(() => flowAnswer, /timed out/)
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    // A new sign-in for the same provider can begin immediately.
    const next = await h.service.beginAccountLogin('anthropic')
    assert.notEqual(next.id, view.id)
  } finally {
    await h.close()
  }
})

test('the attempt cache evicts oldest settled entries past the 128 cap (S3)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const attempts = (h.service as unknown as { loginAttempts: Map<string, Record<string, unknown>> }).loginAttempts
    for (let index = 0; index < 130; index += 1) {
      attempts.set(`la_${index}`, {
        id: `la_${index}`,
        provider: 'anthropic',
        status: 'failed',
        notices: [],
        createdAt: index,
        updatedAt: index,
        settledAt: index,
        controller: new AbortController(),
      })
    }
    // A fresh begin trims the cache back to the cap by dropping the oldest
    // settled entries; in-flight attempts are never candidates.
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(attempts.size, 128)
    assert.equal(attempts.has('la_0'), false)
    assert.equal(attempts.has('la_1'), false)
    assert.equal(attempts.has('la_2'), false)
    assert.equal(attempts.has('la_3'), true)
    assert.ok(attempts.has(view.id))
  } finally {
    await h.close()
  }
})
