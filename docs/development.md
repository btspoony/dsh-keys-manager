# Development

[English](development.md) | [简体中文](development.zh-CN.md) — Back to [README](../README.md)

## Prerequisites

- Node `^22.19 || >=24`
- pnpm

## Commands

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

- `pnpm typecheck` runs `tsc --noEmit` over the Host, Client, and spec
  tsconfigs.
- `pnpm build` runs the Node-side `tsc` build (`lib/`), emits the Client
  declarations, bundles the Client with esbuild, and verifies every artifact
  the package manifest resolves.
- `pnpm test` runs the Vitest suites.

## Host and client halves

The Host half is a normal ESM Cordis function plugin. The Client half is a
normal slot plugin; `scripts/build-client.mjs` wraps it in the
`window.__ModuleLoader__.load` closure only at bundle time, so the source is
importable by tests.

## Repository layout

| File | Role |
|---|---|
| `src/index.ts` | Host plugin: credential broker, selection, failover, settings writes, Remote namespace |
| `src/core.ts` | Pure round-robin, cooldown, status, and validation policy |
| `src/store.ts` | Secret-free durable state and atomic writer |
| `src/providers.ts` | Extra built-in provider catalog |
| `src/domain.ts` | Shared Host/Client domain shapes |
| `src/client/index.ts` | Client registration on the plugin-detail and Models slots |
| `src/client/ui.ts` | Manager page, key rows, forms, and Models badge |
| `src/client/store.ts` | Client snapshot store and RPC calls |
| `tests/core.test.ts` | Policy and store tests |
| `tests/host.test.ts` | Host service, adoption, failover, and secret-free persistence tests |
| `tests/client.test.ts` | Registration, locale parity, and client store tests |
