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
