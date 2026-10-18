import { describe, expect, test } from 'vitest'
import { apply } from '../src/client/index'
import { LOCALE_DICTS } from '../src/client/locales'
import { createStore } from '../src/client/store'
import type { ClientContext, LocaleDicts, RpcResult, StateView } from '../src/client/types'

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
    expect(typeof config?.component).toBe('function')
    expect(typeof cards[0]?.component).toBe('function')

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

  test('locale dictionaries are identical to the exported namespace payload', () => {
    expect(Object.keys(LOCALE_DICTS.zh).sort()).toEqual(Object.keys(LOCALE_DICTS.en).sort())
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

    const before = store.getSnapshot().now
    store.tick()
    expect(store.getSnapshot().now).toBeGreaterThanOrEqual(before)
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
