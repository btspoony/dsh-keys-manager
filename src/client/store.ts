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
  TransportModelsResult,
  TransportModelsView,
} from './types'
import { shapeTransportModels } from './format'

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
/** How long a quota read may stay unanswered before the card reports it (`I-000322`). */
export const QUOTA_WAIT_MS = 30_000

/** Overrides, test-only. */
export interface ClientStoreOptions {
  /** Bound on one quota read; defaults to {@link QUOTA_WAIT_MS}. */
  quotaWaitMs?: number
}

export function createStore(ctx: ClientContext, options: ClientStoreOptions = {}): ClientStore {
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
  // One in-flight quota read per provider, so a double render or a retry click
  // cannot double a vendor probe.
  const quotaInFlight = new Map<string, Promise<ActionOutcome>>()
  // Per-provider request generation: a read that settles after its bound (or
  // after a newer read was issued) must not install anything (`I-000322`).
  const quotaGenerations = new Map<string, number>()
  const quotaWaitMs = options.quotaWaitMs ?? QUOTA_WAIT_MS
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
    // The flag is cleared by the successful read, not here: a load that fails
    // (or is superseded) must leave the recovery pending for the next tail.
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

  /** A transport model-picker answer shapes to its view and is not a snapshot. */
  const modelsOutcome = (value: unknown): { ok: true; value: TransportModelsView } => {
    return { ok: true, value: shapeTransportModels(value) }
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
        // A landed read satisfies any dropped-state recovery (round 40).
        stateDropped = false
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
    cancelAccountLogin(attemptId: string): Promise<AckResult> {
      return send('cancelAccountLogin', { attemptId }, () => ({ ok: true, value: null }))
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
      ++testGeneration
      const request = rpc('testKey', { provider, keyId })
      // The deadline below releases only the row: the snapshot isolation lasts
      // until this RPC actually settles, because the host may still project the
      // tested account while it runs (PR review round 24). An older request
      // settling later must not close a newer window (round 26), but it must
      // invalidate the snapshots taken inside its OWN borrow: a refresh that
      // read the store while this window borrowed it can answer after a newer
      // window settled and the generation already moved (round 28). Every
      // settle therefore advances the generation; `activeTests` still decides
      // whether a window is open at all.
      // Residual: an RPC that never settles keeps the isolation for the life of
      // the page — the safe direction, the row still shows its timeout, and a
      // reload is the recovery.
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        // Count down this request's own borrow even when a newer window owns
        // the tail, so the isolation cannot outlive every settled request.
        activeTests -= 1
        testGeneration += 1
        // The host has put the route back once no test borrows it, so a
        // mutation view dropped inside the window can be read again.
        refreshDroppedState()
      }
      void request.then(release, release)
      try {
        const result = await withDeadline(request, TEST_KEY_DEADLINE_MS, 'testKey')
        if (!result.ok) throw new Error(result.error.message)
        return testOutcome(result.value)
      } catch (error) {
        return { ok: false, error: messageOf(error) }
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
    async transportModels(route: string): Promise<TransportModelsResult> {
      const result = await rpcRead('transportModels', { provider: route })
      if (!result.ok) return { ok: false, error: result.error.message }
      return { ok: true, value: shapeTransportModels(result.value) }
    },
    refreshQuota(provider: string): Promise<ActionOutcome> {
      // Coalesce per provider: a StrictMode double render (and a manual retry
      // during an in-flight read) shares one RPC. Read-style, like `testKey`:
      // no queue, no global busy flag, and a failure never raises the card's
      // error banner — the host's per-row status carries the verdict.
      const pending = quotaInFlight.get(provider)
      if (pending !== undefined) return pending
      // Capture the borrow generation exactly like `load` does: the answer must
      // be judged against the window it was STARTED in.
      const generation = testGeneration
      // Per-provider stamp: an answer that outlives its bound is discarded by
      // comparing this value, never installed.
      const stamp = (quotaGenerations.get(provider) ?? 0) + 1
      quotaGenerations.set(provider, stamp)
      let dropped = false
      let settled = false
      /** Install one answer; shared by the live path and the abandoned tail. */
      const install = (state: StateView): void => {
        // Same install guard as every other state answer: a view that lands
        // inside a row test's borrow window carries the tested row as
        // projected with its activation disabled. Drop it and let the idle
        // tail re-read once that window closes.
        if (activeTests > 0 || testGeneration !== generation) {
          stateDropped = true
          dropped = true
        } else {
          // A background read must not clear a banner the user has not
          // acknowledged; the idle path loads with `keepError` for the same
          // reason.
          update({ status: 'ready', state, now: Date.now(), error: snapshot.error })
        }
      }
      // The read itself. It keeps running after the caller gave up, and then
      // throws its answer away on the stamp check below (`I-000322`).
      const read = (async (): Promise<ActionOutcome> => {
        const result = await rpc('quotaRefresh', { provider })
        if (!result.ok) throw new Error(result.error.message)
        if (quotaGenerations.get(provider) !== stamp) {
          return { ok: false, error: 'superseded by a newer usage read' }
        }
        const state = result.value as StateView
        if (!settled) install(state)
        return { ok: true, value: state }
      })()
      let timer: ReturnType<typeof setTimeout> | undefined
      const request = (async (): Promise<ActionOutcome> => {
        try {
          const answer = await Promise.race([
            read,
            new Promise<'timed-out'>(resolve => {
              timer = setTimeout(() => resolve('timed-out'), quotaWaitMs)
            }),
          ])
          if (answer === 'timed-out') {
            // Give up on this read for the caller, and invalidate it so a late
            // settle cannot overwrite whatever a newer read installs.
            quotaGenerations.set(provider, stamp + 1)
            return { ok: false, error: 'the usage read did not answer in time' }
          }
          return answer
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          settled = true
          quotaInFlight.delete(provider)
          // A borrow that already closed before this answer arrived has no
          // later tail run to recover the dropped view, so recover it here.
          if (dropped) refreshDroppedState()
        }
      })()
      quotaInFlight.set(provider, request)
      return request
    },
    saveTransportModels(route: string, models: string[]): Promise<TransportModelsResult> {
      return send('saveTransportModels', { provider: route, models }, modelsOutcome)
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
