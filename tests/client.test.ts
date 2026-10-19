import { describe, expect, test } from 'vitest'
import { apply } from '../src/client/index'
import { createStore } from '../src/client/store'
import { cooldownMinutes, cooldownMs, graceMinutes, graceMs } from '../src/client/format'
import type { AccountAttemptView, ClientContext, LocaleDicts, RpcResult, StateView } from '../src/client/types'

function makeState(): StateView {
  return {
    now: Date.now(),
    writable: true,
    settings: {
      retryCount: 2,
      baseCooldownMs: 300000,
      recoveryGraceMs: 600000,
      maxCooldownMs: 604800000,
      stickySession: true,
      autoSwitch: true,
    },
    providers: [
      {
        provider: 'zai-coding-cn',
        displayName: 'Z.AI Coding CN',
        source: 'dsh',
        managed: true,
        configured: true,
        active: true,
        supported: true,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'zai-coding-cn'],
        apiKeyEnv: 'KEYSMGR_ZAI_CODING_CN_AAAAAA',
        brokerRef: 'KEYSMGR_ZAI_CODING_CN_AAAAAA',
        bindingHealthy: true,
        extra: false,
        extraId: null,
        api: null,
        baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        env: ['ZAI_CODING_CN_API_KEY'],
        defaultBaseURL: null,
        nativeAuth: { env: ['ZAI_CODING_CN_API_KEY'], oauth: false },
        models: [],
        keyCount: 1,
        healthyKeyCount: 1,
        status: 'active',
        keys: [
          {
            id: 'k_aaaaaaaa',
            alias: 'Imported',
            status: 'active',
            enabled: true,
            createdAt: 1,
            lastUsedAt: 2,
            cooldownUntil: 0,
            failureLevel: 0,
            consecutiveFailures: 0,
            totalUses: 1,
            totalFailures: 0,
            importedFrom: 'ZAI_CODING_CN_API_KEY',
            valueMissing: false,
            kind: 'api-key',
          },
        ],
      },
      {
        provider: 'deepinfra',
        displayName: 'DeepInfra',
        source: 'extra',
        managed: false,
        configured: false,
        active: false,
        supported: true,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepinfra'],
        apiKeyEnv: null,
        brokerRef: null,
        extra: true,
        extraId: 'deepinfra',
        api: 'openai-completions',
        baseURL: 'https://api.deepinfra.com/v1/openai',
        env: ['DEEPINFRA_API_KEY'],
        defaultBaseURL: 'https://api.deepinfra.com/v1/openai',
        nativeAuth: null,
        models: [{ id: 'm', name: 'M' }],
        keyCount: 0,
        healthyKeyCount: 0,
        status: 'unmanaged',
        keys: [],
      },
    ],
    managedCount: 1,
    keyCount: 1,
    healthyKeyCount: 1,
    coolingKeyCount: 0,
    pausedKeyCount: 0,
    bindingsCount: 1,
    warnings: [],
  }
}

interface Harness {
  ctx: ClientContext
  calls: Array<{ channel: string; endpoint: string; payload: unknown }>
  registrations: Array<{ options: { name: string; key?: string }; component: unknown }>
  dictionaries: { value?: LocaleDicts }
  cleanups: Array<() => void>
}

function makeContext(result: RpcResult = { ok: true, value: makeState() }): Harness {
  const calls: Harness['calls'] = []
  const registrations: Harness['registrations'] = []
  const dictionaries: Harness['dictionaries'] = {}
  const cleanups: Harness['cleanups'] = []
  const labels: Record<string, string> = { nav: '密钥管理' }
  const t = (key: string, params: Record<string, string | number> = {}): string => {
    const template = labels[key] ?? key
    return String(template).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
  }
  const ctx: ClientContext = {
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          return result
        },
      },
    },
    locale: {
      register(_ns, dicts) {
        dictionaries.value = dicts
        return () => {}
      },
      bind() {
        return t
      },
      subscribe() {
        return () => {}
      },
      getSnapshot() {
        return { active: 'zh', locales: [], revision: 1 }
      },
    },
    slots: {
      inject(_key, callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return () => {}
      },
      register(options, component) {
        registrations.push({ options: options as { name: string; key?: string }, component })
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    effect(effect, label) {
      if (label !== undefined && label.includes('lifecycle')) return () => {}
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
  }
  return { ctx, calls, registrations, dictionaries, cleanups }
}

describe('client registration', () => {
  test('registers the plugin-detail card, three provider badges, and dictionaries', () => {
    const harness = makeContext()
    apply(harness.ctx)

    const config = harness.registrations.find(entry => entry.options.name === 'plugins.bundle.config')
    const cards = harness.registrations.filter(entry => entry.options.name === 'settings.models.provider-card')
    expect(config).toBeDefined()
    expect(config?.options.key).toBe('dsh-keys-manager')
    expect(harness.registrations.some(entry => entry.options.name === 'settings.section')).toBe(false)
    expect(cards).toHaveLength(3)
    expect(cards.map(entry => entry.options.key).sort()).toEqual(['llm-deepseek', 'llm-deepseek-api-key', 'llm-pi-ai'])

    const dicts = harness.dictionaries.value
    expect(dicts).toBeDefined()
    expect(Object.keys(dicts!.zh).sort()).toEqual(Object.keys(dicts!.en).sort())
    for (const [key, value] of Object.entries(dicts!.zh)) expect(typeof value).toBe('string')
    for (const [key, value] of Object.entries(dicts!.en)) expect(typeof value).toBe('string')
    expect(dicts!.zh.modelsBadge).toContain('{n}')
    expect(dicts!.en.modelsBadge).toContain('{n}')
    expect(dicts!.zh.deleteTitle).toContain('{alias}')
    expect(dicts!.en.deleteTitle).toContain('{alias}')
    expect(dicts!.zh.releaseTitle).toContain('{provider}')

    for (const cleanup of harness.cleanups.reverse()) cleanup()
  })

})

describe('client store', () => {
  test('loads state and calls Remote methods through /api', async () => {
    const harness = makeContext()
    const store = createStore(harness.ctx)
    expect(store.getSnapshot().status).toBe('idle')
    await store.load()
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().state?.managedCount).toBe(1)
    expect(harness.calls[0]).toEqual({ channel: '/api', endpoint: 'keysManager/getState', payload: { args: {} } })

    const outcome = await store.call('addKey', { provider: 'zai-coding-cn', alias: 'second', value: 'sk-second' })
    expect(outcome.ok).toBe(true)
    expect(harness.calls.at(-1)?.endpoint).toBe('keysManager/addKey')

    const callsBefore = harness.calls.length
    const before = store.getSnapshot().now
    store.tick()
    expect(store.getSnapshot().now).toBeGreaterThanOrEqual(before)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.length).toBe(callsBefore + 1)
    expect(harness.calls.at(-1)?.endpoint).toBe('keysManager/getState')
  })

  test('tick refreshes cooldown-derived status from the Host', async () => {
    const harness = makeContext()
    const cooling = makeState()
    cooling.providers[0].status = 'cooling'
    cooling.providers[0].keys[0].status = 'cooling'
    cooling.providers[0].keys[0].cooldownUntil = Date.now() + 60_000
    cooling.providers[0].healthyKeyCount = 0
    cooling.healthyKeyCount = 0
    cooling.coolingKeyCount = 1
    const active = makeState()
    let calls = 0
    harness.ctx.connection.rpc.call = async () => ({ ok: true, value: calls++ === 0 ? cooling : active })
    const store = createStore(harness.ctx)
    await store.load()
    expect(store.getSnapshot().state?.providers[0].status).toBe('cooling')
    store.tick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().state?.providers[0].status).toBe('active')
    expect(store.getSnapshot().state?.coolingKeyCount).toBe(0)
  })

  test('a load started before a mutation cannot overwrite the mutation result', async () => {
    const harness = makeContext()
    let releaseLoad!: () => void
    const gate = new Promise<void>(resolve => { releaseLoad = resolve })
    let getStateCalls = 0
    harness.ctx.connection.rpc.call = async (channel, endpoint, payload) => {
      if (endpoint === 'keysManager/getState') {
        getStateCalls += 1
        if (getStateCalls === 1) await gate
        const state = makeState()
        state.managedCount = getStateCalls === 1 ? 1 : 2
        return { ok: true, value: state }
      }
      const state = makeState()
      state.managedCount = 2
      return { ok: true, value: state }
    }
    const store = createStore(harness.ctx)
    const loading = store.load()
    await new Promise(resolve => setTimeout(resolve, 0))
    const outcome = await store.call('addKey', { provider: 'zai-coding-cn', alias: 'second', value: 'sk-second' })
    expect(outcome.ok).toBe(true)
    expect(store.getSnapshot().state?.managedCount).toBe(2)
    releaseLoad()
    await loading
    expect(store.getSnapshot().state?.managedCount).toBe(2)
  })

  test('refresh does not race an in-flight mutation', async () => {
    const harness = makeContext()
    const original = harness.ctx.connection.rpc.call
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    harness.ctx.connection.rpc.call = async (channel, endpoint, payload) => {
      if (endpoint === 'keysManager/addKey') await gate
      return original(channel, endpoint, payload)
    }
    const store = createStore(harness.ctx)
    await store.load()
    const callsBefore = harness.calls.length
    const pending = store.call('addKey', { provider: 'zai-coding-cn', alias: 'second', value: 'sk-second' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await store.load()
    expect(harness.calls.length).toBe(callsBefore)
    release()
    await pending
    await store.load()
    expect(harness.calls.at(-1)?.endpoint).toBe('keysManager/getState')
  })

  test('surfaces a failed Remote answer as an error', async () => {
    const harness = makeContext({ ok: false, error: { message: 'no credential store' } })
    const store = createStore(harness.ctx)
    await store.load()
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().error).toBe('no credential store')
    const outcome = await store.call('getState', {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('no credential store')
  })
})


describe('policy form conversions', () => {
  test('preserves sub-minute cooldown and grace precision', () => {
    expect(cooldownMinutes(30_000)).toBe(0.5)
    expect(cooldownMinutes(90_000)).toBe(1.5)
    expect(cooldownMs(1.5)).toBe(90_000)
    expect(graceMinutes(90_000)).toBe(1.5)
    expect(graceMs(1.5)).toBe(90_000)
  })
})


describe('mutation ordering', () => {
  test('a later failed mutation keeps the earlier successful snapshot', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/addKey') {
        const state = makeState()
        state.managedCount = 2
        state.keyCount = 2
        return { ok: true, value: state }
      }
      return { ok: false, error: { message: 'update failed' } }
    }
    const store = createStore(harness.ctx)
    const first = store.call('addKey', { provider: 'zai-coding-cn', alias: 'second', value: 'sk-second' })
    const second = store.call('updateKey', { provider: 'zai-coding-cn', keyId: 'k_aaaaaaaa', patch: { enabled: false } })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(false)
    expect(store.getSnapshot().state?.managedCount).toBe(2)
    expect(store.getSnapshot().error).toBe('update failed')
    expect(store.getSnapshot().busy).toBeNull()
  })
})


describe('oauth account store', () => {
  function makeAttempt(): AccountAttemptView {
    return {
      id: 'la_1_ab',
      provider: 'anthropic',
      alias: 'Work account',
      status: 'prompt',
      notices: [{ message: 'Open this page to continue signing in.', url: 'https://example.com/authorize' }],
      prompt: { kind: 'text', message: 'Paste the verification code' },
      createdAt: 1,
      updatedAt: 2,
    }
  }

  test('beginAccountLogin returns the attempt view without replacing the state snapshot', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/beginAccountLogin') {
        expect(payload).toEqual({ args: { provider: 'anthropic', alias: 'Work account' } })
        return { ok: true, value: makeAttempt() }
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    await store.load()
    const stateBefore = store.getSnapshot().state
    const outcome = await store.beginAccountLogin('anthropic', 'Work account')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value?.id).toBe('la_1_ab')
      expect(outcome.value?.status).toBe('prompt')
      expect(outcome.value?.prompt?.kind).toBe('text')
    }
    // The attempt view is not a StateView; the snapshot keeps the loaded state.
    expect(store.getSnapshot().state).toBe(stateBefore)
    expect(store.getSnapshot().busy).toBeNull()
    expect(store.getSnapshot().error).toBeNull()
  })

  test('answerAccountPrompt acknowledges without touching the snapshot state', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      expect(endpoint).toBe('keysManager/answerAccountPrompt')
      expect(payload).toEqual({ args: { attemptId: 'la_1_ab', value: '123-456' } })
      return { ok: true, value: null }
    }
    const store = createStore(harness.ctx)
    await store.load()
    const stateBefore = store.getSnapshot().state
    const outcome = await store.answerAccountPrompt('la_1_ab', '123-456')
    expect(outcome).toEqual({ ok: true, value: null })
    expect(store.getSnapshot().state).toBe(stateBefore)
    expect(store.getSnapshot().busy).toBeNull()
  })

  test('accountAttempt polls without queueing or mutating the snapshot', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/accountAttempt') {
        return payload.args.attemptId === 'la_1_ab' ? { ok: true, value: makeAttempt() } : { ok: true, value: null }
      }
      return { ok: true, value: makeState() }
    }
    const store = createStore(harness.ctx)
    await store.load()
    const snapshotBefore = store.getSnapshot()
    const outcome = await store.accountAttempt('la_1_ab')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value?.notices[0]?.message).toContain('signing in')
    // A poll is read-only: no busy flag, no state replacement, no error.
    const snapshotAfter = store.getSnapshot()
    expect(snapshotAfter.busy).toBe(snapshotBefore.busy)
    expect(snapshotAfter.state).toBe(snapshotBefore.state)

    const missing = await store.accountAttempt('la_missing')
    expect(missing).toEqual({ ok: true, value: null })
  })

  test('listAccountAttempts returns the attempt array', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      expect(endpoint).toBe('keysManager/listAccountAttempts')
      return { ok: true, value: [makeAttempt()] }
    }
    const store = createStore(harness.ctx)
    const outcome = await store.listAccountAttempts()
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value.map(entry => entry.id)).toEqual(['la_1_ab'])
    expect(store.getSnapshot().busy).toBeNull()
  })

  test('activateAccount and removeAccount are queued mutations that refresh the state', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/activateAccount') {
        expect(payload).toEqual({ args: { provider: 'anthropic', accountId: 'k_oauth1' } })
        const state = makeState()
        state.providers[0].keys[0].alias = 'Work account'
        return { ok: true, value: state }
      }
      if (endpoint === 'keysManager/removeAccount') {
        expect(payload).toEqual({ args: { provider: 'anthropic', accountId: 'k_oauth1' } })
        const state = makeState()
        state.managedCount = 0
        return { ok: true, value: state }
      }
      return { ok: true, value: makeState() }
    }
    const store = createStore(harness.ctx)
    await store.load()

    const activated = await store.activateAccount('anthropic', 'k_oauth1')
    expect(activated.ok).toBe(true)
    expect(store.getSnapshot().state?.providers[0].keys[0].alias).toBe('Work account')
    expect(store.getSnapshot().busy).toBeNull()

    const removed = await store.removeAccount('anthropic', 'k_oauth1')
    expect(removed.ok).toBe(true)
    expect(store.getSnapshot().state?.managedCount).toBe(0)
    expect(store.getSnapshot().busy).toBeNull()
  })

  test('account wrapper failures surface the error and clear the busy flag', async () => {
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async () => ({ ok: false, error: { message: 'already in progress' } })
    const store = createStore(harness.ctx)
    await store.load()

    const begun = await store.beginAccountLogin('anthropic')
    expect(begun).toEqual({ ok: false, error: 'already in progress' })
    const polled = await store.accountAttempt('la_1_ab')
    expect(polled).toEqual({ ok: false, error: 'already in progress' })
    const answered = await store.answerAccountPrompt('la_1_ab', 'x')
    expect(answered).toEqual({ ok: false, error: 'already in progress' })
    const activated = await store.activateAccount('anthropic', 'k_oauth1')
    expect(activated).toEqual({ ok: false, error: 'already in progress' })
    expect(store.getSnapshot().error).toBe('already in progress')
    expect(store.getSnapshot().busy).toBeNull()
  })
})
