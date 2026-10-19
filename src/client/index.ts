/**
 * Keys Manager Client body.
 *
 * Registers the manager card on the plugin's own detail page (the standard
 * `plugins.bundle.config` keyed slot) and the managed badge on the existing
 * Models provider-card slot. The Models page remains the place where provider
 * profiles and model lists are edited; this plugin only owns the key pool.
 */
import { LOCALE_DICTS } from './locales'
import { wrapComponent } from './runtime'
import { createStore } from './store'
import { KeysManagerCard, ManagedProviderBadge } from './ui'
import type { ClientContext } from './types'

export const inject = ['slots', 'locale', 'connection']

const NS = 'dsh-keys-manager'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, LOCALE_DICTS), 'keys-manager: dictionaries')

  const store = createStore(ctx)
  const runtime = { ctx, store }

  ctx.effect(() => {
    void store.load()
    let disposed = false
    const retry = async (): Promise<void> => {
      for (let attempt = 0; attempt < 4 && !disposed; attempt += 1) {
        if (store.getSnapshot().status === 'ready') return
        await new Promise(resolve => setTimeout(resolve, 600))
        if (disposed) return
        await store.load()
      }
    }
    void retry()
    const off = ctx.on('connection/reset', () => {
      void store.load()
    })
    const timer = setInterval(() => store.tick(), 30_000)
    return () => {
      disposed = true
      off()
      clearInterval(timer)
    }
  }, 'keys-manager: lifecycle')

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-keys-manager',
  }, wrapComponent(KeysManagerCard, runtime)))

  ctx.slots.inject('settings.models.provider-card', () => {
    const disposers = [
      ctx.slots.register({ name: 'settings.models.provider-card', key: 'llm-pi-ai' }, wrapComponent(ManagedProviderBadge, runtime)),
      ctx.slots.register({ name: 'settings.models.provider-card', key: 'llm-deepseek-api-key' }, wrapComponent(ManagedProviderBadge, runtime)),
      ctx.slots.register({ name: 'settings.models.provider-card', key: 'llm-deepseek' }, wrapComponent(ManagedProviderBadge, runtime)),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
