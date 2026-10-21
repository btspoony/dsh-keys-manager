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

/**
 * Bound one row test's request with the same budget as the UI's row deadline
 * (`client/ui.ts`). A lost answer has no cancellation, but the caller's row
 * must leave its running state, and a test abandoned at this deadline is never
 * started later by a queued reply (PR review round 8).
 */
const TEST_KEY_DEADLINE_MS = 30_000

/** Resolve with `work`'s value, or reject once `ms` passed without it. */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms / 1000}s`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
  // A row test borrows the route's projection while it runs and the host
  // restores the previous owner before it answers, so a snapshot taken inside
  // that window names the tested row as projected. `activeTests` and
  // `testGeneration` let `load` drop such a snapshot instead of storing it
  // (PR review round 9, R8-1).
  let activeTests = 0
  let testGeneration = 0
  // The generation the running mutation captured, and whether its view was
  // dropped because it was built inside a borrow window (PR review round 10).
  let mutationGeneration = 0
  let stateDropped = false
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
      mutationGeneration = testGeneration
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
        // PR review round 12: the queue is idle at exactly this point for every
        // tail — a success, a failure and a non-StateView answer all land here.
        // The re-read used to hang off `stateOutcome` and the test's `finally`
        // only, so a later queued mutation that failed (or answered an attempt
        // view) left a dropped mutation's change unread until the next tick.
        if (queuedMutations === 0) refreshDroppedState()
      }
    }
    const next = mutationTail.then(run, run)
    mutationTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Accept a StateView-carrying mutation: refresh the snapshot with it. */
  const stateOutcome = (value: unknown): ActionOutcome => {
    const state = value as StateView
    // PR review round 10 (I-000178): a mutation that lands inside a row test's
    // borrow window answers with the tested row projected, exactly like the
    // refresh `load` already refuses (R8-1) — the host restores the route
    // before the window closes, so the view is stale on arrival. Installing it
    // would leave the tested row marked as serving with its activation
    // disabled. Keep the mutation's real change by re-reading once no test
    // borrows the route, instead of resurrecting that view.
    const borrowed = activeTests > 0 || testGeneration !== mutationGeneration
    if (borrowed) {
      if (queuedMutations === 1) update({ busy: null, error: null })
      else update({ error: null })
      // The re-read runs at the queue's idle tail (see `send`), not here: this
      // body still holds the queue, so the tail is the one place the dropped
      // view can be read without racing the mutations behind it.
      stateDropped = true
      return { ok: true, value: state }
    }
    if (queuedMutations === 1) update({ status: 'ready', state, now: Date.now(), busy: null, error: null })
    else update({ status: 'ready', state, now: Date.now(), error: null })
    return { ok: true, value: state }
  }

  /** Re-read the state a dropped mutation view would have installed, once safe. */
  const refreshDroppedState = (): void => {
    if (!stateDropped || activeTests > 0 || snapshot.busy !== null) return
    stateDropped = false
    void store.load({ keepError: true })
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

  const store: ClientStore = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async load(options = {}) {
      // Do not let a refresh race a mutation; the UI also disables refresh.
      if (snapshot.busy !== null) return
      const request = ++loadSequence
      const generation = testGeneration
      update({ busy: 'load', error: options.keepError === true ? snapshot.error : null })
      try {
        const result = await rpc('getState', {})
        if (request !== loadSequence) return
        // A snapshot that overlapped a row test carries the borrowed
        // projection; the test's restore already made it stale, so it is
        // dropped and the pre-test snapshot (the restored route) stays.
        if (activeTests > 0 || testGeneration !== generation) {
          update({ busy: null })
          return
        }
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
    async testKey(provider: string, keyId: string): Promise<KeyTestOutcome> {
      // A row test is a read-style call (PR review round 8), not a queued
      // mutation: the UI's row deadline starts as soon as the row is clicked,
      // so queueing the call behind the serialized mutations could time the row
      // out and then run the test — borrowing the route's projection — with
      // nobody watching its answer. It sends at once, sets no global busy flag
      // and never replaces the snapshot: the host's answer is observation-only.
      activeTests += 1
      testGeneration += 1
      try {
        const result = await withDeadline(rpc('testKey', { provider, keyId }), TEST_KEY_DEADLINE_MS, 'testKey')
        if (!result.ok) throw new Error(result.error.message)
        return testOutcome(result.value)
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      } finally {
        activeTests -= 1
        // Invalidate every snapshot that overlapped the window, including one
        // that is still in flight when the host restores the route.
        testGeneration += 1
        // The host has put the route back by now, so a mutation view dropped
        // inside the window can be read again without its borrowed projection.
        refreshDroppedState()
      }
    },
    beginTransportLogin(route: string): Promise<AccountAttemptResult> {
      return send('beginTransportLogin', { provider: route }, attemptOutcome)
    },
    activateTransportAccount(route: string): Promise<ActionOutcome> {
      return send('activateTransportAccount', { provider: route }, stateOutcome)
    },
    removeTransportAccount(route: string): Promise<ActionOutcome> {
      return send('removeTransportAccount', { provider: route }, stateOutcome)
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
  return store
}
