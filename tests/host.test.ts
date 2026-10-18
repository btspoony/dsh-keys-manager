import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    async resolve(ref: string) {
      if (raw.failResolve) throw new Error('credential store unavailable')
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
      if (raw.failUnset) throw new Error('credential store locked')
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
    namespaces,
    describe() {
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
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure)
    const retryOne = await h.service.requestErrorListener(payload, async () => undefined)
    assert.deepEqual(retryOne, { kind: 'retry' })
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure)
    const retryTwo = await h.service.requestErrorListener(payload, async () => undefined)
    assert.deepEqual(retryTwo, { kind: 'retry' })
    ;(h.service as any).recordFailure('zai-coding-cn', 'session-fail', first.id, payload.failure)
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
    await h.service.selectKey('zai-coding-cn', 'session-terminal')
    const payload = {
      provider: 'zai-coding-cn',
      turn: 8,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: 'busy' },
      signal: { aborted: false },
      agent: { session: { id: 'session-terminal' } },
    } as unknown as RequestErrorPayload
    assert.deepEqual(await h.service.requestErrorListener(payload, async () => ({ kind: 'retry' as const })), { kind: 'retry' })
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
    assert.notEqual(h.store.provider('zai-coding-cn'), undefined)
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
