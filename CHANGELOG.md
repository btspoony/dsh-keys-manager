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
