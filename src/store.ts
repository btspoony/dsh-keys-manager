/**
 * Durable, secret-free state for the Keys Manager.
 *
 * The file at `<DSH_HOME>/keys-manager/state.json` holds provider/key
 * metadata only: aliases, refs, health, counters, and session bindings. API
 * key literals live in the Harness credential store under each key's
 * `ref`, and OAuth account grant payloads live there too, behind the
 * account row's `oauth.grantRef`. The shape is deliberately additive so
 * `kind: 'oauth'` rows sit beside `kind: 'api-key'` without a migration
 * that rewrites existing rows.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { KeyRecord, ModelRecord, OAuthAccount, ProviderRecord, StateDocument } from './domain.js'
import { normalizeCursor, normalizeSettings } from './core.js'

export const STATE_VERSION = 1 as const
export const STATE_DIRNAME = 'keys-manager'
export const STATE_FILENAME = 'state.json'
const BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** State document plus a non-fatal load diagnostic. */
export type LoadedState = StateDocument & { loadError?: string; readOnly?: boolean }

/** Resolve the durable state directory for the current Harness home. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh')
  return join(dshHome, STATE_DIRNAME)
}

/** Resolve the complete state file path. */
export function statePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(stateDirectory(env, home), STATE_FILENAME)
}

/** Fresh, empty state. */
export function emptyState(): StateDocument {
  return {
    version: STATE_VERSION,
    settings: normalizeSettings(undefined),
    providers: {},
    sessionBindings: {},
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize one persisted OAuth account payload to the typed shape.
 *
 * Only the reference + metadata fields survive, so a stray token payload can
 * never reach the state document. Legacy placeholder objects (pre-account
 * builds) lack the required `provider`/`grantRef` pair and normalize to
 * null, which keeps those rows loadable unchanged.
 */
function sanitizeOAuthAccount(raw: unknown): OAuthAccount | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  if (typeof source.provider !== 'string' || source.provider.length === 0) return null
  if (typeof source.grantRef !== 'string' || source.grantRef.length === 0) return null
  const account: OAuthAccount = { provider: source.provider, grantRef: source.grantRef }
  if (typeof source.email === 'string') account.email = source.email
  if (typeof source.accountId === 'string') account.accountId = source.accountId
  if (typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt)) account.expiresAt = source.expiresAt
  return account
}

/** Strip any accidental secret-looking field from a key record. */
function sanitizeKey(raw: unknown): KeyRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0) return undefined
  if (typeof source.ref !== 'string' || source.ref.length === 0) return undefined
  const kind: KeyRecord['kind'] = source.kind === 'oauth' ? 'oauth' : 'api-key'
  return {
    id: source.id,
    alias: typeof source.alias === 'string' && source.alias.length > 0 ? source.alias.slice(0, 80) : 'Key',
    ref: source.ref,
    kind,
    enabled: source.enabled !== false,
    createdAt: numberOr(source.createdAt, Date.now()),
    lastUsedAt: numberOr(source.lastUsedAt, 0),
    cooldownUntil: numberOr(source.cooldownUntil, 0),
    lastFailureAt: numberOr(source.lastFailureAt, 0),
    lastFailureCode: typeof source.lastFailureCode === 'string' ? source.lastFailureCode : '',
    failureLevel: integerOr(source.failureLevel, 0),
    consecutiveFailures: integerOr(source.consecutiveFailures, 0),
    totalUses: integerOr(source.totalUses, 0),
    totalFailures: integerOr(source.totalFailures, 0),
    // The flag carries two meanings, split by row kind:
    // - api-key rows cache a transient credential read failure. The credential
    //   may be healthy again, so re-probe on the next selection instead of
    //   carrying a permanent marker across restarts.
    // - oauth rows persist the demotion marker. A demoted row no longer
    //   serves the provider and the projection is gone, so a restarted process
    //   cannot re-identify an owner; dropping the marker would resurrect the
    //   row as active/healthy once its cooldown expires.
    valueMissing: kind === 'oauth' ? source.valueMissing === true : false,
    importedFrom: typeof source.importedFrom === 'string' ? source.importedFrom : null,
    oauth: sanitizeOAuthAccount(source.oauth),
  }
}

function sanitizeModels(raw: unknown): ModelRecord[] {
  if (!Array.isArray(raw)) return []
  const models: ModelRecord[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const source = entry as Record<string, unknown>
    if (typeof source.id !== 'string' || source.id.length === 0) continue
    const model: ModelRecord = { id: source.id }
    if (typeof source.name === 'string') model.name = source.name
    if (typeof source.contextWindow === 'number') model.contextWindow = source.contextWindow
    if (typeof source.maxTokens === 'number') model.maxTokens = source.maxTokens
    if (Array.isArray(source.input)) {
      model.input = source.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    }
    if (source.reasoningEfforts !== null && typeof source.reasoningEfforts === 'object') {
      model.reasoningEfforts = source.reasoningEfforts as Record<string, unknown>
    }
    if (source.compat !== null && typeof source.compat === 'object') {
      model.compat = source.compat as Record<string, unknown>
    }
    models.push(model)
  }
  return models
}

/** Validate one persisted provider record. */
function sanitizeProvider(raw: unknown): ProviderRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  if (typeof source.provider !== 'string' || source.provider.length === 0) return undefined
  const settingsPath = Array.isArray(source.settingsPath)
    ? source.settingsPath.filter((part): part is string => typeof part === 'string')
    : []
  const keys = Array.isArray(source.keys) ? source.keys.map(sanitizeKey).filter((key): key is KeyRecord => key !== undefined) : []
  return {
    provider: source.provider,
    displayName: typeof source.displayName === 'string' && source.displayName.length > 0 ? source.displayName : source.provider,
    source: source.source === 'extra' ? 'extra' : 'dsh',
    settingsNs: typeof source.settingsNs === 'string' ? source.settingsNs : 'llm-pi-ai',
    settingsPath,
    adapter: source.adapter === 'deepseek' ? 'deepseek' : 'pi-ai',
    brokerRef: typeof source.brokerRef === 'string' ? source.brokerRef : '',
    originalApiKeyEnv: typeof source.originalApiKeyEnv === 'string' && source.originalApiKeyEnv.length > 0 ? source.originalApiKeyEnv : null,
    createdProfile: source.createdProfile === true,
    hadProfile: source.hadProfile === true,
    extraId: typeof source.extraId === 'string' ? source.extraId : null,
    api: typeof source.api === 'string' ? source.api : null,
    baseURL: typeof source.baseURL === 'string' ? source.baseURL : null,
    models: sanitizeModels(source.models),
    adoptedAt: numberOr(source.adoptedAt, Date.now()),
    cursor: normalizeCursor(typeof source.cursor === 'number' ? source.cursor : 0, keys.length),
    keys,
  }
}

/** Sanitize a whole document, dropping anything the current schema cannot express. */
export function sanitizeState(raw: unknown): StateDocument {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  const source = raw as Record<string, unknown>
  state.settings = normalizeSettings(source.settings)
  if (source.providers !== null && typeof source.providers === 'object' && !Array.isArray(source.providers)) {
    for (const [id, provider] of Object.entries(source.providers as Record<string, unknown>)) {
      const clean = sanitizeProvider(provider)
      if (clean !== undefined && clean.provider === id) state.providers[id] = clean
    }
  }
  if (source.sessionBindings !== null && typeof source.sessionBindings === 'object' && !Array.isArray(source.sessionBindings)) {
    const now = Date.now()
    for (const [key, binding] of Object.entries(source.sessionBindings as Record<string, unknown>)) {
      if (binding === null || typeof binding !== 'object') continue
      const record = binding as Record<string, unknown>
      const keyId = typeof record.keyId === 'string' ? record.keyId : ''
      const boundAt = numberOr(record.boundAt, 0)
      if (keyId.length === 0 || now - boundAt > BINDING_TTL_MS) continue
      state.sessionBindings[key] = { keyId, boundAt }
    }
  }
  return state
}

/** Read a state file; only parse corruption is preserved and reset. */
export function readStateFile(file: string): LoadedState {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    return {
      ...emptyState(),
      readOnly: true,
      loadError: `Could not inspect ${file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!stats.isFile()) {
    return {
      ...emptyState(),
      readOnly: true,
      loadError: `${file} is not a regular file; refusing to overwrite it.`,
    }
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // A read failure is not corruption. Keep the file untouched and refuse to
    // overwrite it; the manager starts read-only/in-memory.
    return {
      ...emptyState(),
      readOnly: true,
      loadError: `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.corrupt-${stamp}`
    let preserved = false
    try {
      renameSync(file, backup)
      preserved = true
    } catch {
      // Keep the original bytes if the backup could not be created.
    }
    return {
      ...emptyState(),
      readOnly: !preserved,
      loadError: preserved
        ? `State file was corrupt; preserved at ${backup} (${error instanceof Error ? error.message : String(error)})`
        : `State file was corrupt and could not be backed up; refusing to overwrite it (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const version = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>).version : undefined
  if (version !== undefined && version !== STATE_VERSION) {
    return {
      ...emptyState(),
      readOnly: true,
      loadError: `Unsupported state schema version ${String(version)}; refusing to overwrite ${file}.`,
    }
  }
  return sanitizeState(parsed)
}


export interface KeysManagerStoreOptions {
  warn?: (message: string) => void
}

/** Durable store with a debounced atomic writer. */
export class KeysManagerStore {
  readonly file: string
  state: StateDocument
  loadError: string | undefined
  readonly readOnly: boolean
  private readonly warn: (message: string) => void
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(file: string, options: KeysManagerStoreOptions = {}) {
    this.file = file
    this.warn = options.warn ?? (() => {})
    const loaded = readStateFile(file)
    this.loadError = loaded.loadError
    this.readOnly = loaded.readOnly === true
    const { loadError: _loadError, readOnly: _readOnly, ...state } = loaded
    this.state = state
  }

  get settings() {
    return this.state.settings
  }

  get providers(): Record<string, ProviderRecord> {
    return this.state.providers
  }

  provider(id: string): ProviderRecord | undefined {
    return this.state.providers[id]
  }

  key(providerId: string, keyId: string): KeyRecord | undefined {
    return this.state.providers[providerId]?.keys.find(key => key.id === keyId)
  }

  bind(sessionId: string, providerId: string, keyId: string, now: number = Date.now()): void {
    if (sessionId.length === 0) return
    this.state.sessionBindings[`${sessionId}\u0000${providerId}`] = { keyId, boundAt: now }
    this.touch()
  }

  binding(sessionId: string, providerId: string): { keyId: string; boundAt: number } | undefined {
    if (sessionId.length === 0) return undefined
    return this.state.sessionBindings[`${sessionId}\u0000${providerId}`]
  }

  clearBindings(predicate?: (key: string, binding: { keyId: string; boundAt: number }) => boolean): void {
    let changed = false
    for (const key of Object.keys(this.state.sessionBindings)) {
      const binding = this.state.sessionBindings[key]
      if (predicate === undefined || predicate(key, binding)) {
        delete this.state.sessionBindings[key]
        changed = true
      }
    }
    if (changed) this.touch()
  }

  /** Drop session bindings older than the TTL; safe to call periodically. */
  pruneBindings(now: number = Date.now()): boolean {
    let changed = false
    for (const [key, binding] of Object.entries(this.state.sessionBindings)) {
      if (now - binding.boundAt > BINDING_TTL_MS) {
        delete this.state.sessionBindings[key]
        changed = true
      }
    }
    if (changed) this.touch()
    return changed
  }

  /** Mark state dirty and schedule a write. */
  touch(): void {
    if (this.closed || this.readOnly) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(error => {
        this.warn(`keys-manager: failed to persist state: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 150)
    this.timer.unref?.()
  }

  /** Persist pending changes now, serialized after any in-flight write. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.readOnly) {
      this.dirty = false
      return this.writeChain
    }
    if (!this.dirty) return this.writeChain
    this.dirty = false
    // Sanitize at the write boundary too: whatever a caller put into memory,
    // only the typed, secret-free schema may reach the state document.
    const snapshot = JSON.stringify(sanitizeState(this.state), null, 2)
    const file = this.file
    const attempt = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temp, snapshot, { mode: 0o600 })
        await rename(temp, file)
        try {
          await chmod(file, 0o600)
        } catch {
          // Non-POSIX platforms have no mode to tighten.
        }
      } catch (error) {
        // Keep the latest snapshot pending and let an explicit flush retry it.
        this.dirty = true
        throw error
      }
    })
    // The internal chain must stay usable after a rejected attempt; callers
    // that care about the result receive `attempt` itself.
    this.writeChain = attempt.catch(() => {})
    return attempt
  }

  /** Stop the timer and persist once. */
  async close(): Promise<void> {
    this.closed = true
    if (this.readOnly) return
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.dirty = true
    try {
      await this.flush()
    } catch (error) {
      this.warn(`keys-manager: failed to persist state on close: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Synchronous bootstrap used by a Host plugin before its first request:
 * ensure the directory exists and, when the file is absent, write an empty
 * state once. The regular debounced writer owns later updates.
 */
export function ensureStateFile(file: string): void {
  try {
    statSync(file)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(emptyState(), null, 2), { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // A read-only home still serves in-memory state.
  }
}
