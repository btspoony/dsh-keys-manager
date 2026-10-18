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
  let generation = 0
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
      const request = ++generation
      update({ busy: 'load', error: options.keepError === true ? snapshot.error : null })
      try {
        const result = await rpc('getState', {})
        if (request !== generation) return
        if (!result.ok) throw new Error(result.error.message)
        update({ status: 'ready', state: result.value, now: Date.now(), busy: null, error: null })
      } catch (error) {
        if (request !== generation) return
        update({ status: snapshot.state !== null ? snapshot.status : 'error', busy: null, error: messageOf(error) })
      }
    },
    async call(method: string, args: Record<string, unknown>): Promise<ActionOutcome> {
      const request = ++generation
      update({ busy: method, error: null })
      try {
        const result = await rpc(method, args)
        if (!result.ok) throw new Error(result.error.message)
        if (request === generation) update({ status: 'ready', state: result.value, now: Date.now(), busy: null, error: null })
        return { ok: true, value: result.value }
      } catch (error) {
        const message = messageOf(error)
        if (request === generation) update({ busy: null, error: message })
        return { ok: false, error: message }
      }
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
