# Changelog

All notable changes to dsh-keys-manager are documented here. Generated from
git log by the release-prep workflow.

## [0.1.0] - 2026-10-18

### Added

- Multi-key pools for existing DSH providers, with per-session sticky
  round-robin selection and automatic new-session rotation.
- Bounded retry and key failover with exponential cooldown recovery capped at
  seven days.
- A search-driven manager on the plugin detail page with key CRUD,
  pause/resume, cooldowns, policy settings, and release confirmation.
- A managed badge in the Models provider-card slot.
- A curated extra built-in provider catalog installed as normal pi-ai routes.
- TypeScript sources, dual Host/Client builds, Vitest coverage, and a CI/release
  workflow modeled on the sibling DSH plugins.

### Fixed

- A single-key pool, or a pool with no alternate available, now delegates its
  retry without cooling the only usable key first.
- Keys added when an extra provider is already managed are persisted
  immediately instead of waiting for an unrelated mutation.
- Cloudflare AI Gateway and Workers AI are reported as unsupported key pools:
  their auth also needs the Cloudflare account and gateway IDs, which a
  single-key broker cannot own.
- Anthropic imports now prefer `ANTHROPIC_API_KEY` and skip bearer/OAuth token
  variables such as `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN`.
- Explicitly classify Amazon Bedrock, Cloudflare AI Gateway, Cloudflare Workers
  AI, and OpenAI Codex as unsupported key pools.
- Label routes by origin: DSH built-in, plugin built-in, or custom.
- Review hardening: transient credential reads no longer disable a key, a
  delegated retry preserves the current key while terminal delegation cools
  it, native release preserves Models edits, cooldown history survives the
  recovery grace window, non-sticky retries stay bounded, failed state writes
  remain retryable, failed credential deletions keep their metadata for retry,
  derived cooldown statuses refresh, and expired session bindings are pruned.
- Policy forms preserve sub-minute cooldown/grace values; confirmation dialogs
  trap and restore focus.
- Release workflows reject unsafe prerelease dist-tags and resume after a
  partial npm publish without republishing.
- A read-only profile now fails release before any managed credential is
  deleted; adoption aborts on a credential-store read error instead of
  creating an empty pool; a broken broker binding bypasses key selection and
  failover; stale switch counters are pruned.
- Selection excludes already-tried keys and clears legacy `valueMissing`
  markers on load; the client ignores stale refresh responses with a request
  generation guard.
- Release compensates by restoring the broker binding if a credential unset
  fails after the profile mutation; an unreadable settings snapshot is treated
  as unknown rather than a broken binding; client mutations are serialized;
  retry budgets survive failures with no selected key; active switch budgets
  survive pruning; the Typert registration is disposed on unload.
- Failover probes an alternate credential before cooling the current key, and
  workflow actions are pinned to reviewed full commit SHAs.
- Release now leaves an externally replaced provider profile untouched,
  restores the exact live profile snapshot on a failed unset, records per-key
  deletion progress, refuses an unreadable release, never re-enables a cached
  mismatch, serializes first sticky selection per session/provider, and only
  attributes failures to a managed key when the broker actually served it.
- Retry/switch attempts are scoped per session/provider/turn/step so concurrent
  steps cannot reset each other's budget; pruning retains steps that still own
  a switch budget.
- State loading distinguishes read failures from parse corruption: read errors
  keep the file untouched and force a read-only/in-memory store, while corrupt
  JSON is backed up before a fresh state is written.
- Each failed stream attempt is attributed to the step that claims it, so a
  retry on another key or on an external credential refreshes the step's key
  and evidence instead of reusing stale state.
- Failover evidence is linked to the exact failure object the agent loop
  forwards, consumed on every delegation path, and no longer claimed by a
  later request; unscoped broker resolution skips paused/missing/cooling keys.
- Configuration-changing mutations await the durable state flush before
  reporting success. Attribution no longer falls back to the shared session
  record on an identity miss, and production stream regressions cover skipped
  and reversed error callbacks.
- Every recovery requires evidence for the current request; retry budgets are
  scoped per selected key and retries are pinned to their key without sticky
  sessions. Unsupported state schema versions open read-only, and shutdown
  drains the mutation queue before the final snapshot; the disposer returns
  the close promise so teardown awaits it.
- Retry pins are scoped per turn/step (ambiguous concurrent pins are not
  consumed), index rebuilds preserve unrelated pins, and each key in a step
  keeps its own retry counter.
- Recovery identity comes from the agent/request turn/step, so the actual
  retry stream consumes only its own pin; a new step clears abandoned pins,
  success/cancel clear them too, and failover carries a candidate's
  already-spent per-key budget.
- State probing uses stat and distinguishes ENOENT from permission failures;
  a denied parent directory starts read-only and cannot overwrite valid state.
