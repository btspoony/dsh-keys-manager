import { beforeAll, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { apply } from '../src/client/index'
import { createStore } from '../src/client/store'
import { cooldownMinutes, cooldownMs, graceMinutes, graceMs } from '../src/client/format'
import { RuntimeContext } from '../src/client/runtime'
import { KeysManagerBody, oauthCapable, originOf } from '../src/client/ui'
import type { AccountAttemptView, ClientContext, KeyView, LocaleDicts, ProviderView, RpcResult, Runtime, StateView, TransportAccountView } from '../src/client/types'

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
  // Dictionary values the UI tests resolve (N5): a stub t that echoes key
  // names can never catch a copy regression, so the surface under test is
  // rendered with real dictionary values.
  const labels: Record<string, string> = {
    nav: '密钥管理',
    accountIdentity: '账户',
    accountProjected: '服务中',
    adoptAccountTitle: '使用 OAuth 账户登录后即可使用该 Provider。',
    // Round-4 nit I-000087: the account row menu entries are located by
    // their resolved values, not by the stub's key-name echo.
    accountReauth: '重新认证',
    accountActivate: '设为当前',
    // Round-4 finding 4 (I-000085): both empty bodies resolve real copy so
    // the capability branch is asserted by value.
    noKeys: '还没有密钥。添加一个后即可使用该 Provider。',
    noKeysAccount: '还没有账户。添加一个账户后即可使用该 Provider。',
    // R5-N2: the whole login status set resolves real copy, so the dialog
    // assertions locate terminal/pending states by their values instead of
    // the stub's key-name echo.
    loginBrowserOpen: '在浏览器中打开',
    loginFlowEnded: '本次登录流程已结束，请关闭窗口后重新开始。',
    loginReady: '登录成功。',
    loginPending: '等待授权…',
    loginFailed: '登录失败',
    uses: '使用 {n} 次',
    failures: '失败 {n} 次',
    // R7 nit: the account-row status pill is asserted through the resolved
    // copy, so the whole visible status set is resolved — never the stub's
    // key-name echo. I-000105: `keyStatusPaused` joins the set so a paused
    // row can never fall back to rendering its key name.
    keyStatusActive: '正常',
    keyStatusCooling: '冷却中',
    // R9 nit: the cooling row's window lines are asserted through their
    // resolved copy, so the stub carries the same template the zh dictionary
    // registers (`{time} 恢复`).
    coolingUntil: '{time} 恢复',
    keyStatusPaused: '已暂停',
    keyStatusMissing: '凭证缺失',
    keyStatusEmpty: '暂无密钥',
    keyStatusUnmanaged: '未接管',
    unmanaged: '未接管',
    // C6-2: the flow-less route renders the unsupported headline; resolve
    // the real dictionary value instead of the key echo.
    unsupported: '暂不支持密钥池',
    // Round-3 N2: the delete-account copy is asserted through its
    // distinguishing phrases, so the stub resolves the real values.
    deleteAccountBody: '这会从凭证库中删除该账户保存的 OAuth 授权。如果它是当前账户，该 Provider 路由将停用它并回落到 API-key 池；Provider 仍保持接管状态。',
    deleteAccountBodyNoKeys: '这会从凭证库中删除该账户保存的 OAuth 授权。该路由没有 API-key 池，删除后将停止服务，直到重新登录账户。',
    // R6 nit: the last stub-echo locators now resolve real copy as well, so
    // every action these tests click is found by the text the UI renders —
    // never by the key-name echo of a translation the stub does not carry.
    addKey: '添加密钥',
    addAccount: '添加账户',
    adopt: '接管 Provider',
    loginPromptSubmit: '提交',
    delete: '删除',
    testKey: '测试连接',
    testRunning: '测试中…',
    testPassed: '连接正常 · {ms} ms',
    testFailed: '连接失败：{error}',
    // QC N6: the failure copy resolves real values too, so a deadline or an
    // answer without a reason is asserted by the text the UI renders.
    testTimedOut: '测试超时，未收到结果',
    testFailedUnknown: '测试未完成，未返回原因',
    // Transport account surface (`llm-omp-transports/<route>`): every copy the
    // row renders resolves its real zh value, so the assertions below locate
    // the section, status pill and dialogs by rendered text.
    transportAccounts: '传输账户',
    transportTag: '传输',
    transportSignIn: '登录',
    transportExpires: '有效期至 {time}',
    transportStatusActive: '正常',
    transportStatusExpired: '令牌已过期',
    transportStatusNeedsReauth: '需重新登录',
    transportStatusSignedOut: '未登录',
    transportRemoveTitle: '移除 {name} 传输账户？',
    transportRemoveBody: '这会从凭证库中删除该传输路由保存的授权，并取消仍在进行的登录；路由自身不会重建它。要恢复服务需要重新登录。',
    // Provider quick filter: the chip row resolves its real copy, so the set
    // and order are asserted by the value the UI renders.
    filterAll: '全部',
    filterBuiltin: '内置',
    filterPlugin: '插件',
    filterOauth: '支持 OAuth',
    filterTransport: '传输',
    availableEmpty: '没有匹配的 Provider。',
    // Managed section: its empty body distinguishes "none exist" from "the
    // active chip or the query hides them", so all values resolve real copy.
    managed: '已接管',
    managedEmpty: '还没有接管的 Provider。从下方选择一个开始。',
    managedFilteredEmpty: '当前筛选下没有已接管的 Provider。',
    noSearch: '换个关键词试试。',
    cancel: '取消',
    deleteConfirm: '确认删除',
    deleting: '删除中…',
  }
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

  test('the registered dictionaries carry the OAuth account key set in both languages', () => {
    // N3/N-C: key-set + non-empty assertion. The key set is derived from
    // the surfaces under test — the login dialog, the account row menu
    // (including the projection badge), and the delete-account dialog —
    // and must exist in the live registration source (LOCALE_DICTS) for
    // both languages, without mirroring every translation literal here.
    const oauthKeys = [
      'addAccount',
      'accountIdentity',
      'accountProjected',
      'accountReauth',
      'accountActivate',
      'adoptAccountTitle',
      'loginTitle',
      'loginPending',
      'loginBrowserOpen',
      'loginPromptTitle',
      'loginPromptSubmit',
      'loginFailed',
      'loginFlowEnded',
      'loginReady',
      'deleteAccountTitle',
      'deleteAccountBody',
      'deleteAccountBodyNoKeys',
      'noKeysAccount',
    ]
    const harness = makeContext()
    apply(harness.ctx)
    const dicts = harness.dictionaries.value
    expect(dicts).toBeDefined()
    for (const key of oauthKeys) {
      expect(typeof dicts!.en[key]).toBe('string')
      expect(dicts!.en[key]!.length).toBeGreaterThan(0)
      expect(typeof dicts!.zh[key]).toBe('string')
      expect(dicts!.zh[key]!.length).toBeGreaterThan(0)
      expect(dicts!.en[key]).not.toBe(dicts!.zh[key])
    }
    // Counter-parts asserted individually, never as a joined string.
    expect(dicts!.en.deleteAccountTitle).toContain('{alias}')
    expect(dicts!.zh.deleteAccountTitle).toContain('{alias}')
    expect(dicts!.en.deleteAccountBody).not.toBe(dicts!.en.deleteAccountBodyNoKeys)
    expect(dicts!.zh.deleteAccountBody).not.toBe(dicts!.zh.deleteAccountBodyNoKeys)
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

  // PR #26 review round 12: a dropped mutation view was re-read only from
  // `stateOutcome` and the row test's `finally`. A queued mutation behind it
  // that failed drained the queue without reading the dropped change, so the
  // successful rename stayed invisible until the next tick.
  test('a dropped mutation view is re-read when the queue drains on a failure', async () => {
    const state = makeState()
    const accountA = { ...makeOauthKey(), id: 'k_oauthA', alias: 'Account A', projected: true }
    const accountB = { ...makeOauthKey(), id: 'k_oauthB', alias: 'Account B' }
    state.providers[0] = { ...makeOauthProvider(), keys: [accountA, accountB] }
    // Inside the borrow window the host's route carries B's borrowed grant.
    const borrowed = structuredClone(state)
    for (const key of borrowed.providers[0]!.keys) {
      if (key.id === 'k_oauthA') delete key.projected
      if (key.id === 'k_oauthB') key.projected = true
    }
    // The rename the first mutation performed; its view was dropped, so only a
    // re-read can put it in the snapshot.
    const renamed = structuredClone(state)
    renamed.providers[0]!.keys.find(key => key.id === 'k_oauthA')!.alias = 'Account A renamed'
    let releaseTest!: (result: RpcResult) => void
    const testAnswer = new Promise<RpcResult>(resolve => { releaseTest = resolve })
    let releaseFailure!: () => void
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
    let loads = 0
    let mutations = 0
    const harness = makeContext({ ok: true, value: state })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') {
        loads += 1
        // The first load is the pre-test snapshot; every later read observes
        // the rename the dropped mutation performed.
        return { ok: true, value: loads === 1 ? state : renamed }
      }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      if (endpoint === 'keysManager/updateKey') {
        mutations += 1
        if (mutations === 1) return { ok: true, value: borrowed }
        await failureGate
        return { ok: false, error: { message: 'update failed' } }
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    await store.load()
    expect(loads).toBe(1)
    const aliasOf = (id: string) =>
      store.getSnapshot().state?.providers[0]?.keys.find(key => key.id === id)?.alias

    const test = store.testKey('zai-coding-cn', 'k_oauthB')
    // The first mutation succeeds inside the borrow window; its view is dropped.
    const first = await store.call('updateKey', { provider: 'zai-coding-cn', keyId: 'k_oauthA', patch: { alias: 'Account A renamed' } })
    expect(first.ok).toBe(true)
    // A second mutation queues behind the dropped one and fails once the test
    // settled: its tail is the only place the queue becomes idle.
    const second = store.call('updateKey', { provider: 'zai-coding-cn', keyId: 'k_oauthA', patch: { alias: 'x' } })
    releaseTest({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(await test).toEqual({ ok: true, value: { ok: true, latencyMs: 5 } })
    // The window closed, but the queued failure still holds the queue, so the
    // dropped change is not in the snapshot yet.
    expect(aliasOf('k_oauthA')).toBe('Account A')

    releaseFailure()
    expect((await second).ok).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    // The failing tail drained the queue, so the dropped view is re-read.
    expect(loads).toBe(2)
    expect(aliasOf('k_oauthA')).toBe('Account A renamed')
  })
})


describe('row test dispatch', () => {
  // PR #26 review round 8 (P2): the row test went through the mutation queue and
  // waited behind any pending mutation. Its UI deadline starts at the click, so
  // a test that ran after the row timed out kept borrowing the route invisibly,
  // and its late reply looked like a fresh failure.
  test('a row test is sent at once instead of queueing behind a mutation', async () => {
    const harness = makeContext()
    const sent: string[] = []
    let answerAddKey: ((result: RpcResult) => void) | undefined
    const parkedAnswer = new Promise<RpcResult>(resolve => { answerAddKey = resolve })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      sent.push(endpoint)
      if (endpoint === 'keysManager/addKey') return await parkedAnswer
      if (endpoint === 'keysManager/testKey') return { ok: true, value: { ok: true, latencyMs: 7 } }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const pending = store.call('addKey', { provider: 'zai-coding-cn', alias: 'later', value: 'sk-later' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent).toEqual(['keysManager/addKey'])

    const outcome = await Promise.race([
      store.testKey('zai-coding-cn', 'k_aaaaaaaa'),
      new Promise<'queued'>(resolve => setTimeout(() => resolve('queued'), 50)),
    ])
    expect(outcome).not.toBe('queued')
    if (outcome !== 'queued') expect(outcome).toEqual({ ok: true, value: { ok: true, latencyMs: 7 } })
    // Observation-only: the mutation keeps the busy slot, no snapshot
    // replacement, and the row test is never sent a second time.
    expect(store.getSnapshot().busy).toBe('addKey')
    expect(sent.filter(endpoint => endpoint === 'keysManager/testKey')).toHaveLength(1)

    answerAddKey!({ ok: true, value: makeState() })
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent.filter(endpoint => endpoint === 'keysManager/testKey')).toHaveLength(1)
    expect(store.getSnapshot().busy).toBeNull()
  })

  // PR #26 review round 9 (R8-1): a row test borrows the route's projection
  // while it runs and the host restores the previous owner before answering.
  // A refresh landing inside that window used to store the borrowed snapshot,
  // leaving the tested row marked as serving (with its activation disabled)
  // until the next tick.
  test('a snapshot taken while a row test borrows the route never lands', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    let loads = 0
    let answerRefresh: ((result: RpcResult) => void) | undefined
    let releaseTest!: (result: RpcResult) => void
    const testAnswer = new Promise<RpcResult>(resolve => { releaseTest = resolve })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') {
        loads += 1
        // The refresh the user starts during the borrow sees the tested row
        // projected; the test's restore makes that answer stale.
        if (loads > 1) return await new Promise<RpcResult>(resolve => { answerRefresh = resolve })
        return { ok: true, value: state }
      }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    await store.load()
    expect(store.getSnapshot().state?.providers[0]?.keys[0]?.projected).toBeUndefined()

    const test = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
    void store.load()
    await new Promise(resolve => setTimeout(resolve, 0))
    answerRefresh!({ ok: true, value: borrowed })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The borrowed snapshot is dropped; the pre-test snapshot (the route the
    // test restores) is what the page keeps showing.
    expect(store.getSnapshot().state?.providers[0]?.keys[0]?.projected).toBeUndefined()
    expect(store.getSnapshot().busy).toBeNull()

    releaseTest({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(await test).toEqual({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(store.getSnapshot().state?.providers[0]?.keys[0]?.projected).toBeUndefined()
  })

  // PR #26 review round 10 (I-000178): `load` learned to drop a snapshot taken
  // inside the borrow window, but a mutation's own StateView comes from that
  // same window. Renaming another row while B is under test stored
  // `B.projected = true`, so B kept its "serving" badge and its activation
  // stayed disabled after the host restored A.
  test('a mutation view taken while a row test borrows the route never lands', async () => {
    const state = makeState()
    const projected = { ...makeOauthKey(), id: 'k_oauthA', alias: 'Account A', projected: true }
    const tested = { ...makeOauthKey(), id: 'k_oauthB', alias: 'Account B' }
    state.providers[0] = { ...makeOauthProvider(), keys: [projected, tested] }
    // Inside the window the host's route carries B's borrowed grant.
    const borrowed = structuredClone(state)
    for (const key of borrowed.providers[0]!.keys) {
      if (key.id === 'k_oauthA') delete key.projected
      if (key.id === 'k_oauthB') key.projected = true
    }
    const harness = makeContext({ ok: true, value: state })
    let releaseTest!: (result: RpcResult) => void
    const testAnswer = new Promise<RpcResult>(resolve => { releaseTest = resolve })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      if (endpoint === 'keysManager/updateKey') return { ok: true, value: borrowed }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    await store.load()
    const rowProjected = (id: string) =>
      store.getSnapshot().state?.providers[0]?.keys.find(key => key.id === id)?.projected

    const test = store.testKey('zai-coding-cn', 'k_oauthB')
    const rename = await store.call('updateKey', {
      provider: 'zai-coding-cn',
      keyId: 'k_oauthA',
      patch: { alias: 'Account A renamed' },
    })
    expect(rename.ok).toBe(true)
    // The mutation succeeded, but its view belongs to the borrow window: the
    // tested row is not shown as serving, and the pre-window account still is
    // (so B's Set active stays enabled).
    expect(rowProjected('k_oauthB')).toBeUndefined()
    expect(rowProjected('k_oauthA')).toBe(true)

    releaseTest({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(await test).toEqual({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(rowProjected('k_oauthB')).toBeUndefined()
    expect(rowProjected('k_oauthA')).toBe(true)
  })

  // PR #26 review round 24 (P2): the client deadline released the row but also
  // ended the snapshot isolation while the RPC kept running, so a refresh that
  // started after it stored the projected test account. The window now lasts
  // until the RPC actually settles.
  test('a timed-out row test keeps dropping snapshots until its RPC settles', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    let releaseTest!: (result: RpcResult) => void
    const testAnswer = new Promise<RpcResult>(resolve => { releaseTest = resolve })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: borrowed }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      if (endpoint === 'keysManager/deleteKey') return { ok: true, value: borrowed }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const rowProjected = () => store.getSnapshot().state?.providers[0]?.keys[0]?.projected

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const test = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
      // The deadline releases the row while the host still owes an answer.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await test).toEqual({ ok: false, error: 'testKey did not answer within 30s' })

      // A refresh started after the deadline belongs to the same borrow window.
      await store.load()
      expect(rowProjected()).toBeUndefined()

      // A state-carrying mutation's view is dropped the same way.
      const mutation = await store.call('deleteKey', { provider: 'zai-coding-cn', keyId: 'k_aaaaaaaa' })
      expect(mutation.ok).toBe(true)
      expect(rowProjected()).toBeUndefined()

      // The RPC settles: the window closes and the deferred read lands.
      releaseTest({ ok: true, value: { ok: false, latencyMs: 0, error: 'timeout' } })
      await Promise.resolve()
      await Promise.resolve()
      await store.load()
      expect(rowProjected()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // PR #26 review round 26 (P2): the round-24 window had a fixed cap
  // (`deadline + 5s`). A row test whose RPC outlived it lost the snapshot
  // isolation while the host still held the tested projection, so a refresh
  // could store that projection. The window now lasts until the RPC settles.
  test('a timed-out row test keeps snapshot isolation past the old cap', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    let releaseTest!: (result: RpcResult) => void
    const testAnswer = new Promise<RpcResult>(resolve => { releaseTest = resolve })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: borrowed }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const rowProjected = () => store.getSnapshot().state?.providers[0]?.keys[0]?.projected

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const test = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
      // The row deadline ends the row while the host still owes an answer.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await test).toEqual({ ok: false, error: 'testKey did not answer within 30s' })

      // Well past the cap the round-24 code used, the RPC still borrows the
      // route, so the borrowed snapshot is still dropped.
      await vi.advanceTimersByTimeAsync(25_000)
      await store.load()
      expect(rowProjected()).toBeUndefined()

      // The RPC settles: the isolation ends and a read lands again.
      releaseTest({ ok: true, value: { ok: true, latencyMs: 9 } })
      await vi.advanceTimersByTimeAsync(0)
      await store.load()
      expect(rowProjected()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // PR #26 review round 26 (P2): the window is also released by a rejecting
  // RPC, not by a cap, and the late rejection stays out of the snapshot.
  test('a timed-out row test keeps snapshot isolation when the RPC rejects', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    let failTest!: (error: Error) => void
    const testAnswer = new Promise<RpcResult>((_resolve, reject) => { failTest = reject })
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: borrowed }
      if (endpoint === 'keysManager/testKey') return await testAnswer
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const rowProjected = () => store.getSnapshot().state?.providers[0]?.keys[0]?.projected

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const test = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await test).toEqual({ ok: false, error: 'testKey did not answer within 30s' })
      await vi.advanceTimersByTimeAsync(25_000)
      await store.load()
      expect(rowProjected()).toBeUndefined()

      // The rejected RPC ends the borrow; nothing about it reaches the snapshot.
      failTest(new Error('route closed'))
      await vi.advanceTimersByTimeAsync(0)
      await store.load()
      expect(rowProjected()).toBe(true)
      expect(store.getSnapshot().error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // PR #26 review round 26 (P2): the isolation release is owned by the request
  // that opened the window. An older request settling later must not close the
  // newer window nor invalidate the reads that belong to it.
  test('an old settled request does not clear a newer test isolation', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    const answers: Array<(result: RpcResult) => void> = []
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: borrowed }
      if (endpoint === 'keysManager/testKey') {
        return await new Promise<RpcResult>(resolve => { answers.push(resolve) })
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const rowProjected = () => store.getSnapshot().state?.providers[0]?.keys[0]?.projected

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const first = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await first).toEqual({ ok: false, error: 'testKey did not answer within 30s' })

      // A second test starts after the first row already timed out.
      const second = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await second).toEqual({ ok: false, error: 'testKey did not answer within 30s' })

      // The older RPC settles first; the newer one still borrows the route.
      answers[0]!({ ok: true, value: { ok: true, latencyMs: 3 } })
      await vi.advanceTimersByTimeAsync(0)
      await store.load()
      expect(rowProjected()).toBeUndefined()

      // Only the newer RPC settling ends the isolation.
      answers[1]!({ ok: true, value: { ok: false, latencyMs: 0, error: 'timeout' } })
      await vi.advanceTimersByTimeAsync(0)
      await store.load()
      expect(rowProjected()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // PR #26 review round 28 (I-000178 occurrence): the generation used to move
  // only when the SETTLING request owned the newest token. With A under test and
  // B started after it, B settled first and moved the generation, a refresh
  // started during A captured that newer generation, and A's settlement left it
  // untouched — so a snapshot taken inside A's own borrow installed the borrowed
  // view after the host had already restored the route.
  test('a settling test invalidates the snapshots of its own borrow, not only the newest', async () => {
    const state = makeState()
    const borrowed = structuredClone(state)
    borrowed.providers[0]!.keys[0]!.projected = true
    const harness = makeContext({ ok: true, value: state })
    const answers: Array<(result: RpcResult) => void> = []
    let answerRefresh: ((result: RpcResult) => void) | undefined
    let loads = 0
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') {
        loads += 1
        // The read the test parks is the one taken inside A's borrow.
        if (loads === 2) return await new Promise<RpcResult>(resolve => { answerRefresh = resolve })
        return { ok: true, value: state }
      }
      if (endpoint === 'keysManager/testKey') {
        return await new Promise<RpcResult>(resolve => { answers.push(resolve) })
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    const rowProjected = () => store.getSnapshot().state?.providers[0]?.keys[0]?.projected
    await store.load()
    expect(rowProjected()).toBeUndefined()

    const first = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
    const second = store.testKey('zai-coding-cn', 'k_aaaaaaaa')
    await new Promise(resolve => setTimeout(resolve, 0))
    // B owns the newest token and settles first.
    answers[1]!({ ok: true, value: { ok: true, latencyMs: 3 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    // A refresh starts inside A's still-open borrow and captures the generation
    // B's settlement left behind.
    const refresh = store.load()
    await new Promise(resolve => setTimeout(resolve, 0))
    // A settles: not the newest token, but this window is its own.
    answers[0]!({ ok: true, value: { ok: true, latencyMs: 5 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    answerRefresh!({ ok: true, value: borrowed })
    await refresh
    expect(rowProjected()).toBeUndefined()
    expect(store.getSnapshot().busy).toBeNull()

    expect(await first).toEqual({ ok: true, value: { ok: true, latencyMs: 5 } })
    expect(await second).toEqual({ ok: true, value: { ok: true, latencyMs: 3 } })
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


describe('transport account store', () => {
  function makeTransportAttempt(): AccountAttemptView {
    return { id: 'la_2_cd', provider: 'cursor', status: 'pending', notices: [], createdAt: 3, updatedAt: 4 }
  }

  test('transport wrappers post the route and adopt the returned state', async () => {
    const harness = makeContext()
    const sent: Array<{ endpoint: string; payload: unknown }> = []
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      sent.push({ endpoint, payload })
      if (endpoint === 'keysManager/getState') return { ok: true, value: makeState() }
      if (endpoint === 'keysManager/beginTransportLogin') return { ok: true, value: makeTransportAttempt() }
      const state = makeState()
      state.transportAccounts = [{
        id: 'cursor',
        scope: 'llm-omp-transports/cursor',
        displayName: 'Cursor',
        status: 'active',
        active: true,
      }]
      return { ok: true, value: state }
    }
    const store = createStore(harness.ctx)
    await store.load()

    const begun = await store.beginTransportLogin('cursor')
    expect(begun.ok).toBe(true)
    if (begun.ok) expect(begun.value?.id).toBe('la_2_cd')
    expect(sent.at(-1)).toEqual({ endpoint: 'keysManager/beginTransportLogin', payload: { args: { provider: 'cursor' } } })

    const activated = await store.activateTransportAccount('cursor')
    expect(activated.ok).toBe(true)
    expect(sent.at(-1)).toEqual({ endpoint: 'keysManager/activateTransportAccount', payload: { args: { provider: 'cursor' } } })
    expect(store.getSnapshot().state?.transportAccounts?.[0]?.status).toBe('active')

    const removed = await store.removeTransportAccount('cursor')
    expect(removed.ok).toBe(true)
    expect(sent.at(-1)).toEqual({ endpoint: 'keysManager/removeTransportAccount', payload: { args: { provider: 'cursor' } } })
    expect(store.getSnapshot().busy).toBeNull()
  })
})


/**
 * Minimal React test renderer for the no-DOM vitest environment.
 *
 * The client bundle deliberately ships without react-dom and the repo adds no
 * test-only renderer, so rendering tests drive the real hooks dispatcher:
 * components run for real and produce plain element trees, while per-position
 * hook chains keep component state across re-renders. Effects run only inside
 * `flush()` and no DOM is ever touched.
 */
type FlatNode = { type: unknown; props: Record<string, unknown> | null; text: string; path: string }

const reactInternals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((item, index) => Object.is(item, b[index]))
}

function setRuntimeContext(runtime: Runtime | null): void {
  ;(RuntimeContext as unknown as { _currentValue?: unknown })._currentValue = runtime
}

function mountView(component: (props: Record<string, unknown>) => React.ReactElement | null, props: Record<string, unknown> = {}) {
  const pool = new Map<string, { records: Array<{ kind: string; value: any }>; cursor: number }>()
  const effectQueue: Array<{ record: { kind: string; value: any }; run: () => void | (() => void) }> = []
  let nodes: FlatNode[] = []
  let currentChain: { records: Array<{ kind: string; value: any }>; cursor: number } | null = null
  let rendering = false
  let dirty = false

  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  function renderAll(): void {
    if (rendering) {
      dirty = true
      return
    }
    rendering = true
    dirty = false
    try {
      nodes = []
      renderElement(React.createElement(component, props), 'root')
    } finally {
      rendering = false
    }
    if (dirty) renderAll()
  }

  function renderElement(node: unknown, path: string): string {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') {
      nodes.push({ type: null, props: null, text: String(node), path })
      return String(node)
    }
    if (Array.isArray(node)) {
      return node.map((child, index) => renderElement(child, `${path}/${index}`)).join('')
    }
    const element = node as { type: unknown; props: Record<string, unknown> | null; key?: unknown }
    if (typeof element.type === 'function') {
      const name = (element.type as { name?: string }).name ?? 'anon'
      const chainKey = `${path}#${name}`
      let chain = pool.get(chainKey)
      if (chain === undefined) {
        chain = { records: [], cursor: 0 }
        pool.set(chainKey, chain)
      }
      const previousChain = currentChain
      const previousDispatcher = reactInternals.ReactCurrentDispatcher.current
      currentChain = chain
      reactInternals.ReactCurrentDispatcher.current = dispatcher
      let output: unknown
      try {
        chain.cursor = 0
        output = (element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {})
      } finally {
        reactInternals.ReactCurrentDispatcher.current = previousDispatcher
        currentChain = previousChain
      }
      return renderElement(output, chainKey)
    }
    const text = renderElement((element.props?.children ?? null) as unknown, `${path}>`)
    nodes.push({ type: element.type, props: element.props, text, path })
    return text
  }

  function nextRecord(kind: string, create: () => unknown): { kind: string; value: any } {
    const chain = currentChain
    if (chain === null) throw new Error('hook called outside of a rendered component')
    if (chain.cursor >= chain.records.length) chain.records.push({ kind, value: create() })
    const record = chain.records[chain.cursor]!
    if (record.kind !== kind) throw new Error(`hook order changed: expected ${record.kind}, got ${kind}`)
    chain.cursor += 1
    return record
  }

  const scheduleRender = (): void => renderAll()

  const dispatcher = {
    useState(initial: unknown): [unknown, (action: unknown) => void] {
      const holder = nextRecord('state', () => {
        const cell = {
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
          set(action: unknown): void {
            const next = typeof action === 'function' ? (action as (current: unknown) => unknown)(cell.value) : action
            if (!Object.is(next, cell.value)) {
              cell.value = next
              scheduleRender()
            }
          },
        }
        return cell
      }).value as { value: unknown; set: (action: unknown) => void }
      return [holder.value, holder.set]
    },
    useRef(initial: unknown): { current: unknown } {
      return nextRecord('ref', () => ({ current: initial })).value
    },
    useMemo(factory: () => unknown, deps: unknown[]): unknown {
      const cell = nextRecord('memo', () => ({ cached: undefined as unknown, deps: undefined as unknown[] | undefined })).value as { cached: unknown; deps: unknown[] | undefined }
      if (cell.deps === undefined || !depsEqual(cell.deps, deps)) {
        cell.cached = factory()
        cell.deps = deps
      }
      return cell.cached
    },
    useCallback(fn: unknown, deps: unknown[]): unknown {
      return dispatcher.useMemo(() => fn, deps)
    },
    useEffect(run: () => void | (() => void), deps: unknown[]): void {
      const record = nextRecord('effect', () => ({ deps: undefined as unknown[] | undefined, queued: false, cleanup: undefined as (() => void) | undefined }))
      const cell = record.value as { deps: unknown[] | undefined; queued: boolean; cleanup?: () => void }
      if (cell.deps === undefined || !depsEqual(cell.deps, deps)) {
        cell.deps = deps
        if (!cell.queued) {
          cell.queued = true
          effectQueue.push({ record, run })
        }
      }
    },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown): unknown {
      const cell = nextRecord('store', () => ({ value: undefined as unknown, unsubscribe: undefined as (() => void) | undefined })).value as { value: unknown; unsubscribe?: () => void }
      cell.value = getSnapshot()
      if (cell.unsubscribe === undefined) cell.unsubscribe = subscribe(scheduleRender)
      return cell.value
    },
    useContext(ctx: { _currentValue?: unknown }): unknown {
      return ctx._currentValue
    },
    useId(): string { return 'km-test-id' },
    useDebugValue(): void {},
    useImperativeHandle(): void {},
    useLayoutEffect(run: () => void | (() => void), deps: unknown[]): void { dispatcher.useEffect(run, deps) },
    useInsertionEffect(run: () => void | (() => void), deps: unknown[]): void { dispatcher.useEffect(run, deps) },
    useTransition(): [boolean, (callback: () => void) => void] { return [false, (callback: () => void) => callback()] },
    useDeferredValue(value: unknown): unknown { return value },
  }

  renderAll()

  return {
    get nodes(): FlatNode[] { return nodes },
    render(): FlatNode[] {
      renderAll()
      return nodes
    },
    async flush(): Promise<void> {
      let guard = 0
      while (effectQueue.length > 0 && guard < 25) {
        const batch = effectQueue.splice(0)
        for (const entry of batch) {
          const cell = entry.record.value as { queued: boolean; cleanup?: () => void }
          cell.cleanup?.()
          const cleanup = entry.run()
          cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
          cell.queued = false
        }
        await tick()
      }
      await tick()
    },
    unmount(): void {
      for (const chain of pool.values()) {
        for (const record of [...chain.records].reverse()) {
          const cell = record.value as { cleanup?: () => void; unsubscribe?: () => void }
          if (record.kind === 'effect') cell.cleanup?.()
          if (record.kind === 'store') cell.unsubscribe?.()
        }
      }
      pool.clear()
    },
  }
}

function hostNodes(nodes: FlatNode[]): FlatNode[] {
  return nodes.filter(node => typeof node.type === 'string')
}

function findByClass(nodes: FlatNode[], className: string): FlatNode[] {
  return hostNodes(nodes).filter(node => String((node.props?.className as string | undefined) ?? '').split(/\s+/).includes(className))
}

function findButtons(nodes: FlatNode[], needle: string): FlatNode[] {
  return hostNodes(nodes).filter(node => node.type === 'button' && node.text.includes(needle))
}

function descendants(nodes: FlatNode[], ancestor: FlatNode): FlatNode[] {
  return nodes.filter(node => node.path.startsWith(ancestor.path))
}

function makeOauthKey(): KeyView {
  const base = makeState().providers[0]!.keys[0]!
  return {
    ...base,
    id: 'k_oauth9',
    alias: 'Work account',
    importedFrom: null,
    kind: 'oauth',
    totalUses: 3,
    totalFailures: 1,
    oauth: { provider: 'zai-coding-cn', email: 'work@anthropic.example', accountId: 'acc_9', expiresAt: Date.now() + 3_600_000 },
  }
}

function makeOauthProvider(): ProviderView {
  const base = makeState().providers[0]!
  return {
    ...base,
    nativeAuth: { env: ['ZAI_CODING_CN_API_KEY'], oauth: true },
    keys: [makeOauthKey(), makeState().providers[0]!.keys[0]!],
  }
}

/** One `llm-omp-transports/<route>` row as the host projects it. */
function makeTransportAccount(overrides: Partial<TransportAccountView> = {}): TransportAccountView {
  return {
    id: 'cursor',
    scope: 'llm-omp-transports/cursor',
    displayName: 'Cursor',
    email: 'dev@cursor.example',
    accountId: 'user_1',
    expiresAt: Date.now() + 3_600_000,
    status: 'active',
    active: true,
    ...overrides,
  }
}

function makeTransportAttemptView(): AccountAttemptView {
  return { id: 'la_2_cd', provider: 'cursor', status: 'pending', notices: [], createdAt: 3, updatedAt: 4 }
}

function makeAttemptView(): AccountAttemptView {
  return {
    id: 'la_1_ab',
    provider: 'zai-coding-cn',
    alias: 'Work account',
    status: 'prompt',
    notices: [{ message: 'Open this page to continue signing in.', url: 'https://example.com/authorize' }],
    prompt: { kind: 'text', message: 'Paste the verification code' },
    createdAt: 1,
    updatedAt: 2,
  }
}

function makePendingAttemptView(): AccountAttemptView {
  return { ...makeAttemptView(), status: 'pending', prompt: undefined }
}

function makeReadyAttemptView(): AccountAttemptView {
  return { ...makeAttemptView(), status: 'ready', prompt: undefined, accountId: 'k_oauth9', updatedAt: 3 }
}

/** A parked select prompt: a closed choice the dialog must start on. */
function makeSelectAttemptView(options: Array<{ id: string; label: string }>): AccountAttemptView {
  return { ...makeAttemptView(), prompt: { kind: 'select', message: 'Choose the account to continue with', options } }
}

/**
 * Parity for one key set: present and non-empty in every registered locale,
 * translated rather than copied, and identical to the packaged
 * locale/*.json copy the host loads.
 */
function expectLocaleParity(keys: readonly string[]): LocaleDicts {
  const harness = makeContext()
  apply(harness.ctx)
  const dicts = harness.dictionaries.value
  expect(dicts).toBeDefined()
  const enJson = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')) as Record<string, string>
  const zhJson = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8')) as Record<string, string>
  for (const key of keys) {
    expect(typeof dicts!.en[key]).toBe('string')
    expect(typeof dicts!.zh[key]).toBe('string')
    expect(dicts!.en[key]!.length).toBeGreaterThan(0)
    expect(dicts!.zh[key]!.length).toBeGreaterThan(0)
    expect(dicts!.zh[key]).not.toBe(dicts!.en[key])
    // The packaged copy the host loads is a second source of the same value.
    expect(dicts!.en[key]).toBe(enJson[key])
    expect(dicts!.zh[key]).toBe(zhJson[key])
  }
  for (const cleanup of harness.cleanups.reverse()) cleanup()
  return dicts!
}

describe('account ui', () => {
  beforeAll(() => {
    // The node test environment has no DOM; modal effects only need the
    // document surface to exist so their focus/inert bookkeeping can no-op.
    ;(globalThis as unknown as { document?: unknown }).document = {
      getElementById: () => null,
      createElement: () => ({ remove() {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      activeElement: null,
      body: {},
      head: { appendChild: () => {} },
    }
    ;(globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = class FakeHTMLElement {}
  })

  test('oauth-capable managed providers show Add account beside Add key; others keep Add key only', async () => {
    const state = makeState()
    state.providers[0]!.nativeAuth = { env: ['ZAI_CODING_CN_API_KEY'], oauth: true }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    const head = findByClass(view.nodes, 'km-provider-head')[0]
    expect(head).toBeDefined()
    ;(head!.props!.onClick as () => void)()
    view.render()

    expect(findButtons(view.nodes, '添加密钥')).toHaveLength(1)
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(1)
    view.unmount()

    // A provider without native OAuth keeps the single Add key entry.
    const plainHarness = makeContext()
    const plainStore = createStore(plainHarness.ctx)
    setRuntimeContext({ ctx: plainHarness.ctx, store: plainStore })
    const plainView = mountView(KeysManagerBody)
    await plainView.flush()
    const plainHead = findByClass(plainView.nodes, 'km-provider-head')[0]
    expect(plainHead).toBeDefined()
    ;(plainHead!.props!.onClick as () => void)()
    plainView.render()
    expect(findButtons(plainView.nodes, '添加密钥')).toHaveLength(1)
    expect(findButtons(plainView.nodes, '添加账户')).toHaveLength(0)
    plainView.unmount()
    setRuntimeContext(null)
  })

  test('unmanaged OAuth-capable providers enable Adopt and offer Add account; Add key stays gated by key support', async () => {
    // MF1: an OAuth-only route is adoptable for accounts even though the
    // key pool does not apply — Adopt is enabled, Add account rides the
    // adopt flow, and Add key stays disabled on the managed route.
    const unmanaged = makeState()
    unmanaged.providers[0] = {
      ...makeState().providers[0]!,
      provider: 'openai-codex',
      displayName: 'OpenAI Codex',
      managed: false,
      configured: false,
      active: false,
      supported: false,
      accountSupported: true,
      reason: 'Uses ChatGPT OAuth sign-in only; no API-key credential',
      nativeAuth: { env: [], oauth: true },
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'unmanaged',
      keys: [],
    }
    const harness = makeContext({ ok: true, value: unmanaged })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    const head = findByClass(view.nodes, 'km-provider-head')[0]
    expect(head).toBeDefined()
    ;(head!.props!.onClick as () => void)()
    view.render()

    const adopt = findButtons(view.nodes, '接管 Provider')[0]
    expect(adopt).toBeDefined()
    expect(adopt!.props!.disabled).toBe(false)
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(1)
    // I-000063: the adopt panel headline resolves the account title, not
    // the unsupported reason — assert the dictionary value, never the key.
    const adoptTitle = findByClass(view.nodes, 'km-adopt-title')[0]
    expect(adoptTitle).toBeDefined()
    expect(adoptTitle!.text).toBe('使用 OAuth 账户登录后即可使用该 Provider。')
    view.unmount()

    // On the managed OAuth-only route, Add key is disabled (server refuses
    // it too) while Add account stays available.
    const managed = makeState()
    managed.providers[0] = {
      ...makeOauthProvider(),
      supported: false,
      accountSupported: true,
      reason: 'Uses ChatGPT OAuth sign-in only; no API-key credential',
    }
    const managedHarness = makeContext({ ok: true, value: managed })
    const managedStore = createStore(managedHarness.ctx)
    setRuntimeContext({ ctx: managedHarness.ctx, store: managedStore })
    const managedView = mountView(KeysManagerBody)
    await managedView.flush()
    const managedHead = findByClass(managedView.nodes, 'km-provider-head')[0]
    expect(managedHead).toBeDefined()
    ;(managedHead!.props!.onClick as () => void)()
    managedView.render()
    const addKey = findButtons(managedView.nodes, '添加密钥')[0]
    expect(addKey).toBeDefined()
    expect(addKey!.props!.disabled).toBe(true)
    expect(findButtons(managedView.nodes, '添加账户')).toHaveLength(1)
    managedView.unmount()
    setRuntimeContext(null)
  })

  test('a legacy snapshot without accountSupported keeps Adopt and the empty state consistent (R5-N3)', async () => {
    // R5-N3: the adopt gate read `accountSupported === true` while the
    // empty-state gate read oauthCapable(), which treats a missing host
    // verdict as supported. On a snapshot that predates the field the two
    // gates disagreed: the adopt panel claimed the provider was unsupported
    // and disabled Adopt while Add account was offered beside it. Both gates
    // now derive from oauthCapable().
    const reason = 'Uses ChatGPT OAuth sign-in only; no API-key credential'
    const legacy = makeState()
    legacy.providers[0] = {
      ...makeState().providers[0]!,
      provider: 'openai-codex',
      displayName: 'OpenAI Codex',
      managed: false,
      configured: false,
      active: false,
      supported: false,
      // Deliberately absent: the pre-C6-2 host snapshot shape.
      reason,
      nativeAuth: { env: [], oauth: true },
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'unmanaged',
      keys: [],
    }
    const harness = makeContext({ ok: true, value: legacy })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    expect(findButtons(view.nodes, '接管 Provider')[0]!.props!.disabled).toBe(false)
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(1)
    expect(findByClass(view.nodes, 'km-adopt-title')[0]!.text).toBe('使用 OAuth 账户登录后即可使用该 Provider。')
    view.unmount()

    // The empty-state gate agrees on the same snapshot: a managed legacy
    // route with no keys invites a sign-in instead of claiming an
    // unsupported verdict it does not mean.
    const managed = makeState()
    managed.providers[0] = {
      ...makeOauthProvider(),
      supported: false,
      reason,
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'empty',
      keys: [],
    }
    const managedHarness = makeContext({ ok: true, value: managed })
    const managedStore = createStore(managedHarness.ctx)
    setRuntimeContext({ ctx: managedHarness.ctx, store: managedStore })
    const managedView = mountView(KeysManagerBody)
    await managedView.flush()
    ;(findByClass(managedView.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    managedView.render()
    expect(findByClass(managedView.nodes, 'km-empty-keys')[0]!.text).toContain('还没有账户。添加一个账户后即可使用该 Provider。')
    expect(findByClass(managedView.nodes, 'km-empty-keys')[0]!.text).not.toContain('暂不支持密钥池')
    managedView.unmount()
    setRuntimeContext(null)
  })

  test('a nativeAuth.oauth route without a registered flow hides Add account (C6-2)', async () => {
    // C6-2: the catalog flag says the provider supports OAuth upstream, but
    // the host verdict says no flow can begin here. The sign-in entry must be
    // hidden — offering it would open a dialog whose begin() fails.
    const reason = 'This provider has no OAuth sign-in flow registered in this Harness build'
    const unmanaged = makeState()
    unmanaged.providers[0] = {
      ...makeState().providers[0]!,
      provider: 'google-gemini-cli',
      displayName: 'Google Gemini CLI',
      managed: false,
      configured: false,
      active: false,
      supported: false,
      accountSupported: false,
      reason,
      nativeAuth: { env: [], oauth: true },
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'unmanaged',
      keys: [],
    }
    const harness = makeContext({ ok: true, value: unmanaged })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    const head = findByClass(view.nodes, 'km-provider-head')[0]
    expect(head).toBeDefined()
    ;(head!.props!.onClick as () => void)()
    view.render()
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(0)
    // Neither capability exists, so Adopt is disabled and the unsupported
    // headline carries the host's truthful reason instead of a sign-in
    // invitation only the flow-less route cannot honour.
    expect(findButtons(view.nodes, '接管 Provider')[0]!.props!.disabled).toBe(true)
    expect(findByClass(view.nodes, 'km-adopt-title')[0]!.text).toBe('暂不支持密钥池')
    expect(view.nodes.map(node => node.text)).toContain(reason)
    view.unmount()

    // The same verdict on a managed route hides Add account beside the
    // (disabled) Add key entry.
    const managed = makeState()
    managed.providers[0] = {
      ...makeOauthProvider(),
      supported: false,
      accountSupported: false,
      reason,
    }
    const managedHarness = makeContext({ ok: true, value: managed })
    const managedStore = createStore(managedHarness.ctx)
    setRuntimeContext({ ctx: managedHarness.ctx, store: managedStore })
    const managedView = mountView(KeysManagerBody)
    await managedView.flush()
    const managedHead = findByClass(managedView.nodes, 'km-provider-head')[0]
    expect(managedHead).toBeDefined()
    ;(managedHead!.props!.onClick as () => void)()
    managedView.render()
    expect(findButtons(managedView.nodes, '添加账户')).toHaveLength(0)
    expect(findButtons(managedView.nodes, '添加密钥')[0]!.props!.disabled).toBe(true)
    managedView.unmount()
    setRuntimeContext(null)
  })

  test('a managed flow-less route states the unsupported verdict instead of inviting a key (C6-2/M1)', async () => {
    // M1: C6-2 makes a managed route with nativeAuth.oauth but no enumerable
    // flow reachable. Neither capability exists there, so the empty body must
    // not invite a key beside the disabled Add key — it states the truthful
    // unsupported verdict (the same copy the adopt headline uses).
    const reason = 'This provider has no OAuth sign-in flow registered in this Harness build'
    const state = makeState()
    state.providers[0] = {
      ...makeOauthProvider(),
      supported: false,
      accountSupported: false,
      reason,
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'empty',
      keys: [],
    }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const empty = findByClass(view.nodes, 'km-empty-keys')[0]
    expect(empty).toBeDefined()
    // R5-N1: the flow-less verdict is visible text, not only the disabled Add
    // key's hover title — the empty body states the unsupported headline AND
    // the host's real reason, exactly like the unmanaged adopt panel does.
    expect(empty!.text).toContain('暂不支持密钥池')
    expect(empty!.text).toContain(reason)
    expect(empty!.text).not.toContain('还没有密钥。添加一个后即可使用该 Provider。')
    expect(findButtons(view.nodes, '添加密钥')[0]!.props!.disabled).toBe(true)
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(0)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a managed keyless provider renders the empty-state pill, not the unmanaged label', async () => {
    // Round-3 finding 7: adopting an OAuth-only route sits at
    // managed + zero keys until the first sign-in; the pill must read as
    // the empty state, never as "Not managed" beside the Managed badge.
    const state = makeState()
    state.providers[0] = { ...makeOauthProvider(), keyCount: 0, healthyKeyCount: 0, status: 'empty', keys: [] }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    const head = findByClass(view.nodes, 'km-provider-head')[0]
    expect(head).toBeDefined()
    const headText = descendants(view.nodes, head!).map(node => node.text).filter(Boolean)
    expect(headText).toContain('暂无密钥')
    expect(headText).not.toContain('未接管')
    view.unmount()
    setRuntimeContext(null)

    // The unmanaged route keeps the default arm.
    const unmanaged = makeState()
    const unmanagedHarness = makeContext({ ok: true, value: unmanaged })
    const unmanagedStore = createStore(unmanagedHarness.ctx)
    setRuntimeContext({ ctx: unmanagedHarness.ctx, store: unmanagedStore })
    const unmanagedView = mountView(KeysManagerBody)
    await unmanagedView.flush()
    const deepInfraHead = findByClass(unmanagedView.nodes, 'km-provider-head')[1]
    expect(deepInfraHead).toBeDefined()
    const deepInfraText = descendants(unmanagedView.nodes, deepInfraHead!).map(node => node.text).filter(Boolean)
    expect(deepInfraText).toContain('未接管')
    expect(deepInfraText).not.toContain('暂无密钥')
    unmanagedView.unmount()
    setRuntimeContext(null)
  })

  test('an OAuth-only keyless route invites a sign-in instead of telling the user to add a key (I-000085)', async () => {
    // Round-4 finding 4: on a managed route with no key capability, Add key
    // is disabled, so the empty body must invite the only available action
    // (Add account) rather than "Add one".
    const state = makeState()
    state.providers[0] = {
      ...makeOauthProvider(),
      supported: false,
      accountSupported: true,
      reason: 'Uses ChatGPT OAuth sign-in only; no API-key credential',
      keyCount: 0,
      healthyKeyCount: 0,
      status: 'empty',
      keys: [],
    }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const empty = findByClass(view.nodes, 'km-empty-keys')[0]
    expect(empty).toBeDefined()
    // The sign-in invitation, resolved from the dictionary — never the
    // key-capable "Add one" copy, and never the raw key name. R5-N1 appends
    // the host's reason beneath every key-unsupported empty body (the same
    // rule the unmanaged adopt panel applies), so the copy is matched rather
    // than pinned to the whole block.
    expect(empty!.text).toContain('还没有账户。添加一个账户后即可使用该 Provider。')
    expect(empty!.text).not.toContain('还没有密钥。添加一个后即可使用该 Provider。')
    expect(empty!.text).toContain('Uses ChatGPT OAuth sign-in only; no API-key credential')
    expect(empty!.text).not.toContain('noKeys')
    // The viable action is present beside the copy; Add key stays gated.
    expect(findButtons(view.nodes, '添加账户')).toHaveLength(1)
    expect(findButtons(view.nodes, '添加密钥')[0]!.props!.disabled).toBe(true)
    view.unmount()
    setRuntimeContext(null)
  })

  test('oauth rows render as distinct account rows with identity, glyph, and counters', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    const head = findByClass(view.nodes, 'km-provider-head')[0]
    expect(head).toBeDefined()
    ;(head!.props!.onClick as () => void)()
    view.render()

    expect(findByClass(view.nodes, 'km-account-row')).toHaveLength(1)
    expect(findByClass(view.nodes, 'km-key-row')).toHaveLength(1)
    const row = findByClass(view.nodes, 'km-account-row')[0]!
    const inside = descendants(view.nodes, row)
    expect(inside.some(node => node.text === 'work@anthropic.example')).toBe(true)
    expect(findByClass(view.nodes, 'km-account-glyph')).toHaveLength(1)
    // N5: resolved dictionary values, not key names or a pinned separator.
    expect(inside.some(node => node.text === '账户')).toBe(true)
    // Round-3 N1: the counter parts asserted individually, never as a
    // joined string pin of the separator format.
    expect(inside.some(node => node.text === '使用 3 次')).toBe(true)
    expect(inside.some(node => node.text === '失败 1 次')).toBe(true)
    // R7 nit: scope the pill query to the account row — the provider header
    // renders one too, so a whole-view count passes even when the row's own
    // pill is missing — and assert the resolved copy.
    const pills = findByClass(inside, 'km-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text).toBe('正常')
    view.unmount()
    setRuntimeContext(null)
  })

  test('a demoted account row resolves the missing status copy', async () => {
    // R7 nit: the demoted row's own pill renders the resolved
    // "credential missing" copy, scoped to the row instead of the view.
    const state = makeState()
    state.providers[0] = { ...makeOauthProvider(), keys: [{ ...makeOauthKey(), status: 'missing', valueMissing: true }] }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const row = findByClass(view.nodes, 'km-account-row')[0]!
    const pills = findByClass(descendants(view.nodes, row), 'km-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text).toBe('凭证缺失')
    view.unmount()
    setRuntimeContext(null)
  })

  test('a cooling account row resolves the cooling status copy', async () => {
    // I-000105: the cooling arm is rendered and asserted by its resolved
    // copy, so the dictionary entry is exercised rather than dead fixture.
    const cooldownUntil = Date.now() + 60_000
    const state = makeState()
    state.providers[0] = {
      ...makeOauthProvider(),
      keys: [{ ...makeOauthKey(), status: 'cooling', cooldownUntil }],
    }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const row = findByClass(view.nodes, 'km-account-row')[0]!
    const pills = findByClass(descendants(view.nodes, row), 'km-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text).toBe('冷却中')
    // R9 nit: the cooling WINDOW itself must be observable, not just the
    // pill. AccountRow renders the resolved "recovers at" copy on a
    // `km-key-time km-warn` node only while `cold` is true, so a regression
    // that hardcodes cold=false drops the node (and the resolved timestamp).
    const coldLines = findByClass(descendants(view.nodes, row), 'km-warn')
    expect(coldLines).toHaveLength(1)
    expect(String(coldLines[0]!.props!.className).split(/\s+/)).toContain('km-key-time')
    const clock = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(cooldownUntil))
    expect(coldLines[0]!.text).toBe(`${clock} 恢复`)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a paused account row resolves the paused status copy', async () => {
    // I-000105: `statusKey` maps 'paused' to `keyStatusPaused`; the fixture
    // must carry the resolved copy, or the row would render the bare key.
    const state = makeState()
    state.providers[0] = { ...makeOauthProvider(), keys: [{ ...makeOauthKey(), status: 'paused' }] }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const row = findByClass(view.nodes, 'km-account-row')[0]!
    const pills = findByClass(descendants(view.nodes, row), 'km-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text).toBe('已暂停')
    view.unmount()
    setRuntimeContext(null)
  })

  test('the projected account row is badged and its Set active entry is disabled', async () => {
    // Step 6: exactly one account row carries the projection badge, and
    // only that row's Set active entry is disabled.
    const state = makeState()
    const projected = { ...makeOauthKey(), projected: true }
    const other = { ...makeOauthKey(), id: 'k_oauth8', oauth: { provider: 'zai-coding-cn', email: 'other@anthropic.example', accountId: 'acc_8', expiresAt: Date.now() + 3_600_000 } }
    state.providers[0] = { ...makeOauthProvider(), keys: [projected, other] }
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const rows = findByClass(view.nodes, 'km-account-row')
    expect(rows).toHaveLength(2)
    const badged = rows.filter(row => descendants(view.nodes, row).some(node => node.text === '服务中'))
    expect(badged).toHaveLength(1)
    const dots = descendants(view.nodes, badged[0]!).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
    ;(dots[0]!.props!.onClick as () => void)()
    view.render()
    const activate = descendants(view.nodes, badged[0]!).filter(node => node.type === 'button' && node.text.includes('设为当前'))
    expect(activate).toHaveLength(1)
    expect(activate[0]!.props!.disabled).toBe(true)

    // The non-projected row keeps Set active enabled.
    const otherRow = rows.find(row => row.path !== badged[0]!.path)!
    const otherDots = descendants(view.nodes, otherRow).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
    ;(otherDots[0]!.props!.onClick as () => void)()
    view.render()
    const otherActivate = descendants(view.nodes, otherRow).filter(node => node.type === 'button' && node.text.includes('设为当前'))
    expect(otherActivate).toHaveLength(1)
    expect(otherActivate[0]!.props!.disabled).toBe(false)
    view.unmount()
    setRuntimeContext(null)
  })

  test('after a demotion the badge and Set active return to the not-serving state', async () => {
    // Round-3 finding 4, client view: what the host publishes after its own
    // demotion (no row projected) drops the serving badge and re-enables
    // Set active — the documented re-activation path is reachable again.
    const demoted = makeState()
    const row = makeOauthKey()
    demoted.providers[0] = { ...makeOauthProvider(), keys: [row] }
    const harness = makeContext({ ok: true, value: demoted })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const rows = findByClass(view.nodes, 'km-account-row')
    expect(rows).toHaveLength(1)
    expect(rows.filter(row => descendants(view.nodes, row).some(node => node.text === '服务中'))).toHaveLength(0)
    const dots = descendants(view.nodes, rows[0]!).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
    ;(dots[0]!.props!.onClick as () => void)()
    view.render()
    const activate = descendants(view.nodes, rows[0]!).filter(node => node.type === 'button' && node.text.includes('设为当前'))
    expect(activate).toHaveLength(1)
    expect(activate[0]!.props!.disabled).toBe(false)
    view.unmount()
    setRuntimeContext(null)
  })

  test('the delete-account copy states the key-pool fallback only for key-capable routes', async () => {
    // Step 8: an OAuth-only route states the real consequence (no serving
    // until re-login); a key-capable route keeps the fallback clause.
    const buildCopy = async (supported: boolean): Promise<string> => {
      const state = makeState()
      state.providers[0] = { ...makeOauthProvider(), supported, reason: supported ? undefined : 'Uses ChatGPT OAuth sign-in only; no API-key credential' }
      const harness = makeContext({ ok: true, value: state })
      const store = createStore(harness.ctx)
      setRuntimeContext({ ctx: harness.ctx, store })
      const view = mountView(KeysManagerBody)
      await view.flush()
      ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
      view.render()
      const dots = descendants(view.nodes, findByClass(view.nodes, 'km-account-row')[0]!).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
      ;(dots[0]!.props!.onClick as () => void)()
      view.render()
      // R6 nit: locate the destructive account menu item by the structural
      // hooks the row already renders (role="menuitem" + km-menu-danger)
      // instead of the stub's key-name echo for t('delete').
      const del = descendants(view.nodes, findByClass(view.nodes, 'km-account-row')[0]!)
        .filter(node => node.type === 'button' && node.props?.['role'] === 'menuitem' && findByClass([node], 'km-menu-danger').length > 0)
      expect(del).toHaveLength(1)
      ;(del[0]!.props!.onClick as () => void)()
      view.render()
      const copy = findByClass(view.nodes, 'km-modal-copy')[0]!
      view.unmount()
      setRuntimeContext(null)
      return copy.text
    }
    // Round-3 N2: assert the copy itself through its distinguishing
    // phrases — a swapped translation or key-name echo can no longer pass.
    expect(await buildCopy(true)).toContain('回落到 API-key 池')
    expect(await buildCopy(true)).not.toContain('停止服务')
    expect(await buildCopy(false)).toContain('停止服务')
    expect(await buildCopy(false)).not.toContain('回落到 API-key 池')
  })

  test('the account re-authentication entry carries the target row id', async () => {
    // Round-3 finding 6, client half: Re-authenticate passes the row id so
    // the host can bind the fresh grant to that row.
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    let loginArgs: unknown
    const harness = makeContext({ ok: true, value: state })
    const originalCall = harness.ctx.connection.rpc.call.bind(harness.ctx.connection.rpc)
    harness.ctx.connection.rpc.call = async (channel, endpoint, payload) => {
      if (endpoint === 'keysManager/beginAccountLogin') {
        loginArgs = payload
        return { ok: true, value: makePendingAttemptView() }
      }
      if (endpoint === 'keysManager/accountAttempt') return { ok: true, value: makePendingAttemptView() }
      return originalCall(channel, endpoint, payload)
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const dots = descendants(view.nodes, findByClass(view.nodes, 'km-account-row')[0]!).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
    ;(dots[0]!.props!.onClick as () => void)()
    view.render()
    const reauth = descendants(view.nodes, findByClass(view.nodes, 'km-account-row')[0]!).filter(node => node.type === 'button' && node.text.includes('重新认证'))
    expect(reauth).toHaveLength(1)
    ;(reauth[0]!.props!.onClick as () => void)()
    await view.flush()
    expect(loginArgs).toEqual({ args: { provider: 'zai-coding-cn', alias: 'Work account', targetAccountId: 'k_oauth9' } })
    view.unmount()
    setRuntimeContext(null)
  })

  test('login dialog walks prompt → answer → ready and closes after a state refresh', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    let answered = false
    let getStateCalls = 0
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/getState') {
        getStateCalls += 1
        return { ok: true, value: state }
      }
      if (endpoint === 'keysManager/beginAccountLogin') {
        expect(payload).toEqual({ args: { provider: 'zai-coding-cn', alias: undefined } })
        return { ok: true, value: makeAttemptView() }
      }
      if (endpoint === 'keysManager/answerAccountPrompt') {
        expect(payload).toEqual({ args: { attemptId: 'la_1_ab', value: '123-456' } })
        answered = true
        return { ok: true, value: null }
      }
      if (endpoint === 'keysManager/accountAttempt') {
        return { ok: true, value: answered ? makeReadyAttemptView() : makeAttemptView() }
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const addAccount = findButtons(view.nodes, '添加账户')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    // The dialog shows the browser-open notice and the parked prompt.
    expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
    const link = hostNodes(view.nodes).find(node => node.type === 'a')
    expect(link?.props?.href).toBe('https://example.com/authorize')
    expect(link?.text).toContain('在浏览器中打开')
    expect(findButtons(view.nodes, '提交')).toHaveLength(1)
    expect(view.nodes.some(node => node.text === 'Paste the verification code')).toBe(true)

    const form = findByClass(view.nodes, 'km-login-prompt')[0]
    expect(form).toBeDefined()
    const promptInput = descendants(view.nodes, form!).find(node => node.type === 'input')
    expect(promptInput).toBeDefined()
    ;(promptInput!.props!.onChange as (event: unknown) => void)({ target: { value: '123-456' } })
    view.render()
    const submittedForm = findByClass(view.nodes, 'km-login-prompt')[0]
    expect(submittedForm).toBeDefined()
    ;(submittedForm!.props!.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
    await view.flush()

    expect(answered).toBe(true)
    // ready: snapshot refresh, then the dialog closes itself.
    expect(findByClass(view.nodes, 'km-modal')).toHaveLength(0)
    expect(getStateCalls).toBeGreaterThanOrEqual(2)
    view.unmount()
    setRuntimeContext(null)
  })

  // Round-9 finding P2: a select is a closed choice whose answer starts empty,
  // and the empty string matched no rendered option — the submit button stayed
  // disabled until the user touched the control, so a one-option prompt could
  // not be answered at all. The dialog now seeds the answer from the first
  // option whenever the parked prompt arrives or changes.

  test('a select prompt starts on its first option so submit is enabled without a manual change (P2)', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const selectAttempt = makeSelectAttemptView([
      { id: 'personal', label: 'Personal account' },
      { id: 'work', label: 'Work account' },
    ])
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: selectAttempt }
      if (endpoint === 'keysManager/accountAttempt') return { ok: true, value: selectAttempt }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const addAccount = findButtons(view.nodes, '添加账户')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    const form = findByClass(view.nodes, 'km-login-prompt')[0]
    expect(form).toBeDefined()
    const select = descendants(view.nodes, form!).find(node => node.type === 'select')
    expect(select).toBeDefined()
    // Seeded from the first option, matching a rendered option exactly.
    expect(select!.props!.value).toBe('personal')
    const submit = findButtons(view.nodes, '提交')[0]
    expect(submit).toBeDefined()
    expect(submit!.props!.disabled).toBe(false)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a one-option select prompt can be submitted and sends that option (P2)', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const selectAttempt = makeSelectAttemptView([{ id: 'only', label: 'Only account' }])
    const answers: Array<{ args: { attemptId: string; value: string } }> = []
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: selectAttempt }
      if (endpoint === 'keysManager/accountAttempt') return { ok: true, value: selectAttempt }
      if (endpoint === 'keysManager/answerAccountPrompt') {
        answers.push(payload as { args: { attemptId: string; value: string } })
        return { ok: true, value: null }
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const addAccount = findButtons(view.nodes, '添加账户')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    const submit = findButtons(view.nodes, '提交')[0]
    expect(submit).toBeDefined()
    expect(submit!.props!.disabled).toBe(false)
    const form = findByClass(view.nodes, 'km-login-prompt')[0]
    expect(form).toBeDefined()
    ;(form!.props!.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
    await view.flush()
    // No manual selection: the first (and only) option is what gets sent.
    expect(answers).toEqual([{ args: { attemptId: 'la_1_ab', value: 'only' } }])
    view.unmount()
    setRuntimeContext(null)
  })

  test('notice URLs only render as links for http/https schemes (S2)', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const unsafeAttempt = { ...makeAttemptView(), notices: [{ message: 'Open this page to continue signing in.', url: 'javascript:alert(1)' }] }
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: unsafeAttempt }
      if (endpoint === 'keysManager/accountAttempt') return { ok: true, value: unsafeAttempt }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()
    const addAccount = findButtons(view.nodes, '添加账户')[0]
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    // A non-http(s) notice URL stays plain text: no anchor, no href.
    expect(hostNodes(view.nodes).filter(node => node.type === 'a')).toHaveLength(0)
    expect(view.nodes.some(node => node.text.includes('Open this page to continue signing in.'))).toBe(true)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a vanished login flow ends the dialog with the neutral flow-ended state', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    let accountAttemptCalls = 0
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: makePendingAttemptView() }
      if (endpoint === 'keysManager/accountAttempt') {
        accountAttemptCalls += 1
        return { ok: true, value: null }
      }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    const addAccount = findButtons(view.nodes, '添加账户')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    // null means the flow is gone: a neutral ended state, not success.
    expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
    expect(view.nodes.some(node => node.text === '本次登录流程已结束，请关闭窗口后重新开始。')).toBe(true)
    expect(view.nodes.some(node => node.text === '登录成功。')).toBe(false)
    const pollsAtEnd = accountAttemptCalls
    await view.flush()
    await view.flush()
    expect(accountAttemptCalls).toBe(pollsAtEnd)
    view.unmount()
    setRuntimeContext(null)
  })

  test('three consecutive polling failures stop polling and render the failure notice (N1)', async () => {
    // Fake only the dialog's polling interval: the mount harness awaits
    // real setTimeout(0) ticks in flush().
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const state = makeState()
      state.providers[0] = makeOauthProvider()
      let accountAttemptCalls = 0
      const harness = makeContext()
      harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
        if (endpoint === 'keysManager/getState') return { ok: true, value: state }
        if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: makePendingAttemptView() }
        if (endpoint === 'keysManager/accountAttempt') {
          accountAttemptCalls += 1
          return { ok: false, error: { message: 'host restarted under the dialog' } }
        }
        return { ok: false, error: { message: `unexpected ${endpoint}` } }
      }
      const store = createStore(harness.ctx)
      setRuntimeContext({ ctx: harness.ctx, store })
      const view = mountView(KeysManagerBody)
      await view.flush()
      ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
      view.render()
      ;(findButtons(view.nodes, '添加账户')[0]!.props!.onClick as () => void)()
      await view.flush()
      // Initial poll + two interval ticks = three consecutive failures.
      await vi.advanceTimersByTimeAsync(1000)
      await view.flush()
      await vi.advanceTimersByTimeAsync(1000)
      await view.flush()
      expect(accountAttemptCalls).toBe(3)
      // The failure notice renders with the RPC error instead of an endless
      // "Waiting for authorization…".
      expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
      expect(view.nodes.some(node => node.text === '登录失败')).toBe(true)
      expect(view.nodes.some(node => node.text.includes('host restarted under the dialog'))).toBe(true)
      // Polling stopped: further time adds no calls.
      await vi.advanceTimersByTimeAsync(5000)
      await view.flush()
      expect(accountAttemptCalls).toBe(3)
      view.unmount()
    } finally {
      vi.useRealTimers()
      setRuntimeContext(null)
    }
  })

  test('overlapping login polls cannot resurrect an older nonterminal state (C5)', async () => {
    // Round-5 finding C5: an accountAttempt RPC that outlasts the 1 s tick can
    // resolve out of order, and an older `pending` view landing after a newer
    // `failed` left the dialog stuck nonterminal forever. The poll loop skips
    // its tick while a poll is in flight, and any response older than the
    // state already shown is discarded.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const state = makeState()
      state.providers[0] = makeOauthProvider()
      let accountAttemptCalls = 0
      const deferred: Array<(value: RpcResult) => void> = []
      const olderPending = makePendingAttemptView()
      const failed = { ...makeAttemptView(), status: 'failed' as const, prompt: undefined, error: 'sign-in rejected', updatedAt: 5 }
      const harness = makeContext()
      harness.ctx.connection.rpc.call = async (_channel, endpoint) => {
        if (endpoint === 'keysManager/getState') return { ok: true, value: state }
        if (endpoint === 'keysManager/beginAccountLogin') return { ok: true, value: makeAttemptView() }
        if (endpoint === 'keysManager/answerAccountPrompt') return { ok: true, value: null }
        if (endpoint === 'keysManager/accountAttempt') {
          accountAttemptCalls += 1
          if (accountAttemptCalls === 1) return { ok: true, value: makeAttemptView() }
          // The interval's poll outlasts several ticks.
          if (accountAttemptCalls === 2) return new Promise<RpcResult>(resolve => deferred.push(resolve))
          return { ok: true, value: failed }
        }
        return { ok: false, error: { message: `unexpected ${endpoint}` } }
      }
      const store = createStore(harness.ctx)
      setRuntimeContext({ ctx: harness.ctx, store })
      const view = mountView(KeysManagerBody)
      await view.flush()
      ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
      view.render()
      ;(findButtons(view.nodes, '添加账户')[0]!.props!.onClick as () => void)()
      await view.flush()
      expect(accountAttemptCalls).toBe(1)

      // A slow poll is in flight; further ticks must not stack behind it.
      await vi.advanceTimersByTimeAsync(1000)
      expect(accountAttemptCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(3000)
      expect(accountAttemptCalls).toBe(2)

      // Answering the prompt forces a fresh poll, which returns the terminal
      // failed state out of order with the still-pending interval poll.
      const form = findByClass(view.nodes, 'km-login-prompt')[0]
      expect(form).toBeDefined()
      const input = descendants(view.nodes, form!).find(node => node.type === 'input')
      ;(input!.props!.onChange as (event: unknown) => void)({ target: { value: '123-456' } })
      view.render()
      const submitted = findByClass(view.nodes, 'km-login-prompt')[0]
      ;(submitted!.props!.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
      await view.flush()
      expect(accountAttemptCalls).toBe(3)
      expect(view.nodes.some(node => node.text === '登录失败')).toBe(true)
      expect(view.nodes.some(node => node.text.includes('sign-in rejected'))).toBe(true)

      // The earlier pending response resolves late: it must not reopen the flow.
      deferred[0]!({ ok: true, value: olderPending })
      await view.flush()
      expect(view.nodes.some(node => node.text === '登录失败')).toBe(true)
      expect(view.nodes.some(node => node.text === '等待授权…')).toBe(false)
      expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
      // Terminal state sticks and polling has stopped.
      await vi.advanceTimersByTimeAsync(5000)
      await view.flush()
      expect(accountAttemptCalls).toBe(3)
      view.unmount()
    } finally {
      vi.useRealTimers()
      setRuntimeContext(null)
    }
  })

  test('both row menus offer a Test action that reports its outcome inline', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const pending: Array<{ args: unknown; resolve: (value: RpcResult) => void }> = []
    const harness = makeContext({ ok: true, value: state })
    const originalCall = harness.ctx.connection.rpc.call.bind(harness.ctx.connection.rpc)
    harness.ctx.connection.rpc.call = async (channel, endpoint, payload) => {
      if (endpoint !== 'keysManager/testKey') return originalCall(channel, endpoint, payload)
      return await new Promise<RpcResult>(resolve => { pending.push({ args: (payload as { args: unknown }).args, resolve }) })
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    // An account row test sends the pinned row id and reports its latency inline.
    const openMenu = (className: string): void => {
      const row = findByClass(view.nodes, className)[0]!
      const dots = descendants(view.nodes, row).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
      ;(dots[0]!.props!.onClick as () => void)()
      view.render()
    }
    openMenu('km-account-row')
    const accountTest = descendants(view.nodes, findByClass(view.nodes, 'km-account-row')[0]!)
      .filter(node => node.type === 'button' && node.text.includes('测试连接'))
    expect(accountTest).toHaveLength(1)
    ;(accountTest[0]!.props!.onClick as () => void)()
    await view.flush()
    expect(view.nodes.some(node => node.text === '测试中…')).toBe(true)
    expect(pending[0]!.args).toEqual({ provider: 'zai-coding-cn', keyId: 'k_oauth9' })
    pending[0]!.resolve({ ok: true, value: { ok: true, latencyMs: 812 } })
    await view.flush()
    expect(view.nodes.some(node => node.text === '连接正常 · 812 ms')).toBe(true)

    // A second row can be tested afterwards; a failure renders its message.
    openMenu('km-key-row')
    const keyTest = descendants(view.nodes, findByClass(view.nodes, 'km-key-row')[0]!)
      .filter(node => node.type === 'button' && node.text.includes('测试连接'))
    expect(keyTest).toHaveLength(1)
    ;(keyTest[0]!.props!.onClick as () => void)()
    await view.flush()
    expect(pending[1]!.args).toEqual({ provider: 'zai-coding-cn', keyId: 'k_aaaaaaaa' })
    pending[1]!.resolve({ ok: true, value: { ok: false, latencyMs: 4, error: 'invalid api key' } })
    await view.flush()
    expect(view.nodes.some(node => node.text === '连接失败：invalid api key')).toBe(true)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a row test that never answers leaves its running state at the client deadline', async () => {
    const state = makeState()
    state.providers[0] = makeOauthProvider()
    const harness = makeContext({ ok: true, value: state })
    const originalCall = harness.ctx.connection.rpc.call.bind(harness.ctx.connection.rpc)
    harness.ctx.connection.rpc.call = async (channel, endpoint, payload) => {
      if (endpoint !== 'keysManager/testKey') return originalCall(channel, endpoint, payload)
      // The host never answers: a lost or wedged RPC.
      return await new Promise<RpcResult>(() => {})
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    ;(findByClass(view.nodes, 'km-provider-head')[0]!.props!.onClick as () => void)()
    view.render()

    // Only the test's own deadline is faked; the mount harness awaits real
    // setTimeout(0) ticks, so the fake timers start once rendering is settled.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const row = findByClass(view.nodes, 'km-key-row')[0]!
      const dots = descendants(view.nodes, row).filter(node => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
      ;(dots[0]!.props!.onClick as () => void)()
      view.render()
      const testItem = descendants(view.nodes, findByClass(view.nodes, 'km-key-row')[0]!)
        .filter(node => node.type === 'button' && node.text.includes('测试连接'))
      ;(testItem[0]!.props!.onClick as () => void)()
      view.render()
      expect(view.nodes.some(node => node.text === '测试中…')).toBe(true)

      // QC N4: without a client deadline the row stays `running` forever and
      // its Test action is permanently disabled.
      await vi.advanceTimersByTimeAsync(120_000)
      await Promise.resolve()
      await Promise.resolve()
      view.render()
      expect(view.nodes.some(node => node.text === '测试中…')).toBe(false)
      // QC N6: the failure line never renders an empty detail.
      expect(view.nodes.some(node => node.text === '连接失败：测试超时，未收到结果')).toBe(true)

      // PR review SF4: the row deadline releases only the row. The store's
      // serialized mutation queue is released by its own bound, so a lost
      // answer cannot pin every later mutation behind it.
      expect(store.getSnapshot().busy).toBe(null)
      const followUp = store.call('deleteKey', { provider: 'zai-coding-cn', keyId: 'k_aaaaaaaa' })
      await Promise.resolve()
      await Promise.resolve()
      await followUp
      expect(harness.calls.some(entry => entry.endpoint === 'keysManager/deleteKey')).toBe(true)
    } finally {
      vi.useRealTimers()
      view.unmount()
      setRuntimeContext(null)
    }
  })
})


describe('transport account surface', () => {
  const TRANSPORT_KEYS = [
    'transportAccounts',
    'transportTag',
    'transportSignIn',
    'transportExpires',
    'transportStatusActive',
    'transportStatusExpired',
    'transportStatusNeedsReauth',
    'transportStatusSignedOut',
    'transportRemoveTitle',
    'transportRemoveBody',
  ] as const

  test('the transport copy exists in both dictionaries and mirrors locale/*.json', () => {
    const dicts = expectLocaleParity(TRANSPORT_KEYS)
    expect(dicts.en.transportExpires).toContain('{time}')
    expect(dicts.zh.transportExpires).toContain('{time}')
    expect(dicts.en.transportRemoveTitle).toContain('{name}')
    expect(dicts.zh.transportRemoveTitle).toContain('{name}')
  })

  test('a transport account renders in its own section with identity, scope and status', async () => {
    const state = makeState()
    state.transportAccounts = [makeTransportAccount()]
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()

    expect(view.nodes.some(node => node.text === '传输账户')).toBe(true)
    expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(1)
    const row = findByClass(view.nodes, 'km-transport-row')[0]!
    const inside = descendants(view.nodes, row)
    expect(inside.some(node => node.text === 'dev@cursor.example')).toBe(true)
    // The scope is the record identity, never its payload.
    expect(inside.some(node => node.text === 'llm-omp-transports/cursor')).toBe(true)
    expect(inside.some(node => node.text === '传输')).toBe(true)
    const pills = findByClass(inside, 'km-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text).toBe('正常')
    expect(inside.some(node => node.text.includes('有效期至'))).toBe(true)
    // A transport row is a sibling section, never a row inside a provider card.
    for (const card of findByClass(view.nodes, 'km-provider')) {
      const rowInCard = descendants(view.nodes, card)
        .some(node => String((node.props?.className as string | undefined) ?? '').split(/\s+/).includes('km-transport-row'))
      expect(rowInCard).toBe(false)
    }
    view.unmount()
    setRuntimeContext(null)
  })

  test('a snapshot without transport accounts renders no transport section', async () => {
    // Additive host field: an older host build keeps rendering exactly as before.
    const harness = makeContext()
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(0)
    expect(view.nodes.some(node => node.text === '传输账户')).toBe(false)
    view.unmount()
    setRuntimeContext(null)
  })

  test('a signed-out transport route starts its own sign-in flow through the shared dialog', async () => {
    const state = makeState()
    state.transportAccounts = [makeTransportAccount({
      status: 'signed-out',
      active: false,
      email: undefined,
      accountId: undefined,
      expiresAt: undefined,
    })]
    let loginPayload: unknown
    const harness = makeContext()
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/getState') return { ok: true, value: state }
      if (endpoint === 'keysManager/beginTransportLogin') {
        loginPayload = payload
        return { ok: true, value: makeTransportAttemptView() }
      }
      if (endpoint === 'keysManager/accountAttempt') return { ok: true, value: makeTransportAttemptView() }
      return { ok: false, error: { message: `unexpected ${endpoint}` } }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()

    const row = findByClass(view.nodes, 'km-transport-row')[0]!
    const inside = descendants(view.nodes, row)
    expect(inside.some(node => node.text === '未登录')).toBe(true)
    const signIn = descendants(view.nodes, row).filter(node => node.type === 'button' && node.text.includes('登录'))
    expect(signIn).toHaveLength(1)
    // No "Set active": the stored grant already is the route's live credential,
    // so an activation control would be a no-effect button.
    expect(descendants(view.nodes, row).filter(node => node.text === '设为当前')).toHaveLength(0)
    ;(signIn[0]!.props!.onClick as () => void)()
    await view.flush()

    // The route is the only argument; the flow key is the host's business.
    expect(loginPayload).toEqual({ args: { provider: 'cursor' } })
    // The pi-ai dialog is reused: it polls the same attempt record.
    expect(view.nodes.some(node => node.text === '等待授权…')).toBe(true)
    view.unmount()
    setRuntimeContext(null)
  })

  test('removing a transport account confirms, then deletes only that route', async () => {
    const state = makeState()
    state.transportAccounts = [makeTransportAccount()]
    const harness = makeContext({ ok: true, value: state })
    let removed: unknown
    harness.ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
      if (endpoint === 'keysManager/removeTransportAccount') {
        removed = payload
        const next = makeState()
        next.transportAccounts = []
        return { ok: true, value: next }
      }
      return { ok: true, value: state }
    }
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()

    const row = findByClass(view.nodes, 'km-transport-row')[0]!
    const del = descendants(view.nodes, row).filter(node => node.type === 'button' && node.text === '删除')
    expect(del).toHaveLength(1)
    ;(del[0]!.props!.onClick as () => void)()
    view.render()
    const copy = findByClass(view.nodes, 'km-modal-copy')[0]
    expect(copy).toBeDefined()
    expect(copy!.text).toContain('路由自身不会重建它')

    const confirm = findButtons(view.nodes, '确认删除')[0]
    expect(confirm).toBeDefined()
    ;(confirm!.props!.onClick as () => void)()
    await view.flush()
    expect(removed).toEqual({ args: { provider: 'cursor' } })
    // The refreshed state no longer carries the row.
    expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(0)
    view.unmount()
    setRuntimeContext(null)
  })
})

describe('provider quick filter', () => {
  type View = ReturnType<typeof mountView>

  /** One row per origin, the host-refused OAuth row, and one unmanaged row. */
  function filterState(): StateView {
    const state = makeState()
    const base = state.providers[0]!
    const row = (provider: string, origin: ProviderView['origin'], oauth: boolean, managed: boolean, accountSupported?: boolean): ProviderView => ({
      ...base,
      provider,
      displayName: provider,
      origin,
      managed,
      nativeAuth: { env: [], oauth },
      ...(accountSupported === undefined ? {} : { accountSupported }),
    })
    state.providers = [
      row('builtin-route', 'dsh', false, true),
      row('plugin-route', 'plugin', true, false, true),
      // A catalog-flagged route the host refuses: not OAuth-capable.
      row('blocked-route', 'plugin', true, true, false),
      row('custom-route', 'custom', false, true),
    ]
    state.transportAccounts = [makeTransportAccount()]
    return state
  }

  function chipNode(view: View, value: string) {
    const node = findByClass(view.nodes, `km-chip-${value}`)[0]
    expect(node, `chip ${value}`).toBeDefined()
    return node!
  }

  function chipCount(view: View, value: string): number {
    const count = findByClass(descendants(view.nodes, chipNode(view, value)), 'km-chip-count')[0]
    expect(count, `count of chip ${value}`).toBeDefined()
    return Number(count!.text)
  }

  function selectChip(view: View, value: string): void {
    ;(chipNode(view, value).props!.onClick as () => void)()
    view.render()
  }

  function providerNames(view: View): string[] {
    return findByClass(view.nodes, 'km-provider').map(card =>
      String(findByClass(descendants(view.nodes, card), 'km-provider-name')[0]?.text ?? ''),
    )
  }

  function sectionTitles(view: View): string[] {
    return findByClass(view.nodes, 'km-section-title').map(node => node.text)
  }

  function section(view: View, title: string) {
    const head = findByClass(view.nodes, 'km-section-title').find(node => node.text === title)
    expect(head, `section ${title}`).toBeDefined()
    const owner = findByClass(view.nodes, 'km-section').find(candidate =>
      descendants(view.nodes, candidate).some(node => node.path === head!.path),
    )
    expect(owner, `owner of ${title}`).toBeDefined()
    return owner!
  }

  function typeQuery(view: View, value: string): void {
    const input = findByClass(view.nodes, 'km-search-input')[0]
    expect(input).toBeDefined()
    ;(input!.props!.onChange as (event: unknown) => void)({ target: { value } })
    view.render()
  }

  async function mountFiltered(): Promise<{ view: View; state: StateView }> {
    const state = filterState()
    const harness = makeContext({ ok: true, value: state })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const view = mountView(KeysManagerBody)
    await view.flush()
    return { view, state }
  }

  test('the chip copy exists in both dictionaries and mirrors locale/*.json', () => {
    expectLocaleParity(['filterAll', 'filterBuiltin', 'filterPlugin', 'filterOauth', 'filterTransport'])
  })

  test('the filtered-empty copy exists in both dictionaries and mirrors locale/*.json', () => {
    expectLocaleParity(['managedFilteredEmpty'])
  })

  test('no filter selected keeps the whole list and shows one chip per predicate', async () => {
    const { view, state } = await mountFiltered()
    try {
      // The chip set and its order are a product decision, so the row renders
      // exactly one chip per predicate in the fixed order origin → capability
      // → surface.
      expect(findByClass(view.nodes, 'km-chip-label').map(node => node.text))
        .toEqual(['全部', '内置', '插件', '支持 OAuth', '传输'])
      expect(chipNode(view, 'all').props?.['aria-pressed']).toBe(true)

      expect(providerNames(view).sort()).toEqual(state.providers.map(provider => provider.provider).sort())
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(state.transportAccounts!.length)
      expect(sectionTitles(view)).toContain('传输账户')

      // Every count is derived from the snapshot through its own predicate —
      // never a literal, never a sum of the other chips.
      const all = chipCount(view, 'all')
      const builtin = chipCount(view, 'builtin')
      const plugin = chipCount(view, 'plugin')
      const oauth = chipCount(view, 'oauth')
      expect(all).toBe(state.providers.length + state.transportAccounts!.length)
      expect(builtin).toBe(state.providers.filter(provider => originOf(provider) === 'dsh').length)
      expect(plugin).toBe(state.providers.filter(provider => originOf(provider) === 'plugin').length)
      expect(oauth).toBe(state.providers.filter(oauthCapable).length)
      expect(chipCount(view, 'transport')).toBe(state.transportAccounts!.length)
      // Overlapping predicates, not a partition: with a custom-origin route in
      // the snapshot the origin chips are a strict subset of All.
      expect(builtin + plugin).toBeLessThan(all)
      expect(oauth).toBeLessThanOrEqual(all)
      // And `oauthCapable()` is stricter than the catalog flag alone.
      expect(state.providers.filter(provider => provider.nativeAuth?.oauth === true).length).toBeGreaterThan(oauth)
      expect(oauth).toBeGreaterThan(0)
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('Plugin narrows to plugin-origin rows and filters the transport section out', async () => {
    const { view, state } = await mountFiltered()
    try {
      selectChip(view, 'plugin')
      expect(providerNames(view).sort())
        .toEqual(state.providers.filter(provider => originOf(provider) === 'plugin').map(provider => provider.provider).sort())
      expect(chipNode(view, 'plugin').props?.['aria-pressed']).toBe(true)
      expect(chipNode(view, 'all').props?.['aria-pressed']).toBe(false)
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(0)
      expect(sectionTitles(view)).not.toContain('传输账户')
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('OAuth-capable narrows to the rows that can start a sign-in now', async () => {
    const { view, state } = await mountFiltered()
    try {
      selectChip(view, 'oauth')
      expect(providerNames(view).sort())
        .toEqual(state.providers.filter(oauthCapable).map(provider => provider.provider).sort())
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(0)
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('Transport narrows to its own section and keeps an empty section rather than a blank page', async () => {
    const { view, state } = await mountFiltered()
    try {
      selectChip(view, 'transport')
      expect(providerNames(view)).toEqual([])
      expect(sectionTitles(view)).toContain('传输账户')
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(state.transportAccounts!.length)
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }

    // The same chip with zero transport rows: head, count and the existing
    // empty copy, so no new string is invented for the empty filter.
    const emptyState = filterState()
    emptyState.transportAccounts = []
    const harness = makeContext({ ok: true, value: emptyState })
    const store = createStore(harness.ctx)
    setRuntimeContext({ ctx: harness.ctx, store })
    const emptyView = mountView(KeysManagerBody)
    await emptyView.flush()
    try {
      selectChip(emptyView, 'transport')
      expect(sectionTitles(emptyView)).toContain('传输账户')
      const head = section(emptyView, '传输账户')
      expect(findByClass(descendants(emptyView.nodes, head), 'km-section-count')[0]?.text).toBe('0')
      expect(findByClass(descendants(emptyView.nodes, head), 'km-empty')[0]?.text).toBe('没有匹配的 Provider。')
    } finally {
      emptyView.unmount()
      setRuntimeContext(null)
    }
  })

  test('the filter composes with the text search and clearing restores the list', async () => {
    const { view, state } = await mountFiltered()
    try {
      selectChip(view, 'plugin')
      typeQuery(view, 'builtin')
      expect(providerNames(view)).toEqual([])

      typeQuery(view, 'plugin')
      expect(providerNames(view)).toEqual(['plugin-route'])

      // Counts follow the same query-narrowed population the section heads
      // render: a no-match query cannot leave a chip advertising hidden rows.
      typeQuery(view, 'no-such-provider')
      expect(providerNames(view)).toEqual([])
      expect(chipCount(view, 'plugin')).toBe(0)
      expect(chipCount(view, 'all')).toBe(state.transportAccounts!.length)

      typeQuery(view, '')
      selectChip(view, 'all')
      expect(providerNames(view).sort()).toEqual(state.providers.map(provider => provider.provider).sort())
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(state.transportAccounts!.length)
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('Built-in narrows to the dsh-origin rows', async () => {
    const { view, state } = await mountFiltered()
    try {
      selectChip(view, 'builtin')
      expect(providerNames(view).sort()).toEqual(
        state.providers.filter(provider => originOf(provider) === 'dsh').map(provider => provider.provider).sort(),
      )
      expect(findByClass(view.nodes, 'km-transport-row')).toHaveLength(0)
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('a custom-origin row stays reachable through All and the text search', async () => {
    const { view, state } = await mountFiltered()
    try {
      const custom = state.providers
        .filter(provider => originOf(provider) === 'custom')
        .map(provider => provider.provider)
      expect(custom.length).toBeGreaterThan(0)
      // No chip covers custom-origin rows (a Custom chip is deferred), so
      // every chip hides them...
      for (const chip of ['builtin', 'plugin', 'oauth', 'transport']) {
        selectChip(view, chip)
        for (const name of custom) expect(providerNames(view)).not.toContain(name)
      }
      // ...but All composed with the text search still reaches them.
      selectChip(view, 'all')
      typeQuery(view, 'custom')
      expect(providerNames(view).sort()).toEqual(custom.sort())
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('an emptied managed list says the chip hides the rows, not that none exist', async () => {
    const { view } = await mountFiltered()
    try {
      // The fixture has managed rows, none of them OAuth-capable.
      selectChip(view, 'oauth')
      const managedSection = section(view, '已接管')
      expect(findByClass(descendants(view.nodes, managedSection), 'km-provider')).toHaveLength(0)
      const empty = findByClass(descendants(view.nodes, managedSection), 'km-empty')[0]
      expect(empty?.text).toBe('当前筛选下没有已接管的 Provider。')
      // The unfiltered managed population is not empty, so this copy would lie.
      expect(empty?.text).not.toBe('还没有接管的 Provider。从下方选择一个开始。')
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('the filter is view state only: remounting starts on All', async () => {
    const first = await mountFiltered()
    try {
      selectChip(first.view, 'transport')
      expect(chipNode(first.view, 'transport').props?.['aria-pressed']).toBe(true)
    } finally {
      first.view.unmount()
      setRuntimeContext(null)
    }
    const second = await mountFiltered()
    try {
      expect(chipNode(second.view, 'all').props?.['aria-pressed']).toBe(true)
      expect(providerNames(second.view).sort())
        .toEqual(second.state.providers.map(provider => provider.provider).sort())
    } finally {
      second.view.unmount()
      setRuntimeContext(null)
    }
  })

  test('a query that empties the managed list says so under All too', async () => {
    const { view, state } = await mountFiltered()
    try {
      // All is the default chip, so this is the untinted page plus a search.
      expect(state.providers.some(provider => provider.managed)).toBe(true)
      typeQuery(view, 'no-such-provider')
      const managedSection = section(view, '已接管')
      expect(findByClass(descendants(view.nodes, managedSection), 'km-provider')).toHaveLength(0)
      const empty = findByClass(descendants(view.nodes, managedSection), 'km-empty')[0]
      // The query hides the rows; "nothing is managed" would be false.
      expect(empty?.text).toBe('换个关键词试试。')
      expect(empty?.text).not.toBe('还没有接管的 Provider。从下方选择一个开始。')
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })

  test('a query hiding a chip-matching row takes the query copy, not the chip copy', async () => {
    const { view } = await mountFiltered()
    try {
      selectChip(view, 'plugin')
      // `blocked-route` matches this chip but not the query, so the chip is not
      // what empties the list.
      typeQuery(view, 'no-such-provider')
      const managedSection = section(view, '已接管')
      expect(findByClass(descendants(view.nodes, managedSection), 'km-provider')).toHaveLength(0)
      const empty = findByClass(descendants(view.nodes, managedSection), 'km-empty')[0]
      expect(empty?.text).toBe('换个关键词试试。')
      expect(empty?.text).not.toBe('当前筛选下没有已接管的 Provider。')
    } finally {
      view.unmount()
      setRuntimeContext(null)
    }
  })
})
