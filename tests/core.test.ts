import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { KeyRecord, ProviderRecord } from '../src/domain'
import {
  DEFAULT_SETTINGS,
  applyFailureCooldown,
  isSelectable,
  markKeySuccess,
  normalizeSettings,
  patchSettings,
  pickHealthyExcluding,
  pickRoundRobin,
  shouldFailover,
  statusOfKey,
  statusOfProvider,
  validateKeyInput,
  validateKeyPatch,
} from '../src/core'
import { KeysManagerStore, sanitizeState, statePath } from '../src/store'

const now = 1_700_000_000_000
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

function key(id: string, patch: Partial<KeyRecord> = {}): KeyRecord {
  return {
    id,
    alias: id,
    ref: `REF_${id}`,
    kind: 'api-key',
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
    oauth: null,
    ...patch,
  }
}

function provider(keys: KeyRecord[]): ProviderRecord {
  return {
    provider: 'test-provider',
    displayName: 'Test Provider',
    source: 'dsh',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'test-provider'],
    adapter: 'pi-ai',
    brokerRef: 'KEYSMGR_TEST_PROVIDER_AAAAAA',
    originalApiKeyEnv: null,
    createdProfile: false,
    hadProfile: false,
    extraId: null,
    api: null,
    baseURL: null,
    models: [],
    adoptedAt: 0,
    cursor: 0,
    keys,
  }
}

test('normalizeSettings clamps and keeps defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  const normalized = normalizeSettings({ retryCount: 9, baseCooldownMs: 1, recoveryGraceMs: -5, stickySession: false })
  assert.equal(normalized.retryCount, 3)
  assert.equal(normalized.baseCooldownMs, 30_000)
  assert.equal(normalized.recoveryGraceMs, 0)
  assert.equal(normalized.stickySession, false)
  assert.equal(normalized.maxCooldownMs, DEFAULT_SETTINGS.maxCooldownMs)
})

test('patchSettings validates retry count and cooldowns', () => {
  assert.throws(() => patchSettings(DEFAULT_SETTINGS, { retryCount: 0 }))
  assert.throws(() => patchSettings(DEFAULT_SETTINGS, { retryCount: 4 }))
  assert.throws(() => patchSettings(DEFAULT_SETTINGS, { baseCooldownMs: 1000 }))
  const next = patchSettings(DEFAULT_SETTINGS, { retryCount: 1, baseCooldownMs: 2 * MIN, recoveryGraceMs: 3 * MIN })
  assert.equal(next.retryCount, 1)
  assert.equal(next.baseCooldownMs, 2 * MIN)
  assert.equal(next.recoveryGraceMs, 3 * MIN)
})

test('round robin advances across healthy keys and skips unavailable keys', () => {
  const a = key('a')
  const b = key('b', { cooldownUntil: now + MIN })
  const c = key('c', { enabled: false })
  const d = key('d')
  const p = provider([a, b, c, d])
  assert.equal(pickRoundRobin(p, now), a)
  assert.equal(pickRoundRobin(p, now), d)
  assert.equal(pickRoundRobin(p, now), a)
  b.cooldownUntil = 0
  assert.equal(pickRoundRobin(p, now), b)
  c.enabled = true
  assert.equal(pickRoundRobin(p, now), c)
})

test('one healthy key is stable across new sessions', () => {
  const a = key('a')
  const p = provider([a])
  assert.equal(pickRoundRobin(p, now), a)
  assert.equal(pickRoundRobin(p, now), a)
})

test('pickHealthyExcluding never returns the failing key', () => {
  const a = key('a')
  const b = key('b')
  const p = provider([a, b])
  assert.equal(pickHealthyExcluding(p, 'a', now), b)
  assert.equal(pickHealthyExcluding(p, 'b', now), a)
  const only = provider([a])
  assert.equal(pickHealthyExcluding(only, 'a', now), undefined)
})

test('cooldown starts at the base, doubles after quick recovery failures, and caps at seven days', () => {
  const settings = normalizeSettings({ baseCooldownMs: 5 * MIN, recoveryGraceMs: 10 * MIN })
  const k = key('a')
  const first = applyFailureCooldown(k, settings, now, { code: 'RATE_LIMIT' })
  assert.equal(first.level, 0)
  assert.equal(first.cooldownMs, 5 * MIN)
  assert.equal(k.cooldownUntil, now + 5 * MIN)

  const secondAt = k.cooldownUntil + 30 * 1000
  const second = applyFailureCooldown(k, settings, secondAt, { code: 'RATE_LIMIT' })
  assert.equal(second.level, 1)
  assert.equal(second.cooldownMs, 10 * MIN)

  const thirdAt = k.cooldownUntil + 30 * 1000
  const third = applyFailureCooldown(k, settings, thirdAt, { code: 'AUTH' })
  assert.equal(third.level, 2)
  assert.equal(third.cooldownMs, 20 * MIN)

  k.failureLevel = 29
  k.cooldownUntil = thirdAt
  const capped = applyFailureCooldown(k, settings, thirdAt + 1000, { code: 'SERVER' })
  assert.equal(capped.cooldownMs, DEFAULT_SETTINGS.maxCooldownMs)
  assert.ok(capped.cooldownUntil <= thirdAt + 1000 + DEFAULT_SETTINGS.maxCooldownMs)
})

test('a long healthy gap resets escalation', () => {
  const settings = normalizeSettings({ baseCooldownMs: MIN, recoveryGraceMs: MIN })
  const k = key('a', { cooldownUntil: now - 10 * MIN, failureLevel: 3, lastFailureAt: now - 20 * MIN })
  const result = applyFailureCooldown(k, settings, now, { code: 'SERVER' })
  assert.equal(result.level, 0)
  assert.equal(result.cooldownMs, MIN)
})

test('provider-requested delay wins when it is larger, but respects the cap', () => {
  const settings = normalizeSettings({ baseCooldownMs: MIN, recoveryGraceMs: MIN })
  const k = key('a')
  const result = applyFailureCooldown(k, settings, now, { code: 'RATE_LIMIT', providerRetryAfterMs: 4 * MIN })
  assert.equal(result.cooldownMs, 4 * MIN)
  const k2 = key('b')
  const huge = applyFailureCooldown(k2, settings, now, { code: 'RATE_LIMIT', providerRetryAfterMs: 30 * DAY })
  assert.equal(huge.cooldownMs, DEFAULT_SETTINGS.maxCooldownMs)
})

test('success keeps recovery history through the grace window', () => {
  const k = key('a', { cooldownUntil: now - MIN, failureLevel: 4, consecutiveFailures: 3 })
  markKeySuccess(k, now)
  assert.equal(k.cooldownUntil, now - MIN)
  assert.equal(k.failureLevel, 4)
  assert.equal(k.consecutiveFailures, 0)
  assert.equal(k.lastUsedAt, now)
  assert.equal(k.totalUses, 1)
  const settings = normalizeSettings({ baseCooldownMs: MIN, recoveryGraceMs: 10 * MIN })
  const next = applyFailureCooldown(k, settings, now + 30 * 1000, { code: 'SERVER' })
  assert.equal(next.level, 5)
})

test('statuses cover active, cooling, paused, missing, and empty', () => {
  assert.equal(statusOfKey(key('a'), now), 'active')
  assert.equal(statusOfKey(key('a', { cooldownUntil: now + 1 }), now), 'cooling')
  assert.equal(statusOfKey(key('a', { enabled: false }), now), 'paused')
  assert.equal(statusOfKey(key('a', { valueMissing: true }), now), 'missing')
  assert.equal(statusOfProvider([], now), 'empty')
  assert.equal(statusOfProvider([key('a', { enabled: false })], now), 'paused')
  assert.equal(statusOfProvider([key('a'), key('b', { cooldownUntil: now + 1 })], now), 'active')
  assert.equal(statusOfProvider([key('a', { cooldownUntil: now + 1 })], now), 'cooling')
})

test('failover excludes request-shaped failures and cancellation', () => {
  for (const code of ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'INVALID_CREDENTIAL']) {
    assert.equal(shouldFailover(code), true, code)
  }
  for (const code of ['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'UNKNOWN_MODEL', '']) {
    assert.equal(shouldFailover(code), false, code)
  }
})

test('key input validation trims and rejects blanks', () => {
  assert.deepEqual(validateKeyInput('  Primary  ', '  sk-test  '), { alias: 'Primary', value: 'sk-test' })
  assert.throws(() => validateKeyInput('', 'sk'))
  assert.throws(() => validateKeyInput('a', '   '))
  assert.throws(() => validateKeyInput('a'.repeat(81), 'sk'))
  assert.deepEqual(validateKeyPatch({ enabled: false }), { enabled: false })
  assert.throws(() => validateKeyPatch({}))
  assert.throws(() => validateKeyPatch({ alias: '' }))
})

test('state sanitization drops secret fields and keeps OAuth-compatible rows', () => {
  const state = sanitizeState({
    version: 1,
    settings: { retryCount: 1 },
    providers: {
      p: {
        provider: 'p',
        displayName: 'P',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'p'],
        brokerRef: 'KEYSMGR_P_AAAAAA',
        hadProfile: true,
        keys: [
          {
            id: 'k1',
            alias: 'one',
            ref: 'KEYSMGR_P_AAAAAA_K_111111',
            value: 'sk-must-not-survive',
            oauth: { type: 'oauth', access: 'x' },
          },
        ],
      },
    },
    sessionBindings: {
      'session\u0000p': { keyId: 'k1', boundAt: Date.now() },
      old: { keyId: 'gone', boundAt: 0 },
    },
  })
  assert.equal((state.providers.p.keys[0] as unknown as { value?: unknown }).value, undefined)
  assert.equal(state.providers.p.hadProfile, true)
  assert.equal(state.providers.p.keys[0].kind, 'api-key')
  assert.equal(state.providers.p.keys[0].oauth!.access, 'x')
  assert.equal(state.sessionBindings['session\u0000p'].keyId, 'k1')
  assert.equal(state.sessionBindings.old, undefined)
})

test('store persists atomically and reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-test-'))
  try {
    const file = join(dir, 'state.json')
    const store = new KeysManagerStore(file)
    store.state.providers.p = {
      provider: 'p',
      displayName: 'P',
      source: 'dsh',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'p'],
      adapter: 'pi-ai',
      brokerRef: 'KEYSMGR_P_AAAAAA',
      originalApiKeyEnv: null,
      createdProfile: false,
      hadProfile: true,
      extraId: null,
      api: null,
      baseURL: null,
      models: [],
      adoptedAt: now,
      cursor: 0,
      keys: [key('k1')],
    }
    store.state.settings = normalizeSettings({ retryCount: 1 })
    store.touch()
    await store.flush()
    const text = await readFile(file, 'utf8')
    assert.ok(text.includes('KEYSMGR_P_AAAAAA'))
    assert.ok(!text.includes('sk-'))
    const reloaded = new KeysManagerStore(file)
    assert.equal(reloaded.provider('p')!.keys[0].id, 'k1')
    assert.equal(reloaded.settings.retryCount, 1)
    await reloaded.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt state is preserved and the store starts fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-test-'))
  try {
    const file = join(dir, 'state.json')
    await writeFile(file, '{not json', 'utf8')
    const store = new KeysManagerStore(file)
    assert.ok(store.loadError)
    assert.deepEqual(store.providers, {})
    const entries = await (await import('node:fs/promises')).readdir(dir)
    assert.ok(entries.some(entry => entry.includes('.corrupt-')))
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('statePath honors DSH_HOME', () => {
  assert.equal(statePath({ DSH_HOME: '/tmp/dsh-home' }, '/home/user'), '/tmp/dsh-home/keys-manager/state.json')
  assert.equal(statePath({}, '/home/user'), '/home/user/.dsh/keys-manager/state.json')
})


test('a failed flush keeps state dirty for an explicit retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-flush-'))
  try {
    const file = join(dir, 'state.json')
    const store = new KeysManagerStore(file, { warn: () => {} })
    await mkdir(file)
    store.state.settings.retryCount = 3
    store.touch()
    await assert.rejects(() => store.flush())
    await rm(file, { recursive: true, force: true })
    await store.flush()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { settings: { retryCount: number } }
    assert.equal(persisted.settings.retryCount, 3)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('pruneBindings drops expired session bindings', () => {
  const store = new KeysManagerStore(join(tmpdir(), `keys-manager-bindings-${process.pid}.json`))
  const now = Date.now()
  store.state.sessionBindings['fresh\u0000p'] = { keyId: 'k1', boundAt: now }
  store.state.sessionBindings['old\u0000p'] = { keyId: 'k2', boundAt: now - 31 * 24 * 60 * 60 * 1000 }
  assert.equal(store.pruneBindings(now), true)
  assert.deepEqual(Object.keys(store.state.sessionBindings), ['fresh\u0000p'])
  assert.equal(store.pruneBindings(now), false)
})


test('round robin can exclude already tried keys', () => {
  const a = key('a')
  const b = key('b')
  const p = provider([a, b])
  const exclude = new Set(['a'])
  assert.equal(pickRoundRobin(p, now, exclude), b)
  exclude.add('b')
  assert.equal(pickRoundRobin(p, now, exclude), undefined)
})

test('sanitize drops legacy valueMissing markers', () => {
  const state = sanitizeState({
    version: 1,
    providers: {
      p: {
        provider: 'p',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'p'],
        keys: [{ id: 'k', ref: 'REF_K', valueMissing: true }],
      },
    },
  })
  assert.equal(state.providers.p.keys[0].valueMissing, false)
})


test('a state read failure keeps the file untouched and refuses writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-readfail-'))
  try {
    const file = join(dir, 'state.json')
    await mkdir(file)
    const store = new KeysManagerStore(file, { warn: () => {} })
    assert.equal(store.readOnly, true)
    assert.match(String(store.loadError), /not a regular file|Could not read/)
    store.state.settings.retryCount = 3
    store.touch()
    await store.flush()
    assert.equal((await stat(file)).isDirectory(), true)
    await store.close()
    assert.equal((await stat(file)).isDirectory(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt state is backed up and the fresh store is writable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-corrupt-'))
  try {
    const file = join(dir, 'state.json')
    await writeFile(file, '{not json')
    const store = new KeysManagerStore(file, { warn: () => {} })
    assert.equal(store.readOnly, false)
    assert.match(String(store.loadError), /preserved at/)
    const entries = await readdir(dir)
    assert.ok(entries.some(name => name.includes('state.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('a permission-denied parent directory is read-only and preserves state', async () => {
  if (process.getuid?.() === 0) return
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-permissions-'))
  const file = join(dir, 'state.json')
  const original = JSON.stringify({ settings: { retryCount: 2 }, providers: {}, sessionBindings: {} }, null, 2)
  try {
    await writeFile(file, original)
    await chmod(dir, 0o000)
    const store = new KeysManagerStore(file, { warn: () => {} })
    assert.equal(store.readOnly, true)
    assert.match(String(store.loadError), /Could not inspect|not a regular file/)
    await chmod(dir, 0o700)
    store.state.settings.retryCount = 9
    store.touch()
    await store.close()
    assert.equal(await readFile(file, 'utf8'), original)
  } finally {
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})


test('an unsupported state version stays read-only and untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keys-manager-version-'))
  try {
    const file = join(dir, 'state.json')
    const original = JSON.stringify({ version: 2, settings: { retryCount: 3 }, providers: {}, sessionBindings: {} }, null, 2)
    await writeFile(file, original)
    const store = new KeysManagerStore(file, { warn: () => {} })
    assert.equal(store.readOnly, true)
    assert.match(String(store.loadError), /Unsupported state schema version 2/)
    store.state.settings.retryCount = 9
    store.touch()
    await store.close()
    assert.equal(await readFile(file, 'utf8'), original)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
