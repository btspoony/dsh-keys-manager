/** State store shared by the plugin-detail card and the Models badges. */
import type {
  AckResult,
  ActionOutcome,
  AccountAttemptListResult,
  AccountAttemptResult,
  AccountAttemptView,
  ClientContext,
  ClientSnapshot,
  ClientStore,
  KeyTestOutcome,
  KeyTestResult,
  RpcResult,
  StateView,
} from './types'

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** Create the store bound to one connected Client context. */
export function createStore(ctx: ClientContext): ClientStore {
  let snapshot: ClientSnapshot = {
    status: 'idle',
    state: null,
    error: null,
    busy: null,
    now: Date.now(),
  }
  let loadSequence = 0
  let mutationTail: Promise<unknown> = Promise.resolve()
  let queuedMutations = 0
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Contain subscriber failures; a broken card must not blank the slot.
      }
    }
  }
  const update = (patch: Partial<ClientSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    emit()
  }
  const rpc = (method: string, args: Record<string, unknown>): Promise<RpcResult> =>
    ctx.connection.rpc.call('/api', `keysManager/${method}`, { args })

  /**
   * Serialize mutations so a later failure cannot discard the successful
   * snapshot of an earlier mutation. Keep the busy flag until the queue is
   * empty; a load cannot start while a mutation is queued or running.
   * `onSuccess` decides what a successful value does to the snapshot (a
   * StateView replaces it; attempt views and acknowledgements do not) and
   * produces the typed outcome.
   */
  const send = async <T>(
    method: string,
    args: Record<string, unknown>,
    onSuccess: (value: unknown) => T,
  ): Promise<T | { ok: false; error: string }> => {
    queuedMutations += 1
    update({ busy: method, error: null })
    const run = async (): Promise<T | { ok: false; error: string }> => {
      ++loadSequence // invalidate a load that started before this mutation
      try {
        const result = await rpc(method, args)
        if (!result.ok) throw new Error(result.error.message)
        const outcome = onSuccess(result.value)
        if (queuedMutations === 1) update({ busy: null })
        return outcome
      } catch (error) {
        const message = messageOf(error)
        if (queuedMutations === 1) update({ busy: null, error: message })
        else update({ error: message })
        return { ok: false, error: message }
      } finally {
        queuedMutations -= 1
      }
    }
    const next = mutationTail.then(run, run)
    mutationTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Accept a StateView-carrying mutation: refresh the snapshot with it. */
  const stateOutcome = (value: unknown): ActionOutcome => {
    const state = value as StateView
    if (queuedMutations === 1) update({ status: 'ready', state, now: Date.now(), busy: null, error: null })
    else update({ status: 'ready', state, now: Date.now(), error: null })
    return { ok: true, value: state }
  }

  /** Read-only RPC (polling): never queues, never touches the snapshot. */
  const rpcRead = async (method: string, args: Record<string, unknown>): Promise<RpcResult> => {
    try {
      return await rpc(method, args)
    } catch (error) {
      return { ok: false, error: { message: messageOf(error) } }
    }
  }

  /** Narrow an attempt-scoped answer; the wire may carry undefined or null. */
  const attemptOutcome = (value: unknown): AccountAttemptResult => {
    return { ok: true, value: (value ?? null) as AccountAttemptView | null }
  }

  /** A connection test answers with its own result, never a state view. */
  const testOutcome = (value: unknown): { ok: true; value: KeyTestResult } => {
    const result = (value ?? {}) as Partial<KeyTestResult>
    return {
      ok: true,
      value: { ok: result.ok === true, latencyMs: result.latencyMs ?? 0, ...(result.error === undefined ? {} : { error: result.error }) },
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async load(options = {}) {
      // Do not let a refresh race a mutation; the UI also disables refresh.
      if (snapshot.busy !== null) return
      const request = ++loadSequence
      update({ busy: 'load', error: options.keepError === true ? snapshot.error : null })
      try {
        const result = await rpc('getState', {})
        if (request !== loadSequence) return
        if (!result.ok) throw new Error(result.error.message)
        update({ status: 'ready', state: result.value as StateView, now: Date.now(), busy: null, error: null })
      } catch (error) {
        if (request !== loadSequence) return
        update({ status: snapshot.state !== null ? snapshot.status : 'error', busy: null, error: messageOf(error) })
      }
    },
    call(method: string, args: Record<string, unknown>): Promise<ActionOutcome> {
      return send(method, args, stateOutcome)
    },
    beginAccountLogin(provider: string, alias?: string, targetAccountId?: string): Promise<AccountAttemptResult> {
      return send('beginAccountLogin', { provider, alias, targetAccountId }, attemptOutcome)
    },
    answerAccountPrompt(attemptId: string, value: string): Promise<AckResult> {
      return send('answerAccountPrompt', { attemptId, value }, () => ({ ok: true, value: null }))
    },
    async accountAttempt(attemptId: string): Promise<AccountAttemptResult> {
      const result = await rpcRead('accountAttempt', { attemptId })
      if (!result.ok) return { ok: false, error: result.error.message }
      return attemptOutcome(result.value)
    },
    async listAccountAttempts(): Promise<AccountAttemptListResult> {
      const result = await rpcRead('listAccountAttempts', {})
      if (!result.ok) return { ok: false, error: result.error.message }
      return { ok: true, value: (result.value ?? []) as AccountAttemptView[] }
    },
    activateAccount(provider: string, accountId: string): Promise<ActionOutcome> {
      return send('activateAccount', { provider, accountId }, stateOutcome)
    },
    removeAccount(provider: string, accountId: string): Promise<ActionOutcome> {
      return send('removeAccount', { provider, accountId }, stateOutcome)
    },
    testKey(provider: string, keyId: string): Promise<KeyTestOutcome> {
      return send('testKey', { provider, keyId }, testOutcome)
    },
    tick() {
      update({ now: Date.now() })
      // Cooldown statuses and summary counters are derived on the Host. Refresh
      // them while the page is idle so a cooled-down key becomes active in the
      // UI without waiting for an unrelated mutation.
      if (snapshot.status === 'ready' && snapshot.busy === null) void this.load({ keepError: true })
    },
    dismissError() {
      update({ error: null })
    },
  }
}
