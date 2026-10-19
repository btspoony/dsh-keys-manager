import { beforeAll, describe, expect, test } from 'vitest'
import React from 'react'
import { apply } from '../src/client/index'
import { createStore } from '../src/client/store'
import { cooldownMinutes, cooldownMs, graceMinutes, graceMs } from '../src/client/format'
import { RuntimeContext } from '../src/client/runtime'
import { KeysManagerBody } from '../src/client/ui'
import type { AccountAttemptView, ClientContext, KeyView, LocaleDicts, ProviderView, RpcResult, Runtime, StateView } from '../src/client/types'

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

  test('the registered dictionaries carry all 12 OAuth account strings in both languages', () => {
    // W6 pin: these strings must live in the live registration source
    // (LOCALE_DICTS), not only in the package's locale/*.json files.
    const oauthStrings: Record<string, { en: string; zh: string }> = {
      addAccount: { en: 'Add account', zh: '添加账户' },
      accountIdentity: { en: 'Account', zh: '账户' },
      accountReauth: { en: 'Re-authenticate', zh: '重新认证' },
      accountActivate: { en: 'Set active', zh: '设为当前' },
      loginTitle: { en: 'Account sign-in', zh: '账户登录' },
      loginPending: { en: 'Waiting for authorization…', zh: '等待授权…' },
      loginBrowserOpen: { en: 'Open in browser', zh: '在浏览器中打开' },
      loginPromptTitle: { en: 'Complete sign-in', zh: '完成登录' },
      loginPromptSubmit: { en: 'Submit', zh: '提交' },
      loginFailed: { en: 'Login failed', zh: '登录失败' },
      loginFlowEnded: { en: 'This sign-in session has ended. Close the dialog and start again.', zh: '本次登录流程已结束，请关闭窗口后重新开始。' },
      loginReady: { en: 'Signed in.', zh: '登录成功。' },
    }
    const harness = makeContext()
    apply(harness.ctx)
    const dicts = harness.dictionaries.value
    expect(dicts).toBeDefined()
    for (const [key, expected] of Object.entries(oauthStrings)) {
      expect(dicts!.en[key]).toBe(expected.en)
      expect(dicts!.zh[key]).toBe(expected.zh)
    }
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

    expect(findButtons(view.nodes, 'addKey')).toHaveLength(1)
    expect(findButtons(view.nodes, 'addAccount')).toHaveLength(1)
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
    expect(findButtons(plainView.nodes, 'addKey')).toHaveLength(1)
    expect(findButtons(plainView.nodes, 'addAccount')).toHaveLength(0)
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

    const adopt = findButtons(view.nodes, 'adopt')[0]
    expect(adopt).toBeDefined()
    expect(adopt!.props!.disabled).toBe(false)
    expect(findButtons(view.nodes, 'addAccount')).toHaveLength(1)
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
    const addKey = findButtons(managedView.nodes, 'addKey')[0]
    expect(addKey).toBeDefined()
    expect(addKey!.props!.disabled).toBe(true)
    expect(findButtons(managedView.nodes, 'addAccount')).toHaveLength(1)
    managedView.unmount()
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
    expect(inside.some(node => node.text === 'accountIdentity')).toBe(true)
    expect(inside.some(node => node.text === 'uses · failures')).toBe(true)
    expect(findByClass(view.nodes, 'km-status').length).toBeGreaterThanOrEqual(1)
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

    const addAccount = findButtons(view.nodes, 'addAccount')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    // The dialog shows the browser-open notice and the parked prompt.
    expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
    const link = hostNodes(view.nodes).find(node => node.type === 'a')
    expect(link?.props?.href).toBe('https://example.com/authorize')
    expect(link?.text).toContain('loginBrowserOpen')
    expect(findButtons(view.nodes, 'loginPromptSubmit')).toHaveLength(1)
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
    const addAccount = findButtons(view.nodes, 'addAccount')[0]
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

    const addAccount = findButtons(view.nodes, 'addAccount')[0]
    expect(addAccount).toBeDefined()
    ;(addAccount!.props!.onClick as () => void)()
    await view.flush()

    // null means the flow is gone: a neutral ended state, not success.
    expect(findByClass(view.nodes, 'km-modal')).toHaveLength(1)
    expect(view.nodes.some(node => node.text === 'loginFlowEnded')).toBe(true)
    expect(view.nodes.some(node => node.text === 'loginReady')).toBe(false)
    const pollsAtEnd = accountAttemptCalls
    await view.flush()
    await view.flush()
    expect(accountAttemptCalls).toBe(pollsAtEnd)
    view.unmount()
    setRuntimeContext(null)
  })
})
