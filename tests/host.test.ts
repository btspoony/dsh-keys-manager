import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { HostContext, RequestErrorPayload } from '../src/host-types'
import type { ExtraProvider, KeyRecord, KeyTestResult, ProviderRecord, ProviderView, StateView } from '../src/domain'
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
    /** Credential keys whose record read rejects (PR review round 17). */
    failReadRecordRefs: new Set<string>(),
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
      if (raw.failReadRecordRefs.has(key)) throw new Error('credential store unavailable')
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
    /** True while the seam refuses a withdraw because a commit is in flight. */
    committing: false,
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
        // The real seam withdraws the attempt when the caller's signal aborts:
        // it settles `cancelled` without waiting for the flow, and it does so
        // asynchronously, so a flow that commits at the same moment can still
        // resolve `authorized` first.
        const signal = request.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => {
          // The real seam does not withdraw an attempt that is already
          // committing; the pending promise resolves only once the commit does.
          if (this.committing) return
          queueMicrotask(() => resolve({ status: 'cancelled' }))
        }, { once: true })
      })
    },
  }
}

async function harness(flows?: Array<{ key: string; label: string; methods: Array<{ id: string; label: string }> }>): Promise<Harness> {
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
  // The pi-ai flow set is the default; a transport test passes its own list
  // (the transports package registers its flows on the same seam).
  const authorization = flows === undefined ? fakeAuthorization() : fakeAuthorization(flows)
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
    // The route's credential is the OAuth grant: a broker reference here would
    // make pi-ai resolve an api-key that never exists (MISSING_CREDENTIAL).
    const profile = h.settings.valueOf('llm-pi-ai').providers['openai-codex']
    assert.equal(profile?.apiKeyEnv, undefined)
    assert.equal(profile !== undefined && 'apiKeyEnv' in profile, false)
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

/**
 * Drive one real sign-in through the seam: pi-ai commits the provider grant
 * (`llm-pi-ai/<provider>`), the manager harvests it into an account row and
 * claims the projection. Returns the harvested row id.
 */
async function signInThroughFlow(h: Harness, provider: string): Promise<string> {
  const grantKey = `llm-pi-ai/${provider}`
  h.credentials.records.set(grantKey, grantPayload())
  const view = await h.service.beginAccountLogin(provider)
  h.emitEvent('authorization/settled', grantKey, 'authorized')
  h.authorization.pending!.resolve({ status: 'authorized' })
  await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'ready'))
  return h.service.getAccountAttempt(view.id)!.accountId!
}

// The reported failure: adoption bound the pi-ai profile to the broker
// (`apiKeyEnv = KEYSMGR_OPENAI_CODEX_A220D4`) on a route whose credential is
// an OAuth grant. pi-ai resolves a named credential synchronously and throws
// MISSING_CREDENTIAL when the seam cannot answer it, instead of falling
// through to its own stored grant.

test('an OAuth-only route resolves through its grant, never MISSING_CREDENTIAL', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    const rowId = await signInThroughFlow(h, 'openai-codex')
    const provider = h.store.provider('openai-codex')!
    assert.ok(provider.keys.some(key => key.id === rowId && key.kind === 'oauth'))
    const codex = h.service.getState().providers.find(entry => entry.provider === 'openai-codex')!
    assert.equal(codex.bindingHealthy, true)
    // pi-ai's own rule, applied to the live profile: naming no credential is
    // what lets the stored grant serve; a named one would have to resolve
    // through the credential seam.
    const ref = h.settings.valueOf('llm-pi-ai').providers['openai-codex']?.apiKeyEnv
    assert.equal(ref, undefined)
  } finally {
    await h.close()
  }
})

test('a hand-edited apiKeyEnv equal to the adoption original survives startup', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    assert.equal(profile.apiKeyEnv, record.brokerRef)
    assert.equal(record.originalApiKeyEnv, 'ZAI_CODING_CN_API_KEY')
    // The user takes the profile back in Models. The value is exactly the
    // reference adoption replaced, so an exception scoped to
    // `originalApiKeyEnv` instead of to adoption would silently re-bind it.
    profile.apiKeyEnv = 'ZAI_CODING_CN_API_KEY'
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    // The startup repair is entirely in-memory; one macrotask turn settles it.
    await new Promise(resolve => setTimeout(resolve, 20))
    const repaired = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    assert.equal(repaired.apiKeyEnv, 'ZAI_CODING_CN_API_KEY')
    assert.notEqual(repaired.apiKeyEnv, record.brokerRef)
    // The take-back stays visible: no heal, no cleared verdict or warning.
    const zai = restarted.getState().providers.find(entry => entry.provider === 'zai-coding-cn')!
    assert.equal(zai.bindingHealthy, false)
    assert.match(String(zai.warning), /Re-adopt/)
  } finally {
    await h.close()
  }
})

// The pre-fix build wrote the broker reference unconditionally at adoption, so
// an existing installation still carries that state. Startup repairs it
// through the same binding authority instead of leaving the route broken.

test('startup self-heal removes a legacy broker reference from a credential-less OAuth route', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    // The reference is deterministic (brokerRefFor), so this document is
    // exactly what a pre-fix build left behind.
    const legacy = h.store.provider('openai-codex')!.brokerRef
    h.settings.valueOf('llm-pi-ai').providers['openai-codex'] = { apiKeyEnv: legacy }
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, legacy)
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, undefined))
    const codex = restarted.getState().providers.find(entry => entry.provider === 'openai-codex')!
    assert.equal(codex.bindingHealthy, true)
    assert.equal(String(codex.warning ?? '').includes('Re-adopt'), false)
  } finally {
    await h.close()
  }
})

test('a refused binding write surfaces a user warning and never throws', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    const legacy = h.store.provider('openai-codex')!.brokerRef
    h.settings.valueOf('llm-pi-ai').providers['openai-codex'] = { apiKeyEnv: legacy }
    // The repair needs a write, and this profile refuses every one.
    h.settings.writable = false
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await new Promise(resolve => setTimeout(resolve, 20))
    // The route keeps the reference it had: nothing was repaired…
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, legacy)
    // …and the refusal reaches the user, not only the log.
    const warnings = restarted.getState().warnings.join('\n')
    assert.match(warnings, /credential reference for openai-codex was not updated/)
    assert.match(warnings, /read-only/)
  } finally {
    await h.close()
  }
})

test('a settings mount landing after hydration still heals the binding', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('openai-codex')
    const legacy = h.store.provider('openai-codex')!.brokerRef
    h.settings.valueOf('llm-pi-ai').providers['openai-codex'] = { apiKeyEnv: legacy }
    // A service constructed before the settings service is mounted cannot
    // read a profile, so its startup pass has nothing to repair…
    const ctxWithoutSettings = {
      ...(h.ctx as unknown as Record<string, unknown>),
      get: (name: string) => (name === 'settings' ? undefined : (h.ctx as unknown as { get: (key: string) => unknown }).get(name)),
    } as unknown as HostContext
    const restarted = new KeysManagerService(ctxWithoutSettings, h.store)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, legacy)
    // QC N3: a settings service that is merely not mounted yet is a not-yet,
    // so the constructor pass stays silent instead of warning about a route
    // the mount heals a moment later. (The read-only note is buildState's own
    // statement about the unreadable snapshot, not a repair failure.)
    assert.deepEqual(restarted.getState().warnings.filter(message => /credential reference/.test(message)), [])
    // …and the mount seam retries the same repair in this process instead of
    // leaving the route broken until the next start.
    restarted.attachSettings(h.settings)
    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers['openai-codex'].apiKeyEnv, undefined))
    assert.deepEqual(restarted.getState().warnings.filter(message => /credential reference/.test(message)), [])
  } finally {
    await h.close()
  }
})

test('a mixed route un-binds on projection and re-binds on demotion', async () => {
  const h = await harness()
  try {
    const adopted = await h.service.adoptProvider('anthropic')
    const brokerRef = h.store.provider('anthropic')!.brokerRef
    assert.equal(adopted.providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, true)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, brokerRef)
    await signInThroughFlow(h, 'anthropic')
    // The grant is the serving credential now: a broker reference would make
    // pi-ai read the key pool instead of the projection.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)
    assert.equal(h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, true)
    await h.service.fallbackToKeys('anthropic')
    // Demotion hands the route back to the surviving key pool.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, brokerRef)
    assert.equal(h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, true)
  } finally {
    await h.close()
  }
})

test('a key-capable route binds only once its pool holds a key', async () => {
  const h = await harness()
  try {
    // No importable credential exists for this route, so adoption starts with
    // an empty pool: a broker reference there would name a credential nothing
    // can resolve until a key is added.
    const adopted = await h.service.adoptProvider('openrouter')
    const openrouter = adopted.providers.find(entry => entry.provider === 'openrouter')!
    assert.equal(openrouter.keyCount, 0)
    assert.equal(openrouter.bindingHealthy, true)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.openrouter?.apiKeyEnv, undefined)
    await h.service.addKey('openrouter', 'mine', 'sk-or-secret')
    const record = h.store.provider('openrouter')!
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.openrouter.apiKeyEnv, record.brokerRef)
    assert.equal(h.service.getState().providers.find(entry => entry.provider === 'openrouter')!.bindingHealthy, true)
  } finally {
    await h.close()
  }
})

test('a hand-edited apiKeyEnv is never rewritten by the binding sync', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    // The user took the profile back in Models.
    profile.apiKeyEnv = 'MY_OWN_REF'
    // Adding a key is a bind-direction sync through a public call site.
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    assert.equal(profile.apiKeyEnv, 'MY_OWN_REF')
    const zai = h.service.getState().providers.find(entry => entry.provider === 'zai-coding-cn')!
    assert.equal(zai.bindingHealthy, false)
  } finally {
    await h.close()
  }
})

test('release keeps the pre-adoption apiKeyEnv when an oauth row precedes the key', async () => {
  const h = await harness()
  try {
    // A stale pre-adoption reference plus one usable api-key credential: the
    // pool starts unbound, the user signs in first and adds a key afterwards,
    // so the rows are ordered [oauth, api-key].
    h.settings.valueOf('llm-pi-ai').providers.xai = { apiKeyEnv: 'XAI_LEGACY_REF' }
    h.credentials.refs.set('XAI_API_KEY', 'sk-xai-user')
    await h.service.adoptProvider('xai')
    const record = h.store.provider('xai')!
    assert.equal(record.originalApiKeyEnv, 'XAI_LEGACY_REF')
    const brokerRef = record.brokerRef
    await signInThroughFlow(h, 'xai')
    // Drop the imported key while the projection serves, then add one back:
    // the account row stays first in the pool.
    const imported = record.keys.find(key => key.kind === 'api-key')!
    await h.service.deleteKey('xai', imported.id)
    await h.service.addKey('xai', 'mine', 'sk-xai-user-2')
    // Demotion hands the route back to the pool, so release takes the restore
    // path (the profile is bound again at that point).
    await h.service.fallbackToKeys('xai')
    assert.deepEqual(record.keys.map(key => key.kind), ['oauth', 'api-key'])
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.xai.apiKeyEnv, brokerRef)
    await h.service.releaseProvider('xai')
    // The demotion inside the deletion loop must not re-point the released
    // profile at the broker: that would let the closing unbind strip the
    // reference the user had before adoption.
    const released = h.settings.valueOf('llm-pi-ai').providers.xai
    assert.equal(released.apiKeyEnv, 'XAI_LEGACY_REF')
    assert.equal(h.store.provider('xai'), undefined)
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

/**
 * Drain one provider's grant-reconciliation chain.
 *
 * `onGrantRecordUpdated` is fire-and-forget (the seam event carries no
 * completion channel), so an assertion about what an echo did or did not
 * write must wait until the chain is genuinely empty — one mutation-queue
 * turn is not enough. The chain entry disappears only when its newest body
 * has settled, so an absent entry proves every echo of the mutations written
 * so far has been processed.
 */
async function drainGrantChain(h: Harness, provider: string): Promise<void> {
  const chains = (h.service as unknown as { grantReconciliations: Map<string, Promise<void>> }).grantReconciliations
  await eventually(() => assert.equal(chains.get(provider), undefined))
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

// Codex P2 (PR #17) + I-000122: a release queued AHEAD of the harvest can
// finalize the attempt and then fail its own preflight (unreadable settings),
// leaving the provider managed. The authorized settlement arrived while that
// release body was still parked, so the harvest's pre-queue settled guard
// passed and its callback ran afterwards — and used to write the grant copy
// plus the account row while the attempt the user sees stayed failed. The
// callback must revalidate settlement immediately before its first credential
// write, and because the seam already committed this attempt's grant as the
// provider projection at that broadcast, it must also demote that projection
// before returning instead of leaving the route on a failed login's grant.

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
    // terminal it already has. The projection the seam committed for this
    // attempt at the settlement broadcast is demoted through the
    // ownership-checked compensation (I-000122), so a failed login cannot
    // keep serving, while the provider itself stays managed.
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 0)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').length, 0)
    assert.notEqual(h.store.provider('anthropic'), undefined)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
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

// Issue #18 (store I-000122), the named release-ahead-of-harvest regression:
// a release queued ahead of the harvest cancels the sign-in and then refuses
// its own preflight, so the provider survives while the seam has already
// committed this attempt's grant as the route's projection. The queued harvest
// must demote that projection (ownership-checked) instead of leaving the route
// authenticated against a failed login — and an account that was already
// managed must keep its row and its plugin-scope grant untouched.

test('a harvest queued behind a failed release demotes the settled projection (release-ahead-of-harvest)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-1', email: 'first@example.com' })
  try {
    // The seam committed THIS attempt's grant as the provider projection.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-settled-attempt',
      access: 'at-settled-attempt',
      accountId: 'acc-2',
      email: 'second@example.com',
    }))
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // The release queues first and then fails its preflight, so the provider
    // survives and the harvest queued behind it still runs.
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    // The settlement broadcast arrives while the release body is parked.
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    // The next queued mutation resolves only after the harvest callback ran.
    await h.service.setSettings({})
    // The release owns the terminal; the harvest adds nothing to it.
    const failed = h.service.getAccountAttempt(view.id)!
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /released during sign-in/)
    assert.equal(failed.accountId, undefined)
    // No plugin-scope copy and no row for the settled attempt.
    assert.equal([...h.credentials.records.keys()].filter(key => key.startsWith('keys-manager/')).length, 1)
    assert.equal(h.store.provider('anthropic')!.keys.filter(key => key.kind === 'oauth').map(key => key.id).join(','), rowId)
    // The projection this attempt committed is demoted...
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    // ...while the account that was already managed keeps its grant copy.
    assert.equal(h.credentials.records.has(grantRef), true)
  } finally {
    await h.close()
  }
})

// I-000125 (PR #23 review 5586433311): the abort-path compensation deletes the
// projection, and that deletion must register the same one-shot
// intentional-removal marker the demotion path sets. When the provider already
// serves an ACTIVATED managed account, the unmarked echo reconciles as an
// external deletion — the active row is flagged `valueMissing` and a
// misleading "removed outside Keys Manager" warning is pushed, although that
// row and its plugin-scope grant are untouched by the abort.
//
// The marker only silences that echo; it does not make the manager's state
// truthful. The route no longer holds the projection the account rows were
// claimed against, so the owner claim is invalidated: `projected` turns false,
// the route falls back to the key pool, and the surviving row keeps its row,
// its `grantRef` and `valueMissing: false` — exactly the state the "Set active"
// control needs to re-project the route.

test('a settled abort invalidates the stale projection owner and leaves the account re-activatable (I-000125)', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-1', email: 'first@example.com' })
  try {
    const warnings = (): string => (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    const isProjected = (): boolean => h.service.buildState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .some(key => key.id === rowId && key.projected === true)
    await h.service.activateAccount('anthropic', rowId)
    // Let the activation echo's reconciliation round finish before the
    // attempt's grant replaces the projection, so nothing below is
    // attributable to that round.
    await drainGrantChain(h, 'anthropic')
    assert.equal(isProjected(), true)
    assert.equal(warnings().includes('removed outside Keys Manager'), false)
    // The seam commits THIS attempt's grant as the provider projection at
    // the settlement broadcast; it belongs to a different account.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-settled-attempt',
      access: 'at-settled-attempt',
      accountId: 'acc-2',
      email: 'second@example.com',
    }))
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // The release queues first and then fails its preflight, so the provider
    // survives and the harvest queued behind it still runs.
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    // The next queued mutation resolves only after the harvest callback ran.
    await h.service.setSettings({})
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    // The removal's echo is fire-and-forget: drain it before asserting.
    await drainGrantChain(h, 'anthropic')
    // Snapshot the warnings before any `buildState()` call — it drains them.
    const emitted = warnings()
    // The attempt's grant is gone from the route, and the surviving row is
    // untouched: same plugin-scope grant, still managed, still not demoted.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row.valueMissing, false, 'the surviving row is not demoted')
    assert.equal(row.oauth!.grantRef, grantRef)
    assert.equal(h.credentials.records.has(grantRef), true)
    // ...but the owner claim it kept is no longer true, so the manager stops
    // rendering the route as projected (and stops bypassing the key pool).
    assert.equal(isProjected(), false, 'the stale owner claim is invalidated')
    assert.equal(emitted.includes('removed outside Keys Manager'), false)
    // The one-shot marker was consumed by the removal's own echo.
    assert.equal(markers.has('anthropic'), false)
    // Re-activation: the surviving row's grant is still live, so "Set active"
    // re-projects the route and claims it again.
    await h.service.activateAccount('anthropic', rowId)
    await drainGrantChain(h, 'anthropic')
    const record = h.credentials.records.get(GRANT_KEY)
    assert.notEqual(record, undefined, 're-activation re-projects the route')
    assert.equal((record!.payload as Record<string, unknown>).refresh, 'rt-seed-value')
    assert.equal(isProjected(), true, 'the re-activated account owns the projection again')
  } finally {
    await h.close()
  }
})

// I-000125 marker hygiene (PR #23 review 5586433311 nit): a provider that holds
// no OAuth row cannot be demoted, but its own removal echo must still reach the
// handler's marker consumer. The handler used to return at "no OAuth rows"
// before reading the marker, so a first-ever login whose abort compensation
// deleted the projection left the marker armed for its whole TTL — and a
// genuine out-of-band removal inside that window was silently swallowed.

test('a settled abort on a provider with no OAuth rows spends its removal marker (I-000125)', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    const warnings = (): string => (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    // The seam commits THIS attempt's grant as the provider projection; no
    // OAuth row exists yet, so the compensation's delete cannot demote one.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-settled-attempt', access: 'at-settled-attempt' }))
    const view = await h.service.beginAccountLogin('anthropic')
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    await h.service.setSettings({})
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    // The removal's own echo ran and stayed silent: the projection is gone and
    // the one-shot marker with it.
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(markers.has('anthropic'), false, 'the no-row removal echo consumed its own marker')
    // A later sign-in makes a row serve the route; a genuine out-of-band
    // removal inside the marker's TTL must still warn and demote.
    h.settings.failDescribe = false
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const next = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(next.id)!.status, 'ready'))
    await drainGrantChain(h, 'anthropic')
    const rowId = h.service.getAccountAttempt(next.id)!.accountId!
    const row = (): KeyRecord => h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!
    assert.equal(row().valueMissing, false)
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(warnings(), /removed outside Keys Manager/))
    assert.equal(row().valueMissing, true, 'the externally removed projection demoted its row')
  } finally {
    await h.close()
  }
})

// I-000122 provenance safety: the settled abort may only demote the projection
// while it still carries the payload captured for THIS attempt. A newer or
// native grant that replaced it before the queued harvest ran belongs to
// someone else and must survive the abort.

test('a settled abort never demotes a projection another writer replaced (I-000122)', async () => {
  const h = await harnessWithManagedAnthropic()
  const warnings: string[] = []
  h.ctx.logger.warn = (message: string) => {
    warnings.push(message)
  }
  const raw = h.credentials.raw
  const realRead = raw.readRecord.bind(raw)
  try {
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-settled-attempt', access: 'at-settled-attempt' }))
    const view = await h.service.beginAccountLogin('anthropic')
    // The settlement capture reads this attempt's payload; a native writer
    // replaces the projection immediately afterwards, before the queued
    // harvest runs.
    raw.readRecord = async (key: string) => {
      const record = await realRead(key)
      if (key === GRANT_KEY) {
        h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-native-replacement', access: 'at-native-replacement' }))
      }
      return record
    }
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    await h.service.setSettings({})
    // The live projection belongs to another writer: untouched.
    const live = h.credentials.records.get(GRANT_KEY)
    assert.notEqual(live, undefined)
    assert.equal((live!.payload as Record<string, unknown>).refresh, 'rt-native-replacement')
    // The refused demotion is observable, not silent.
    assert.ok(
      warnings.some(message => message.includes('kept the projection for anthropic')),
      `expected a compensation skip warning, got: ${warnings.join(' | ')}`,
    )
  } finally {
    raw.readRecord = realRead
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

// I-000125 (second producer of the one-shot marker): `revertHarvestProjection`
// registers the same marker as `decideAndDeleteProjection` and revokes it —
// identity-checked — when the delete throws. The shared consumer's one-shot
// and expiry behaviour is already pinned by the W5 expiry test and the R7-SF2
// failed-delete test above; this case proves the NEW call site revokes its own
// marker too, so the abort path cannot mask a later genuine out-of-band
// removal for the rest of the TTL.

test('a throwing abort-path projection revoke leaves no marker masking a later removal (I-000125)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-1', email: 'first@example.com' })
  try {
    const warnings = (): string => (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    // `warn()` logs through the host logger; `pushWarning()` rides the state
    // response. The compensation failure is a log line, the out-of-band
    // removal is a state warning — capture both.
    const logged: string[] = []
    h.ctx.logger.warn = (message: string) => { logged.push(message) }
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    await h.service.activateAccount('anthropic', rowId)
    await drainGrantChain(h, 'anthropic')
    // The seam commits THIS attempt's grant as the route projection.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-settled-attempt',
      access: 'at-settled-attempt',
      accountId: 'acc-2',
      email: 'second@example.com',
    }))
    const view = await h.service.beginAccountLogin('anthropic')
    h.settings.failDescribe = true
    const release = h.service.releaseProvider('anthropic')
    // Fail the compensation's projection delete: the marker is set right
    // before it and must be revoked before the failure leaves the method.
    h.credentials.raw.failDeleteRecord = true
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => release, /unreadable/)
    await h.service.setSettings({})
    h.credentials.raw.failDeleteRecord = false
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    // The failed revoke is observable and left no marker behind.
    assert.ok(
      logged.some(message => message.includes('could not revert the projection for anthropic')),
      `expected a compensation failure log, got: ${logged.join(' | ')}`,
    )
    assert.equal(markers.has('anthropic'), false, 'the failed revoke revoked its marker')
    // The delete threw, so the record is still live; a genuine out-of-band
    // removal inside the TTL window still surfaces the demotion warning.
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(warnings(), /removed outside Keys Manager/))
    assert.equal(h.store.provider('anthropic')!.keys.find(key => key.id === rowId)!.valueMissing, true)
  } finally {
    h.credentials.raw.failDeleteRecord = false
    await h.close()
  }
})

// I-000125 / PR #23 review (Minor 1): the abort compensation arms its removal
// marker while the provider is managed, but the echo that consumes that marker
// is fire-and-forget. A release landing before the echo's body runs makes the
// provider unmanaged at echo time — the reconciliation is dropped, so nothing
// spends the marker and it stays armed for its whole TTL. A provider re-adopted
// inside that window then reads a genuine out-of-band removal as the manager's
// own: no warning, no `valueMissing`, no stale-owner cleanup.
//
// Shape: a failed release (unreadable settings) queues the harvest behind it,
// so the provider is still managed when the compensation arms. The provider's
// grant-reconciliation chain is held open, the state an in-flight echo leaves
// behind, so the removal echo cannot run yet. A successful release then removes
// the provider — and must drop the marker it can no longer have consumed.

test('a release between arming the removal marker and its echo drops the marker', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-1', email: 'first@example.com' })
  let unpark: (() => void) | undefined
  try {
    const warnings = (): string => (h.service as unknown as { warnings: string[] }).warnings.join('\n')
    const markers = (h.service as unknown as { intentionalProjectionRemovals: Map<string, number> }).intentionalProjectionRemovals
    const chains = (h.service as unknown as { grantReconciliations: Map<string, Promise<void>> }).grantReconciliations
    await h.service.activateAccount('anthropic', rowId)
    await drainGrantChain(h, 'anthropic')
    // The seam commits THIS attempt's grant as the provider projection at the
    // settlement broadcast.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-settled-attempt',
      access: 'at-settled-attempt',
      accountId: 'acc-2',
      email: 'second@example.com',
    }))
    const view = await h.service.beginAccountLogin('anthropic')
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'pending')
    // Park the provider's grant chain: the removal echo the abort compensation
    // is about to schedule stays queued behind this body, exactly as it does
    // behind an echo whose record read is still in flight.
    const parked = new Promise<void>(resolve => { unpark = resolve })
    chains.set('anthropic', parked)
    // Release-ahead-of-harvest (I-000122 shape): the release cancels the
    // sign-in and THEN refuses its preflight, leaving the provider managed, so
    // the harvest queued behind it arms the marker as a managed provider's.
    h.settings.failDescribe = true
    const failedRelease = h.service.releaseProvider('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await assert.rejects(() => failedRelease, /unreadable/)
    // The next queued mutation resolves only after the harvest callback ran.
    await h.service.setSettings({})
    assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed')
    // The compensation removed the projection and armed its one-shot marker.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    assert.equal(markers.has('anthropic'), true, 'the abort compensation armed its own removal marker')
    // The release that follows succeeds before the parked echo drains.
    h.settings.failDescribe = false
    await h.service.releaseProvider('anthropic')
    assert.equal(h.store.provider('anthropic'), undefined)
    // The echo for an unmanaged provider is dropped, so the marker must not
    // outlive the release.
    assert.equal(markers.has('anthropic'), false, 'the successful release drops the armed marker')
    unpark?.()
    await drainGrantChain(h, 'anthropic')
    assert.equal(markers.has('anthropic'), false, 'the dropped echo cannot re-arm the marker')
    // Re-adopt inside the marker's TTL and let a fresh sign-in make a row
    // serve the route again.
    await h.service.adoptProvider('anthropic')
    h.credentials.records.set(GRANT_KEY, grantPayload())
    const next = await h.service.beginAccountLogin('anthropic')
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(next.id)!.status, 'ready'))
    await drainGrantChain(h, 'anthropic')
    const accountId = h.service.getAccountAttempt(next.id)!.accountId!
    const row = (): KeyRecord => h.store.provider('anthropic')!.keys.find(key => key.id === accountId)!
    assert.equal(row().valueMissing, false)
    // A genuine out-of-band removal inside the 5 s window is still external:
    // the row is marked missing and the warning is pushed.
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => assert.match(warnings(), /removed outside Keys Manager/))
    assert.equal(row().valueMissing, true, 'the externally removed projection demoted its row')
    assert.equal(
      h.service.buildState().providers.find(entry => entry.provider === 'anthropic')!.keys.some(key => key.projected === true),
      false,
      'the stale owner claim was dropped with it',
    )
  } finally {
    unpark?.()
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
      // Each provider's own projection read lands independently (PR review
      // round 13), so this route must not wait for anthropic's stalled read —
      // let alone its bound.
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
      // The startup repair registered its own bounded wait for this provider.
      // It is not per-request retention, so let it expire before counting what
      // the requests leave behind (PR review round 3 gave the repair a
      // per-provider readiness wait).
      await eventually(() => assert.equal(
        (restarted as unknown as { hydrationWaiterCount?: () => number }).hydrationWaiterCount?.() ?? 0,
        0,
      ))
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

// PR review round 13: hydration used to skip every provider that holds no
// OAuth rows, so a native grant persisted under `llm-pi-ai/<provider>` on a
// key-only managed route stayed invisible to the startup repair — which then
// bound the broker reference over it and took the grant out of service.
// Ownership must be decided from the projection for EVERY managed provider.

test('a key-only provider with a persisted native grant stays unbound after startup', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    await h.service.addKey('anthropic', 'route-key', 'sk-ant-route-key')
    const record = h.store.provider('anthropic')!
    // The route is served by its API-key pool: a broker-bound profile.
    assert.ok(record.keys.length > 0)
    assert.ok(record.keys.every(row => row.kind === 'api-key'), 'the route holds no OAuth rows')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)
    // A native sign-in persisted its own grant for the same route.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-native', accountId: 'acc-native', email: 'native@example.com' }))

    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await new Promise(resolve => setTimeout(resolve, 80))

    // The live projection still serves the route, so the startup repair must
    // not bind the broker over it…
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, undefined)
    // …and the native grant is untouched and remains the route's credential.
    assert.equal(liveProjectionRefresh(h), 'rt-native')
    assert.equal(restarted.getState().providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, true)
  } finally {
    await h.close()
  }
})

// PR review round 13: a transient startup read failure pinned ownership
// unknown for the life of the process, even after a later reconciliation read
// the projection successfully: no attribution, no key selection, and every
// row test refused with "ownership is still loading". An authoritative read
// must clear the failure.

test('a successful reconciliation clears a failed hydration read', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let failGrantReads = true
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'].models = [{ id: 'claude-test-model' }]
    // A key row makes the broker-bound profile observable before the restart.
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    const brokerRef = h.store.provider('anthropic')!.brokerRef
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // The startup hydration cannot read the projection at all.
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (failGrantReads && key === GRANT_KEY) throw new Error('credential store unavailable')
      return realRead(key)
    }
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    ;(restarted as unknown as { hydrationWaitMs: number }).hydrationWaitMs = 20
    await new Promise(resolve => setTimeout(resolve, 40))
    // Nothing was repaired from a guessed shape: the profile still binds the
    // pool while the projection is unread.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, brokerRef)

    // A later record-updated reconciliation reads the projection successfully.
    failGrantReads = false
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await eventually(() => {
      const rows = restarted.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
      assert.equal(rows.find(row => row.id === rowId)!.projected, true)
    })
    // The binding converges on the now-known projection…
    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, undefined))
    // …and the row test no longer refuses with an ownership that is "loading".
    h.llm.stream = (options: Record<string, any>) => restarted.streamListener(options as any, async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    const result = await restarted.testKey('anthropic', rowId)
    assert.doesNotMatch(String(result.error), /ownership is still loading/)
    assert.equal(result.ok, true)
  } finally {
    h.credentials.raw.readRecord = realRead
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
      // Task 2: the per-row connection test rides the same Remote surface.
      'testKey',
      'beginTransportLogin',
      'activateTransportAccount',
      'removeTransportAccount',
    ])
    const params = (method: string): string[] =>
      invocations.find(invocation => invocation.method === method)!.parameters.map(parameter => parameter.name)
    assert.deepEqual(params('beginAccountLogin'), ['provider', 'alias', 'targetAccountId'])
    assert.deepEqual(params('answerAccountPrompt'), ['attemptId', 'value'])
    assert.deepEqual(params('accountAttempt'), ['attemptId'])
    assert.deepEqual(params('listAccountAttempts'), [])
    assert.deepEqual(params('activateAccount'), ['provider', 'accountId'])
    assert.deepEqual(params('removeAccount'), ['provider', 'accountId'])
    assert.deepEqual(params('testKey'), ['provider', 'keyId'])
    // Transport routes are addressed by route only; the attempt is polled
    // through the same accountAttempt record the pi-ai dialog uses.
    assert.deepEqual(params('beginTransportLogin'), ['provider'])
    assert.deepEqual(params('activateTransportAccount'), ['provider'])
    assert.deepEqual(params('removeTransportAccount'), ['provider'])
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

// A per-row connection test runs one real `ctx.llm.stream` request under a
// test-only request scope: the broker answers with the pinned credential and
// the stream listener skips selection, cursor movement and every health write.

test('testKey pins the selected api-key and never touches health state', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const provider = h.store.provider('zai-coding-cn')!
    const target = provider.keys[1]!
    const before = {
      row: structuredClone(target),
      cursor: provider.cursor,
      bindings: structuredClone(h.store.state.sessionBindings),
    }
    const requests: Array<Record<string, any>> = []
    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => {
      requests.push(options)
      return h.service.streamListener(options as any, async function* () {
        resolved.push((await h.credentials.raw.resolve(provider.brokerRef))?.value)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    const result = await h.service.testKey('zai-coding-cn', target.id)

    assert.equal(result.ok, true)
    assert.ok(result.latencyMs >= 0)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.provider, 'zai-coding-cn')
    assert.equal(requests[0]!.model, 'zai-test-model')
    assert.equal(requests[0]!.maxTokens, 1)
    assert.deepEqual(requests[0]!.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }])
    // The test scope — not the cursor — decided the credential.
    assert.deepEqual(resolved, ['sk-second'])
    assert.deepEqual(structuredClone(h.store.provider('zai-coding-cn')!.keys[1]), before.row)
    assert.equal(h.store.provider('zai-coding-cn')!.cursor, before.cursor)
    assert.deepEqual(structuredClone(h.store.state.sessionBindings), before.bindings)
  } finally {
    await h.close()
  }
})

test('a failing key test reports the provider failure without cooling the key', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'invalid api key' } } }
    } as any)

    const result = await h.service.testKey('zai-coding-cn', target.id)

    assert.equal(result.ok, false)
    assert.match(String(result.error), /invalid api key/)
    assert.equal(target.cooldownUntil, 0)
    assert.equal(target.totalFailures, 0)
    assert.equal(target.consecutiveFailures, 0)
    assert.equal(target.failureLevel, 0)
  } finally {
    await h.close()
  }
})

test('an oauth row test restores the previous projection', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const first = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
    const second = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-second', email: 'second@example.com', refresh: 'rt-second' })
    // The user's live projection is the second account.
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-second', accountId: 'acc-second', email: 'second@example.com' }))
    await h.service.activateAccount('anthropic', second.rowId)
    const seenDuringTest: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const projection = h.credentials.records.get(GRANT_KEY)
      seenDuringTest.push((projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, true)
    // The row under test served the request…
    assert.deepEqual(seenDuringTest, ['rt-first'])
    // …and the previous projection is back afterwards.
    const restored = h.credentials.records.get(GRANT_KEY)
    assert.equal(restored?.kind, 'grant')
    assert.equal((restored?.payload as Record<string, unknown>).refresh, 'rt-second')
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.notEqual(rows.find(row => row.id === first.rowId)!.projected, true)
    assert.equal(rows.find(row => row.id === second.rowId)!.projected, true)
  } finally {
    await h.close()
  }
})

test('a provider without a configured model refuses the test without sending a request', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    let calls = 0
    h.llm.stream = () => {
      calls += 1
      return (async function* () {})()
    }
    const result = await h.service.testKey('zai-coding-cn', target.id)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /No model is configured/)
    assert.equal(calls, 0)
  } finally {
    await h.close()
  }
})

test('a concurrent test on the same provider is refused with a clear message', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      await gate
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const first = h.service.testKey('zai-coding-cn', target.id)
    // M2: every expected refusal is a structured result, so the row's inline
    // line is the only failure surface (no thrown RPC error / page banner).
    const refusal = await h.service.testKey('zai-coding-cn', target.id)
    assert.equal(refusal.ok, false)
    assert.match(String(refusal.error), /already running/)
    release!()
    assert.equal((await first).ok, true)
  } finally {
    await h.close()
  }
})

test('an oauth row test removes the borrowed projection when the route had none', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const seeded = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    const seen: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const projection = h.credentials.records.get(GRANT_KEY)
      seen.push((projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', seeded.rowId)

    assert.equal(result.ok, true)
    assert.deepEqual(seen, ['rt-only'])
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.notEqual(rows.find(row => row.id === seeded.rowId)!.projected, true)
  } finally {
    await h.close()
  }
})

test('a native grant landing during the projection cleanup survives the test', async () => {
  // PR review MF2: removing the projection this test created is a
  // compare-and-delete. A native writer's new grant landing between the
  // restore's re-read and the removal is not the test's leftover, so it must
  // survive and own the route — and the restore did not complete, so the test
  // must not report a pass.
  const h = await harness()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const seeded = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    const native = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-native', email: 'native@example.com', refresh: 'rt-native' })
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    let pinged = false
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) pinged = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    // The native sign-in lands right after the restore's re-read returned the
    // borrowed payload — inside the re-read/delete window of the unfixed code.
    let landed = false
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      const record = await realRead(key)
      if (!landed && pinged && key === GRANT_KEY && (record?.payload as Record<string, unknown> | undefined)?.refresh === 'rt-only') {
        landed = true
        h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-native', accountId: 'acc-native', email: 'native@example.com' }))
      }
      return record
    }

    const result = await h.service.testKey('anthropic', seeded.rowId)

    assert.equal(landed, true)
    // The native grant survives the cleanup…
    assert.equal(liveProjectionRefresh(h), 'rt-native')
    // …and the owner map follows it, not the tested row.
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.find(row => row.id === native.rowId)!.projected, true)
    assert.notEqual(rows.find(row => row.id === seeded.rowId)!.projected, true)
    // The borrow could not be removed, so the test reports a failure.
    assert.equal(result.ok, false)
    assert.match(String(result.error), /changed during the test/)
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// PR review round 13: the borrow write is a compare-and-swap against the
// record the pre-borrow read captured. A native or manager sign-in that
// commits a newer projection between that read and the write used to be
// overwritten by the borrow — and the window's cleanup then restored the
// stale pre-borrow payload, dropping the sign-in for good.

test('a native sign-in landing before the borrow write is not overwritten', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let armed = false
  let landed = false
  let calls = 0
  try {
    await drainGrantChain(h, 'anthropic')
    await new Promise(resolve => setTimeout(resolve, 0))
    armed = true
    h.llm.stream = (options: Record<string, any>) => {
      calls += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }
    // The pre-borrow read returns the user's projection, then the native
    // sign-in commits a new grant before the borrow's write runs.
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      const record = await realRead(key)
      if (armed && !landed && key === GRANT_KEY) {
        landed = true
        h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-native', accountId: 'acc-native', email: 'native@example.com' }))
      }
      return record
    }

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(landed, true, 'the native sign-in landed inside the borrow window')
    assert.equal(result.ok, false)
    // The borrow refused instead of overwriting the newer projection…
    assert.match(String(result.error), /changed while the test was starting/)
    // …so the native grant survives and nothing was sent for the tested row.
    assert.equal(liveProjectionRefresh(h), 'rt-native')
    assert.equal(calls, 0)
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.notEqual(rows.find(row => row.id === first.rowId)!.projected, true)
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// PR review round 14: the CAS above compared against the pre-borrow record by
// reference, so a writer that mutated that stored object in place made
// `current` and `previous` serialise identically and the borrow passed. The
// snapshot and its comparison key are frozen at capture instead.

test('an in-place mutation of the captured projection refuses the borrow', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let armed = false
  let mutated = false
  let calls = 0
  try {
    await drainGrantChain(h, 'anthropic')
    await new Promise(resolve => setTimeout(resolve, 0))
    armed = true
    h.llm.stream = (options: Record<string, any>) => {
      calls += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }
    // The stored projection object is mutated in place — same identity in the
    // records map — after the pre-borrow read resolved and before the borrow's
    // updater runs.
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (armed && !mutated && key === GRANT_KEY) {
        mutated = true
        const stored = h.credentials.records.get(GRANT_KEY)!
        ;(stored.payload as Record<string, unknown>).refresh = 'rt-mutated'
      }
      return realModify(key, mutate)
    }

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(mutated, true, 'the in-place mutation landed inside the borrow window')
    assert.equal(result.ok, false)
    // The borrow refused instead of treating the mutated record as unchanged…
    assert.match(String(result.error), /changed while the test was starting/)
    // …the mutated payload stays, and nothing was borrowed or sent.
    assert.equal(liveProjectionRefresh(h), 'rt-mutated')
    assert.equal(calls, 0)
    const borrows = (h.service as unknown as { testBindingBorrows: Set<string> }).testBindingBorrows
    assert.equal(borrows.has('anthropic'), false, 'the refused borrow left its marker behind')
  } finally {
    h.credentials.raw.modifyRecord = realModify
    await h.close()
  }
})

test('an aborted finish fails the row test and a length-limited finish passes it', async () => {
  // PR review SF3: only a real completion ends the probe as a pass. The ping
  // asks for one token, so `length` is the expected completion; `aborted`
  // means the provider stopped the request, not that it answered.
  const { h, first } = await harnessWithTwoProjectedAccounts()
  try {
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      yield { type: 'finish', reason: { kind: 'aborted' } }
    } as any)
    const aborted = await h.service.testKey('anthropic', first.rowId)
    assert.equal(aborted.ok, false)
    assert.match(String(aborted.error), /aborted/)

    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      yield { type: 'finish', reason: { kind: 'length' } }
    } as any)
    const limited = await h.service.testKey('anthropic', first.rowId)
    assert.equal(limited.ok, true)
    assert.equal(liveProjectionRefresh(h), 'rt-second')
  } finally {
    await h.close()
  }
})

// A row test borrows a projection for its provider. These cases pin the
// isolation and the compare-by-payload restoration: an ordinary request must
// not be served by (or attributed to) the borrowed grant, a rotation the ping
// caused must reach the tested row, a foreign payload must survive, and a
// restoration that did not land must fail the test.

/**
 * Two seeded anthropic accounts with the second one projected — the setup
 * every OAuth-row test case needs: an account to test and a user projection
 * to restore.
 */
async function harnessWithTwoProjectedAccounts() {
  const h = await harness()
  h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
  await h.service.adoptProvider('anthropic')
  const first = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
  const second = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-second', email: 'second@example.com', refresh: 'rt-second' })
  h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-second', accountId: 'acc-second', email: 'second@example.com' }))
  await h.service.activateAccount('anthropic', second.rowId)
  return { h, first, second }
}

// C1: a route served by a projected OAuth account resolves the account's
// stored grant. The adapter only hands pi-ai an `apiKey` override when the
// profile names an `apiKeyEnv`, and Task 1 deliberately unsets that reference
// while a projection is live, so the test scope's pinned literal is never
// consulted: an api-key row test here would report a pass for a key the
// request did not carry. The row is refused with the serving source instead,
// without a request and without borrowing or deleting the projection.
test('an api-key test is refused while the oauth account serves the route', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-first', accountId: 'acc-first', email: 'first@example.com' }))
    await h.service.activateAccount('anthropic', account.rowId)
    const keyRow = h.store.provider('anthropic')!.keys.find(row => row.kind === 'api-key')!
    let calls = 0
    // A route that answers successfully: on the pre-fix path this yielded a
    // false pass for a key the request never carried.
    h.llm.stream = (options: Record<string, any>) => {
      calls += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    const result = await h.service.testKey('anthropic', keyRow.id)

    assert.equal(result.ok, false)
    assert.equal(result.latencyMs, 0)
    // The refusal names the credential actually serving the route.
    assert.match(String(result.error), /served by its OAuth account/)
    assert.match(String(result.error), /API key pool is not in use/)
    // No request was sent for a key this route cannot carry…
    assert.equal(calls, 0)
    // …and the account's projection is untouched (no borrow, no delete).
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-first')
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.find(row => row.id === account.rowId)!.projected, true)
    assert.notEqual(rows.find(row => row.id === keyRow.id)!.projected, true)
    assert.equal(h.store.provider('anthropic')!.keys.find(row => row.id === keyRow.id)!.totalUses, 0)
  } finally {
    await h.close()
  }
})

// The refusal above is about the serving source, not the row: once the
// account is demoted the profile is bound to the pool again, so the very same
// api-key row is testable and carries its own literal.
test('an api-key test works again after the projection is demoted', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-first', accountId: 'acc-first', email: 'first@example.com' }))
    await h.service.activateAccount('anthropic', account.rowId)
    const provider = h.store.provider('anthropic')!
    const keyRow = provider.keys.find(row => row.kind === 'api-key')!
    const literal = h.credentials.refs.get(keyRow.ref)!
    await h.service.fallbackToKeys('anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      resolved.push((await h.credentials.raw.resolve(provider.brokerRef))?.value)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', keyRow.id)

    assert.equal(result.ok, true)
    assert.deepEqual(resolved, [literal])
  } finally {
    await h.close()
  }
})

test('an oauth test keeps the borrowed projection away from ordinary requests', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  try {
    const provider = h.store.provider('anthropic')!
    let releaseTest!: () => void
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let enterTest!: () => void
    const testEntered = new Promise<void>(resolve => { enterTest = resolve })
    const projections: Array<string | undefined> = []
    const ordinaryStarted: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const projection = h.credentials.records.get(GRANT_KEY)
      const refresh = (projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined
      if (options.maxTokens === 1) {
        projections.push(refresh)
        enterTest()
        await testGate
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      ordinaryStarted.push(refresh)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const testRun = h.service.testKey('anthropic', first.rowId)
    await testEntered
    // The test window is open: the borrowed grant is the live projection.
    assert.deepEqual(projections, ['rt-first'])

    const ordinary = h.llm.stream({
      provider: 'anthropic',
      model: 'claude-test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 64,
    })
    const iterator = ordinary[Symbol.asyncIterator]()
    const ordinaryNext = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 20))
    // The ordinary request waits for the test; it is not served by the
    // borrowed grant.
    assert.deepEqual(ordinaryStarted, [])
    assert.deepEqual(projections, ['rt-first'])

    releaseTest()
    assert.equal((await testRun).ok, true)
    await ordinaryNext
    // After the restore it runs on the user's own projection…
    assert.deepEqual(ordinaryStarted, ['rt-second'])
    // …and its outcome is not attributed to the tested account.
    const rows = h.store.provider('anthropic')!.keys
    assert.equal(rows.find(row => row.id === first.rowId)!.totalUses, 0)
    assert.equal(rows.find(row => row.id === second.rowId)!.totalUses, 1)
    assert.ok(provider.keys.find(row => row.id === second.rowId)!.lastUsedAt > 0)
  } finally {
    await h.close()
  }
})

test('a rotation during an oauth test is written back before the projection is restored', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  try {
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        // pi-ai refreshes the borrowed grant during the ping and commits the
        // rotated payload to the projection.
        h.credentials.records.set(GRANT_KEY, grantPayload({
          refresh: 'rt-first-rotated',
          access: 'at-rotated',
          accountId: 'acc-first',
          email: 'first@example.com',
        }))
        h.emitEvent('credentials/record-updated', GRANT_KEY)
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, true)
    // The rotation reached the tested row before the previous projection
    // returned: its grant reference follows the rotated payload…
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-first-rotated').digest('hex').slice(0, 12))
    const row = h.store.provider('anthropic')!.keys.find(candidate => candidate.id === first.rowId)!
    assert.equal(row.oauth!.grantRef, rotatedRef)
    const stored = h.credentials.records.get(rotatedRef)!
    assert.equal(stored.kind, 'grant')
    assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-first-rotated')
    // …the superseded pre-test generation is gone…
    assert.equal(h.credentials.records.has(first.grantRef), false)
    // …and the user's projection is back on their account.
    const restored = h.credentials.records.get(GRANT_KEY)!
    assert.equal((restored.payload as Record<string, unknown>).refresh, 'rt-second')
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.find(candidate => candidate.id === second.rowId)!.projected, true)
    assert.notEqual(rows.find(candidate => candidate.id === first.rowId)!.projected, true)
  } finally {
    await h.close()
  }
})

test('a foreign projection written during the test window is not overwritten', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  try {
    const other = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-other', email: 'other@example.com', refresh: 'rt-other' })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        // A native writer (another sign-in) replaces the projection while the
        // test request runs.
        h.credentials.records.set(GRANT_KEY, grantPayload({
          refresh: 'rt-other',
          access: 'at-other',
          accountId: 'acc-other',
          email: 'other@example.com',
        }))
        h.emitEvent('credentials/record-updated', GRANT_KEY)
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, true)
    // The foreign payload survives untouched…
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal(live.kind, 'grant')
    assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-other')
    // …and the owner follows what is actually stored.
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.find(candidate => candidate.id === other.rowId)!.projected, true)
    assert.notEqual(rows.find(candidate => candidate.id === first.rowId)!.projected, true)
  } finally {
    await h.close()
  }
})

test('an externally removed projection is not resurrected by an oauth test', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  try {
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        // The projection is removed during the ping by a writer outside the
        // provider's grant chain (a release, a native sign-out); the seam
        // broadcasts the post-commit removal like any other record write.
        await h.credentials.raw.deleteRecord(GRANT_KEY)
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, true)
    // The removal stands: the pre-test projection is not written back.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    // No row is projected any more — the owner map follows the empty store.
    const rows = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.filter(candidate => candidate.projected === true).length, 0)
  } finally {
    await h.close()
  }
})

test('a failed restore fails the test and keeps the owner on the live grant', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  try {
    let failFirstRestore = true
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1 && failFirstRestore) {
        // The projection write that puts the pre-test payload back fails.
        failFirstRestore = false
        h.credentials.raw.failModifyRecord = true
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, false)
    assert.match(String(result.error), /could not be restored/)
    // The store still holds the borrowed grant: the owner must name that row,
    // not the pre-test account.
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-first')
    const state = h.service.getState()
    const rows = state.providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(rows.find(candidate => candidate.id === first.rowId)!.projected, true)
    assert.notEqual(rows.find(candidate => candidate.id === second.rowId)!.projected, true)
    assert.ok(state.warnings.some(warning => /could not be restored/.test(warning)))

    // PR review MF1: a cleanup that failed on the normal path must leave the
    // provider fenced and isolated exactly as an abandoned window does. The
    // borrow marker is still set, so serving this route would use the tested
    // account's credential.
    await assert.rejects(
      () => consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 })),
      /still being cleaned up/,
    )
    // A second test is refused too, instead of borrowing the unreconciled
    // route again.
    const refused = await h.service.testKey('anthropic', second.rowId)
    assert.equal(refused.ok, false)
    assert.match(String(refused.error), /still being cleaned up/)

    // Once the seam answers again, the recovery the fence relies on
    // converges: the pre-test projection is back and the route serves again.
    h.credentials.raw.failModifyRecord = false
    const retried = await h.service.testKey('anthropic', first.rowId)
    assert.equal(retried.ok, true)
    assert.equal(liveProjectionRefresh(h), 'rt-second')
    const converged = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(converged.find(candidate => candidate.id === second.rowId)!.projected, true)
    assert.notEqual(converged.find(candidate => candidate.id === first.rowId)!.projected, true)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
  } finally {
    h.credentials.raw.failModifyRecord = false
    await h.close()
  }
})

// QC fix wave — the row test must prove the route actually serves the tested
// credential (B1), never revert a rotation of the serving account (B2), keep
// its isolation bounded (B3) and invisible to the binding authority (B4),
// defer the provider stream on both isolation branches (B5), and refuse while
// account ownership is still loading (B6).

test('an oauth row test borrows a broker-bound route and restores the binding', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const record = h.store.provider('anthropic')!
    // The key pool serves the route: adoption bound the profile to the broker.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    const seen: Array<{ apiKeyEnv: string | undefined; projection: string | undefined }> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const profile = h.settings.valueOf('llm-pi-ai').providers['anthropic'] as Record<string, any>
      const projection = h.credentials.records.get(GRANT_KEY)
      seen.push({
        apiKeyEnv: profile.apiKeyEnv as string | undefined,
        projection: (projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined,
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', account.rowId)

    assert.equal(result.ok, true)
    // The request ran on the account grant, not on the broker reference…
    assert.deepEqual(seen, [{ apiKeyEnv: undefined, projection: 'rt-only' }])
    // …and the binding the route had before the test is back.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
    const view = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(view.bindingHealthy, true)

    // An ordinary request after the test still resolves the pool key.
    const keyRow = record.keys.find(candidate => candidate.kind === 'api-key')!
    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      resolved.push((await h.credentials.raw.resolve(record.brokerRef))?.value)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.deepEqual(resolved, [h.credentials.refs.get(keyRow.ref)])
  } finally {
    await h.close()
  }
})

test('an api-key test is refused on a mismatch route', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    // The user took the profile back in Models: a reference Keys Manager never
    // wrote. pi-ai resolves it before the pinned literal, so a test here could
    // report a pass for a key the request never carried.
    h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv = 'ANTHROPIC_AUTH_TOKEN'
    const keyRow = h.store.provider('anthropic')!.keys.find(candidate => candidate.kind === 'api-key')!
    let calls = 0
    // A route that answers successfully: on the pre-fix path this yielded a
    // false pass for a key the request never carried.
    h.llm.stream = (options: Record<string, any>) => {
      calls += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    const result = await h.service.testKey('anthropic', keyRow.id)

    assert.equal(result.ok, false)
    assert.equal(result.latencyMs, 0)
    // The refusal names the credential reference that actually serves the route.
    assert.match(String(result.error), /ANTHROPIC_AUTH_TOKEN/)
    assert.equal(calls, 0)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, 'ANTHROPIC_AUTH_TOKEN')

    // The mismatch is about the serving source, not the row: an OAuth row is
    // refused with the same named source (and without borrowing anything).
    const accountResult = await h.service.testKey('anthropic', account.rowId)
    assert.equal(accountResult.ok, false)
    assert.match(String(accountResult.error), /ANTHROPIC_AUTH_TOKEN/)
    assert.equal(calls, 0)
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    // The same route with no managed binding at all: no `apiKeyEnv` override
    // means pi-ai reads its own stored credential, so the pinned literal never
    // reaches the request either.
    delete h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv
    const unbound = await h.service.testKey('anthropic', keyRow.id)
    assert.equal(unbound.ok, false)
    assert.equal(calls, 0)
  } finally {
    await h.close()
  }
})

test('a rotation of the serving account during its own test survives', async () => {
  const { h, rowId, grantRef } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'].models = [{ id: 'claude-test-model' }]
    // The tested row IS the route's projection: the case restoring the
    // pre-test payload would revert.
    await h.service.activateAccount('anthropic', rowId)
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-serving-rotated').digest('hex').slice(0, 12))
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        h.credentials.records.set(GRANT_KEY, grantPayload({
          refresh: 'rt-serving-rotated',
          access: 'at-rotated',
          accountId: 'acc-9',
          email: 'dev@example.com',
        }))
        h.emitEvent('credentials/record-updated', GRANT_KEY)
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const result = await h.service.testKey('anthropic', rowId)

    assert.equal(result.ok, true)
    // The queued echoes run after the test body; the account must end on the
    // rotated generation either way.
    await eventually(() => {
      const row = h.store.provider('anthropic')!.keys.find(candidate => candidate.id === rowId)!
      assert.equal(row.oauth!.grantRef, rotatedRef)
      const stored = h.credentials.records.get(rotatedRef)!
      assert.equal(stored.kind, 'grant')
      assert.equal((stored.payload as Record<string, unknown>).refresh, 'rt-serving-rotated')
      // The superseded generation is gone and the projection is the rotation.
      assert.equal(h.credentials.records.has(grantRef), false)
      const live = h.credentials.records.get(GRANT_KEY)!
      assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-serving-rotated')
    })
  } finally {
    await h.close()
  }
})

test('a stalled credential read in an oauth test does not park ordinary requests past the isolation deadline', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let testRun: Promise<KeyTestResult> | undefined
  let releaseRead: (() => void) | undefined
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    const provider = h.store.provider('anthropic')!
    const row = provider.keys.find(candidate => candidate.id === first.rowId)!
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    let stalled = false
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === row.oauth!.grantRef && !stalled) {
        stalled = true
        await readGate
      }
      return realRead(key)
    }
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 40
    const ordinaryStarted: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const projection = h.credentials.records.get(GRANT_KEY)
      ordinaryStarted.push((projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    testRun = h.service.testKey('anthropic', first.rowId)
    await eventually(() => assert.equal(stalled, true))
    // The test is parked on an untimed credential read; the ordinary request
    // must resume after the bounded wait instead of waiting for it.
    const resumed = await Promise.race([
      consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 })).then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500)),
    ])
    assert.equal(resumed, true, 'the ordinary request resumed after the bounded wait')
    // The borrow never landed: the request ran on the user's own projection.
    assert.deepEqual(ordinaryStarted, ['rt-second'])
  } finally {
    h.credentials.raw.readRecord = realRead
    releaseRead?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

test('an addKey during an oauth test window does not persist an unbind', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    const record = h.store.provider('anthropic')!
    let releaseTest!: () => void
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let enterTest!: () => void
    const testEntered = new Promise<void>(resolve => { enterTest = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        enterTest()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const testRun = h.service.testKey('anthropic', account.rowId)
    await testEntered
    // A mutation landing inside the borrowed window must not persist a binding
    // decision derived from the borrowed world.
    await h.service.addKey('anthropic', 'during-test', 'sk-during-test')
    releaseTest()
    assert.equal((await testRun).ok, true)
    // The restored state re-syncs at window end: the pool serves again, so the
    // profile is bound to the broker exactly as before the test.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)
    const view = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(view.bindingHealthy, true)
  } finally {
    await h.close()
  }
})

test('a mismatch route builds its provider stream only when the request starts', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    // The user took the profile back: `mismatch` is the isolation branch whose
    // stream used to be constructed before the wait.
    h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv = 'ANTHROPIC_AUTH_TOKEN'
    assert.equal(h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, false)

    let opened = 0
    const open = (): AsyncIterable<unknown> => {
      opened += 1
      return {
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined } },
        }),
      }
    }
    const stream = h.service.streamListener(
      { provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 8 } as any,
      open as any,
    )
    // Construction is deferred until the wrapper's first pull.
    assert.equal(opened, 0)
    for await (const _chunk of stream) {
      // drain
    }
    assert.equal(opened, 1)

    // A consumer that never starts must not construct (or leak) the provider
    // stream at all.
    let abandoned = 0
    const cancelled = h.service.streamListener(
      { provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 8 } as any,
      (() => {
        abandoned += 1
        return {
          [Symbol.asyncIterator]: () => ({
            async next(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined } },
          }),
        }
      }) as any,
    )
    await cancelled[Symbol.asyncIterator]().return?.()
    assert.equal(abandoned, 0)
  } finally {
    await h.close()
  }
})

test('an oauth test refuses while account ownership is still loading', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'].models = [{ id: 'claude-test-model' }]
    // The ownership hydration read is the slow one: the test must not decide a
    // serving source from an ownership map that has not landed yet.
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) {
        await new Promise(resolve => setTimeout(resolve, 60))
        return undefined
      }
      return realRead(key)
    }
    let calls = 0
    h.llm.stream = () => {
      calls += 1
      return (async function* () {})()
    }
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    ;(restarted as unknown as { hydrationWaitMs: number }).hydrationWaitMs = 10

    const result = await restarted.testKey('anthropic', rowId)

    assert.equal(result.ok, false)
    assert.equal(result.latencyMs, 0)
    assert.match(String(result.error), /ownership is still loading/)
    assert.equal(calls, 0)
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

test('an unreadable settings snapshot is distinguished from a missing model', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    h.settings.failDescribe = true
    let calls = 0
    h.llm.stream = () => {
      calls += 1
      return (async function* () {})()
    }
    const result = await h.service.testKey('zai-coding-cn', target.id)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /settings could not be read/)
    assert.doesNotMatch(String(result.error), /No model is configured/)
    assert.equal(calls, 0)
  } finally {
    h.settings.failDescribe = false
    await h.close()
  }
})

// QC fix wave 2 (B3 follow-up): the watchdog released the provider's slot
// without putting back what the abandoned test had borrowed, so ordinary
// traffic resumed against the tested account's grant. These four cases pin the
// abandon-safe window: the cleanup, the isolation ordering, the fence and the
// late settlement.

/** The refresh token the live anthropic projection carries, if any. */
function liveProjectionRefresh(h: Harness): string | undefined {
  const record = h.credentials.records.get(GRANT_KEY)
  return (record?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined
}

test('an abandoned oauth test does not leave the borrowed grant serving ordinary requests', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    const ordinaryStarted: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const projection = h.credentials.records.get(GRANT_KEY)
      const refresh = (projection?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined
      if (options.maxTokens === 1) {
        testEntered()
        // The test request itself never settles: the seam offers no
        // cancellation, so the watchdog is the only thing that ends the window.
        await testGate
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      ordinaryStarted.push(refresh)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // The window is open: the tested account's grant IS the live projection.
    assert.equal(liveProjectionRefresh(h), 'rt-first')
    // The abandoned window puts the borrowed projection back on its own…
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-second'))
    // …so the ordinary request is served by the user's account, never by the
    // credential the abandoned test borrowed.
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.deepEqual(ordinaryStarted, ['rt-second'])
  } finally {
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

test('an abandoned oauth test restores the binding it released', async () => {
  const h = await harness()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const record = h.store.provider('anthropic')!
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
    // The key pool serves this route, so an oauth row test releases the broker
    // reference for its window (QC B1).
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)

    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30

    testRun = h.service.testKey('anthropic', account.rowId)
    await entered
    // The window released the binding and borrowed the account's grant.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, undefined)
    assert.equal(liveProjectionRefresh(h), 'rt-first')
    // The abandoned window must hand the route back exactly as it found it.
    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef))
    assert.equal(liveProjectionRefresh(h), undefined)
  } finally {
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

// PR review round 13: an OAuth adapter that ignores the abort can refresh the
// borrowed grant AFTER the watchdog's cleanup already restored the user's
// projection and released the provider. The abandoned window then skipped its
// cleanup when the request finally settled, leaving the tested account
// projected and serving ordinary traffic. The settlement now reconciles the
// late write: the newer generation is written back to the tested row and the
// route is projected back to what the test found.

test('an abandoned test reconciles the projection its late request rewrote', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    const ordinaryStarted: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
        // The adapter ignored the abort and rewrote the borrowed projection
        // past the cleanup that already put the user's projection back.
        await h.credentials.raw.modifyRecord(GRANT_KEY, () => Promise.resolve(grantPayload({
          refresh: 'rt-first-refreshed',
          access: 'at-refreshed',
          accountId: 'acc-first',
          email: 'first@example.com',
        })))
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      ordinaryStarted.push(liveProjectionRefresh(h))
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // The watchdog already restored the user's projection before the late
    // write, so the late write is what puts the tested grant in service.
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-second'))
    releaseTest?.()
    const result = await testRun!

    // The settlement reconciles the late write away from the tested account…
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-second'))
    // …without losing the newer generation: it was written back to the row.
    const row = h.store.provider('anthropic')!.keys.find(key => key.id === first.rowId)!
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-first-refreshed').digest('hex').slice(0, 12))
    assert.equal(row.oauth!.grantRef, rotatedRef)
    assert.ok(h.credentials.records.has(rotatedRef))
    // Ordinary traffic is served by the user's account, never by the account
    // the abandoned test borrowed.
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.deepEqual(ordinaryStarted, ['rt-second'])
    // The wedged request never reports the pass it eventually produced.
    assert.equal(result.ok, false)
    assert.match(String(result.error), /abandoned/)
  } finally {
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

test('a new test is refused while a previous window is being cleaned up', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let stallCleanup = false
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // From here the cleanup cannot read the projection at all: it needs the
    // same untimed seam the wedged test is parked in.
    stallCleanup = true
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (stallCleanup && key === GRANT_KEY) await new Promise<never>(() => {})
      return realRead(key)
    }
    await new Promise(resolve => setTimeout(resolve, 300))

    // The provider is still fenced: the aborted window never got its
    // projection back, so a second test must not borrow the route.
    const refusal = await Promise.race([
      h.service.testKey('anthropic', second.rowId),
      new Promise<KeyTestResult>(resolve => setTimeout(() => resolve({ ok: true, latencyMs: 0, error: 'the second test was not refused' }), 300)),
    ])
    assert.equal(refusal.ok, false)
    assert.match(String(refusal.error), /still being cleaned up/)

    // Ordinary traffic is refused too: the borrowed grant may still be live,
    // so waiting a bounded time and then serving the request would cross-use
    // the tested account's credential.
    await assert.rejects(
      () => consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 })),
      /still being cleaned up/,
    )
  } finally {
    stallCleanup = false
    h.credentials.raw.readRecord = realRead
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

// QC fix wave 3 (W-001, W-002, S-004, S-003): the abandon window must not call
// itself clean while the borrow it recorded is still in flight, the fence must
// be able to clear itself from a later attempt, an already-known fence must not
// put the isolation deadline on the refusal path, and the window-end binding
// sync must run even when the test did not release the binding.

test('an abandoned test whose borrow write lands after the deadline keeps the provider isolated', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let releaseBorrow: (() => void) | undefined
  let releaseLanding: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let borrowStalled = false
  try {
    const borrowGate = new Promise<void>(resolve => { releaseBorrow = resolve })
    const landingGate = new Promise<void>(resolve => { releaseLanding = resolve })
    // The borrow write is parked BEFORE it lands, then held AFTER it landed and
    // before its promise resolves: the projection carries the tested account's
    // grant while the test's own continuation has not run yet.
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY && !borrowStalled) {
        borrowStalled = true
        await borrowGate
        const landed = await realModify(key, mutate)
        await landingGate
        return landed
      }
      return realModify(key, mutate)
    }
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    const ordinaryStarted: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const refresh = liveProjectionRefresh(h)
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      ordinaryStarted.push(refresh)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50

    testRun = h.service.testKey('anthropic', first.rowId)
    await eventually(() => assert.equal(borrowStalled, true))
    // The watchdog fired and the cleanup deadline passed while the borrow write
    // was still parked: a re-read can only see the pre-borrow payload, which
    // looks exactly like a foreign projection.
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(liveProjectionRefresh(h), 'rt-second')
    // The provider is its own until the borrow is reconciled: an ordinary
    // request may not be served from a route whose borrow has not landed.
    await assert.rejects(
      () => consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 })),
      /still being cleaned up/,
    )
    // Now the write lands. Its payload IS the tested account's grant until a
    // cleanup succeeds, so ordinary traffic must still not reach it.
    releaseBorrow?.()
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-first'))
    await assert.rejects(
      () => consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 })),
      /still being cleaned up/,
    )
    assert.deepEqual(ordinaryStarted, [])
    // The late settlement retries the cleanup, and only then does the route
    // serve the user's account again.
    releaseLanding?.()
    releaseTest?.()
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-second'))
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.deepEqual(ordinaryStarted, ['rt-second'])
  } finally {
    releaseBorrow?.()
    releaseLanding?.()
    releaseTest?.()
    h.credentials.raw.modifyRecord = realModify
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Transport accounts (`llm-omp-transports/<route>`)
 *
 * The transports package owns the record, the flow and the adapter that reads
 * it. Keys Manager lists/activates/removes the account beside the pi-ai pool
 * and must never route it through that pool: no `llm-pi-ai/<route>` record and
 * no `providers.<route>` profile may appear from any of these actions.
 * ------------------------------------------------------------------------- */

/** The flow the llm-omp-transports package registers for its cursor route. */
const TRANSPORT_FLOW = {
  key: 'llm-omp-transports/cursor',
  label: 'Cursor',
  methods: [{ id: 'oauth', label: 'Sign in with Cursor' }],
}

const CURSOR_SCOPE = 'llm-omp-transports/cursor'

/** The grant payload the transports package writes for the cursor route. */
function cursorGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access: 'cursor-access',
    refresh: 'cursor-refresh',
    expires: Date.now() + 3_600_000,
    email: 'dev@cursor.example',
    accountId: 'user_1',
    ...overrides,
  }
}

function transportHarness(): Promise<Harness> {
  return harness([...piAiFlows(), TRANSPORT_FLOW])
}

/** A transport action may never write into the pi-ai pool. */
function assertNoPiAiProjection(h: Harness): void {
  assert.equal(h.credentials.records.has('llm-pi-ai/cursor'), false)
  assert.equal((h.settings.valueOf('llm-pi-ai') as { providers: Record<string, unknown> }).providers.cursor, undefined)
}

test('lists the cursor transport account from its own grant record', async () => {
  const h = await transportHarness()
  try {
    const payload = cursorGrant()
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload })
    await h.service.refreshTransportAccounts()

    const state = h.service.buildState()
    assert.deepEqual(state.transportAccounts, [{
      id: 'cursor',
      scope: CURSOR_SCOPE,
      displayName: 'Cursor',
      email: 'dev@cursor.example',
      accountId: 'user_1',
      expiresAt: payload.expires,
      status: 'active',
      active: true,
    }])
    // The row is additive beside the pi-ai pool, not part of it.
    assert.equal(state.providers.some(provider => provider.provider === 'cursor'), false)
    // The snapshot never carries the grant payload itself.
    const text = JSON.stringify(state)
    assert.ok(!text.includes('cursor-access'))
    assert.ok(!text.includes('cursor-refresh'))
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

test('a fenced provider is cleaned up by the next test attempt', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let releaseReads: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let stallCleanup = false
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    const readGate = new Promise<void>(resolve => { releaseReads = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    let testCalls = 0
    const logged: string[] = []
    ;(h.ctx.logger as { warn: (message: string) => void }).warn = message => logged.push(String(message))
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testEntered()
          await testGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // From here the cleanup cannot read the projection: the fence can only
    // clear once the seam answers again.
    stallCleanup = true
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (stallCleanup && key === GRANT_KEY) await readGate
      return realRead(key)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    // The wedged test settles while the seam is still stalled, so the retry its
    // settlement triggers fails too: the fence now has nothing left to ride on.
    releaseTest?.()
    await testRun
    // One cleanup deadline past the settlement, so the retry the settlement
    // triggers has failed instead of clearing the fence.
    await new Promise(resolve => setTimeout(resolve, 200))
    // The seam recovers: the parked reads and the echoes queued behind them
    // drain, and only the fence is left to clear.
    stallCleanup = false
    h.credentials.raw.readRecord = realRead
    releaseReads?.()
    await new Promise(resolve => setTimeout(resolve, 100))

    const result = await h.service.testKey('anthropic', second.rowId)

    assert.equal(result.ok, true)
    assert.equal(testCalls, 2)
    // The fence is gone: the route serves ordinary traffic again.
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    // Each failed attempt is reported, not only the first watchdog one.
    assert.ok(logged.some(message => /is still fenced/.test(message)), `no failed-attempt warning in: ${logged.join(' | ')}`)
  } finally {
    stallCleanup = false
    h.credentials.raw.readRecord = realRead
    releaseReads?.()
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

test('ordinary traffic is refused immediately while the fence is known', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let stallCleanup = false
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    stallCleanup = true
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (stallCleanup && key === GRANT_KEY) await new Promise<never>(() => {})
      return realRead(key)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    // The fence is known at entry: the isolation deadline is no longer what a
    // request pays before it is refused, so raise it far past the assertion.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000

    const started = Date.now()
    const outcome = await Promise.race([
      consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
        .then(() => 'served', () => 'refused'),
      new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 500)),
    ])
    const elapsed = Date.now() - started

    assert.equal(outcome, 'refused')
    assert.ok(elapsed < 500, `the refusal took ${elapsed}ms; it waited on the isolation deadline`)
  } finally {
    stallCleanup = false
    h.credentials.raw.readRecord = realRead
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

test('a key added during the window converges the binding at window end', async () => {
  const h = await harness()
  let releaseTest: (() => void) | undefined
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const record = h.store.provider('anthropic')!
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-only', email: 'only@example.com', refresh: 'rt-only' })
    // Dropping the pool's last usable key and projecting nothing leaves the
    // route with no broker reference: this test's window releases no binding.
    const keyRow = record.keys.find(candidate => candidate.kind === 'api-key' && candidate.valueMissing !== true)!
    await h.service.deleteKey('anthropic', keyRow.id)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, undefined)

    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const testRun = h.service.testKey('anthropic', account.rowId)
    await entered
    assert.equal(liveProjectionRefresh(h), 'rt-only')
    // The key add inside the window is skipped by the borrow guard, so the
    // binding decision it implies is only observable at window end.
    await h.service.addKey('anthropic', 'during-test', 'sk-during-test')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, undefined)
    releaseTest?.()
    const result = await testRun

    assert.equal(result.ok, true)
    // The pool serves again once the borrow is restored, so the window-end
    // sync must bind the profile even though the test never released it.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['anthropic'].apiKeyEnv, record.brokerRef)
  } finally {
    releaseTest?.()
    await h.close()
  }
})

test('a transport row reports active, expired, needs-reauth and signed-out', async () => {
  const h = await transportHarness()
  const rowOf = async (): Promise<{ status?: string; active?: boolean }> => {
    await h.service.refreshTransportAccounts()
    return h.service.buildState().transportAccounts?.[0] ?? {}
  }
  const statusOf = async (): Promise<string | undefined> => (await rowOf()).status
  try {
    // A route with a registered flow but no record still gets a row, so the
    // UI can offer the sign-in that writes it.
    assert.equal(await statusOf(), 'signed-out')

    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    const live = await rowOf()
    assert.equal(live.status, 'active')
    assert.equal(live.active, true)

    // Expired but refreshable: the route's adapter renews it on the next
    // request, but the stored grant is not the live credential right now.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant({ expires: Date.now() - 1000 }) })
    const expired = await rowOf()
    assert.equal(expired.status, 'expired')
    assert.equal(expired.active, false)

    // Expired with no refresh token: only a new sign-in restores service.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant({ expires: Date.now() - 1000, refresh: undefined }) })
    assert.equal(await statusOf(), 'needs-reauth')
    assert.equal((await rowOf()).active, false)

    // A record this manager cannot read is not a usable grant either.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: { access: 'cursor-access' } })
    assert.equal(await statusOf(), 'needs-reauth')
    assert.equal((await rowOf()).active, false)

    h.credentials.records.delete(CURSOR_SCOPE)
    assert.equal(await statusOf(), 'signed-out')
    assert.equal((await rowOf()).active, false)
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// PR #26 review round 2 (Codex P1/P2 + must-fix): a projection that goes away
// hands the route back to its API-key pool, and the binding must follow the
// serving source — otherwise pi-ai resolves its own stored credential (a bare
// passthrough) instead of the broker reference the profile names.
//
// The compensated mixed-provider sign-in is the review's must-fix: the aborted
// harvest deletes its projection and restores the owner map, leaving the route
// key-pool-served while its profile stays unbound.

test('a compensated mixed-provider sign-in returns the route to its key pool', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const record = h.store.provider('anthropic')!
    const brokerRef = record.brokerRef
    const keyRow = record.keys.find(candidate => candidate.kind === 'api-key')!
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, brokerRef)

    // One live account already serves this mixed route as its projection.
    const live = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-live', email: 'live@example.com', refresh: 'rt-live' })
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-live', accountId: 'acc-live', email: 'live@example.com' }))
    await h.service.activateAccount('anthropic', live.rowId)
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)

    // A second sign-in commits its grant, then its state flush rejects: the
    // harvest rollback removes the row and this attempt's projection.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-abort',
      access: 'at-abort',
      accountId: 'acc-abort',
      email: 'abort@example.com',
    }))
    const view = await h.service.beginAccountLogin('anthropic')
    ;(h.store as unknown as { flush: () => Promise<void> }).flush = async () => {
      throw new Error('disk full')
    }
    h.emitEvent('authorization/settled', GRANT_KEY, 'authorized')
    h.authorization.pending!.resolve({ status: 'authorized' })
    await eventually(() => assert.equal(h.service.getAccountAttempt(view.id)!.status, 'failed'))
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    // The route serves from its pool again, and the persisted binding says so.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, brokerRef)
    const state = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(state.bindingHealthy, true)

    // An ordinary request now resolves the managed broker reference, not a
    // bare passthrough to pi-ai's own credential.
    const served: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const profile = h.settings.valueOf('llm-pi-ai').providers.anthropic
      served.push((await h.credentials.raw.resolve(profile.apiKeyEnv))?.value)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [] }))
    assert.deepEqual(served, [h.credentials.refs.get(keyRow.ref)])
  } finally {
    await h.close()
  }
})

// PR #26 review round 2 (Codex P1): the settings mount repaired every managed
// provider immediately. A persisted OAuth projection is only recognisable once
// ownership hydration has landed, so a mount landing first read it as
// key-pool-served and bound the route to the broker for the rest of the
// process. Round 3 kept the guard per provider: a key-pool route needs no
// projection read and repairs at once, an OAuth route still waits for its own.

test('a settings mount repairs a key-pool route without waiting for another provider\'s hydration (R3)', async () => {
  const h = await harness()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let releaseHydration: (() => void) | undefined
  let stallHydration = false
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    // A key-pool route whose persisted profile lost its broker binding: the
    // mount repair is what re-binds it.
    await h.service.adoptProvider('zai-coding-cn')
    const poolBrokerRef = h.store.provider('zai-coding-cn')!.brokerRef
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'] = {}
    // A projection-served route whose profile must stay unbound.
    await h.service.adoptProvider('anthropic')
    const projected = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-live', email: 'live@example.com', refresh: 'rt-live' })
    h.credentials.records.set(GRANT_KEY, grantPayload({ refresh: 'rt-live', accountId: 'acc-live', email: 'live@example.com' }))
    await h.service.activateAccount('anthropic', projected.rowId)
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)

    // Restart with the settings service unmounted. Hydration starts at
    // construction and its anthropic read is parked, so the owner map is still
    // empty when the mount lands.
    stallHydration = true
    const hydrationGate = new Promise<void>(resolve => { releaseHydration = resolve })
    h.credentials.raw.readRecord = async (key: string) => {
      if (stallHydration && key === GRANT_KEY) await hydrationGate
      return realRead(key)
    }
    const ctxWithoutSettings = {
      ...(h.ctx as unknown as Record<string, unknown>),
      get: (name: string) => (name === 'settings' ? undefined : (h.ctx as unknown as { get: (key: string) => unknown }).get(name)),
    } as unknown as HostContext
    const restarted = new KeysManagerService(ctxWithoutSettings, h.store)
    restarted.attachSettings(h.settings)
    await new Promise(resolve => setTimeout(resolve, 30))

    assert.equal(
      h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv,
      undefined,
      'the mount bound a projection-served route from an empty owner map',
    )
    // Readiness is per provider (PR review round 3): the key-pool route needs
    // no projection read at all, so it is repaired without waiting for the
    // parked OAuth provider.
    assert.equal(
      h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv,
      poolBrokerRef,
      'the mount delayed a pure key-pool route behind another provider\'s hydration',
    )

    // Hydration lands: the projection-served route stays unbound.
    stallHydration = false
    releaseHydration?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, poolBrokerRef)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)
  } finally {
    stallHydration = false
    releaseHydration?.()
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// PR #26 review round 2 (Codex P1): an attempt that outlived the cleanup
// deadline keeps writing while a later attempt for the same window starts. The
// older attempt used to delete the provider-wide borrow marker (and fence)
// unconditionally, so it could release isolation the newer window owns.

test('a superseded cleanup attempt cannot release the newer window\'s borrow marker', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let stallNextRestore = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (stallNextRestore && key === GRANT_KEY) {
        // Park the FIRST cleanup's restore write, and only that one: the
        // superseded attempt must still be running when the newer window owns
        // the route.
        stallNextRestore = false
        attemptOneParked()
        await attemptOneGate
      }
      return realModify(key, mutate)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50

    testOne = h.service.testKey('anthropic', first.rowId)
    await enteredOne
    // The window is abandoned by the watchdog; its cleanup parks in the
    // restore write and outlives the cleanup deadline, so the fence stays.
    stallNextRestore = true
    await attemptOneReached
    await new Promise(resolve => setTimeout(resolve, 150))

    // The wedged test settles: its body leaves the provider's grant chain and
    // the fence alone still isolates the route.
    releaseTestOne?.()
    await testOne
    // The next test attempt runs a second cleanup, which completes and hands
    // the provider to a fresh window. That window borrows the route and is
    // held open deliberately, so the isolation deadline is lifted for it.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', second.rowId)
    await enteredTwo
    const borrows = (h.service as unknown as { testBindingBorrows: Set<string> }).testBindingBorrows
    assert.equal(borrows.has('anthropic'), true, 'the newer window owns the borrow marker')

    // The superseded attempt resumes now and must not release it.
    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(borrows.has('anthropic'), true, 'a superseded cleanup released the newer window\'s borrow marker')

    releaseTestTwo?.()
    const outcome = await testTwo
    assert.equal(outcome.ok, true)
  } finally {
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.modifyRecord = realModify
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// PR #26 review round 2 (Codex P1): adoption recorded the provider as managed
// and imported its credential BEFORE the binding write. A refused write left
// that managed record and its plugin-scope copy behind, and every later repair
// (no takeover) read the pre-adoption reference as a hand edit.

test('a refused adoption binding write rolls the adoption back entirely', async () => {
  const h = await harness()
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    const before = structuredClone(h.settings.valueOf('llm-pi-ai').providers.anthropic)
    h.settings.failMutate = true

    await assert.rejects(() => h.service.adoptProvider('anthropic'), /adoption was rolled back|refused the credential binding/i)

    // No managed provider, no broker owner…
    assert.equal(h.store.provider('anthropic'), undefined)
    assert.equal(h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.managed, false)
    // …no plugin-scope copy of the imported credential…
    assert.deepEqual([...h.credentials.refs.keys()].filter(ref => ref.startsWith('KEYSMGR_')), [])
    // …and the pre-adoption profile is exactly as it was.
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers.anthropic, before)
    // The source credential was only read, never consumed.
    assert.equal(h.credentials.refs.get('ANTHROPIC_AUTH_TOKEN'), 'oauth-auth-token')
  } finally {
    h.settings.failMutate = false
    await h.close()
  }
})

// PR #26 review round 3, must-fix: a cleanup attempt that outlived its deadline
// keeps running after a newer window took the provider over. Both windows test
// the SAME account, so the superseded attempt's compare-by-payload still
// matches the newer window's borrow and its restore rewrites the projection
// (and the owner) out from under that window.

test('a superseded cleanup cannot rewrite the newer window\'s projection or owner', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let stallNextRestore = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (stallNextRestore && key === GRANT_KEY) {
        // Park the FIRST cleanup's restore write, and only that one: the
        // superseded attempt must still be running when the newer window owns
        // the route.
        stallNextRestore = false
        attemptOneParked()
        await attemptOneGate
      }
      return realModify(key, mutate)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    testOne = h.service.testKey('anthropic', first.rowId)
    await enteredOne
    // The watchdog abandons the window; its cleanup parks in the restore write
    // and outlives the cleanup deadline.
    stallNextRestore = true
    await attemptOneReached
    await new Promise(resolve => setTimeout(resolve, 150))

    releaseTestOne?.()
    await testOne
    await new Promise(resolve => setTimeout(resolve, 50))
    // The next attempt cleans the abandoned window up and hands the provider
    // to a second window on the SAME account, held open deliberately.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', first.rowId)
    await enteredTwo
    assert.equal(liveProjectionRefresh(h), 'rt-first', 'the newer window borrowed its grant')
    assert.deepEqual(projectedRows(), [first.rowId], 'the newer window owns the route')

    // The superseded attempt resumes inside the newer window.
    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(liveProjectionRefresh(h), 'rt-first', 'a superseded cleanup rewrote the newer window\'s projection')
    assert.deepEqual(projectedRows(), [first.rowId], 'a superseded cleanup rewrote the newer window\'s owner')

    releaseTestTwo?.()
    const outcome = await testTwo
    assert.equal(outcome.ok, true)
    // The second window restored what it found: the user's own projection.
    assert.equal(liveProjectionRefresh(h), 'rt-second')
  } finally {
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.modifyRecord = realModify
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// PR #26 review round 6, must-fix: the rotation write-back is an await inside
// the cleanup. A cleanup parked in it can outlive its deadline while a newer
// window borrows ANOTHER account; when it resumes, its compare-by-payload
// still matches its own rotation, so the unfenced owner reconcile claims the
// tested row back over the newer window's borrow.

test('a superseded rotation write-back cannot claim the owner for its own row', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  const rotatedRefresh = 'rt-second-rotated'
  const rotatedRef = accountRef('anthropic', createHash('sha256').update(rotatedRefresh).digest('hex').slice(0, 12))
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  const logged: string[] = []
  h.ctx.logger.warn = (message: string) => { logged.push(String(message)) }
  let stallRotationWriteBack = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (stallRotationWriteBack && key === rotatedRef) {
        // Park the FIRST cleanup's rotation write-back only: the superseded
        // attempt must still be running when the newer window owns the route.
        stallRotationWriteBack = false
        attemptOneParked()
        await attemptOneGate
      }
      return realModify(key, mutate)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          // The serving account's own generation rotates during its window,
          // so its restore takes the rotation write-back branch.
          h.credentials.records.set(GRANT_KEY, grantPayload({
            refresh: rotatedRefresh,
            access: 'at-rotated',
            accountId: 'acc-second',
            email: 'second@example.com',
          }))
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 500
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    testOne = h.service.testKey('anthropic', second.rowId)
    await enteredOne
    // The watchdog abandons the window; its cleanup sees the rotation of the
    // tested row and parks in the rotation write-back.
    stallRotationWriteBack = true
    await attemptOneReached
    // The wedged request still holds the provider's grant chain; let it settle
    // so the next test can enter (the parked cleanup is not on that chain).
    releaseTestOne?.()
    await testOne
    // A later test attempt cleans the abandoned window up and hands the
    // provider to a second window on the OTHER account, held open deliberately
    // (lift the isolation deadline so that window is not abandoned too).
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', first.rowId)
    await enteredTwo
    assert.equal(liveProjectionRefresh(h), 'rt-first', 'the newer window borrowed the other account')
    assert.deepEqual(projectedRows(), [first.rowId], 'the newer window owns the route')

    // The superseded attempt resumes: its write-back completes, but it may not
    // reconcile or claim the owner away from the newer window. Its takeover
    // report is the signal that it has finished writing.
    releaseAttemptOne?.()
    await eventually(() => assert.ok(logged.some(message => /took over/.test(message)),
      'the superseded cleanup did not report the takeover'))
    assert.deepEqual(projectedRows(), [first.rowId],
      'a superseded rotation write-back claimed the owner for its own row')

    releaseTestTwo?.()
    const outcome = await testTwo
    assert.equal(outcome.ok, true)
    // The second window restored what it found: the rotated generation.
    assert.equal(liveProjectionRefresh(h), rotatedRefresh)
    assert.deepEqual(projectedRows(), [second.rowId])
  } finally {
    stallRotationWriteBack = false
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.modifyRecord = realModify
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// PR #26 review round 7, must-fix: the rotation write-back can also REJECT
// after the attempt outlived its deadline. Its failure branch keeps the live
// rotation and claims the tested row so the route keeps serving it; a
// superseded attempt used to take that claim from the newer window's borrow.

test('a superseded rotation write-back that rejects cannot claim the owner', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  const rotatedRefresh = 'rt-second-rotated'
  const rotatedRef = accountRef('anthropic', createHash('sha256').update(rotatedRefresh).digest('hex').slice(0, 12))
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let stallRotationWriteBack = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (stallRotationWriteBack && key === rotatedRef) {
        // Park the FIRST cleanup's rotation write-back only. Its failure lands
        // after the newer window borrowed the other account.
        stallRotationWriteBack = false
        attemptOneParked()
        await attemptOneGate
        throw new Error('the credential store refused the rotation write-back')
      }
      return realModify(key, mutate)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          // The serving account's own generation rotates during its window,
          // so its restore takes the rotation write-back branch.
          h.credentials.records.set(GRANT_KEY, grantPayload({
            refresh: rotatedRefresh,
            access: 'at-rotated',
            accountId: 'acc-second',
            email: 'second@example.com',
          }))
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 500
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    testOne = h.service.testKey('anthropic', second.rowId)
    await enteredOne
    // The watchdog abandons the window; its cleanup sees the rotation of the
    // tested row and parks in the rotation write-back.
    stallRotationWriteBack = true
    await attemptOneReached
    releaseTestOne?.()
    await testOne
    // A later test attempt cleans the abandoned window up and hands the
    // provider to a second window on the OTHER account, held open deliberately.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', first.rowId)
    await enteredTwo
    assert.equal(liveProjectionRefresh(h), 'rt-first', 'the newer window borrowed the other account')
    assert.deepEqual(projectedRows(), [first.rowId], 'the newer window owns the route')

    // The superseded attempt resumes: its write-back rejects, but it may not
    // claim the owner from the newer window.
    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(projectedRows(), [first.rowId],
      'a superseded rotation write-back failure claimed the owner for its own row')

    releaseTestTwo?.()
    const outcome = await testTwo
    assert.equal(outcome.ok, true)
  } finally {
    stallRotationWriteBack = false
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.modifyRecord = realModify
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// PR #26 review round 7: the reconcile that follows the awaited re-read /
// projectionStillMatches belongs to the attempt that read it. A cleanup that
// outlived its deadline resumes into a newer window's world; its owner write
// must not clear the owner that window holds.

test('a superseded cleanup cannot reconcile the owner from its awaited re-read', async () => {
  const h = await harness()
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let stallStalenessProbe = false
  let grantModifies = 0
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const first = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-first', email: 'first@example.com', refresh: 'rt-first' })
    const second = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-second', email: 'second@example.com', refresh: 'rt-second' })
    // The route has no projection before the window, so its restore takes the
    // branch that owns the test's own borrow.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)

    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.modifyRecord = async (key: string, mutate: any): Promise<FakeCredentialRecord | undefined> => {
      if (stallStalenessProbe && key === GRANT_KEY) {
        // The first cleanup's restore touches the projection twice: the
        // removal decision, then the staleness probe it awaits before the
        // re-read that follows. Park the probe only, so the attempt is
        // superseded while it waits there.
        grantModifies += 1
        if (grantModifies === 2) {
          stallStalenessProbe = false
          attemptOneParked()
          await attemptOneGate
        }
      }
      return realModify(key, mutate)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 500
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    testOne = h.service.testKey('anthropic', second.rowId)
    await enteredOne
    // The watchdog abandons the window; its cleanup parks in the staleness
    // probe and outlives its deadline.
    stallStalenessProbe = true
    await attemptOneReached
    releaseTestOne?.()
    await testOne
    // A later attempt completes the cleanup and hands the provider to a second
    // window on the OTHER account, held open deliberately.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', first.rowId)
    await enteredTwo
    assert.equal(liveProjectionRefresh(h), 'rt-first', 'the newer window borrowed the other account')
    assert.deepEqual(projectedRows(), [first.rowId], 'the newer window owns the route')

    // A writer outside the provider's grant chain removes the projection, and
    // the superseded attempt resumes into its awaited re-read: its reconcile
    // would follow that empty store over the owner the newer window holds.
    h.credentials.records.delete(GRANT_KEY)
    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(projectedRows(), [first.rowId],
      'a superseded cleanup reconciled the owner from its awaited re-read')

    releaseTestTwo?.()
    const outcome = await testTwo
    assert.equal(outcome.ok, true)
  } finally {
    stallStalenessProbe = false
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.modifyRecord = realModify
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// PR #26 review round 3: the startup repair waited on the process-wide
// hydration promise, so one OAuth read that never settles starved the repair
// of every provider — including a pure key-pool route that can never own a
// projection. Readiness is decided per provider now.

test('one wedged OAuth read does not block a pure key-pool route\'s startup repair', async () => {
  const h = await harness()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    // A mixed provider whose hydration read will never settle…
    await h.service.adoptProvider('anthropic')
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-9', email: 'dev@example.com' })
    h.credentials.records.set(GRANT_KEY, grantPayload())
    // …and a pure key-pool route whose binding was lost: its profile exists
    // (a first run never materializes one) but names no credential.
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'] = {}
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) return new Promise<FakeCredentialRecord | undefined>(() => {})
      return realRead(key)
    }
    const profile = (): Record<string, any> => h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']

    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    // The key-pool route is repaired although the OAuth read is wedged…
    await eventually(() => assert.equal(profile().apiKeyEnv, record.brokerRef,
      'the key-pool route was never repaired while an OAuth read was wedged'))
    // …and its ordinary request still resolves through the broker reference.
    await consume(restarted.streamListener(
      { provider: 'zai-coding-cn', model: 'glm-test-model', sessionId: 'session-peer-repair', messages: [] },
      async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any,
    ))
    assert.ok(h.store.provider('zai-coding-cn')!.keys[0]!.lastUsedAt > 0, 'the pool key served the request')
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// PR #26 review round 3, P1: hydration leaves `activeAccounts` empty when no
// managed row matches the persisted grant. `keyPoolServes` then read that as
// "no projection" and the startup repair bound the broker reference over the
// foreign account's grant, which pi-ai prefers — silently taking the external
// account out of service. A present-but-unowned projection is not an absent one.

test('an orphan projection on a mixed provider keeps the route unbound after startup', async () => {
  const { h } = await harnessWithSeededAccount({ accountId: 'acc-managed', email: 'managed@example.com', refresh: 'rt-managed' })
  try {
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    // The route's profile names no credential: exactly the shape the startup
    // repair (wrongly) bound over an unowned projection.
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-orphan',
      access: 'at-orphan',
      accountId: 'acc-orphan',
      email: 'orphan@example.com',
    }))

    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await new Promise(resolve => setTimeout(resolve, 40))

    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined,
      'the startup repair bound the pool over an unowned projection')
    // The orphan projection still serves the route.
    assert.equal(h.credentials.records.has(GRANT_KEY), true)
    const view = restarted.getState().providers.find(entry => entry.provider === 'anthropic')!
    assert.equal(view.bindingHealthy, true)
    assert.equal(view.keys.filter(key => key.projected === true).length, 0)
  } finally {
    await h.close()
  }
})

// PR #26 review round 3, P1: the deletion branch of the record reconciler only
// rebound inside `active !== undefined`. A native writer that replaced the
// managed projection first (clearing the owner entry) and deleted the record
// later left the profile unbound although the surviving pool now serves.

test('a projection deletion after a foreign replacement rebinds the surviving pool', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    const record = h.store.provider('anthropic')!
    const poolValues = record.keys
      .filter(key => key.kind === 'api-key')
      .map(key => h.credentials.refs.get(key.ref))
    await h.service.activateAccount('anthropic', rowId)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)

    // A native writer replaces the managed projection: the echo drops the owner.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-foreign',
      access: 'at-foreign',
      accountId: 'acc-foreign',
      email: 'foreign@example.com',
    }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true).length, 0)
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined)

    // The same writer then deletes it: the surviving pool is the serving source.
    h.credentials.records.delete(GRANT_KEY)
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, record.brokerRef,
      'the surviving pool was not rebound after the projection deletion')

    // The next ordinary request resolves through the broker reference.
    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      resolved.push((await h.credentials.raw.resolve(record.brokerRef))?.value)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.equal(resolved.length, 1)
    assert.ok(poolValues.includes(resolved[0]), `the request resolved ${String(resolved[0])}, not a pool key`)
  } finally {
    await h.close()
  }
})

// PR #26 review round 4, P1 #1: the foreign-projection marker only warned. A
// route that was still broker-bound kept resolving the managed pool, because
// pi-ai reads `apiKeyEnv` before its own stored grant — the native account the
// warning announced never served a request.

test('a foreign grant taking over a broker-bound route unbinds the profile', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-managed', email: 'managed@example.com' })
  try {
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    const record = h.store.provider('anthropic')!
    const poolValues = record.keys
      .filter(key => key.kind === 'api-key')
      .map(key => h.credentials.refs.get(key.ref))
    // Demotion hands the route back to the surviving pool: the broker-bound
    // shape a native sign-in then lands on.
    await h.service.activateAccount('anthropic', rowId)
    await h.service.fallbackToKeys('anthropic')
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, record.brokerRef)

    // A native sign-in writes an orphan grant no pool row owns.
    h.credentials.records.set(GRANT_KEY, grantPayload({
      refresh: 'rt-foreign-takeover',
      access: 'at-foreign-takeover',
      accountId: 'acc-foreign',
      email: 'foreign@example.com',
    }))
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await drainGrantChain(h, 'anthropic')

    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined,
      'the broker reference stayed on a route the foreign grant now serves')
    // What pi-ai resolves for one request: the profile's named credential
    // first, its own stored grant when the profile names none.
    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      const apiKeyEnv = h.settings.valueOf('llm-pi-ai').providers.anthropic?.apiKeyEnv
      resolved.push(typeof apiKeyEnv === 'string'
        ? (await h.credentials.raw.resolve(apiKeyEnv))?.value
        : String((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).access))
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.deepEqual(resolved, ['at-foreign-takeover'])
    assert.equal(poolValues.includes(resolved[0]), false, `the request resolved ${String(resolved[0])}, a pool key`)
  } finally {
    await h.close()
  }
})

// PR #26 review round 4, P1 #2: hydration only classified a valid OAuth grant.
// A persisted native api-key record (or any record this pool cannot interpret)
// left the route looking projection-free, so the startup repair bound the
// broker over it — and pi-ai prefers `apiKeyEnv` over the native record.

test('a persisted native api-key record keeps a mixed route unbound after startup', async () => {
  const { h } = await harnessWithSeededAccount({ accountId: 'acc-managed', email: 'managed@example.com' })
  try {
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    // The profile names no credential: exactly the shape the startup repair
    // bound over the native record.
    h.settings.valueOf('llm-pi-ai').providers.anthropic = { models: [{ id: 'claude-test-model' }] }
    h.credentials.records.set(GRANT_KEY, { kind: 'api-key', key: 'sk-native-out-of-band' })

    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await new Promise(resolve => setTimeout(resolve, 40))

    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined,
      'the startup repair bound the pool over a native api-key record')
    assert.ok(h.credentials.records.has(GRANT_KEY), 'the native record survives startup')
    assert.equal(restarted.getState().providers.find(entry => entry.provider === 'anthropic')!.bindingHealthy, true)
  } finally {
    await h.close()
  }
})

// PR #26 review round 5 (I-000168): pass 2 re-derived readiness instead of
// carrying pass 1's skipped set, so a provider whose hydration landed while
// pass 1 was syncing another provider was processed by neither pass and kept
// its stale binding for the whole session.

test('a provider hydrated during the first repair pass is repaired in the same call', async () => {
  const h = await harness()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    // Provider A: a mixed route whose projection read will land late. Its
    // profile starts unbound, so the repair under test is what binds it.
    await h.service.adoptProvider('anthropic')
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-9', email: 'dev@example.com' })
    const record = h.store.provider('anthropic')!
    h.settings.valueOf('llm-pi-ai').providers.anthropic = { models: [{ id: 'claude-test-model' }] }
    // Provider B: a pure key-pool route pass 1 repairs while A's read is held.
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'] = {}

    let releaseRead: (() => void) | undefined
    h.credentials.raw.readRecord = (key: string) => {
      if (key !== GRANT_KEY) return realRead(key)
      return new Promise(resolve => { releaseRead = () => resolve(undefined) })
    }
    // Park pass 1 inside B's write, then land A's read before releasing it: at
    // that moment A is known, which is exactly what the old pass 2 re-read.
    let releaseWrite: (() => void) | undefined
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    const realMutate = h.settings.mutate.bind(h.settings)
    let firstWrite = true
    h.settings.mutate = async (ns: string, ops: any[], revision?: number) => {
      if (firstWrite) {
        firstWrite = false
        await writeGate
      }
      return realMutate(ns, ops, revision)
    }

    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    releaseRead!()
    await eventually(() => assert.equal(
      (restarted as unknown as { hydratedProviders: Set<string> }).hydratedProviders.has('anthropic'),
      true,
    ))
    releaseWrite!()

    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv,
      record.brokerRef, 'the provider hydrated during pass 1 was not repaired by the same call'))
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// PR #26 review round 5 (I-000167): the foreign marker set at hydration was
// only ever retired by a claim or by the deletion echo's own cleanup. The
// reconcile that observes a confirmed absence kept it, and `keyPoolServes`
// then held the surviving pool unbound for good. The public deletion flow is
// already pinned above ('a projection deletion after a foreign replacement
// rebinds the surviving pool'); this pins the reconcile contract itself, which
// is the seam a restore reaches when it observes the record already gone.

test('a confirmed projection absence clears the foreign marker and rebinds the pool (I-000167)', async () => {
  const { h } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
  try {
    await h.service.addKey('anthropic', 'backup', 'sk-ant-backup')
    const record = h.store.provider('anthropic')!
    const poolValues = record.keys
      .filter(key => key.kind === 'api-key')
      .map(key => h.credentials.refs.get(key.ref))
    h.settings.valueOf('llm-pi-ai').providers.anthropic = { models: [{ id: 'claude-test-model' }] }
    // A native api-key record takes the route over: the echo marks it foreign.
    h.credentials.records.set(GRANT_KEY, { kind: 'api-key', key: 'sk-native' })
    h.credentials.emitRecordUpdated(GRANT_KEY)
    await drainGrantChain(h, 'anthropic')
    assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv, undefined,
      'the foreign record is not a projection this pool owns')

    // The projection is gone (a sign-out the store did not broadcast) and the
    // owner map reconciles without a payload.
    h.credentials.records.delete(GRANT_KEY)
    const internals = h.service as unknown as {
      reconcileProjectionOwner: (provider: string, payload: undefined) => void
      foreignProjections: Set<string>
    }
    internals.reconcileProjectionOwner('anthropic', undefined)
    assert.equal(internals.foreignProjections.has('anthropic'), false, 'the foreign marker survived a confirmed absence')

    // The next repair pass binds the surviving pool.
    h.service.attachSettings(h.settings)
    await eventually(() => assert.equal(h.settings.valueOf('llm-pi-ai').providers.anthropic.apiKeyEnv,
      record.brokerRef, 'the surviving pool was never bound after the marker stayed set'))

    const resolved: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      resolved.push((await h.credentials.raw.resolve(record.brokerRef))?.value)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    await consume(h.llm.stream({ provider: 'anthropic', model: 'claude-test-model', messages: [], maxTokens: 64 }))
    assert.ok(poolValues.includes(resolved[0]), `the request resolved ${String(resolved[0])}, not a pool key`)
  } finally {
    await h.close()
  }
})

// ── PR #26 review round 8 ───────────────────────────────────────────────────

// Review must-fix (I-000167 reopened): a record that is PRESENT and not a grant
// is not an absence. `reconcileProjectionOwner` used to receive only the grant
// payload, so a native api-key record that replaced the projection during an
// OAuth row test arrived as `undefined`: the restore cleared the foreign marker
// and the window-end sync bound the broker over the native credential.
test('a native record that replaced the projection keeps the route unbound after a row test', async () => {
  const h = await harness()
  const bindingWrites: string[] = []
  const realMutate = h.settings.mutate.bind(h.settings)
  try {
    h.settings.mutate = async (ns: string, ops: any[], revision?: number) => {
      for (const op of ops) bindingWrites.push(`${op.op} ${op.path.join('/')}`)
      return await realMutate(ns, ops, revision)
    }
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-nine', email: 'nine@example.com', refresh: 'rt-nine' })
    await h.service.activateAccount('anthropic', account.rowId)
    const profile = (): Record<string, any> => h.settings.valueOf('llm-pi-ai').providers['anthropic']
    assert.equal(profile().apiKeyEnv, undefined, 'the projected route still named the broker reference')

    let release: (() => void) | undefined
    let pinged!: () => void
    const enteredPing = new Promise<void>(resolve => { pinged = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      pinged()
      await gate
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const test = h.service.testKey('anthropic', account.rowId)
    await enteredPing
    // Let the borrow write's record echo settle before the native write, so the
    // assertion below observes the restore's own decision.
    await new Promise(resolve => setTimeout(resolve, 30))
    // A native writer takes the projection over while the test borrows it…
    h.credentials.records.set(GRANT_KEY, { kind: 'api-key', key: 'sk-native-value' })
    // …and the ownership-verified demotion confirms it.
    await h.service.fallbackToKeys('anthropic', account.rowId)
    const beforeRelease = bindingWrites.length
    release!()
    assert.equal((await test).ok, true)
    // No binding write was made for the route after the replacement: a present
    // record keeps the route out of the key pool, so the broker is never bound
    // over the native credential (the check counts writes because the late
    // record echo would undo a wrong bind a tick later).
    assert.deepEqual(bindingWrites.slice(beforeRelease), [],
      `the cleanup wrote the provider binding over a present native record`)

    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal(live.kind, 'api-key', 'the restore replaced the native record')
    assert.equal(profile().apiKeyEnv, undefined,
      'the window-end sync bound the broker over a present native record')
  } finally {
    await h.close()
  }
})

// Review should-fix: f8f77c2 fenced the removal branch of the projection
// restore, but the check after the re-read ran before it, so no test could park
// an attempt where only that branch fence stops it. This one resumes a
// superseded attempt into the branch with the projection deleted during a newer
// window, and pins the owner the newer window holds.
test('a superseded cleanup cannot clear the owner of a projection removed during the window', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  let stallRestoreRead = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (stallRestoreRead && key === GRANT_KEY) {
        // Park the FIRST cleanup's projection re-read only.
        stallRestoreRead = false
        attemptOneParked()
        await attemptOneGate
      }
      return realRead(key)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    // The window borrows `first`'s grant over the live `second` projection, so
    // its restore reaches the removal branch with `previous !== undefined`.
    testOne = h.service.testKey('anthropic', first.rowId)
    await enteredOne
    stallRestoreRead = true
    await attemptOneReached
    // The parked cleanup outlives its own deadline.
    await new Promise(resolve => setTimeout(resolve, 150))
    releaseTestOne?.()
    await testOne
    await new Promise(resolve => setTimeout(resolve, 50))
    // The next attempt cleans the abandoned window up and opens a second window
    // on `second`, held open deliberately: it owns the route now.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', second.rowId)
    await enteredTwo
    assert.deepEqual(projectedRows(), [second.rowId], 'the newer window owns the route')
    // An external writer removes the projection while that window is open, so
    // the parked attempt's re-read observes the removal.
    h.credentials.records.delete(GRANT_KEY)

    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(projectedRows(), [second.rowId],
      'a superseded cleanup cleared the owner from a removal it no longer owns')

    releaseTestTwo?.()
    assert.equal((await testTwo).ok, true)
    // The removal is not undone by the newer window either.
    assert.equal(h.credentials.records.has(GRANT_KEY), false)
  } finally {
    stallRestoreRead = false
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.readRecord = realRead
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

test('the transport sign-in begins on llm-omp-transports/cursor and harvests nothing', async () => {
  const h = await transportHarness()
  try {
    const attempt = await h.service.beginTransportLogin('cursor')
    assert.equal(attempt.status, 'pending')
    assert.equal(attempt.provider, 'cursor')
    const request = h.authorization.beganRequests.at(-1)!
    assert.equal(request.key, CURSOR_SCOPE)
    assert.equal(request.method, 'oauth')
    // A second begin while one is pending resumes the same attempt.
    assert.equal((await h.service.beginTransportLogin('cursor')).id, attempt.id)

    // The transports flow commits its own grant, then settles.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    h.authorization.pending!.resolve({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(h.service.accountAttempt(attempt.id)?.status, 'ready')
    assert.equal(h.service.buildState().transportAccounts?.[0]?.status, 'active')
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// Review should-fix: the same dead fence on the foreign-payload branch. A
// superseded attempt that reads a native record must not clear the owner a newer
// window holds.
test('a superseded cleanup cannot clear the owner from a foreign record', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let releaseAttemptOne: (() => void) | undefined
  let releaseTestOne: (() => void) | undefined
  let releaseTestTwo: (() => void) | undefined
  let testOne: Promise<KeyTestResult> | undefined
  let testTwo: Promise<KeyTestResult> | undefined
  let stallRestoreRead = false
  try {
    let attemptOneParked!: () => void
    const attemptOneReached = new Promise<void>(resolve => { attemptOneParked = resolve })
    const attemptOneGate = new Promise<void>(resolve => { releaseAttemptOne = resolve })
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (stallRestoreRead && key === GRANT_KEY) {
        stallRestoreRead = false
        attemptOneParked()
        await attemptOneGate
      }
      return realRead(key)
    }
    const testOneGate = new Promise<void>(resolve => { releaseTestOne = resolve })
    const testTwoGate = new Promise<void>(resolve => { releaseTestTwo = resolve })
    let testOneEntered!: () => void
    let testTwoEntered!: () => void
    const enteredOne = new Promise<void>(resolve => { testOneEntered = resolve })
    const enteredTwo = new Promise<void>(resolve => { testTwoEntered = resolve })
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testCalls += 1
        if (testCalls === 1) {
          testOneEntered()
          await testOneGate
        } else {
          testTwoEntered()
          await testTwoGate
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50
    const projectedRows = (): string[] => h.service.getState().providers
      .find(entry => entry.provider === 'anthropic')!.keys
      .filter(key => key.projected === true)
      .map(key => key.id)

    testOne = h.service.testKey('anthropic', second.rowId)
    await enteredOne
    stallRestoreRead = true
    await attemptOneReached
    await new Promise(resolve => setTimeout(resolve, 150))
    releaseTestOne?.()
    await testOne
    await new Promise(resolve => setTimeout(resolve, 50))
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    testTwo = h.service.testKey('anthropic', first.rowId)
    await enteredTwo
    assert.deepEqual(projectedRows(), [first.rowId], 'the newer window owns the route')
    // A native api-key record replaces the borrowed projection; the parked
    // attempt's re-read now carries a payload it cannot attribute.
    h.credentials.records.set(GRANT_KEY, { kind: 'api-key', key: 'sk-native-value' })

    releaseAttemptOne?.()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(projectedRows(), [first.rowId],
      'a superseded cleanup cleared the owner from a foreign record')

    releaseTestTwo?.()
    assert.equal((await testTwo).ok, true)
    // The foreign record survives both cleanups.
    assert.equal(h.credentials.records.get(GRANT_KEY)?.kind, 'api-key')
  } finally {
    stallRestoreRead = false
    releaseAttemptOne?.()
    releaseTestOne?.()
    releaseTestTwo?.()
    h.credentials.raw.readRecord = realRead
    await testOne?.catch(() => undefined)
    await testTwo?.catch(() => undefined)
    await h.close()
  }
})

// Review P1: a failed ownership read is not "no projection". Hydration's catch
// skipped the provider and its finally still marked it hydrated, so the startup
// repair read an empty owner/foreign map as proof that the pool served and bound
// the broker over a projection it could not read.
test('a failed ownership read never lets the startup repair bind the broker', async () => {
  const h = await harness()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    seedOAuthAccount(h, 'anthropic', { accountId: 'acc-nine', email: 'nine@example.com', refresh: 'rt-nine' })
    // A persisted projection this restarted process cannot read, on a route whose
    // profile the user left unbound.
    h.credentials.records.set(GRANT_KEY, grantPayload({ accountId: 'acc-nine', email: 'nine@example.com' }))
    const profile = (): Record<string, any> => h.settings.valueOf('llm-pi-ai').providers['anthropic']
    delete profile().apiKeyEnv
    const before = structuredClone(profile())
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (key === GRANT_KEY) throw new Error('credential store unavailable')
      return realRead(key)
    }
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    await new Promise(resolve => setTimeout(resolve, 100))
    restarted.attachSettings(h.settings)
    await new Promise(resolve => setTimeout(resolve, 100))

    // The profile keeps the shape it had: nothing proved the pool serves.
    assert.deepEqual(profile(), before)
    assert.equal(profile().apiKeyEnv, undefined,
      'the startup repair bound the broker over a projection it could not read')
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// Review: a finish chunk without a completion reason is not a pass. Only a real
// completion proves the credential served the request.
test('a finish chunk without a completion reason is not a pass', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    const runWith = (chunk: unknown): Promise<KeyTestResult> => {
      h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
        yield chunk
      } as any)
      return h.service.testKey('zai-coding-cn', target.id)
    }

    const silent = await runWith({ type: 'finish' })
    assert.equal(silent.ok, false, 'a reasonless finish chunk was reported as a pass')
    assert.match(String(silent.error), /no completion reason/)
    const unknown = await runWith({ type: 'finish', reason: { kind: 'interrupted' } })
    assert.equal(unknown.ok, false)
    assert.match(String(unknown.error), /interrupted/)
    for (const kind of ['stop', 'length', 'toolUse']) {
      const outcome = await runWith({ type: 'finish', reason: { kind } })
      assert.equal(outcome.ok, true, `the ${kind} completion was not reported as a pass`)
    }
  } finally {
    await h.close()
  }
})

test('a transport flow begins with its own method id, not the pi-ai oauth literal', async () => {
  // The scope prefix is the whole cross-package contract; the method id belongs
  // to the transports package's flow.
  const h = await harness([
    ...piAiFlows(),
    { key: CURSOR_SCOPE, label: 'Cursor', methods: [{ id: 'cursor-device', label: 'Sign in with Cursor' }] },
  ])
  try {
    await h.service.beginTransportLogin('cursor')
    assert.equal(h.authorization.beganRequests.at(-1)!.method, 'cursor-device')
  } finally {
    await h.close()
  }
})

// Review P2: the borrow marker was registered after the projection write was
// awaited, so a mutation landing while that write was in flight derived a
// binding from the pre-borrow world: on an unbound route it bound the broker
// over the projection the test was about to borrow.
test('an addKey during the borrow write cannot persist a broker binding', async () => {
  const h = await harness()
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  let releaseBorrow: (() => void) | undefined
  let borrowParked!: () => void
  let stallBorrow = false
  try {
    h.settings.valueOf('llm-pi-ai').providers['anthropic'] = { models: [{ id: 'claude-test-model' }] }
    await h.service.adoptProvider('anthropic')
    const record = h.store.provider('anthropic')!
    const account = seedOAuthAccount(h, 'anthropic', { accountId: 'acc-nine', email: 'nine@example.com', refresh: 'rt-nine' })
    const profile = (): Record<string, any> => h.settings.valueOf('llm-pi-ai').providers['anthropic']
    // The route is unbound while the pool could serve it: the shape a release
    // leaves behind, and the one the borrow's window must not bind.
    delete profile().apiKeyEnv
    assert.equal(profile().apiKeyEnv, undefined)

    const borrowReached = new Promise<void>(resolve => { borrowParked = resolve })
    const borrowGate = new Promise<void>(resolve => { releaseBorrow = resolve })
    h.credentials.raw.modifyRecord = async (
      key: string,
      mutate: (current: FakeCredentialRecord | undefined) => Promise<FakeCredentialRecord | undefined>,
    ): Promise<FakeCredentialRecord | undefined> => {
      if (stallBorrow && key === GRANT_KEY) {
        stallBorrow = false
        borrowParked()
        await borrowGate
      }
      return realModify(key, mutate)
    }
    const seen: Array<{ apiKeyEnv: string | undefined; refresh: string | undefined }> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      seen.push({
        apiKeyEnv: profile().apiKeyEnv as string | undefined,
        refresh: (h.credentials.records.get(GRANT_KEY)?.payload as Record<string, unknown> | undefined)?.refresh as string | undefined,
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    stallBorrow = true
    const test = h.service.testKey('anthropic', account.rowId)
    await borrowReached
    // A user adds a key while the borrow write is still in flight.
    await h.service.addKey('anthropic', 'during-borrow', 'sk-during-borrow')
    assert.equal(profile().apiKeyEnv, undefined, 'a mutation bound the broker while the borrow write was pending')
    releaseBorrow!()
    assert.equal((await test).ok, true)
    // The request ran on the account grant, never on the pool…
    assert.deepEqual(seen, [{ apiKeyEnv: undefined, refresh: 'rt-nine' }])
    // …and the window ends on the state it restored: the pool serves, so bound.
    assert.equal(profile().apiKeyEnv, record.brokerRef,
      'the window never rebound the route its entry snapshot found unbound')
  } finally {
    stallBorrow = false
    releaseBorrow?.()
    h.credentials.raw.modifyRecord = realModify
    await h.close()
  }
})

test('a cancelled transport sign-in settles without an account', async () => {
  const h = await transportHarness()
  try {
    const attempt = await h.service.beginTransportLogin('cursor')
    h.authorization.pending!.resolve({ status: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(h.service.accountAttempt(attempt.id)?.status, 'cancelled')
    assert.equal(h.service.buildState().transportAccounts?.[0]?.status, 'signed-out')
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// ── PR #26 review round 9 ───────────────────────────────────────────────────

// Review R8-2 (Codex P2): `testKey` captures its row, its credential and the
// route's serving shape before the first await, so a removal landing inside
// that window deleted the credential the test was about to send. Removing an
// account during a *borrowed* test was worse than a stale read: the removal
// compared its decision against the test's temporary projection, deleted it
// and demoted every row — disabling an account nobody touched — while the
// test's restore wrote the removed account's grant back.
test('removing an account waits for its own connection test', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  try {
    let enteredTest!: () => void
    const testEntered = new Promise<void>(resolve => { enteredTest = resolve })
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    const projections: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        projections.push((h.credentials.records.get(GRANT_KEY)?.payload as Record<string, unknown>).refresh as string)
        enteredTest()
        await testGate
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const testRun = h.service.testKey('anthropic', first.rowId)
    await testEntered
    const removal = h.service.removeAccount('anthropic', first.rowId)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.store.provider('anthropic')!.keys.some(row => row.id === first.rowId), true,
      'the account was removed while its own test borrowed the route')
    assert.deepEqual(projections, ['rt-first'], 'the test never reached its request')

    releaseTest!()
    assert.equal((await testRun).ok, true)
    await removal
    // The test borrowed, then restored the user's projection…
    assert.deepEqual(projections, ['rt-first'])
    // …and the removal ran on that restored state, so the account the user did
    // not touch keeps serving and stays selectable.
    const remaining = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(remaining.some(row => row.id === first.rowId), false)
    assert.equal(remaining.find(row => row.id === second.rowId)!.projected, true)
    assert.equal(h.store.provider('anthropic')!.keys.find(row => row.id === second.rowId)!.valueMissing, false)
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-second')
    assert.equal(h.credentials.records.has(first.grantRef), false)
  } finally {
    releaseTest?.()
    await h.close()
  }
})

test('removing a transport account withdraws the pending sign-in and stays removed', async () => {
  const h = await transportHarness()
  try {
    const attempt = await h.service.beginTransportLogin('cursor')
    // The browser flow had already reached its commit when the removal ran:
    // the grant lands after the abort, exactly as a commit already in flight
    // can. The account was deleted, so that write must not recreate it.
    const request = h.authorization.beganRequests.at(-1)!
    ;(request.signal as AbortSignal).addEventListener('abort', () => {
      h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    }, { once: true })

    const state = await h.service.removeTransportAccount('cursor')

    assert.equal(h.credentials.records.has(CURSOR_SCOPE), false)
    assert.equal(state.transportAccounts?.[0]?.status, 'signed-out')
    assert.equal(state.transportAccounts?.[0]?.active, false)
    assert.equal(h.service.accountAttempt(attempt.id)?.status, 'cancelled')
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// The same window for `deleteKey`, parked before the test's first credential
// read: the row's credential must not be deleted while the test is about to
// send it.
test('deleting a row waits for its connection test', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  const raw = h.credentials.raw
  const realRead = raw.readRecord.bind(raw)
  let releaseRead: (() => void) | undefined
  let stallRead = true
  try {
    let enteredRead!: () => void
    const readEntered = new Promise<void>(resolve => { enteredRead = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    raw.readRecord = async (key: string) => {
      if (stallRead && key === first.grantRef) {
        stallRead = false
        enteredRead()
        await readGate
      }
      return await realRead(key)
    }
    const sent: Array<boolean> = []
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      // The request carries the row's grant only while the store still holds it.
      sent.push(h.credentials.records.has(first.grantRef))
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)

    const testRun = h.service.testKey('anthropic', first.rowId)
    await readEntered
    const removal = h.service.deleteKey('anthropic', first.rowId)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.store.provider('anthropic')!.keys.some(row => row.id === first.rowId), true,
      'the key was deleted while its own test was about to send it')
    assert.deepEqual(sent, [], 'the test sent its request before the removal settled')

    releaseRead!()
    assert.equal((await testRun).ok, true)
    await removal
    assert.deepEqual(sent, [true], 'the request carried a credential the store no longer held')
    assert.equal(h.store.provider('anthropic')!.keys.some(row => row.id === first.rowId), false)
    assert.equal(h.credentials.records.has(first.grantRef), false)
    const live = h.credentials.records.get(GRANT_KEY)!
    assert.equal((live.payload as Record<string, unknown>).refresh, 'rt-second')
    const remaining = h.service.getState().providers.find(entry => entry.provider === 'anthropic')!.keys
    assert.equal(remaining.find(row => row.id === second.rowId)!.projected, true)
  } finally {
    releaseRead?.()
    raw.readRecord = realRead
    await h.close()
  }
})

test('a removal withdraws a commit that outlived another settle path', async () => {
  const h = await transportHarness()
  try {
    await h.service.beginTransportLogin('cursor')
    // The seam is mid-commit, so it ignores the withdraw and `begin` stays
    // pending; the prune timeout settles the attempt record meanwhile.
    h.authorization.committing = true
    h.service.pruneTransient(Date.now() + 365 * 24 * 60 * 60 * 1000)

    const removal = h.service.removeTransportAccount('cursor')
    // The commit lands after the removal's abort, as a late authorization can.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    h.authorization.pending!.resolve({ status: 'authorized' })
    const state = await removal

    assert.equal(h.credentials.records.has(CURSOR_SCOPE), false)
    assert.equal(state.transportAccounts?.[0]?.status, 'signed-out')
    assert.equal(state.transportAccounts?.[0]?.active, false)
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// ── PR #26 review round 10 ──────────────────────────────────────────────────

// Review I-000179 (round 10): `removeAccount` and `deleteKey` coordinated with
// a running row test, but `releaseProvider → releaseLocked →
// deleteManagedCredentials` did not. A release landing on a parked probe
// deleted the api-key literal the test was about to send.
test('releasing a provider waits for a parked row test', async () => {
  const h = await harness()
  let releaseProbe: (() => void) | undefined
  let stall = true
  try {
    // A window long enough that the release cannot win the bound.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    const realProbe = (h.service as unknown as { probeKey: (ref: string) => Promise<unknown> }).probeKey.bind(h.service)
    let enteredProbe!: () => void
    const probeEntered = new Promise<void>(resolve => { enteredProbe = resolve })
    const gate = new Promise<void>(resolve => { releaseProbe = resolve })
    ;(h.service as unknown as { probeKey: (ref: string) => Promise<unknown> }).probeKey = async (ref: string) => {
      if (stall && ref === target.ref) {
        stall = false
        enteredProbe()
        await gate
      }
      return await realProbe(ref)
    }
    const sent: Array<string | undefined> = []
    h.llm.stream = (options: Record<string, any>) => {
      sent.push(h.credentials.refs.get(target.ref))
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    const testRun = h.service.testKey('zai-coding-cn', target.id)
    await probeEntered
    const release = h.service.releaseProvider('zai-coding-cn')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined,
      'the provider was released while its own test was about to send')
    assert.equal(h.credentials.refs.has(target.ref), true, 'the release deleted the literal the test was about to send')
    assert.deepEqual(sent, [], 'the test sent its request before the release settled')

    releaseProbe!()
    assert.equal((await testRun).ok, true)
    await release
    assert.deepEqual(sent, ['sk-existing-zai'], 'the request carried a credential the store no longer held')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(target.ref), false)
  } finally {
    releaseProbe?.()
    await h.close()
  }
})

test('activating a transport account re-reads the grant and writes nothing', async () => {
  const h = await transportHarness()
  try {
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    const state = await h.service.activateTransportAccount('cursor')

    assert.equal(state.transportAccounts?.[0]?.status, 'active')
    assert.deepEqual([...h.credentials.records.keys()], [CURSOR_SCOPE])
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// The same window past its bound: the removal must refuse instead of deleting
// the credential, and the abandoned probe must not send when it finally answers
// (I-000179).
test('a release is refused while a probe outlives the isolation deadline', async () => {
  const h = await harness()
  let releaseProbe: (() => void) | undefined
  let stall = true
  try {
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50
    await h.service.adoptProvider('zai-coding-cn')
    h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].models = [{ id: 'zai-test-model' }]
    const target = h.store.provider('zai-coding-cn')!.keys[0]!
    const realProbe = (h.service as unknown as { probeKey: (ref: string) => Promise<unknown> }).probeKey.bind(h.service)
    let enteredProbe!: () => void
    const probeEntered = new Promise<void>(resolve => { enteredProbe = resolve })
    const gate = new Promise<void>(resolve => { releaseProbe = resolve })
    ;(h.service as unknown as { probeKey: (ref: string) => Promise<unknown> }).probeKey = async (ref: string) => {
      if (stall && ref === target.ref) {
        stall = false
        enteredProbe()
        await gate
      }
      return await realProbe(ref)
    }
    let requests = 0
    h.llm.stream = (options: Record<string, any>) => {
      requests += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    // The api-key window borrows nothing, so the record, the profile fields
    // the plugin wrote and every managed credential must be what a refused
    // release leaves behind.
    const recordBefore = h.store.provider('zai-coding-cn')!
    const brokerRefBefore = recordBefore.brokerRef
    const keysBefore = structuredClone(recordBefore.keys)
    const profileBefore = structuredClone(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'])
    const revisionBefore = h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai').revision
    const credentialBefore = await h.credentials.raw.resolve(target.ref)

    const testRun = h.service.testKey('zai-coding-cn', target.id)
    await probeEntered
    await assert.rejects(
      () => h.service.releaseProvider('zai-coding-cn'),
      /did not settle within|still being cleaned up/,
    )
    // Refused, not partially applied: the record, its pool, the profile fields
    // the plugin wrote and every managed credential are untouched, and no
    // settings write happened on the way to the refusal.
    assert.equal(h.store.provider('zai-coding-cn'), recordBefore)
    assert.equal(h.store.provider('zai-coding-cn')!.brokerRef, brokerRefBefore)
    assert.deepEqual(h.store.provider('zai-coding-cn')!.keys, keysBefore)
    assert.deepEqual(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'], profileBefore)
    assert.deepEqual(await h.credentials.raw.resolve(target.ref), credentialBefore)
    assert.equal(
      h.settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai').revision,
      revisionBefore,
      'the refused release wrote settings',
    )

    releaseProbe!()
    const result = await testRun
    assert.equal(result.ok, false)
    assert.match(String(result.error), /abandoned/)
    assert.equal(requests, 0, 'a probe that outlived its window still sent a request')

    // A refusal is retryable: once the abandoned window's cleanup has ended,
    // the same call goes through and takes the credential with it.
    await h.service.releaseProvider('zai-coding-cn')
    assert.equal(h.store.provider('zai-coding-cn'), undefined)
    assert.equal(h.credentials.refs.has(target.ref), false)
    assert.equal(await h.credentials.raw.resolve(target.ref), undefined)
    // The profile keeps the reference the user had before adoption.
    assert.equal(h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv, 'ZAI_CODING_CN_API_KEY')
  } finally {
    releaseProbe?.()
    await h.close()
  }
})

test('removing a transport account deletes only its own record', async () => {
  const h = await transportHarness()
  try {
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    h.credentials.records.set('llm-pi-ai/anthropic', { kind: 'grant', payload: { type: 'oauth', refresh: 'r', access: 'a' } })

    const state = await h.service.removeTransportAccount('cursor')

    assert.equal(h.credentials.records.has(CURSOR_SCOPE), false)
    // Another package's record — and the pi-ai projection — stay untouched.
    assert.equal(h.credentials.records.has('llm-pi-ai/anthropic'), true)
    assert.equal(state.transportAccounts?.[0]?.status, 'signed-out')
    assert.equal(state.transportAccounts?.[0]?.active, false)
  } finally {
    await h.close()
  }
})

// ── PR #26 review round 12 ──────────────────────────────────────────────────

// Review must-fix: `settleTestBeforeRemoval` waits only for a test that already
// exists, so a test starting after that check read the account grant and the
// projection while a release was deleting them, then re-projected the removed
// account's grant and sent with it. The removal now refuses a test at entry.
test('a test starting during a release is refused instead of re-projecting the removed account', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  // Park the release in its credential deletion: it has already passed its own
  // test wait, which is exactly the window a starting test used to enter.
  const held = holdDeleteRecord(h, first.grantRef)
  try {
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    let requests = 0
    h.llm.stream = (options: Record<string, any>) => {
      requests += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }

    const release = h.service.releaseProvider('anthropic')
    await held.started
    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(result.ok, false)
    assert.match(String(result.error), /being removed/)
    assert.equal(requests, 0, 'a test starting inside a release sent a request')
    held.release()
    await release
    assert.equal(h.store.provider('anthropic'), undefined)
    // The removed account is gone and nothing projected it again on the way
    // out: neither its grant record nor a projection carrying its refresh.
    assert.equal(h.credentials.records.has(first.grantRef), false)
    for (const record of h.credentials.records.values()) {
      assert.notEqual((record.payload as Record<string, unknown> | undefined)?.refresh, 'rt-first')
    }
  } finally {
    held.release()
    await h.close()
  }
})

test('a transport record echoed by the seam refreshes the list instead of a pi-ai reconciliation', async () => {
  const h = await transportHarness()
  try {
    // An out-of-band commit (another surface's sign-in) reaches the manager
    // only through the seam's post-commit fan-out.
    h.credentials.records.set(CURSOR_SCOPE, { kind: 'grant', payload: cursorGrant() })
    h.credentials.emitRecordUpdated(CURSOR_SCOPE)
    await new Promise(resolve => setTimeout(resolve, 0))

    const state = h.service.buildState()
    assert.equal(state.transportAccounts?.[0]?.status, 'active')
    // Not "native management of the route": this manager owns the account row.
    assert.deepEqual(state.warnings, [])
    assertNoPiAiProjection(h)
  } finally {
    await h.close()
  }
})

// ── PR #26 review round 15 ──────────────────────────────────────────────────

// Review must-fix: `testKey` read the removal marker only at entry and then
// awaited the abandoned-window recovery — and that cleanup is exactly what
// lifts the fence a removal's own precheck reads. A removal starting inside
// the await passed its precheck (no fence, no registered test), parked in its
// grant deletion, and the resumed attempt registered, read the still-present
// grant, passed the ownership re-check and borrowed: the account being
// removed was projected again and the request carried it. The attempt now
// re-reads the markers after the recovery await, and the borrow-time assertion
// refuses a row whose retirement already started.
test('a removal started during the recovery await refuses the test instead of re-projecting the account', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  let removal: Promise<StateView> | undefined
  let removalStarted = false
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  const realModify = h.credentials.raw.modifyRecord.bind(h.credentials.raw)
  const held = holdDeleteRecord(h, first.grantRef)
  let slowReads = false
  const projectionWrites: string[] = []
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    let requests = 0
    let testCalls = 0
    h.llm.stream = (options: Record<string, any>) => {
      requests += 1
      return h.service.streamListener(options as any, async function* () {
        if (options.maxTokens === 1) {
          testCalls += 1
          if (testCalls === 1) {
            testEntered()
            await testGate
          }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30
    ;(h.service as unknown as { testCleanupDeadlineMs: number }).testCleanupDeadlineMs = 50
    // The interleaving point: this warning is logged after the recovery
    // cleanup lifted the fence and before the attempt that awaited it
    // registers. A removal started here passes its own precheck and parks in
    // the account's grant deletion.
    ;(h.ctx.logger as { warn: (message: string) => void }).warn = message => {
      const text = String(message)
      if (removalStarted || !/was cleaned up on the next attempt/.test(text)) return
      removalStarted = true
      removal = h.service.removeAccount('anthropic', first.rowId)
    }
    h.credentials.raw.modifyRecord = async (
      key: string,
      mutate: (current: FakeCredentialRecord | undefined) => Promise<FakeCredentialRecord | undefined>,
    ) => realModify(key, async (current: FakeCredentialRecord | undefined) => {
      const replacement = await mutate(current)
      if (key === GRANT_KEY && replacement !== undefined) projectionWrites.push(JSON.stringify(replacement.payload))
      return replacement
    })

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // From here the abandoned window's cleanup cannot reach its deadline: the
    // projection read outlasts it, so the fence can only clear once the seam
    // answers in time again.
    slowReads = true
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      if (slowReads && key === GRANT_KEY) await new Promise(resolve => setTimeout(resolve, 120))
      return realRead(key)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    // The wedged test settles while the seam is still slow, so the retry its
    // settlement triggers fails too and only a new attempt can clear the fence.
    releaseTest?.()
    await testRun
    await new Promise(resolve => setTimeout(resolve, 400))
    // The seam answers in time again: the attempt entering now clears the
    // fence, and the removal interleaves inside that await.
    slowReads = false
    h.credentials.raw.readRecord = realRead
    // The fence this attempt clears is the only abandoned window left; the
    // attempt itself must not be abandoned by the deadline above.
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 2_000
    requests = 0
    projectionWrites.length = 0

    const result = await h.service.testKey('anthropic', first.rowId)
    assert.equal(removalStarted, true, 'the removal never interleaved with the recovery await')
    // Parked in the account's grant deletion: the removal won its precheck
    // before this attempt registered.
    await held.started

    assert.equal(result.ok, false)
    assert.equal(requests, 0, 'the test sent a request while the account was being removed')
    assert.match(String(result.error), /being removed/)
    assert.deepEqual(
      projectionWrites.filter(payload => payload.includes('rt-first')),
      [],
      'the test re-projected the account the removal is deleting',
    )

    held.release()
    await removal
    // The removal finished: the removed account stays removed and nothing
    // projected it on the way out.
    assert.equal(h.credentials.records.has(first.grantRef), false)
    assert.equal(h.store.provider('anthropic')!.keys.some(row => row.id === first.rowId), false)
    assert.equal((h.credentials.records.get(GRANT_KEY)!.payload as Record<string, unknown>).refresh, 'rt-second')
    for (const record of h.credentials.records.values()) {
      assert.notEqual((record.payload as Record<string, unknown> | undefined)?.refresh, 'rt-first')
    }
  } finally {
    slowReads = false
    h.credentials.raw.readRecord = realRead
    h.credentials.raw.modifyRecord = realModify
    releaseTest?.()
    held.release()
    await removal?.catch(() => undefined)
    await testRun?.catch(() => undefined)
    await h.close()
  }
})

// ── PR #26 review round 16 ──────────────────────────────────────────────────

// The regressions above cover a removal that goes through the coordinator
// (rounds 12/15) and an in-place mutation of the captured projection (round
// 14), but not an out-of-band store edit in the window between the pre-borrow
// captures and the borrow write. A native writer splices the tested row from
// the provider's keys; the borrow-time re-check must refuse instead of
// re-projecting the removed account's grant and sending with it.
test('a row deleted out of band between the captures and the borrow refuses the test', async () => {
  const { h, first } = await harnessWithTwoProjectedAccounts()
  const realRead = h.credentials.raw.readRecord.bind(h.credentials.raw)
  let armed = false
  let deleted = false
  let calls = 0
  try {
    await drainGrantChain(h, 'anthropic')
    await new Promise(resolve => setTimeout(resolve, 0))
    armed = true
    h.llm.stream = (options: Record<string, any>) => {
      calls += 1
      return h.service.streamListener(options as any, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
    }
    // Both pre-borrow reads have returned. The row is then removed directly in
    // the store — no removal coordinator, no retirement mark, no credential
    // delete — before the borrow write runs.
    h.credentials.raw.readRecord = async (key: string): Promise<FakeCredentialRecord | undefined> => {
      const record = await realRead(key)
      if (armed && !deleted && key === GRANT_KEY) {
        deleted = true
        const keys = h.store.provider('anthropic')!.keys
        keys.splice(keys.findIndex(row => row.id === first.rowId), 1)
        h.store.touch()
      }
      return record
    }

    const result = await h.service.testKey('anthropic', first.rowId)

    assert.equal(deleted, true, 'the row was removed inside the borrow window')
    // A structured refusal, not a pass for a credential the route no longer
    // carries.
    assert.equal(result.ok, false)
    assert.match(String(result.error), /was removed from anthropic before its test could borrow it/)
    // Nothing was sent for the removed row…
    assert.equal(calls, 0)
    // …the tested grant was never projected over the live one…
    assert.equal(liveProjectionRefresh(h), 'rt-second')
    // …and the borrow marker never went up.
    const borrows = (h.service as unknown as { testBindingBorrows: Set<string> }).testBindingBorrows
    assert.equal(borrows.has('anthropic'), false, 'the refused borrow left its marker behind')
  } finally {
    h.credentials.raw.readRecord = realRead
    await h.close()
  }
})

// ── PR #26 review round 17 ──────────────────────────────────────────────────

// Review must-fix: readiness was process-wide, so a provider that did not exist
// when hydration ran looked exactly like one whose read found no projection.
// Adoption then bound the pool over the route's native grant. The projection is
// read per provider now, and adoption reads it before the first binding sync.
test('a provider adopted after startup hydration does not bind over its native projection', async () => {
  const h = await harness()
  try {
    // The startup snapshot only covers providers that were already managed;
    // this route's native sign-in landed after that read.
    await eventually(() => assert.equal((h.service as unknown as { hydrationSettled: boolean }).hydrationSettled, true))
    h.credentials.records.set('llm-pi-ai/zai-coding-cn', {
      kind: 'grant',
      payload: { type: 'oauth', refresh: 'rt-native', access: 'at-native' },
    })
    const native = structuredClone(h.credentials.records.get('llm-pi-ai/zai-coding-cn'))

    await h.service.adoptProvider('zai-coding-cn')

    const record = h.store.provider('zai-coding-cn')!
    assert.equal(record.keys.length, 1, 'the pooled credential was not imported')
    const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    assert.equal(profile.apiKeyEnv, 'ZAI_CODING_CN_API_KEY',
      'adoption bound the broker over a native projection it never read')
    assert.notEqual(profile.apiKeyEnv, record.brokerRef)
    assert.deepEqual(h.credentials.records.get('llm-pi-ai/zai-coding-cn'), native,
      'the native grant was replaced by the adoption')
  } finally {
    await h.close()
  }
})

// Review must-fix: a projection read that rejects is not an absent projection.
// Adoption keeps the route managed (there is nothing to roll back), but it must
// bind nothing over a projection this process could not see, and ownership must
// stay unknown until an authoritative read answers.
test('an adopted provider with a failed projection read does not bind', async () => {
  const h = await harness()
  try {
    await eventually(() => assert.equal((h.service as unknown as { hydrationSettled: boolean }).hydrationSettled, true))
    h.credentials.raw.failReadRecordRefs.add('llm-pi-ai/zai-coding-cn')

    const state = await h.service.adoptProvider('zai-coding-cn')

    const record = h.store.provider('zai-coding-cn')!
    assert.equal(record.keys.length, 1, 'the failed read rolled the adoption back')
    const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
    assert.equal(profile.apiKeyEnv, 'ZAI_CODING_CN_API_KEY', 'the broker was bound over an unreadable projection')
    assert.notEqual(profile.apiKeyEnv, record.brokerRef)
    assert.equal(
      (h.service as unknown as { projectionOwnershipKnown: (provider: string) => boolean }).projectionOwnershipKnown('zai-coding-cn'),
      false,
      'a failed projection read was reported as known ownership',
    )
    assert.match(state.warnings.join('\n'), /could not be read/)
  } finally {
    h.credentials.raw.failReadRecordRefs.delete('llm-pi-ai/zai-coding-cn')
    await h.close()
  }
})

// ── PR #26 review round 18 ──────────────────────────────────────────────────

// Advisor: the round-17 regression proves the adopted route's projection is read
// at all, but the P1 names every "present but foreign" presentation. Adoption
// holds no account row, so any live record is foreign — a native grant, a native
// api-key, an unrecognized payload — and each must keep the route off the pool.
// The round-17 case keeps its own assertions; this table pins all three
// presentations against the same facts: the pre-adoption reference survives, the
// record is untouched, ownership is known while the pool does not serve, and an
// ordinary request resolves the pre-adoption credential instead of a managed row.
const ADOPTED_FOREIGN_PROJECTIONS: Array<{ label: string; stored: FakeCredentialRecord }> = [
  {
    label: 'a native OAuth grant',
    stored: { kind: 'grant', payload: { type: 'oauth', refresh: 'rt-native', access: 'at-native' } },
  },
  { label: 'a native api-key record', stored: { kind: 'api-key', key: 'sk-native-route' } },
  {
    label: 'an unrecognized payload',
    stored: { kind: 'grant', payload: { type: 'unknown-native', token: 'opaque-native' } },
  },
]

for (const { label, stored: nativeRecord } of ADOPTED_FOREIGN_PROJECTIONS) {
  test(`an adopted provider does not bind over ${label}`, async () => {
    const h = await harness()
    const nativeKey = 'llm-pi-ai/zai-coding-cn'
    try {
      // Restart shape: the startup snapshot ran before this record existed, so
      // the adoption's own read is the only one that can see it.
      await eventually(() => assert.equal((h.service as unknown as { hydrationSettled: boolean }).hydrationSettled, true))
      h.credentials.records.set(nativeKey, structuredClone(nativeRecord))
      const before = structuredClone(h.credentials.records.get(nativeKey))

      await h.service.adoptProvider('zai-coding-cn')

      const record = h.store.provider('zai-coding-cn')!
      const profile = h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn']
      // 1. The profile keeps the reference it had before adoption: no bind.
      assert.equal(profile.apiKeyEnv, 'ZAI_CODING_CN_API_KEY', `adoption bound the broker over ${label}`)
      assert.notEqual(profile.apiKeyEnv, record.brokerRef)
      // 2. The record no pool row owns survives untouched.
      assert.deepEqual(h.credentials.records.get(nativeKey), before, `adoption rewrote ${label}`)
      // 3. The read happened (ownership is known) and it answered "not mine".
      const internals = h.service as unknown as {
        projectionOwnershipKnown: (provider: string) => boolean
        keyPoolServes: (record: ProviderRecord) => boolean
      }
      assert.equal(internals.projectionOwnershipKnown('zai-coding-cn'), true, `the projection behind ${label} was never read`)
      assert.equal(internals.keyPoolServes(record), false, `the pool still serves a route ${label} owns`)
      // 4. An ordinary request resolves the pre-adoption reference, never the
      //    broker reference, and touches no managed pool row.
      const resolvedRefs: string[] = []
      const realResolve = h.credentials.raw.resolve.bind(h.credentials.raw)
      h.credentials.raw.resolve = async (ref: string) => {
        resolvedRefs.push(ref)
        return realResolve(ref)
      }
      const values: Array<string | undefined> = []
      h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
        values.push((await h.credentials.raw.resolve(profile.apiKeyEnv))?.value)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } as any)
      await consume(h.llm.stream({ provider: 'zai-coding-cn', model: 'glm-4.6', messages: [], maxTokens: 32 }))
      assert.deepEqual(values, ['sk-existing-zai'])
      assert.deepEqual(resolvedRefs, ['ZAI_CODING_CN_API_KEY'], 'the request asked the broker for a managed key')
      assert.ok(
        record.keys.every(row => row.totalUses === 0 && row.lastUsedAt === 0),
        'a managed row served a request for a route the pool does not serve',
      )
    } finally {
      await h.close()
    }
  })
}

// ── PR #26 review round 19 ──────────────────────────────────────────────────

// I-000182: the echo reconciliation recorded the authoritative read and then
// returned early for a provider that holds no OAuth row, before the api-key /
// unrecognized-payload classification that sets the foreign marker. The queued
// binding repair then read the pool as the serving source and kept the broker
// reference over the native credential this route actually resolves. A present
// record is classified before that early return now.
test('a key-only provider reconciled onto a native api-key record is foreign', async () => {
  const h = await harness()
  const key = 'llm-pi-ai/zai-coding-cn'
  try {
    await h.service.adoptProvider('zai-coding-cn')
    const record = h.store.provider('zai-coding-cn')!
    const bound = (): unknown => h.settings.valueOf('llm-pi-ai').providers['zai-coding-cn'].apiKeyEnv
    assert.equal(bound(), record.brokerRef, 'the key pool was not bound at adoption')
    // A native writer takes the route over while this process cannot read any
    // projection: startup ownership stays unknown and nothing is repaired.
    h.credentials.records.set(key, { kind: 'api-key', key: 'sk-native-route' })
    const native = structuredClone(h.credentials.records.get(key))
    h.credentials.raw.failReadRecordRefs.add(key)
    const restarted = new KeysManagerService(h.ctx as unknown as HostContext, h.store)
    const internals = restarted as unknown as {
      foreignProjections: Set<string>
      projectionOwnershipKnown: (provider: string) => boolean
      keyPoolServes: (candidate: ProviderRecord) => boolean
    }
    await eventually(() => assert.equal(internals.projectionOwnershipKnown('zai-coding-cn'), false))

    // The seam answers again: the first authoritative read sees the native
    // api-key record, so the route is classified and the skipped repair runs.
    h.credentials.raw.failReadRecordRefs.delete(key)
    h.emitEvent('credentials/record-updated', key)

    await eventually(() => assert.equal(internals.foreignProjections.has('zai-coding-cn'), true))
    await eventually(() => assert.equal(bound(), undefined, 'the broker reference was kept over the native record'))
    assert.equal(internals.projectionOwnershipKnown('zai-coding-cn'), true)
    assert.equal(internals.keyPoolServes(record), false, 'the pool still counts as the serving source')
    assert.deepEqual(h.credentials.records.get(key), native, 'the reconcile rewrote the native record')
    assert.match(restarted.getState().warnings.join('\n'), /natively managed API-key credential/)
  } finally {
    h.credentials.raw.failReadRecordRefs.delete(key)
    await h.close()
  }
})

// I-000179 (late restore): the watchdog's cleanup can hand the route back and
// release the provider while the abandoned request is still parked, so the
// account whose projection the window captured can be deleted before that
// request settles. The late reconcile then compared against `previous`, whose
// row no longer matched anything, so nothing rejected the write and the route
// was handed a deleted account's credential. The restore now requires the
// previous owner to still be managed, leaves the live record alone and reports
// that the borrow could not be undone.
test('a late abandoned-window restore does not restore a deleted owner', async () => {
  const { h, first, second } = await harnessWithTwoProjectedAccounts()
  let releaseTest: (() => void) | undefined
  let testRun: Promise<KeyTestResult> | undefined
  try {
    const testGate = new Promise<void>(resolve => { releaseTest = resolve })
    let testEntered!: () => void
    const entered = new Promise<void>(resolve => { testEntered = resolve })
    h.llm.stream = (options: Record<string, any>) => h.service.streamListener(options as any, async function* () {
      if (options.maxTokens === 1) {
        testEntered()
        await testGate
        // The adapter ignored the abort and rewrote the borrowed projection
        // after the cleanup had already handed the route back.
        await h.credentials.raw.modifyRecord(GRANT_KEY, () => Promise.resolve(grantPayload({
          refresh: 'rt-first-refreshed',
          access: 'at-refreshed',
          accountId: 'acc-first',
          email: 'first@example.com',
        })))
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } as any)
    ;(h.service as unknown as { isolationWaitMs: number }).isolationWaitMs = 30

    testRun = h.service.testKey('anthropic', first.rowId)
    await entered
    // The watchdog put the user's projection back and released the provider…
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-second'))
    await eventually(() => assert.equal(
      (h.service as unknown as { cleaningTests: Set<string> }).cleaningTests.has('anthropic'),
      false,
    ))
    // …so the previous owner can be deleted before the wedged request settles.
    await h.service.removeAccount('anthropic', second.rowId)
    assert.equal(h.credentials.records.has(GRANT_KEY), false, 'the demotion left the removed account projected')

    releaseTest?.()
    const result = await testRun!

    // The late write is reconciled: the deleted account's credential is NOT
    // put back…
    await eventually(() => assert.equal(liveProjectionRefresh(h), 'rt-first-refreshed'))
    assert.equal(h.credentials.records.has(second.grantRef), false, 'the deleted account was re-projected')
    // …the newer generation is still written back to the tested row…
    const row = h.store.provider('anthropic')!.keys.find(candidate => candidate.id === first.rowId)!
    const rotatedRef = accountRef('anthropic', createHash('sha256').update('rt-first-refreshed').digest('hex').slice(0, 12))
    assert.equal(row.oauth!.grantRef, rotatedRef)
    assert.ok(h.credentials.records.has(rotatedRef))
    // …and the route reports that its borrow could not be undone.
    assert.equal(result.ok, false)
    assert.match(String(result.error), /abandoned/)
    assert.match(h.service.getState().warnings.join('\n'), /is no longer managed/)
  } finally {
    releaseTest?.()
    await testRun?.catch(() => undefined)
    await h.close()
  }
})
