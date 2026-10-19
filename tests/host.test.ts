import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { HostContext, RequestErrorPayload } from '../src/host-types'
import type { KeyRecord, ProviderRecord, ProviderView, StateView } from '../src/domain'
import { accountRef } from '../src/core'
import { apply, KeysManagerService } from '../src/index'
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
  emitEvent: (name: string, ...args: unknown[]) => void
  close: () => Promise<void>
}

/**
 * The flows `llm-pi-ai/login.ts:131-171` registers: one flow per installed
 * catalog provider, keyed `recordKeyFor(providerId)` = `llm-pi-ai/<id>`
 * (auth.ts:29,36-38), methods sorted oauth-first (login.ts:40-47). The oauth
 * members and this method order are the pin the login driver depends on.
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
    assert.equal(codex.supported, false)
    assert.match(String(codex.reason), /OAuth/)
    assert.equal(deepseek.supported, true)
    assert.equal(anthropic.supported, true)
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
    // Method order is oauth-first on dual-auth flows (login.ts:40-47).
    const anthropic = h.authorization.describe('llm-pi-ai/anthropic')
    assert.deepEqual(anthropic.methods.map((method: { id: string }) => method.id), ['oauth', 'api-key'])
    // A provider with no oauth method (not in the flow table, or oauth: false
    // upstream) yields nothing: the manager must not begin a flow it cannot name.
    assert.equal(h.service.oauthFlowFor('zai-coding-cn'), undefined)
    assert.equal(h.service.oauthFlowFor('amazon-bedrock'), undefined)
    assert.equal(h.service.oauthFlowFor('no-such-provider'), undefined)
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

test('concurrent logins for one provider are refused until the attempt settles', async () => {
  const h = await harnessWithManagedAnthropic()
  try {
    await h.service.beginAccountLogin('anthropic')
    await assert.rejects(() => h.service.beginAccountLogin('anthropic'), /already/)
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

test('a rotated refresh token re-associates its row and syncs the rotated payload back (W1)', async () => {
  const { h, rowId } = await harnessWithSeededAccount({ accountId: 'acc-9', email: 'dev@example.com' })
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
    // grantRef re-hashes to the rotated refresh token.
    const newRef = accountRef('anthropic', createHash('sha256').update('rt-rotated-token').digest('hex').slice(0, 12))
    await eventually(() => assert.equal(row.oauth!.grantRef, newRef))
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
    assert.deepEqual(params('beginAccountLogin'), ['provider', 'alias'])
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
