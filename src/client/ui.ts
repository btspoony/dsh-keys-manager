/** Keys Manager browser components, rendered from the plugin-detail card and
 * the Models provider-card extension slot. */
import React from 'react'
import type { ActionOutcome, ClientStore, KeyStatus, ProviderStatus, KeyView, ProviderView, StateView, AccountAttemptView, TransportAccountStatus, TransportAccountView, TransportModelsView } from './types'
import type { ManagerSettings } from '../domain'
import { useLocaleId, useNow, useRuntime, useStore, useT } from './runtime'
import {
  QUOTA_WINDOW_LABEL,
  cooldownMinutes,
  cooldownMs,
  graceMinutes,
  graceMs,
  modelPickerRows,
  quotaNeedsRefresh,
  quotaPercent,
  quotaTone,
  quotaWindows,
  tightestQuotaWindow,
} from './format'

const h = React.createElement

type T = (key: string, params?: Record<string, string | number>) => string
type Tone = 'success' | 'warn' | 'idle' | 'error'
type IconName =
  | 'search' | 'plus' | 'dots' | 'chevron' | 'eye' | 'eyeOff' | 'key' | 'check'
  | 'pause' | 'play' | 'trash' | 'close' | 'refresh' | 'warning' | 'shield' | 'user' | 'activity'

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function countText(t: T, count: number, oneKey: string, manyKey: string): string {
  return count === 1 ? t(oneKey) : t(manyKey, { n: count })
}

function formatClock(timestamp: number, locale: string, t: T): string {
  if (!timestamp) return t('never')
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}

function relativeTime(timestamp: number, now: number, t: T): string {
  if (!timestamp) return t('never')
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return t('timeJustNow')
  if (diff < 3_600_000) return t('timeMinutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('timeHoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('timeDaysAgo', { n: Math.floor(diff / 86_400_000) })
}

function durationText(milliseconds: number, t: T): string {
  const ms = Math.max(0, milliseconds)
  if (ms < 60_000) return t('timeSeconds', { n: Math.max(1, Math.ceil(ms / 1000)) })
  if (ms < 3_600_000) return t('timeMinutes', { n: Math.ceil(ms / 60_000) })
  if (ms < 86_400_000) return t('timeHours', { n: Math.ceil(ms / 3_600_000) })
  return t('timeDays', { n: Math.ceil(ms / 86_400_000) })
}

function providerInitial(provider: ProviderView | undefined): string {
  const source = String(provider?.displayName || provider?.provider || '?').trim()
  return source.length === 0 ? '?' : source.slice(0, 1).toUpperCase()
}

/**
 * True when this route can offer OAuth sign-in right now.
 *
 * C6-2: the catalog's `nativeAuth.oauth` flag says the provider supports
 * OAuth upstream; the host's `accountSupported` verdict says this Harness
 * build has a flow it can actually begin. The host verdict is authoritative
 * whenever present, so a nativeAuth.oauth route without a pi-ai flow hides
 * Add account instead of opening a sign-in that would fail. Older host
 * snapshots that predate the field keep the catalog-only behaviour.
 */
export function oauthCapable(provider: ProviderView): boolean {
  // The host verdict is authoritative whenever present. An in-process sign-in
  // (issue #15: kilo, zai) has no catalog OAuth flag at all — its route may
  // report `nativeAuth: null` — so the old `nativeAuth.oauth` test would hide
  // the only sign-in entry the route has. Snapshots that predate the field
  // keep the catalog-only fallback.
  if (provider.accountSupported !== undefined) return provider.accountSupported
  return provider.nativeAuth?.oauth === true
}

/** Where the row tag says a route came from, including legacy snapshots. */
export function originOf(provider: ProviderView): 'dsh' | 'plugin' | 'custom' {
  return provider.origin ?? (provider.extra ? 'plugin' : 'dsh')
}

/** Provider-list quick filter. View state only: never written to the store. */
type ProviderFilter = 'all' | 'builtin' | 'plugin' | 'oauth' | 'transport'

/** Fixed chip set and order (product decision): origin → capability → surface. */
const FILTER_CHIPS: ReadonlyArray<{ value: ProviderFilter; label: string }> = [
  { value: 'all', label: 'filterAll' },
  { value: 'builtin', label: 'filterBuiltin' },
  { value: 'plugin', label: 'filterPlugin' },
  { value: 'oauth', label: 'filterOauth' },
  { value: 'transport', label: 'filterTransport' },
]

/**
 * One predicate per chip, so a row is never shown under two chips at once: a
 * transport route is its own surface and only All and Transport select it.
 */
function matchesFilter(provider: ProviderView, filter: ProviderFilter): boolean {
  switch (filter) {
    case 'transport': return provider.transport === true
    case 'builtin': return provider.transport !== true && originOf(provider) === 'dsh'
    case 'plugin': return provider.transport !== true && originOf(provider) === 'plugin'
    case 'oauth': return provider.transport !== true && oauthCapable(provider)
    default: return true
  }
}

/**
 * Transport account rows no provider card owns: without a card they have no
 * other sign-in/remove control, so the 已接管 surface renders them directly.
 */
function orphanTransportAccounts(providers: ProviderView[], transportAccounts: TransportAccountView[]): TransportAccountView[] {
  // Only a TRANSPORT card owns its account. A route id that collides with an
  // ordinary provider's id owns nothing here, so the row stays an orphan and
  // keeps rendering (the standalone section that used to carry it is gone).
  return transportAccounts.filter(account =>
    !providers.some(provider => provider.transport === true && provider.provider === account.id))
}

/**
 * Entries the 已接管 surface renders: provider cards (managed or transport)
 * plus transport account rows with no card.
 *
 * `StateView.managedCount` is the host's managed-only count (a transport route
 * stays out of it), so every 已接管 number the client renders derives from this
 * rule instead — the summary tile, the collapsed summary and the section head
 * cannot disagree.
 */
function managedEntryCount(providers: ProviderView[], transportAccounts: TransportAccountView[]): number {
  const cards = providers.filter(provider => provider.managed || provider.transport === true).length
  return cards + orphanTransportAccounts(providers, transportAccounts).length
}

/**
 * Identity line of an OAuth account row: the email, else the provider-side
 * account id, else the provider's display name.
 */
function accountIdentityOf(key: KeyView, provider: ProviderView): string {
  const oauth = key.oauth
  if (oauth !== null && oauth !== undefined) {
    if (oauth.email !== undefined && oauth.email.length > 0) return oauth.email
    if (oauth.accountId !== undefined && oauth.accountId.length > 0) return oauth.accountId
  }
  return provider.displayName || provider.provider
}

function statusKey(status: KeyStatus | ProviderStatus): string {
  switch (status) {
    case 'active': return 'keyStatusActive'
    case 'cooling': return 'keyStatusCooling'
    case 'paused': return 'keyStatusPaused'
    case 'missing': return 'keyStatusMissing'
    // A managed route with zero keys (round-3 finding 7): "Not managed"
    // would contradict the Managed badge rendered beside it.
    case 'empty': return 'keyStatusEmpty'
    default: return 'keyStatusUnmanaged'
  }
}

/**
 * Transport account status copy. A transport grant has three observable
 * states beyond "signed out": fresh, expired-but-refreshable (the route's
 * adapter renews it on the next request), and expired without a refresh token
 * (only a new sign-In can restore service).
 */
function transportStatusKey(status: TransportAccountStatus): string {
  switch (status) {
    case 'active': return 'transportStatusActive'
    case 'expired': return 'transportStatusExpired'
    case 'needs-reauth': return 'transportStatusNeedsReauth'
    default: return 'transportStatusSignedOut'
  }
}

function transportStatusTone(status: TransportAccountStatus): Tone {
  switch (status) {
    case 'active': return 'success'
    case 'expired': return 'warn'
    case 'needs-reauth': return 'error'
    default: return 'idle'
  }
}

function statusTone(status: KeyStatus | ProviderStatus): Tone {
  switch (status) {
    case 'active': return 'success'
    case 'cooling': return 'warn'
    case 'paused': return 'idle'
    case 'missing': return 'error'
    case 'empty': return 'idle'
    default: return 'idle'
  }
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

function Icon({ name, size = 16, className }: IconProps): React.ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
  if (name === 'search') return h('svg', common, h('circle', { cx: 11, cy: 11, r: 6.5 }), h('path', { d: 'M16 16l4 4' }))
  if (name === 'plus') return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
  if (name === 'dots') return h('svg', common, h('circle', { cx: 5, cy: 12, r: 1.2, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 12, cy: 12, r: 1.2, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 19, cy: 12, r: 1.2, fill: 'currentColor', stroke: 'none' }))
  if (name === 'chevron') return h('svg', common, h('path', { d: 'M6 9l6 6 6-6' }))
  if (name === 'eye') return h('svg', common, h('path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z' }), h('circle', { cx: 12, cy: 12, r: 2.5 }))
  if (name === 'eyeOff') return h('svg', common, h('path', { d: 'M3 3l18 18M10.6 6.2A9.8 9.8 0 0112 6c6 0 9.5 6 9.5 6a17 17 0 01-3.2 3.8M6.2 6.7A16.4 16.4 0 002.5 12s3.5 6 9.5 6a9.7 9.7 0 004.2-.9M9.9 9.9a3 3 0 004.2 4.2' }))
  if (name === 'key') return h('svg', common, h('circle', { cx: 8, cy: 12, r: 3.5 }), h('path', { d: 'M11.5 12H21M17 12v3M20 12v2.5' }))
  if (name === 'check') return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))
  if (name === 'pause') return h('svg', common, h('path', { d: 'M9 6v12M15 6v12' }))
  if (name === 'play') return h('svg', common, h('path', { d: 'M8 5l11 7-11 7V5z' }))
  if (name === 'trash') return h('svg', common, h('path', { d: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5' }))
  if (name === 'close') return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
  if (name === 'refresh') return h('svg', common, h('path', { d: 'M20 11a8 8 0 10-2.3 6M20 5v6h-6' }))
  if (name === 'warning') return h('svg', common, h('path', { d: 'M12 3l9.5 17h-19L12 3zM12 9v5M12 17.2v.1' }))
  if (name === 'shield') return h('svg', common, h('path', { d: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4' }))
  if (name === 'user') return h('svg', common, h('circle', { cx: 12, cy: 8, r: 3.6 }), h('path', { d: 'M5 20a7 7 0 0114 0' }))
  if (name === 'activity') return h('svg', common, h('path', { d: 'M3 12h4l2.5-7 4 14 2.5-7h5' }))
  return h('svg', common)
}

interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'normal' | 'small'
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
  children?: React.ReactNode
  title?: string
}

function Button({ variant = 'secondary', size = 'normal', type = 'button', disabled, onClick, children, title }: ButtonProps): React.ReactElement {
  return h('button', {
    type,
    className: cx('km-btn', `km-btn-${variant}`, size === 'small' && 'km-btn-small'),
    disabled,
    onClick,
    title,
  }, children)
}

interface StatusPillProps {
  status: KeyStatus | ProviderStatus
  t: T
}

function StatusPill({ status, t }: StatusPillProps): React.ReactElement {
  return h('span', { className: cx('km-status', `km-status-${statusTone(status)}`) },
    h('span', { className: cx('km-dot', `km-dot-${statusTone(status)}`) }),
    h('span', null, t(statusKey(status))),
  )
}

interface NoticeProps {
  tone?: 'info' | 'warn' | 'error'
  icon?: IconName
  title?: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
}

function Notice({ tone = 'info', icon = 'warning', title, children, action }: NoticeProps): React.ReactElement {
  return h('div', { className: cx('km-notice', `km-notice-${tone}`), role: tone === 'error' ? 'alert' : 'note' },
    h(Icon, { name: icon, size: 15, className: 'km-notice-icon' }),
    h('div', { className: 'km-notice-body' },
      title ? h('div', { className: 'km-notice-title' }, title) : null,
      h('div', { className: 'km-notice-text' }, children),
    ),
    action ? h('div', { className: 'km-notice-action' }, action) : null,
  )
}

interface ModalProps {
  title: string
  children?: React.ReactNode
  onClose: () => void
  footer?: React.ReactNode
  busy?: boolean
}

function Modal({ title, children, onClose, footer, busy }: ModalProps): React.ReactElement {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const onCloseRef = React.useRef(onClose)
  const busyRef = React.useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy

  React.useEffect(() => {
    // Focus trapping is a browser facility; a DOM-less mount (SSR, the no-DOM
    // test renderer) has nothing to trap.
    if (typeof document === 'undefined') return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const inerted: HTMLElement[] = []
    if (dialog !== null) {
      // Inert every sibling branch on the path to the dialog so assistive
      // technology cannot browse the page behind the confirmation.
      let node: HTMLElement | null = dialog.parentElement
      while (node !== null && node !== document.body) {
        for (const child of [...node.children]) {
          if (!(child instanceof HTMLElement) || child === dialog || child.contains(dialog)) continue
          if (!child.inert) {
            child.inert = true
            inerted.push(child)
          }
        }
        node = node.parentElement
      }
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialog).focus()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && busyRef.current !== true) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || dialog === null) return
      const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(node => node.offsetParent !== null)
      if (nodes.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      for (const element of inerted) element.inert = false
      if (previous !== null && previous.isConnected) previous.focus()
    }
  }, [])

  return h('div', {
    className: 'km-modal-backdrop',
    role: 'presentation',
    onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !busy) onClose()
    },
  }, h('div', {
    className: 'km-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    tabIndex: -1,
    ref: dialogRef,
  },
    h('div', { className: 'km-modal-title' }, title),
    h('div', { className: 'km-modal-body' }, children),
    h('div', { className: 'km-modal-footer' }, footer),
  ))
}

interface KeyFormProps {
  provider: ProviderView
  onDone?: () => void
  autoFocus?: boolean
}

function KeyForm({ provider, onDone, autoFocus = false }: KeyFormProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const [alias, setAlias] = React.useState('')
  const [value, setValue] = React.useState('')
  const [show, setShow] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const isExtra = !provider.managed && provider.extra
  const disabled = busy || alias.trim().length === 0 || value.trim().length === 0

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (disabled) return
    setBusy(true)
    setError(null)
    const method = provider.managed ? 'addKey' : 'addExtraProvider'
    const args = provider.managed
      ? { provider: provider.provider, alias: alias.trim(), value }
      : { extraId: provider.extraId ?? provider.provider, alias: alias.trim(), value }
    const result = await runtime.store.call(method, args)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setAlias('')
    setValue('')
    setShow(false)
    onDone?.()
  }

  return h('form', { className: 'km-form', onSubmit: submit },
    h('div', { className: 'km-form-lead' },
      h('div', { className: 'km-form-title' }, t('addKeyTitle')),
      h('div', { className: 'km-muted' }, isExtra ? t('adoptExtraHint') : t('addKeyHint')),
    ),
    h('div', { className: 'km-form-grid' },
      h('label', { className: 'km-field' },
        h('span', { className: 'km-field-label' }, t('alias')),
        h('input', {
          className: 'km-input',
          value: alias,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setAlias(event.target.value),
          placeholder: t('aliasPlaceholder'),
          maxLength: 80,
          autoFocus: autoFocus || isExtra,
          disabled: busy,
        }),
      ),
      h('label', { className: 'km-field km-field-wide' },
        h('span', { className: 'km-field-label' }, t('secret')),
        h('div', { className: 'km-secret' },
          h('input', {
            className: 'km-input km-secret-input',
            type: show ? 'text' : 'password',
            value,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
            placeholder: t('secretPlaceholder'),
            autoComplete: 'new-password',
            spellCheck: false,
            disabled: busy,
          }),
          h('button', {
            type: 'button',
            className: 'km-secret-toggle',
            onClick: () => setShow(current => !current),
            disabled: busy,
            title: show ? t('hide') : t('show'),
          }, h(Icon, { name: show ? 'eyeOff' : 'eye', size: 15 })),
        ),
      ),
    ),
    error !== null ? h('div', { className: 'km-inline-error', role: 'alert' }, error) : null,
    h('div', { className: 'km-form-actions' },
      h(Button, { variant: 'primary', type: 'submit', disabled },
        busy ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'plus', size: 14 }),
        h('span', null, busy ? (isExtra ? t('adding') : t('saving')) : (isExtra ? t('addExtra') : t('save'))),
      ),
    ),
  )
}

/** Inline state of one row's connection test. */
interface RowTestState {
  kind: 'running' | 'passed' | 'failed'
  latencyMs?: number
  error?: string
  /** The client gave up waiting for an answer (QC N4). */
  timedOut?: boolean
}

/** Result spans the row's grid columns (the row grids have no full-width cell). */
const ROW_TEST_STYLE = { gridColumn: '1 / -1', marginTop: '-2px' }

/**
 * Client-side deadline for one row test. The host bounds its own provider
 * call at 20 s and may spend a little longer restoring the route, so a lost
 * or wedged answer must not leave the row's Test action disabled forever
 * (QC N4).
 */
const ROW_TEST_DEADLINE_MS = 30_000

/**
 * Run one row test and fold the wire answer into the inline state, giving up
 * at {@link ROW_TEST_DEADLINE_MS} so `running` is always transient (QC N4).
 */
async function requestRowTest(store: ClientStore, provider: string, keyId: string): Promise<RowTestState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<RowTestState>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'failed', timedOut: true }), ROW_TEST_DEADLINE_MS)
  })
  const answer = store.testKey(provider, keyId).then((outcome): RowTestState => {
    if (!outcome.ok) return { kind: 'failed', error: outcome.error }
    if (outcome.value.ok) return { kind: 'passed', latencyMs: outcome.value.latencyMs }
    return { kind: 'failed', ...(outcome.value.error === undefined ? {} : { error: outcome.value.error }) }
  })
  try {
    return await Promise.race([answer, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function testLine(test: RowTestState | null, t: T): React.ReactElement | null {
  if (test === null) return null
  if (test.kind === 'running') {
    return h('div', { className: 'km-key-time km-muted', role: 'status', style: ROW_TEST_STYLE }, t('testRunning'))
  }
  if (test.kind === 'passed') {
    return h('div', { className: 'km-key-time', role: 'status', style: ROW_TEST_STYLE }, t('testPassed', { ms: test.latencyMs ?? 0 }))
  }
  // QC N6: never render an empty failure detail; a deadline and a wire answer
  // without a reason each carry their own copy.
  const detail = test.error !== undefined && test.error.length > 0
    ? test.error
    : test.timedOut === true ? t('testTimedOut') : t('testFailedUnknown')
  return h('div', { className: 'km-key-time km-warn', role: 'status', style: ROW_TEST_STYLE }, t('testFailed', { error: detail }))
}

interface KeyRowProps {
  provider: ProviderView
  keyRecord: KeyView
  now: number
  /** Start a fresh sign-in that replaces this row's literal (sign-in rows only). */
  onReauthenticate?: () => void
}

function KeyRow({ provider, keyRecord, now, onReauthenticate }: KeyRowProps): React.ReactElement {
  const key = keyRecord
  const runtime = useRuntime()
  const t = useT()
  const locale = useLocaleId()
  const [menu, setMenu] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [alias, setAlias] = React.useState(key.alias)
  const [confirm, setConfirm] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [test, setTest] = React.useState<RowTestState | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setAlias(key.alias)
  }, [key.alias])

  React.useEffect(() => {
    if (!menu) return undefined
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  async function update(patch: { alias?: string; enabled?: boolean }): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.call('updateKey', { provider: provider.provider, keyId: key.id, patch })
    setBusy(false)
    if (!result.ok) setError(result.error)
    else setEditing(false)
  }

  async function submitRename(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const next = alias.trim()
    if (next.length === 0 || next === key.alias) {
      setEditing(false)
      return
    }
    await update({ alias: next })
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.call('deleteKey', { provider: provider.provider, keyId: key.id })
    setBusy(false)
    if (!result.ok) setError(result.error)
    else setConfirm(false)
  }

  async function runTest(): Promise<void> {
    setTest({ kind: 'running' })
    setTest(await requestRowTest(runtime.store, provider.provider, key.id))
  }

  const cold = key.status === 'cooling' && key.cooldownUntil > now
  const meta = key.status === 'missing'
    ? t('keyStatusMissing')
    : key.totalUses > 0
      ? t('uses', { n: key.totalUses })
      : ''

  return h('div', { className: 'km-key-row', ref: rootRef },
    h('div', { className: 'km-key-identity' },
      h('div', { className: 'km-key-alias-line' },
        editing
          ? h('form', { className: 'km-rename', onSubmit: submitRename },
              h('input', {
                className: 'km-input km-rename-input',
                'aria-label': t('alias'),
                value: alias,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => setAlias(event.target.value),
                maxLength: 80,
                autoFocus: true,
                disabled: busy,
                onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Escape') setEditing(false)
                },
              }),
              h('button', { type: 'submit', className: 'km-icon-btn', disabled: busy, title: t('save') }, h(Icon, { name: 'check', size: 15 })),
              h('button', { type: 'button', className: 'km-icon-btn', onClick: () => { setEditing(false); setAlias(key.alias) }, title: t('cancel') }, h(Icon, { name: 'close', size: 15 })),
            )
          : h('span', { className: 'km-key-alias' }, key.alias),
        key.importedFrom !== null ? h('span', { className: 'km-tag' }, t('imported')) : null,
        key.kind === 'oauth' ? h('span', { className: 'km-tag' }, 'OAuth') : null,
      ),
      h('div', { className: 'km-key-sub' },
        h('span', { className: 'km-mono km-muted' }, `•••• ${key.id.slice(-4)}`),
        key.totalFailures > 0 ? h('span', { className: 'km-muted' }, t('failures', { n: key.totalFailures })) : null,
      ),
    ),
    h('div', { className: 'km-key-status' },
      h(StatusPill, { status: key.status, t }),
      cold ? h('div', { className: 'km-key-time km-warn' }, t('coolingUntil', { time: formatClock(key.cooldownUntil, locale, t) })) : null,
      cold ? h('div', { className: 'km-key-time' }, t('remaining', { time: durationText(key.cooldownUntil - now, t) })) : null,
    ),
    h('div', { className: 'km-key-last' },
      h('div', { className: 'km-key-time' }, `${t('lastUsed')}: ${relativeTime(key.lastUsedAt, now, t)}`),
      meta ? h('div', { className: 'km-key-time km-muted' }, meta) : null,
    ),
    h('div', { className: 'km-key-actions' },
      h('button', {
        type: 'button',
        className: 'km-icon-btn',
        'aria-haspopup': 'menu',
        'aria-expanded': menu,
        title: t('moreActions'),
        'aria-label': t('moreActions'),
        onClick: () => setMenu(current => !current),
        disabled: busy,
      }, h(Icon, { name: 'dots', size: 17 })),
      menu ? h('div', { className: 'km-menu', role: 'menu' },
        // A row this plugin signed in for can be refreshed the same way it was
        // created; a hand-entered key has nothing to re-authenticate.
        key.importedFrom?.startsWith('signin:') === true && onReauthenticate !== undefined
          ? h('button', { type: 'button', className: 'km-menu-item', role: 'menuitem', onClick: () => { setMenu(false); onReauthenticate() }, disabled: busy },
              h(Icon, { name: 'user', size: 15 }), t('signInAgain'))
          : null,
        h('button', { type: 'button', className: 'km-menu-item', role: 'menuitem', onClick: () => { setMenu(false); setEditing(true) } }, h(Icon, { name: 'key', size: 15 }), t('rename')),
        h('button', {
          type: 'button',
          className: 'km-menu-item',
          role: 'menuitem',
          onClick: () => { setMenu(false); void runTest() },
          disabled: busy || test?.kind === 'running',
        }, h(Icon, { name: 'activity', size: 15 }), t('testKey')),
        h('button', {
          type: 'button',
          className: 'km-menu-item',
          role: 'menuitem',
          onClick: () => { setMenu(false); void update({ enabled: !key.enabled }) },
          disabled: busy,
        }, h(Icon, { name: key.enabled ? 'pause' : 'play', size: 15 }), key.enabled ? t('pause') : t('resume')),
        h('div', { className: 'km-menu-sep' }),
        h('button', { type: 'button', className: 'km-menu-item km-menu-danger', role: 'menuitem', onClick: () => { setMenu(false); setConfirm(true) }, disabled: busy }, h(Icon, { name: 'trash', size: 15 }), t('delete')),
      ) : null,
    ),
    error !== null ? h('div', { className: 'km-key-error', role: 'alert' }, error) : null,
    testLine(test, t),
    confirm ? h(Modal, {
      title: t('deleteTitle', { alias: key.alias }),
      onClose: () => setConfirm(false),
      busy,
      footer: [
        h(Button, { key: 'cancel', onClick: () => setConfirm(false), disabled: busy }, t('cancel')),
        h(Button, { key: 'delete', variant: 'danger', onClick: remove, disabled: busy }, busy ? t('deleting') : t('deleteConfirm')),
      ],
    }, h('p', { className: 'km-modal-copy' }, t('deleteBody'))) : null,
  )
}

interface AccountRowProps {
  provider: ProviderView
  keyRecord: KeyView
  now: number
  /** Start a fresh OAuth sign-in that replaces this account's grant. */
  onReauthenticate: () => void
}

/**
 * One `kind: 'oauth'` pool member. Visually a sibling of {@link KeyRow}
 * (same grid, same status/last-used columns) but distinct through the
 * account glyph, the brand accent bar, and the identity line: accounts are
 * addressed by their provider-disclosed identity instead of a human alias.
 */
function AccountRow({ provider, keyRecord, now, onReauthenticate }: AccountRowProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const locale = useLocaleId()
  const key = keyRecord
  const identity = accountIdentityOf(key, provider)
  const [menu, setMenu] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [test, setTest] = React.useState<RowTestState | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!menu) return undefined
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  async function activate(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.activateAccount(provider.provider, key.id)
    setBusy(false)
    if (!result.ok) setError(result.error)
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.removeAccount(provider.provider, key.id)
    setBusy(false)
    if (!result.ok) setError(result.error)
    else setConfirm(false)
  }

  async function runTest(): Promise<void> {
    setTest({ kind: 'running' })
    setTest(await requestRowTest(runtime.store, provider.provider, key.id))
  }

  const cold = key.status === 'cooling' && key.cooldownUntil > now
  // Round-3 N1: the counters render as separate nodes (separator included),
  // so tests can assert the parts instead of pinning the joined string.
  const metaParts = [
    key.totalUses > 0 ? t('uses', { n: key.totalUses }) : null,
    key.totalFailures > 0 ? t('failures', { n: key.totalFailures }) : null,
  ].filter((value): value is string => value !== null)

  return h('div', { className: 'km-account-row', ref: rootRef },
    h('div', { className: 'km-key-identity' },
      h('div', { className: 'km-key-alias-line' },
        h('span', { className: 'km-account-glyph', 'aria-hidden': true }, h(Icon, { name: 'user', size: 13 })),
        h('span', { className: 'km-key-alias' }, identity),
        h('span', { className: 'km-tag km-tag-accent' }, t('accountIdentity')),
        // Step 6: the row whose grant IS the live projection is badged.
        key.projected === true ? h('span', { className: 'km-tag km-tag-accent' }, t('accountProjected')) : null,
      ),
      h('div', { className: 'km-key-sub' },
        h('span', { className: 'km-mono km-muted' }, `•••• ${key.id.slice(-4)}`),
      ),
    ),
    h('div', { className: 'km-key-status' },
      h(StatusPill, { status: key.status, t }),
      cold ? h('div', { className: 'km-key-time km-warn' }, t('coolingUntil', { time: formatClock(key.cooldownUntil, locale, t) })) : null,
      cold ? h('div', { className: 'km-key-time' }, t('remaining', { time: durationText(key.cooldownUntil - now, t) })) : null,
    ),
    h('div', { className: 'km-key-last' },
      h('div', { className: 'km-key-time' }, `${t('lastUsed')}: ${relativeTime(key.lastUsedAt, now, t)}`),
      metaParts.length > 0 ? h('div', { className: 'km-key-time km-muted' },
        metaParts.map((value, index) => [
          index > 0 ? h('span', { key: `sep-${index}`, className: 'km-dot-sep', 'aria-hidden': true }, '·') : null,
          h('span', { key: `part-${index}` }, value),
        ])) : null,
    ),
    h('div', { className: 'km-key-actions' },
      h('button', {
        type: 'button',
        className: 'km-icon-btn',
        'aria-haspopup': 'menu',
        'aria-expanded': menu,
        title: t('moreActions'),
        'aria-label': t('moreActions'),
        onClick: () => setMenu(current => !current),
        disabled: busy,
      }, h(Icon, { name: 'dots', size: 17 })),
      menu ? h('div', { className: 'km-menu', role: 'menu' },
        h('button', {
          type: 'button',
          className: 'km-menu-item',
          role: 'menuitem',
          onClick: () => { setMenu(false); void activate() },
          // Step 6: the projected row already serves the route; setting it
          // active again is a no-op, so the entry stays disabled.
          disabled: busy || key.projected === true,
        }, h(Icon, { name: 'check', size: 15 }), t('accountActivate')),
        h('button', {
          type: 'button',
          className: 'km-menu-item',
          role: 'menuitem',
          onClick: () => { setMenu(false); void runTest() },
          disabled: busy || test?.kind === 'running',
        }, h(Icon, { name: 'activity', size: 15 }), t('testKey')),
        h('button', {
          type: 'button',
          className: 'km-menu-item',
          role: 'menuitem',
          onClick: () => { setMenu(false); onReauthenticate() },
          disabled: busy,
        }, h(Icon, { name: 'refresh', size: 15 }), t('accountReauth')),
        h('div', { className: 'km-menu-sep' }),
        h('button', { type: 'button', className: 'km-menu-item km-menu-danger', role: 'menuitem', onClick: () => { setMenu(false); setConfirm(true) }, disabled: busy }, h(Icon, { name: 'trash', size: 15 }), t('delete')),
      ) : null,
    ),
    error !== null ? h('div', { className: 'km-key-error', role: 'alert' }, error) : null,
    testLine(test, t),
    confirm ? h(Modal, {
      // SF4: account-specific copy — the grant removal consequence, not a
      // key-deletion/provider-release promise. Step 8: the key-pool
      // fallback clause appears only when the route actually has key
      // support; an OAuth-only route states the real consequence instead.
      title: t('deleteAccountTitle', { alias: identity }),
      onClose: () => setConfirm(false),
      busy,
      footer: [
        h(Button, { key: 'cancel', onClick: () => setConfirm(false), disabled: busy }, t('cancel')),
        h(Button, { key: 'delete', variant: 'danger', onClick: remove, disabled: busy }, busy ? t('deleting') : t('deleteConfirm')),
      ],
    }, h('p', { className: 'km-modal-copy' }, t(provider.supported === true ? 'deleteAccountBody' : 'deleteAccountBodyNoKeys'))) : null,
  )
}

interface TransportAccountRowProps {
  account: TransportAccountView
}

/**
 * One `llm-omp-transports/<route>` account.
 *
 * Visually a sibling of {@link AccountRow}, but the model underneath differs:
 * a transport route keeps exactly one grant record and its own adapter
 * resolves it, so there is nothing to project into pi-ai and no "Set active"
 * entry — the row has no activation control because the stored grant already
 * IS the route's live credential. Removal deletes that record, and sign-in
 * starts the transports package's own flow.
 */
function TransportAccountRow({ account }: TransportAccountRowProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const locale = useLocaleId()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState(false)
  const [login, setLogin] = React.useState<{ attemptId: string } | null>(null)

  async function signIn(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.beginTransportLogin(account.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.value !== null) setLogin({ attemptId: result.value.id })
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.removeTransportAccount(account.id)
    setBusy(false)
    if (!result.ok) setError(result.error)
    else setConfirm(false)
  }

  const identity = account.email ?? account.accountId ?? account.displayName
  const tone = transportStatusTone(account.status)
  return h('div', { className: 'km-account-row km-transport-row' },
    h('div', { className: 'km-key-identity' },
      h('div', { className: 'km-key-alias-line' },
        h('span', { className: 'km-account-glyph', 'aria-hidden': true }, h(Icon, { name: 'user', size: 13 })),
        h('span', { className: 'km-key-alias' }, identity),
        h('span', { className: 'km-tag km-tag-accent' }, t('transportTag')),
      ),
      // The credential scope, never the payload: the record is the account.
      h('div', { className: 'km-key-sub' },
        h('span', { className: 'km-mono km-muted' }, account.scope),
      ),
    ),
    h('div', { className: 'km-key-status' },
      h('span', { className: cx('km-status', `km-status-${tone}`) },
        h('span', { className: cx('km-dot', `km-dot-${tone}`) }),
        h('span', null, t(transportStatusKey(account.status))),
      ),
    ),
    // The expiry column stays a clock, not a countdown: the route's adapter
    // renews the grant itself, so "expired" here means "renews on next use".
    // A static-bearer row advertises no expiry, but the cell stays in the grid
    // so its actions line up with dated rows; nothing is announced.
    account.expiresAt === undefined
      ? h('div', { className: 'km-key-last', 'aria-hidden': true })
      : h('div', { className: 'km-key-last' },
          h('div', { className: 'km-key-time' }, t('transportExpires', { time: formatClock(account.expiresAt, locale, t) })),
        ),
    h('div', { className: 'km-key-actions' },
      h(Button, {
        size: 'small',
        disabled: busy,
        onClick: signIn,
        title: account.active ? t('accountReauth') : t('transportSignIn'),
      }, busy ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'refresh', size: 14 }),
        t(account.active ? 'accountReauth' : 'transportSignIn')),
      // No "Set active" entry: activation would write nothing (the stored grant
      // already IS the route's live credential), so the host endpoint stays for
      // API symmetry with the account surface and the row omits a no-effect
      // control.
      h(Button, {
        size: 'small',
        variant: 'danger',
        disabled: busy,
        onClick: () => setConfirm(true),
      }, h(Icon, { name: 'trash', size: 14 }), t('delete')),
    ),
    error !== null ? h('div', { className: 'km-key-error', role: 'alert' }, error) : null,
    confirm ? h(Modal, {
      title: t('transportRemoveTitle', { name: account.displayName }),
      onClose: () => setConfirm(false),
      busy,
      footer: [
        h(Button, { key: 'cancel', onClick: () => setConfirm(false), disabled: busy }, t('cancel')),
        h(Button, { key: 'delete', variant: 'danger', onClick: remove, disabled: busy }, busy ? t('deleting') : t('deleteConfirm')),
      ],
    }, h('p', { className: 'km-modal-copy' }, t('transportRemoveBody'))) : null,
    login !== null ? h(LoginDialog, {
      provider: { displayName: account.displayName },
      attemptId: login.attemptId,
      onClose: () => setLogin(null),
    }) : null,
  )
}

interface TransportModelsProps {
  route: string
}

/**
 * The transport route's model allow-list, collapsed until opened.
 *
 * The catalog comes from the host: the route's own `listModels` answers only
 * the allow-list, so a picker could not discover what was hidden. Selection
 * saves through the host and an empty selection means "every model", the same
 * rule the adapter applies.
 */
function TransportModels({ route }: TransportModelsProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<TransportModelsView | null>(null)
  const [draft, setDraft] = React.useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const loading = React.useRef(false)

  async function load(): Promise<void> {
    if (loading.current) return
    loading.current = true
    setError(null)
    const result = await runtime.store.transportModels(route)
    loading.current = false
    if (!result.ok) {
      setError(result.error)
      return
    }
    setView(result.value)
    setDraft(new Set(result.value.models))
  }

  function toggle(): void {
    const next = !open
    setOpen(next)
    if (next && view === null) void load()
  }

  function toggleModel(id: string): void {
    setDraft(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await runtime.store.saveTransportModels(route, [...draft])
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setView(result.value)
    setDraft(new Set(result.value.models))
  }

  const rows = view === null ? [] : modelPickerRows(view)
  // One predicate disables Save on an empty grid, which would otherwise end in
  // the host's un-localized "no model list"; the hint on top of it also needs
  // the host's report that this build ships no catalog.
  const emptyCatalog = view !== null && view.catalog.length === 0
  const missingCatalog = view !== null && view.missingCatalog === true
  const errorLine = error === null ? null : h('div', { className: 'km-inline-error', role: 'alert' }, error)
  return h('div', { className: 'km-models' },
    h('button', {
      type: 'button',
      className: 'km-models-head',
      onClick: toggle,
      'aria-expanded': open,
    },
      h(Icon, { name: 'chevron', size: 14, className: cx('km-chevron', open && 'km-chevron-open') }),
      h('span', { className: 'km-models-title' }, t('transportModels')),
      view === null
        ? null
        : h('span', { className: 'km-muted' },
            draft.size === 0 ? t('transportModelsAll') : t('transportModelsSelected', { n: draft.size, total: view.catalog.length })),
    ),
    open ? h('div', { className: 'km-models-body' },
      // A failed load leaves no view: showing the loading line next to the
      // error would claim a request that already finished, and Save must stay
      // off without a view so a failed read cannot clear the saved selection.
      // A failed save keeps the loaded view and reports above the grid.
      view === null ? null : errorLine,
      view === null
        ? error !== null
          ? h('div', { className: 'km-models-failure' },
              errorLine,
              h(Button, { size: 'small', variant: 'primary', onClick: () => void load() }, t('reload')),
            )
          : h('div', { className: 'km-muted' }, t('transportModelsLoading'))
        : h('div', { className: 'km-models-grid' }, rows.map(row =>
            h('label', { key: row.id, className: 'km-model-option' },
              h('input', {
                type: 'checkbox',
                checked: draft.has(row.id),
                onChange: () => toggleModel(row.id),
                disabled: busy,
              }),
              h('span', null, row.name),
            ))),
      // An empty grid is also the all-models state: only the host's report of
      // a missing catalog explains it.
      emptyCatalog && missingCatalog
        ? h('div', { className: 'km-field-hint', role: 'status' }, t('transportModelsMissingCatalog'))
        : null,
      h('div', { className: 'km-models-actions' },
        // Save cannot fix a route the host has no catalog for; clicking it
        // would only surface the un-localized "no model list" error.
        h(Button, { size: 'small', variant: 'primary', onClick: () => void save(), disabled: busy || view === null || emptyCatalog },
          busy ? t('saving') : t('save')),
        h(Button, {
          size: 'small',
          variant: 'ghost',
          onClick: () => setDraft(new Set()),
          disabled: busy || view === null || draft.size === 0,
        }, t('transportModelsClear')),
      ),
      h('div', { className: 'km-field-hint' }, t('transportModelsHint')),
    ) : null,
  )
}

/**
 * One account's plan-usage row: alias, one thin bar per available window and
 * the reset countdown of the tightest window. A row with no bars states why
 * (checking, not reported, sign in again) instead of rendering an empty bar.
 */
function quotaRow(row: KeyView, t: T, now: number): React.ReactElement {
  const windows = quotaWindows(row.quota)
  const alias = h('span', { className: 'km-quota-alias', title: row.alias }, row.alias)
  if (windows.length === 0) {
    // `natively-managed` is the host telling us a DSH projection serves the
    // route but its usage cannot be read: that is neither "no usage API" nor
    // "your credential is invalid", so it gets its own line.
    // `unauthorized` is an account problem only on OAuth rows; an API-key row
    // has no sign-in to offer, so both parse gaps read as "not reported".
    const note = row.quota === undefined
      ? t('quotaChecking')
      : row.quota.status === 'natively-managed'
        ? t('quotaNativelyManaged')
        : row.quota.status === 'unauthorized' && row.kind === 'oauth'
          ? t('quotaSignInAgain')
          : t('quotaNotReported')
    return h('li', { key: row.id, className: 'km-quota-row' }, alias, h('span', { className: 'km-quota-note' }, note))
  }
  const tightest = windows.reduce((best, window) => (window.usedFraction > best.usedFraction ? window : best))
  return h('li', { key: row.id, className: 'km-quota-row' },
    alias,
    h('span', { className: cx('km-quota-metrics', row.quota?.stale === true && 'km-quota-stale') },
      windows.map(window => {
        const percent = quotaPercent(window.usedFraction)
        const label = QUOTA_WINDOW_LABEL[window.id]
        return h('span', { key: window.id, className: 'km-quota-metric' },
          h('span', { className: 'km-quota-window', 'aria-hidden': true }, label),
          h('span', {
            className: 'km-quota-track',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': percent,
            'aria-label': t('quotaBarLabel', { window: label, percent }),
          }, h('span', {
            className: cx('km-quota-fill', `km-quota-fill-${quotaTone(window.usedFraction)}`),
            style: { width: `${percent}%` },
          })),
          h('span', { className: 'km-quota-pct' }, `${percent}%`),
        )
      }),
      h('span', { className: 'km-quota-reset' }, durationText(tightest.resetsAt - now, t)),
      row.quota?.stale === true ? h('span', { className: 'km-quota-flag' }, t('quotaStale')) : null,
    ),
  )
}

/** Snapshot fingerprint: one stable string per account row. */
function quotaSignature(provider: ProviderView): string {
  return provider.keys.map(key => `${key.id}:${key.quota?.status ?? '-'}:${key.quota?.fetchedAt ?? 0}`).join('|')
}

/**
 * The expanded card's usage strip. Pull-only (D2): it asks for a refresh when
 * a row has no snapshot or its snapshot is past the TTL, and shows the cached
 * rows immediately so the card never waits on a vendor.
 */
function QuotaStrip({ provider, now }: { provider: ProviderView; now: number }): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const [refreshing, setRefreshing] = React.useState(false)
  // A rejected refresh leaves the rows unchanged, so the signature cannot
  // move on its own; remembering the attempted signature keeps a failed read
  // from retrying on every minute tick. A successful answer clears it.
  const attempted = React.useRef<string | null>(null)
  // The request itself owns the busy flag. A minute tick re-runs this effect
  // and React cleans up the previous run, so clearing the flag from that run's
  // closure could drop the only `setRefreshing(false)` and leave the label on
  // screen for good (QC FIX-1).
  const pending = React.useRef<Promise<ActionOutcome> | null>(null)
  // A successful answer that left the rows unchanged earns exactly one later
  // retry: `retryBudget` marks the state that has one available, and `retried`
  // records it once that request is ISSUED (never pre-consumed in the previous
  // answer), so the retry really fires and can never fire twice.
  const retryBudget = React.useRef<string | null>(null)
  const retried = React.useRef<string | null>(null)
  const quotas = provider.keys.map(key => key.quota)
  const needsRefresh = quotaNeedsRefresh(quotas, now)
  // Re-evaluated once a minute so a TTL expiry refreshes an already-open card
  // without a timer of its own (the page tick supplies `now`).
  const minute = Math.floor(now / 60_000)
  const signature = quotaSignature(provider)

  React.useEffect(() => {
    if (!needsRefresh) {
      attempted.current = null
      retried.current = null
      retryBudget.current = null
      return undefined
    }
    if (attempted.current === signature) return undefined
    if (retried.current === signature) return undefined
    attempted.current = signature
    // Spend the retry when this request is issued, not when the previous
    // answer arrived, so the following run actually performs it.
    if (retryBudget.current === signature) {
      retried.current = signature
      retryBudget.current = null
    }
    setRefreshing(true)
    const request = runtime.store.refreshQuota(provider.provider)
    pending.current = request
    void request.then(outcome => {
      // A newer read owns the flag now; this answer is stale news.
      if (pending.current !== request) return
      pending.current = null
      setRefreshing(false)
      if (!outcome.ok) return
      // A successful answer that moved the rows is fresh data; one that did
      // not is still stale by this client's contract, so it is not terminal —
      // it earns one later retry. A rejection keeps the one-shot lock, so a
      // failing RPC cannot loop.
      const latest = runtime.store.getSnapshot().state?.providers.find(row => row.provider === provider.provider)
      const moved = latest === undefined || quotaSignature(latest) !== signature
      attempted.current = null
      retryBudget.current = moved ? null : signature
    })
    return undefined
  }, [provider.provider, signature, minute, needsRefresh])

  return h('div', { className: 'km-quota-strip' },
    h('div', { className: 'km-quota-head' },
      h('span', { className: 'km-quota-title' }, t('quotaTitle')),
      refreshing ? h('span', { className: 'km-quota-busy', role: 'status' }, t('quotaRefreshing')) : null,
    ),
    h('ul', { className: 'km-quota-list' }, provider.keys.map(key => quotaRow(key, t, now))),
  )
}

interface ProviderCardProps {
  provider: ProviderView
  expanded: boolean
  onToggle: () => void
  now: number
  /** The transport route's own account row, when the host lists one. */
  transportAccount?: TransportAccountView
}

function ProviderCard({ provider, expanded, onToggle, now, transportAccount }: ProviderCardProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const [adding, setAdding] = React.useState(false)
  const [adopting, setAdopting] = React.useState(false)
  const [releasing, setReleasing] = React.useState(false)
  const [confirmRelease, setConfirmRelease] = React.useState(false)
  const [login, setLogin] = React.useState<{ attemptId: string } | null>(null)
  const [startingLogin, setStartingLogin] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const managed = provider.managed
  const broken = managed && provider.bindingHealthy === false
  const keyCount = provider.keyCount
  const warning = provider.warning
  const isExtra = provider.extra
  // Main's architecture: a transport route is a provider card of its own, so it
  // carries the plugin tag rather than a key-pool origin. `originOf` is the
  // same expression main inlines for snapshots that predate `origin`.
  const transport = provider.transport === true
  const origin = originOf(provider)
  const originLabel = transport || origin === 'plugin' ? t('pluginBuiltin') : origin === 'dsh' ? t('dshBuiltin') : t('customProvider')
  const providerMeta = [
    provider.provider,
    // `active`/`configured` are read off the route's profile or the host's
    // provider list, neither of which describes a transport route: its state
    // is the account row it carries (signed out when the host lists none).
    transport
      ? t(transportStatusKey(transportAccount?.status ?? 'signed-out'))
      : provider.active ? t('active') : provider.configured ? t('configured') : t('notConfigured'),
    provider.api ?? null,
  ].filter((value): value is string => Boolean(value))

  async function adopt(): Promise<void> {
    setAdopting(true)
    setError(null)
    const result = await runtime.store.call('adoptProvider', { provider: provider.provider })
    setAdopting(false)
    if (!result.ok) setError(result.error)
  }

  async function release(): Promise<void> {
    setReleasing(true)
    setError(null)
    const result = await runtime.store.call('releaseProvider', { provider: provider.provider })
    setReleasing(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setConfirmRelease(false)
  }

  /**
   * Start one interactive OAuth sign-in and open the login dialog for it.
   * `targetAccountId` (round-3 finding 6) names the row a re-authentication
   * replaces: the host binds the committed grant to that row, so a rotated
   * token with no identity metadata cannot duplicate the account. The dialog
   * state carries only the attempt id (round-4 nit): the alias is host-side
   * naming input for a new row, never dialog state, so keeping it there invited
   * the wrong assumption about which account a resumed attempt belongs to.
   */
  async function openLogin(targetAccountId?: string, alias?: string): Promise<void> {
    if (startingLogin) return
    setStartingLogin(true)
    setError(null)
    const result = await runtime.store.beginAccountLogin(provider.provider, alias, targetAccountId)
    setStartingLogin(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.value !== null) setLogin({ attemptId: result.value.id })
  }

  /**
   * MF1 reachability: an unmanaged OAuth-capable route adopts first (zero
   * keys when no key credential exists), then opens its sign-in dialog.
   */
  async function adoptThenLogin(): Promise<void> {
    if (provider.managed || signInCreatesRoute) {
      await openLogin()
      return
    }
    setAdopting(true)
    setError(null)
    const result = await runtime.store.call('adoptProvider', { provider: provider.provider })
    setAdopting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await openLogin()
  }

  // MF1: adoption is reachable through either capability — key-pool support
  // or OAuth account sign-in. An OAuth-only route stays adoptable while the
  // key entry (Add key) stays gated by key support alone. Round-5 nit N3:
  // this gate derives from the same `oauthCapable()` rule as the empty-state
  // gate, so a legacy snapshot without `accountSupported` does not show an
  // enabled sign-in entry beside a disabled Adopt and an "unsupported" panel.
  // The collapsed line reads only what the cache already holds; rendering a
  // card never probes (D2).
  const tightest = managed ? tightestQuotaWindow(provider.keys.map(key => key.quota)) : undefined
  const accountAdoptable = oauthCapable(provider)
  const adoptable = provider.supported || accountAdoptable
  // An unmanaged *extra* route signs in directly: its first successful sign-in
  // creates the profile and the first key, so adopting first would be a second,
  // empty step (issue #15 design §4.4). A shipped route (zai) still adopts.
  const signInCreatesRoute = provider.extra === true && accountAdoptable

  // A transport card takes the adopted tint too, so the list reads as one component.
  return h('div', { className: cx('km-card', 'km-provider', expanded && 'km-provider-open', (managed || transport) && 'km-provider-managed') },
    h('button', {
      type: 'button',
      className: 'km-provider-head',
      onClick: onToggle,
      'aria-expanded': expanded,
    },
      h('span', { className: 'km-avatar', 'aria-hidden': true }, providerInitial(provider)),
      h('span', { className: 'km-provider-main' },
        h('span', { className: 'km-provider-title-line' },
          h('span', { className: 'km-provider-name' }, provider.displayName || provider.provider),
          h('span', { className: 'km-tag' }, originLabel),
          transport ? h('span', { className: 'km-tag km-tag-accent' }, t('transportTag')) : null,
          managed ? h('span', { className: 'km-tag km-tag-accent' }, t('managedBadge')) : null,
          !transport && !managed && !provider.supported && !accountAdoptable ? h('span', { className: 'km-tag km-tag-warn' }, t('unsupported')) : null,
        ),
        h('span', { className: 'km-provider-meta' },
          h('span', { className: 'km-mono' }, provider.provider),
          h('span', { className: 'km-dot-sep', 'aria-hidden': true }, '·'),
          h('span', null, providerMeta.slice(1).join(' · ')),
          provider.env.length > 0 ? h('span', { className: 'km-mono km-muted' }, provider.env.join(', ')) : null,
        ),
      ),
      h('span', { className: 'km-provider-side' },
        // D5: the tightest plan window across this provider's accounts, as a
        // supplementary one-liner next to the key count. Narrow screens drop
        // it (the expanded strip is the primary carrier) instead of wrapping.
        tightest === undefined
          ? null
          : h('span', {
              className: cx(
                'km-quota-compact',
                tightest.usedFraction >= 1 ? 'km-quota-error' : tightest.usedFraction >= 0.9 ? 'km-quota-warn' : null,
              ),
              title: t('quotaCompactHint'),
            }, `${QUOTA_WINDOW_LABEL[tightest.id]} ${quotaPercent(tightest.usedFraction)}%`),
        // I-000120 / D8: requests this route served without an attributed
        // account. Rendered only above zero, and the visible label carries the
        // count so it is the accessible name; the hint stays a description.
        (provider.unattributedRequests ?? 0) > 0
          ? h('span', {
              className: 'km-tag km-tag-warn km-unattributed',
              title: t('unattributedHint'),
            }, t('unattributed', { n: provider.unattributedRequests ?? 0 }))
          : null,
        transport
          // No adopt state and no key count: the route's credential is the
          // account row in the body.
          ? null
          : managed
            ? h('span', { className: 'km-count' }, countText(t, keyCount, 'providerKeyOne', 'providerKeys'))
            : h('span', { className: 'km-count km-muted' }, adoptable ? t('unmanaged') : t('unsupported')),
        managed ? h(StatusPill, { status: provider.status, t }) : null,
        h(Icon, { name: 'chevron', size: 16, className: cx('km-chevron', expanded && 'km-chevron-open') }),
      ),
    ),
    expanded ? h('div', { className: 'km-provider-body' },
      error !== null ? h('div', { className: 'km-inline-error', role: 'alert' }, error) : null,
      warning !== undefined || broken ? h(Notice, { tone: 'warn', title: t('warning') }, broken ? t('bindingBroken') : warning) : null,
      // A transport route has no adopt step and no key pool: its whole
      // credential surface is the one account row its own plugin serves, plus
      // the model allow-list its adapter advertises.
      transport
        ? h('div', { className: 'km-transport-body' },
            transportAccount !== undefined
              ? h('div', { className: 'km-keys' }, h(TransportAccountRow, { account: transportAccount }))
              : h('div', { className: 'km-muted' }, t('transportProviderHint')),
            h(TransportModels, { route: provider.provider }),
          )
        : !managed ? h('div', { className: 'km-adopt' },
        h('div', { className: 'km-adopt-copy' },
          // I-000063: an OAuth-only route is account-adoptable, so its
          // adopt panel headline must invite sign-in instead of claiming
          // the provider is unsupported. The unsupported headline remains
          // only for providers that are neither key- nor account-capable.
          h('div', { className: 'km-adopt-title' },
            provider.supported
              ? t(isExtra ? 'adoptExtraHint' : 'adoptHint')
              : accountAdoptable
                ? t('adoptAccountTitle')
                : t('unsupported'),
          ),
          !provider.supported && provider.reason !== undefined ? h('div', { className: 'km-muted' }, provider.reason) : null,
          provider.apiKeyEnv !== null ? h('div', { className: 'km-meta-line' }, h('span', { className: 'km-muted' }, `${t('secret')}:`), h('span', { className: 'km-mono' }, provider.apiKeyEnv)) : null,
          provider.baseURL !== null ? h('div', { className: 'km-meta-line' }, h('span', { className: 'km-muted' }, `${t('baseUrl')}:`), h('span', { className: 'km-mono km-truncate' }, provider.baseURL)) : null,
          provider.models.length > 0 ? h('div', { className: 'km-meta-line' }, h('span', { className: 'km-muted' }, `${t('models')}:`), h('span', null, t('countModels', { n: provider.models.length }))) : null,
        ),
        isExtra
          // The key form keeps the column's full width; only the sign-in entry
          // joins the action row, matching the managed body's layout.
          ? h(React.Fragment, null,
              signInCreatesRoute
                ? h('div', { className: 'km-adopt-actions' },
                    h(Button, { variant: 'secondary', onClick: () => void adoptThenLogin(), disabled: adopting || startingLogin },
                      startingLogin ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'user', size: 14 }),
                      // I-000263: this path signs in without adopting, so its
                      // progress copy names the sign-in, not an adopt.
                      h('span', null, startingLogin ? t('signingIn') : t('addAccount')),
                    ),
                  )
                : null,
              h(KeyForm, { provider, autoFocus: true }),
            )
          : h('div', { className: 'km-adopt-actions' },
              h(Button, { variant: 'primary', onClick: adopt, disabled: adopting || !adoptable },
                adopting ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'shield', size: 14 }),
                h('span', null, adopting ? t('adopting') : t('adopt')),
              ),
              // MF1: Add account is reachable from the unmanaged/adopt flow —
              // adopt (zero keys for OAuth-only routes) then sign in.
              oauthCapable(provider)
                ? h(Button, { variant: 'secondary', onClick: () => void adoptThenLogin(), disabled: adopting || startingLogin },
                    startingLogin ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'user', size: 14 }),
                    h('span', null, startingLogin ? t('adopting') : t('addAccount')),
                  )
                : null,
            ),
      ) : h('div', { className: 'km-managed-body' },
        h('div', { className: 'km-managed-toolbar' },
          h('div', { className: 'km-managed-summary' },
            h('span', { className: 'km-mono km-muted' }, `${t('secret')}: ${provider.brokerRef ?? '—'}`),
            provider.baseURL !== null ? h('span', { className: 'km-mono km-muted km-truncate' }, provider.baseURL) : null,
          ),
          h('div', { className: 'km-managed-actions' },
            h(Button, { variant: 'secondary', size: 'small', onClick: () => setAdding(current => !current), disabled: releasing || !provider.supported, title: provider.supported ? undefined : provider.reason },
              h(Icon, { name: 'plus', size: 14 }),
              h('span', null, t('addKey')),
            ),
            oauthCapable(provider) ? h(Button, { variant: 'secondary', size: 'small', onClick: () => void openLogin(), disabled: releasing || startingLogin },
              h(Icon, { name: 'user', size: 14 }),
              h('span', null, t('addAccount')),
            ) : null,
            h(Button, { variant: 'ghost', size: 'small', onClick: () => setConfirmRelease(true), disabled: releasing },
              releasing ? t('releasing') : t('release'),
            ),
          ),
        ),
        adding ? h(KeyForm, { provider, onDone: () => setAdding(false), autoFocus: true }) : null,
        provider.keys.length > 0 ? h(QuotaStrip, { provider, now }) : null,
        provider.keys.length === 0
          // Round-4 finding 4 (I-000085): the empty body must name an action
          // this route actually offers. Add key is disabled without key
          // capability, so an account-only route invites a sign-in instead
          // of telling the user to "add one". A managed route with neither
          // capability (C6-2: nativeAuth.oauth without an enumerable flow)
          // offers no action at all, so it states the unsupported verdict
          // rather than inviting a key the toolbar refuses.
          // Round-5 nit N1: the reason is part of that verdict as visible
          // text, matching the unmanaged adopt panel, instead of being
          // reachable only through the disabled Add key's hover title.
          ? h('div', { className: 'km-empty-keys' },
              h('div', null, provider.supported
                ? t('noKeys')
                : oauthCapable(provider) ? t('noKeysAccount') : t('unsupported')),
              !provider.supported && provider.reason !== undefined
                ? h('div', { className: 'km-muted' }, provider.reason)
                : null,
            )
          : h('div', { className: 'km-keys' }, provider.keys.map(key => key.kind === 'oauth'
              ? h(AccountRow, { key: key.id, provider, keyRecord: key, now, onReauthenticate: () => void openLogin(key.id, key.alias) })
              : h(KeyRow, { key: key.id, provider, keyRecord: key, now, onReauthenticate: () => void openLogin(key.id, key.alias) }))),
      ),
      h('div', { className: 'km-provider-foot' },
        h('span', { className: 'km-muted' }, provider.extra ? `${t('api')}: ${provider.api ?? '—'} · ${t('models')}: ${provider.models.length}` : null),
        provider.defaultBaseURL !== null ? h('span', { className: 'km-mono km-muted km-truncate' }, provider.defaultBaseURL) : null,
      ),
    ) : null,
    confirmRelease ? h(Modal, {
      title: t('releaseTitle', { provider: provider.displayName || provider.provider }),
      onClose: () => setConfirmRelease(false),
      busy: releasing,
      footer: [
        h(Button, { key: 'cancel', onClick: () => setConfirmRelease(false), disabled: releasing }, t('cancel')),
        h(Button, { key: 'release', variant: 'danger', onClick: release, disabled: releasing }, releasing ? t('releasing') : t('releaseConfirm')),
      ],
    }, h('p', { className: 'km-modal-copy' }, t(provider.createdProfile === true ? 'releaseBodyCreated' : 'releaseBody'))) : null,
    login !== null ? h(LoginDialog, {
      provider,
      attemptId: login.attemptId,
      cancellable: oauthCapable(provider) && provider.nativeAuth?.oauth !== true,
      onClose: () => setLogin(null),
    }) : null,
  )
}

const LOGIN_POLL_MS = 1000

/**
 * Only http(s) notice URLs render as links: the notice channel is
 * seam-provided, but a malformed or hostile scheme must fall back to plain
 * text instead of becoming a clickable href. Returns null when the URL is
 * absent or not allowlisted.
 */
function safeNoticeUrl(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

interface LoginDialogProps {
  /** Only the display name is rendered; a transport account supplies one too. */
  provider: { displayName: string }
  attemptId: string
  /**
   * True when this plugin drove the flow and may cancel it. A seam-driven
   * sign-in (pi-ai OAuth, transport) settles through its own surface, so its
   * dialog only closes.
   */
  cancellable?: boolean
  onClose: () => void
}

/** Consecutive polling failures tolerated before the dialog gives up (N1). */
const LOGIN_POLL_FAILURE_LIMIT = 3

/**
 * Interactive OAuth sign-in dialog. State arrives by polling
 * `accountAttempt` (a dialog-local cadence layered on the store's read-only
 * poller); `null` means the flow is gone — a neutral ended state, never
 * success. Prompt answers go through the `answerAccountPrompt` ack, and
 * polling continues until a terminal status. A permanent polling failure
 * (host restart pruned the attempt, revoked RPC) stops the poller after
 * three consecutive misses and renders the failure notice (N1) instead of
 * waiting forever.
 */
function LoginDialog({ provider, attemptId, cancellable = false, onClose }: LoginDialogProps): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const [attempt, setAttempt] = React.useState<AccountAttemptView | null>(null)
  const [flowEnded, setFlowEnded] = React.useState(false)
  const [pollError, setPollError] = React.useState<string | null>(null)
  const [answer, setAnswer] = React.useState('')
  const [revealed, setRevealed] = React.useState(false)
  const [answering, setAnswering] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const pollNowRef = React.useRef<(() => void) | null>(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  const prompt = attempt?.prompt
  // Round-9 finding P2: a select is a closed choice, so its answer must start
  // on one of the rendered options. The empty initial answer matched no
  // option, which kept the submit button disabled unless the user touched the
  // control — and a one-option prompt could never be answered at all. The
  // signature changes only when the parked prompt does, so a fresh prompt
  // (re)seeds the answer while polling refreshes of the same prompt keep the
  // user's choice.
  const promptKey = prompt === undefined
    ? ''
    : `${prompt.kind}\u0000${prompt.message}\u0000${(prompt.options ?? []).map(option => option.id).join('\u0000')}`
  React.useEffect(() => {
    // A fresh prompt starts masked: a pasted code is the only secret in the
    // exchange, so the reveal toggle never carries over.
    setRevealed(false)
    const options = prompt !== undefined && prompt.kind === 'select' ? prompt.options : undefined
    if (options !== undefined && options.length > 0) {
      setAnswer(current => options.some(option => option.id === current) ? current : options[0]!.id)
      return
    }
    setAnswer('')
  }, [promptKey])

  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setInterval> | undefined
    let failures = 0
    // Round-5 finding C5: an accountAttempt RPC can outlast the 1 s tick, and
    // overlapping polls can resolve out of order — an older `pending` response
    // landing after a newer `failed`/`cancelled` left the dialog stuck in a
    // nonterminal state forever. Two guards: the interval never starts a poll
    // while one is in flight, and a response older than the state already
    // shown is discarded (a user-triggered poll may still overlap a tick, and
    // that overlap must be harmless).
    let pending = 0
    let latestUpdatedAt = 0
    const isTerminal = (status: AccountAttemptView['status']): boolean =>
      status === 'ready' || status === 'failed' || status === 'cancelled'
    const poll = async (): Promise<void> => {
      if (stopped) return
      pending += 1
      try {
        const result = await runtime.store.accountAttempt(attemptId)
        if (stopped) return
        if (!result.ok) {
          failures += 1
          if (failures >= LOGIN_POLL_FAILURE_LIMIT) {
            if (timer !== undefined) clearInterval(timer)
            setPollError(result.error)
          }
          return // transient failures keep polling until the limit
        }
        failures = 0
        if (result.value === null) {
          // Unknown id: the flow is gone (pruned/expired), which is not success.
          if (timer !== undefined) clearInterval(timer)
          setFlowEnded(true)
          return
        }
        const view = result.value
        // Never move backwards: a stale response must not resurrect an older
        // nonterminal state after a terminal one has been shown.
        if (view.updatedAt < latestUpdatedAt) return
        latestUpdatedAt = view.updatedAt
        setAttempt(current => {
          if (current === null) return view
          if (isTerminal(current.status) && !isTerminal(view.status)) return current
          if (current.updatedAt > view.updatedAt) return current
          if (current.updatedAt === view.updatedAt && current.status === view.status) return current
          return view
        })
        if (view.status === 'ready') {
          if (timer !== undefined) clearInterval(timer)
          await runtime.store.load()
          if (!stopped) onCloseRef.current()
          return
        }
        if (view.status === 'failed' || view.status === 'cancelled') {
          if (timer !== undefined) clearInterval(timer)
        }
      } finally {
        pending -= 1
      }
    }
    const pollNow = (): void => { void poll() }
    pollNowRef.current = pollNow
    void poll()
    timer = setInterval(() => {
      // A slow RPC must not stack concurrent polls behind the interval.
      if (pending === 0) void poll()
    }, LOGIN_POLL_MS)
    return () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [attemptId, runtime])

  async function submitAnswer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const prompt = attempt?.prompt
    if (prompt === undefined || answering) return
    const value = answer.trim()
    if (value.length === 0) return
    setAnswering(true)
    setError(null)
    const result = await runtime.store.answerAccountPrompt(attemptId, value)
    setAnswering(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setAnswer('')
    // The answered prompt may be re-asked verbatim (the Z.AI retry), which the
    // signature effect cannot see, so the next code always starts masked.
    setRevealed(false)
    // The answer is only an ack: poll immediately for the next state.
    pollNowRef.current?.()
  }

  // Only an in-process attempt may be cancelled here; see `cancellable`.
  const inProcess = cancellable

  async function cancel(): Promise<void> {
    if (cancelling) return
    setCancelling(true)
    setError(null)
    const result = await runtime.store.cancelAccountLogin(attemptId)
    setCancelling(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // Cancellation is a state transition, not an ack: poll for it.
    pollNowRef.current?.()
  }

  const lastNotice = attempt !== null && attempt.notices.length > 0 ? attempt.notices[attempt.notices.length - 1]! : null
  const safeUrl = attempt !== null ? attempt.notices.map(notice => safeNoticeUrl(notice.url)).reverse().find(url => url !== null) ?? null : null
  const answerable = prompt !== undefined && !answering && answer.trim().length > 0

  let body: React.ReactNode
  if (pollError !== null) {
    // N1: the poller gave up on a permanent RPC failure.
    body = h(Notice, { tone: 'error', icon: 'warning', title: t('loginFailed') }, pollError)
  } else if (flowEnded) {
    body = h(Notice, { tone: 'warn', icon: 'warning' }, t('loginFlowEnded'))
  } else if (attempt === null || attempt.status === 'pending') {
    body = h('div', { className: 'km-login-flow' },
      h('div', { className: 'km-login-pending' }, h(Icon, { name: 'refresh', size: 15, className: 'km-spin' }), h('span', null, t('loginPending'))),
      lastNotice !== null ? h('div', { className: 'km-login-notices' }, lastNotice.message) : null,
      safeUrl !== null ? h('div', { className: 'km-login-notices' },
        h('a', { className: 'km-login-link', href: safeUrl, target: '_blank', rel: 'noreferrer' }, t('loginBrowserOpen')),
      ) : null,
    )
  } else if (attempt.status === 'ready') {
    body = h('div', { className: 'km-login-pending' }, h(Icon, { name: 'check', size: 15 }), h('span', null, t('loginReady')))
  } else if (attempt.status === 'failed' || attempt.status === 'cancelled') {
    body = h(Notice, { tone: 'error', icon: 'warning', title: t('loginFailed') }, attempt.error ?? lastNotice?.message ?? provider.displayName)
  } else {
    body = h('div', { className: 'km-login-flow' },
      lastNotice !== null ? h('div', { className: 'km-login-notices' }, lastNotice.message) : null,
      safeUrl !== null ? h('div', { className: 'km-login-notices' },
        h('a', { className: 'km-login-link', href: safeUrl, target: '_blank', rel: 'noreferrer' }, t('loginBrowserOpen')),
      ) : null,
      prompt !== undefined ? h('form', { className: 'km-login-prompt', onSubmit: submitAnswer },
        h('div', { className: 'km-login-prompt-title' }, t('loginPromptTitle')),
        h('div', { className: 'km-field' },
          h('span', { className: 'km-field-label' }, prompt.message),
          prompt.kind === 'manual-code' ? h('span', { className: 'km-muted' }, t('loginPasteHint')) : null,
          prompt.kind === 'select' && prompt.options !== undefined
            ? h('select', {
                className: 'km-input',
                value: answer,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setAnswer(event.target.value),
                disabled: answering,
                autoFocus: true,
              }, prompt.options.map(option => h('option', { key: option.id, value: option.id }, option.label)))
            : h('input', {
                className: 'km-input',
                // A pasted code is the only secret in the exchange (Z.AI's flow
                // has no PKCE, the Devin flow sends none back), so it is masked
                // exactly like `secret` prompts.
                type: (prompt.kind === 'secret' || prompt.kind === 'manual-code') && !revealed ? 'password' : 'text',
                value: answer,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => setAnswer(event.target.value),
                placeholder: prompt.placeholder,
                spellCheck: false,
                // The repo's convention for a field the browser must never fill
                // from a saved password; `off` is ignored on password inputs.
                autoComplete: prompt.kind === 'secret' || prompt.kind === 'manual-code' ? 'new-password' : 'off',
                disabled: answering,
                autoFocus: true,
              }),
          prompt.kind === 'manual-code'
            ? h('label', { className: 'km-muted' },
                h('input', {
                  type: 'checkbox',
                  checked: revealed,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => setRevealed(event.target.checked),
                  disabled: answering,
                }),
                h('span', null, t('loginReveal')),
              )
            : null,
        ),
        error !== null ? h('div', { className: 'km-inline-error', role: 'alert' }, error) : null,
        h('div', { className: 'km-form-actions' },
          h(Button, { variant: 'primary', type: 'submit', disabled: !answerable },
            answering ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : h(Icon, { name: 'check', size: 14 }),
            h('span', null, answering ? t('loginPending') : t('loginPromptSubmit')),
          ),
        ),
      ) : null,
    )
  }

  return h(Modal, {
    title: t('loginTitle'),
    onClose,
    busy: false,
    footer: [
      ...(inProcess
        ? [h(Button, { key: 'cancel', onClick: () => void cancel(), disabled: answering || cancelling }, cancelling ? t('loginPending') : t('cancel'))]
        : []),
      h(Button, { key: 'close', onClick: onClose, disabled: answering || cancelling }, t('close')),
    ],
  }, body)
}

function SettingsCard(): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const snapshot = useStore()
  const state = snapshot.state
  const settings: ManagerSettings | null = state?.settings ?? null
  const [retry, setRetry] = React.useState('2')
  const [base, setBase] = React.useState('5')
  const [grace, setGrace] = React.useState('10')
  const [busy, setBusy] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const dirty = React.useRef(false)

  React.useEffect(() => {
    if (settings === null || dirty.current) return
    setRetry(String(settings.retryCount))
    setBase(String(cooldownMinutes(settings.baseCooldownMs)))
    setGrace(String(graceMinutes(settings.recoveryGraceMs)))
  }, [settings])

  function change(setter: React.Dispatch<React.SetStateAction<string>>) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => {
      dirty.current = true
      setSaved(false)
      setter(event.target.value)
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    const result = await runtime.store.call('setSettings', {
      patch: {
        retryCount: Number(retry),
        baseCooldownMs: cooldownMs(Number(base)),
        recoveryGraceMs: graceMs(Number(grace)),
      },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    dirty.current = false
    setSaved(true)
  }

  return h('form', { className: 'km-card km-settings', onSubmit: save },
    h('div', { className: 'km-settings-head' },
      h('div', null,
        h('h3', { className: 'km-settings-title' }, t('settingsTitle')),
        h('p', { className: 'km-settings-intro' }, t('settingsIntro')),
      ),
      h('span', { className: 'km-settings-icon' }, h(Icon, { name: 'shield', size: 20 })),
    ),
    h('div', { className: 'km-settings-grid' },
      h('label', { className: 'km-field' },
        h('span', { className: 'km-field-label' }, t('retryCount')),
        h('select', { className: 'km-input', value: retry, onChange: change(setRetry), disabled: busy || state?.writable === false },
          ['1', '2', '3'].map(value => h('option', { key: value, value }, value)),
        ),
        h('span', { className: 'km-field-hint' }, t('retryHint')),
      ),
      h('label', { className: 'km-field' },
        h('span', { className: 'km-field-label' }, t('baseCooldown')),
        h('input', { className: 'km-input', type: 'number', min: 0.5, step: 'any', value: base, onChange: change(setBase), disabled: busy || state?.writable === false }),
        h('span', { className: 'km-field-hint' }, t('baseHint')),
      ),
      h('label', { className: 'km-field' },
        h('span', { className: 'km-field-label' }, t('grace')),
        h('input', { className: 'km-input', type: 'number', min: 0, step: 'any', value: grace, onChange: change(setGrace), disabled: busy || state?.writable === false }),
        h('span', { className: 'km-field-hint' }, t('graceHint')),
      ),
      h('div', { className: 'km-field km-field-note' },
        h('div', { className: 'km-policy-note' },
          h('div', { className: 'km-policy-title' }, h(Icon, { name: 'warning', size: 14 }), t('cap')),
          h('p', { className: 'km-muted' }, t('strategyBody')),
        ),
      ),
    ),
    error !== null ? h('div', { className: 'km-inline-error', role: 'alert' }, error) : null,
    h('div', { className: 'km-settings-actions' },
      saved ? h('span', { className: 'km-saved' }, h(Icon, { name: 'check', size: 14 }), t('saved')) : null,
      h(Button, { variant: 'primary', type: 'submit', disabled: busy || state?.writable === false || snapshot.busy !== null },
        busy ? h(Icon, { name: 'refresh', size: 14, className: 'km-spin' }) : null,
        busy ? t('savingSettings') : t('saveSettings'),
      ),
    ),
  )
}

function KeysManagerBody(): React.ReactElement {
  const runtime = useRuntime()
  const t = useT()
  const snapshot = useStore()
  const state = snapshot.state
  const now = snapshot.now
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<ProviderFilter>('all')
  const [showAllAvailable, setShowAllAvailable] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const loadedRef = React.useRef(false)

  React.useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    if (snapshot.status === 'idle') void runtime.store.load()
  }, [runtime, snapshot.status])

  const providers = state?.providers ?? []
  // Additive host field: a snapshot from a build without transport support
  // renders cards with the hint instead of an account row.
  const transportAccounts = state?.transportAccounts ?? []
  const normalizedQuery = query.trim().toLowerCase()
  const matches = (provider: ProviderView): boolean => {
    if (normalizedQuery.length === 0) return true
    const haystack = [
      provider.displayName,
      provider.provider,
      provider.extraId,
      provider.api,
      provider.baseURL,
      ...provider.env,
    ].filter((value): value is string => Boolean(value)).join(' ').toLowerCase()
    return haystack.includes(normalizedQuery)
  }
  // A transport route is a provider card of its own: it groups with the
  // managed providers (the same set every 已接管 number counts), but it is
  // never offered as addable and never counts toward the key pool.
  const managed = providers.filter(provider => (provider.managed || provider.transport === true) && matchesFilter(provider, filter) && matches(provider))
  const available = providers.filter(provider => !provider.managed && provider.transport !== true && matchesFilter(provider, filter) && matches(provider))
  const visibleAvailable = showAllAvailable || normalizedQuery.length > 0 ? available : available.slice(0, 12)
  // Orphan rows obey the same search filter their provider cards do.
  const matchesAccount = (account: TransportAccountView): boolean => {
    if (normalizedQuery.length === 0) return true
    const haystack = [account.id, account.scope, account.displayName].join(' ').toLowerCase()
    return haystack.includes(normalizedQuery)
  }
  const orphanAccounts = orphanTransportAccounts(providers, transportAccounts).filter(matchesAccount)
  // The chips govern the orphan rows too: an orphan is a transport account with
  // no card, so only All and Transport select it, and the section count and its
  // placeholder must agree with what is actually rendered.
  const visibleOrphans = filter === 'all' || filter === 'transport' ? orphanAccounts : []
  // Counts follow the query-narrowed population the section heads render, so a
  // no-match query cannot leave a chip advertising rows no section shows.
  const filterCount = (value: ProviderFilter): number => {
    const searchable = providers.filter(matches)
    if (value === 'all') return searchable.length + orphanAccounts.length
    if (value === 'transport') return searchable.filter(provider => provider.transport === true).length + orphanAccounts.length
    return searchable.filter(provider => matchesFilter(provider, value)).length
  }
  // The managed list can be empty because nothing is managed, or because the
  // query or the active chip hides rows that exist; the empty body says which.
  // The query branch wins in the renderer, so this predicate needs only the
  // chip term: with a query present the query copy is shown regardless.
  const managedHiddenByChip = filter !== 'all'
    && providers.some(provider => provider.managed || provider.transport === true)

  function toggle(provider: string): void {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const loading = snapshot.status === 'loading' || (snapshot.status === 'idle' && state === null)
  const failed = snapshot.status === 'error' || (snapshot.status === 'ready' && state === null)

  return h('div', { className: 'km-page' },
    snapshot.error !== null ? h('div', { className: 'km-banner km-banner-error', role: 'alert' },
      h(Icon, { name: 'warning', size: 16 }),
      h('span', { className: 'km-banner-text' }, snapshot.error),
      h('button', { type: 'button', className: 'km-banner-close', onClick: () => runtime.store.dismissError(), 'aria-label': t('dismiss') }, h(Icon, { name: 'close', size: 14 })),
    ) : null,

    state !== null && state.warnings.length > 0
      ? h('div', { className: 'km-banner km-banner-warn', role: 'note' },
          h(Icon, { name: 'warning', size: 16 }),
          h('div', { className: 'km-banner-text' }, state.warnings.map((warning, index) => h('div', { key: index }, warning))),
        )
      : null,

    state !== null && !state.writable
      ? h('div', { className: 'km-banner km-banner-warn', role: 'note' },
          h(Icon, { name: 'shield', size: 16 }),
          h('span', { className: 'km-banner-text' }, t('writableFalse')),
        )
      : null,

    h('div', { className: 'km-embedded-head' },
      h('div', { className: 'km-summary' },
        h('div', { className: 'km-stat' }, h('strong', null, loading ? '—' : managedEntryCount(providers, transportAccounts)), h('span', null, t('managed'))),
        h('div', { className: 'km-stat' }, h('strong', null, loading ? '—' : state?.keyCount ?? 0), h('span', null, t('keys'))),
        h('div', { className: 'km-stat' }, h('strong', null, loading ? '—' : state?.healthyKeyCount ?? 0), h('span', null, t('healthy'))),
        h('div', { className: 'km-stat' }, h('strong', null, loading ? '—' : state?.coolingKeyCount ?? 0), h('span', null, t('cooling'))),
      ),
      h('div', { className: 'km-embedded-actions' },
        h(Button, {
          variant: 'ghost',
          size: 'small',
          onClick: () => void runtime.store.load(),
          disabled: snapshot.busy !== null,
          title: t('refresh'),
        }, h(Icon, { name: 'refresh', size: 14 }), t('refresh')),
      ),
    ),

    // Quick filter: single select, view state only, composed with the text
    // search below. Counts are derived per predicate from the snapshot.
    !loading && !failed ? h('div', {
      className: 'km-filters',
      role: 'group',
      'aria-label': t('filterGroup'),
    }, FILTER_CHIPS.map(chip =>
      h('button', {
        key: chip.value,
        type: 'button',
        className: cx('km-chip', `km-chip-${chip.value}`, filter === chip.value && 'km-chip-on'),
        'aria-pressed': filter === chip.value,
        onClick: () => setFilter(chip.value),
      },
        h('span', { className: 'km-chip-label' }, t(chip.label)),
        h('span', { className: 'km-chip-count' }, filterCount(chip.value)),
      ),
    )) : null,

    h('div', { className: 'km-search' },
      h(Icon, { name: 'search', size: 17, className: 'km-search-icon' }),
      h('input', {
        className: 'km-search-input',
        value: query,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        placeholder: t('search'),
        type: 'search',
        autoFocus: true,
        'aria-label': t('search'),
      }),
      query.length > 0
        ? h('button', { type: 'button', className: 'km-search-clear', onClick: () => setQuery(''), 'aria-label': t('reset') }, h(Icon, { name: 'close', size: 14 }))
        : null,
    ),

    loading ? h('div', { className: 'km-loading' }, h(Icon, { name: 'refresh', size: 18, className: 'km-spin' }), t('loading')) : null,
    failed ? h('div', { className: 'km-load-failure' },
      h('div', { className: 'km-empty-title' }, t('loadError')),
      h(Button, { variant: 'primary', onClick: () => void runtime.store.load() }, t('reload')),
    ) : null,

    !loading && !failed ? h('section', { className: 'km-section' },
      h('div', { className: 'km-section-head' },
        h('h2', { className: 'km-section-title' }, t('managed')),
        // What is below it, like the available section: the tile above keeps
        // the global total.
        h('span', { className: 'km-section-count' }, managed.length + visibleOrphans.length),
      ),
      // The placeholder only when the section renders neither a card nor a row
      // the active chip selects.
      managed.length === 0 && visibleOrphans.length === 0
        ? h('div', { className: 'km-empty' }, h(Icon, { name: 'key', size: 20 }), h('span', null,
            normalizedQuery.length > 0
              ? t('noSearch')
              : filter === 'transport' ? t('transportEmpty') : managedHiddenByChip ? t('managedFilteredEmpty') : t('managedEmpty')))
        : null,
      managed.length > 0
        ? h('div', { className: 'km-provider-list' }, managed.map(provider => h(ProviderCard, {
            key: provider.provider,
            provider,
            now,
            transportAccount: provider.transport === true
              ? transportAccounts.find(account => account.id === provider.provider)
              : undefined,
            expanded: expanded.has(provider.provider),
            onToggle: () => toggle(provider.provider),
          })))
        : null,
      visibleOrphans.length > 0
        ? h('div', { className: 'km-provider-list' }, visibleOrphans.map(account => h(TransportAccountRow, {
            key: account.scope,
            account,
          })))
        : null,
    ) : null,

    !loading && !failed ? h('section', { className: 'km-section' },
      h('div', { className: 'km-section-head' },
        h('h2', { className: 'km-section-title' }, t('available')),
        h('span', { className: 'km-section-count' }, available.length),
      ),
      available.length === 0
        ? h('div', { className: 'km-empty' }, h(Icon, { name: 'search', size: 20 }), h('span', null, normalizedQuery.length > 0 ? t('noSearch') : t('availableEmpty')))
        : h('div', { className: 'km-provider-list' }, visibleAvailable.map(provider => h(ProviderCard, {
            key: provider.provider,
            provider,
            now,
            expanded: expanded.has(provider.provider),
            onToggle: () => toggle(provider.provider),
          }))),
      available.length > visibleAvailable.length
        ? h('div', { className: 'km-show-more' },
            h(Button, { variant: 'ghost', size: 'small', onClick: () => setShowAllAvailable(true) }, t('showAll', { n: available.length })),
          )
        : showAllAvailable && available.length > 12
          ? h('div', { className: 'km-show-more' },
              h(Button, { variant: 'ghost', size: 'small', onClick: () => setShowAllAvailable(false) }, t('showLess')),
            )
          : null,
    ) : null,

    !loading && !failed ? h('section', { className: 'km-section' }, h(SettingsCard)) : null,

    h('footer', { className: 'km-footer' },
      h(Icon, { name: 'shield', size: 14 }),
      h('span', null, t('storageNote')),
    ),
  )
}

interface KeysManagerCardProps {
  view?: 'summary' | 'page'
  form?: unknown
}

function KeysManagerCard({ view }: KeysManagerCardProps): React.ReactElement | null {
  const t = useT()
  const snapshot = useStore()
  if (view === 'summary') {
    const state = snapshot.state
    if (state === null) return h('span', { className: 'km-summary-line' }, snapshot.status === 'error' ? t('loadError') : t('loading'))
    const managed = managedEntryCount(state.providers, state.transportAccounts ?? [])
    if (managed === 0) return h('span', { className: 'km-summary-line' }, t('summaryEmpty'))
    return h('span', { className: 'km-summary-line' }, t('summaryText', { providers: managed, keys: state.keyCount }))
  }
  return h(KeysManagerBody)
}

interface ManagedProviderBadgeProps {
  provider?: { provider?: string }
  view?: 'summary' | 'page'
}

function ManagedProviderBadge(props: ManagedProviderBadgeProps): React.ReactElement | null {
  const t = useT()
  const snapshot = useStore()
  const state = snapshot.state
  const providerId = props.provider?.provider
  if (state === null || providerId === undefined) return null
  const managed = state.providers.find(provider => provider.provider === providerId && provider.managed)
  if (managed === undefined) return null
  const broken = managed.bindingHealthy === false
  return h('div', { className: cx('km-models-note', broken && 'km-models-note-warn'), role: 'note' },
    h('span', { className: cx('km-dot', broken ? 'km-dot-warn' : 'km-dot-success') }),
    h('span', { className: 'km-models-note-text' }, t('modelsBadge', { n: managed.keyCount })),
    h('span', { className: 'km-models-note-hint' }, broken ? t('bindingBroken') : t('modelsHint')),
  )
}

export { KeysManagerCard, ManagedProviderBadge, KeysManagerBody }
export type { KeysManagerCardProps, ManagedProviderBadgeProps }
