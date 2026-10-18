/** React runtime context and hooks shared by the Client plugin body. */
import React from 'react'
import { CSS } from './styles'
import type { ClientContext, ClientSnapshot, Runtime } from './types'

/** Context installed by every wrapped slot entry. */
export const RuntimeContext = React.createContext<Runtime | null>(null)

/** Read the plugin runtime; a component outside the wrapper is a wiring bug. */
export function useRuntime(): Runtime {
  const runtime = React.useContext(RuntimeContext)
  if (runtime === null) throw new Error('Keys Manager runtime is not mounted')
  return runtime
}

/** Translate through the plugin locale namespace, re-rendering on locale changes. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const runtime = useRuntime()
  const ctx = runtime.ctx
  const subscribe = React.useCallback((listener: () => void) => ctx.locale.subscribe(listener), [ctx])
  const getSnapshot = React.useCallback(() => ctx.locale.getSnapshot(), [ctx])
  const locale = React.useSyncExternalStore(subscribe, getSnapshot)
  return React.useMemo(() => ctx.locale.bind('dsh-keys-manager'), [ctx, locale.revision])
}

/** Active locale id, used by date/time formatting. */
export function useLocaleId(): string {
  const runtime = useRuntime()
  const ctx = runtime.ctx
  const subscribe = React.useCallback((listener: () => void) => ctx.locale.subscribe(listener), [ctx])
  const getSnapshot = React.useCallback(() => ctx.locale.getSnapshot(), [ctx])
  return React.useSyncExternalStore(subscribe, getSnapshot).active
}

/** Subscribe to the shared manager store. */
export function useStore(): ClientSnapshot {
  const runtime = useRuntime()
  return React.useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot)
}

/** Current wall clock from the store's 30-second tick. */
export function useNow(): number {
  return useStore().now
}

let styleRefs = 0

/** Install the plugin stylesheet once per mounted surface. */
export function useStyles(): void {
  React.useEffect(() => {
    styleRefs += 1
    let element = document.getElementById('dsh-keys-manager-styles')
    if (element === null) {
      element = document.createElement('style')
      element.id = 'dsh-keys-manager-styles'
      document.head.appendChild(element)
    }
    element.textContent = CSS
    return () => {
      styleRefs -= 1
      if (styleRefs <= 0) {
        styleRefs = 0
        element?.remove()
      }
    }
  }, [])
}

/** Wrap a slot component with the runtime provider and the stylesheet. */
export function wrapComponent(
  Component: React.ComponentType<any>,
  runtime: Runtime,
): React.ComponentType<any> {
  return function KeysManagerRuntime(props: Record<string, unknown>) {
    useStyles()
    return React.createElement(RuntimeContext.Provider, { value: runtime }, React.createElement(Component, props))
  }
}

/** Re-export for callers that want the raw context value. */
export type { ClientContext, Runtime }
