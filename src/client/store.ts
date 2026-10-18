/** State store shared by the plugin-detail card and the Models badges. */
import type { ActionOutcome, ClientContext, ClientSnapshot, ClientStore, RpcResult } from './types'

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
        update({ status: 'ready', state: result.value, now: Date.now(), busy: null, error: null })
      } catch (error) {
        if (request !== loadSequence) return
        update({ status: snapshot.state !== null ? snapshot.status : 'error', busy: null, error: messageOf(error) })
      }
    },
    call(method: string, args: Record<string, unknown>): Promise<ActionOutcome> {
      // Serialize mutations so a later failure cannot discard the successful
      // snapshot of an earlier mutation. Keep the busy flag until the queue is
      // empty; a load cannot start while a mutation is queued or running.
      queuedMutations += 1
      update({ busy: method, error: null })
      const run = async (): Promise<ActionOutcome> => {
        ++loadSequence // invalidate a load that started before this mutation
        try {
          const result = await rpc(method, args)
          if (!result.ok) throw new Error(result.error.message)
          const outcome: ActionOutcome = { ok: true, value: result.value }
          if (queuedMutations === 1) {
            update({ status: 'ready', state: result.value, now: Date.now(), busy: null, error: null })
          } else {
            update({ status: 'ready', state: result.value, now: Date.now(), error: null })
          }
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
