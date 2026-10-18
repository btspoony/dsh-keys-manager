import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { HostContext, RequestErrorPayload } from '../src/host-types'
import type { ProviderView, StateView } from '../src/domain'
import { KeysManagerService } from '../src/index'
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

function fakeCredentials(initial: Record<string, string> = {}): { raw: any; refs: Map<string, string> } {
  const refs = new Map(Object.entries(initial))
  const raw = {
    failResolve: false,
    failUnset: false,
    failUnsetRefs: new Set<string>(),
    failRefs: new Set<string>(),
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
  }
  Object.defineProperty(raw, ORIGINAL, { value: raw })
  return { raw, refs }
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
  credentials: any
  settings: any
  llm: any
  service: KeysManagerService
  close: () => Promise<void>
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
  const ctx = {
    llm,
    logger: { warn() {}, info() {} },
    get(name: string) {
      if (name === 'credentials') return credentials.raw
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      return undefined
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
    service,
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
    const retry = await h.service.selectKey('zai-coding-cn', 'session-pin')
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
    const retry = await h.service.selectKey('zai-coding-cn', 'session-switch-pin')
    assert.equal(retry.key!.id, second.id)
    assert.equal(first.cooldownUntil > 0, true)
  } finally {
    await h.close()
  }
})


test('step-scoped retry pins are not stolen by a concurrent step', async () => {
  const h = await harness()
  try {
    await h.service.adoptProvider('zai-coding-cn')
    await h.service.addKey('zai-coding-cn', 'second', 'sk-second')
    const provider = h.store.provider('zai-coding-cn')!
    const [first, second] = provider.keys
    provider.cursor = 0
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-pins', 1, 1, first.id)
    ;(h.service as any).pinRetry('zai-coding-cn', 'session-pins', 2, 1, second.id)
    const ambiguous = await h.service.selectKey('zai-coding-cn', 'session-pins')
    assert.equal((h.service as any).retryBindings.size, 2)
    assert.ok(ambiguous.key !== undefined)
    ;(h.service as any).retryBindings.delete('session-pins\u0000zai-coding-cn\u00002\u00001')
    const pinned = await h.service.selectKey('zai-coding-cn', 'session-pins')
    assert.equal(pinned.key!.id, first.id)
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
    ;(h.service as any).attempts.set('session-per-key\u0000zai-coding-cn', {
      keyId: first.id,
      retries: 0,
      at: Date.now(),
      usedManagedKey: true,
    })
    const failureOne = { code: 'RATE_LIMIT', message: 'busy-a1' }
    const failureTwo = { code: 'RATE_LIMIT', message: 'busy-b1' }
    const failureThree = { code: 'RATE_LIMIT', message: 'busy-a2' }
    const payload = (failure: object) => ({
      provider: 'zai-coding-cn',
      turn: 1,
      step: 1,
      failure,
      signal: { aborted: false },
      agent: { session: { id: 'session-per-key' } },
    }) as unknown as RequestErrorPayload
    linkFailure(h, 'zai-coding-cn', 'session-per-key', first.id, failureOne)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureOne), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    linkFailure(h, 'zai-coding-cn', 'session-per-key', second.id, failureTwo)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureTwo), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    linkFailure(h, 'zai-coding-cn', 'session-per-key', first.id, failureThree)
    assert.deepEqual(await h.service.requestErrorListener(payload(failureThree), async () => ({ kind: 'retry' as const })), { kind: 'retry' })
    assert.equal(first.cooldownUntil > 0, true)
    assert.equal(second.cooldownUntil, 0)
  } finally {
    await h.close()
  }
})
