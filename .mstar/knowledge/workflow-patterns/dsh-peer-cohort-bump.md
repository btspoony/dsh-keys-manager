---
module: dependency-upgrades
date: 2026-11-06
problem_type: workflow_issue
category: workflow-patterns
severity: medium
plan_id: dsh-peers-0.2.2-rc1
tags: [dsh, peers, cordis, schemastery, cosmokit, declaration-emit, ts2742]
---

# Bumping the DSH peer cohort

`applies_when`: a new `dsh-v0.2.x-rc.N` release exists and both packages must move onto it.

## Procedure

1. Bump every `@deepseek-ai/dsh-*` peer in the root `package.json` and in
   `packages/llm-omp/package.json` to the new cohort range, plus the transport's
   `devDependencies` copy of `@deepseek-ai/dsh-llm`.
2. Declare every peer the cohort's `dsh-llm` newly requires. `0.2.2-rc.3` moved the
   `HarnessError` base class into `@deepseek-ai/dsh-error` and declared it a peer of
   `dsh-llm`, so the bump adds that package to both manifests' peers and to the transport's
   `devDependencies`; with `autoInstallPeers: false` the declaration alone does not install
   it, and `dsh-llm`'s declaration files import it.
3. In the same commit, move the two adjacent pins to the ranges that cohort's `dsh-llm`
   declares: `@deepseek-ai/cordis` `~4.1.0` and, in the transport package,
   `@deepseek-ai/schemastery` `~3.19.0` — as the peer range **and** the devDependency range
   (rationale below).
3. Update `pnpm-workspace.yaml`: the six `@deepseek-ai/dsh-*` entries under
   `minimumReleaseAgeExclude` must name the new cohort's exact versions, or a frozen install
   refuses it as too fresh. Update both README DSH badges to the declared peer range.
4. `pnpm install --no-frozen-lockfile`, then confirm one resolution per package:
   `pnpm ls -r --depth 99 @deepseek-ai/cordis @deepseek-ai/schemastery @deepseek-ai/cosmokit`.
5. Run both packages' typecheck, build and tests. The transport build is the real gate for
   declaration emit; typecheck alone does not exercise it.

## Why cordis and schemastery move with the cohort

`dsh-llm@0.2.2-rc.1` depends on `@deepseek-ai/schemastery ~3.19.0` and
`@deepseek-ai/cordis ~4.1.0`. Leaving `cordis@4.0.5` in place pins
`@deepseek-ai/cosmokit@1.8.6`, while `schemastery@3.19.0` needs `~1.9.0`, so a second
cosmokit copy nests under the schemastery install. Types from that nested copy cannot be
named in declaration emit:

```text
src/index.ts(151,14): error TS2742: The inferred type of 'Config' cannot be named
without a reference to '@deepseek-ai/schemastery/node_modules/@deepseek-ai/cosmokit'.
```

`cordis@4.1.0` depends on `cosmokit@~1.9.0`, so aligning cordis dedupes cosmokit and removes
the error at its root.

Two separate reasons keep both the peer and the devDependency at the tilde range:

- **Peer range** — a consumer resolving cordis 4.2+ would satisfy this plugin while violating
  `dsh-llm`'s own `~4.1.0` peer, so the declaration must state the same ceiling the cohort
  enforces.
- **DevDependency range** — `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so the dev
  resolution is the only cordis the workspace installs and the one typecheck/build/tests run
  against. A caret there lets a lockfile refresh pull a cordis line the published peer
  forbids, and CI would go green against an unsupported version.

The same applies to `schemastery` in the transport package: peer and devDependency both move
to the cohort's range.

## What does not work

- Annotating `export const Config: z<Config>` and making `TransportProviderProfile.models`
  `readonly` makes typecheck pass, but keeps the duplicate install. The annotation then
  breaks the schema-to-profile assignment (`TS2322`) once the profile type is left mutable.
- Bumping only `schemastery` still leaves the cordis-pinned `cosmokit@1.8.6`; declaration
  emit continues to fail.
- `pnpm peers check` keeps reporting three `missing peer` lines (`dsh-authorization`,
  `dsh-credentials`, `dsh-settings`) because those are host-provided peers and the workspace
  runs with `autoInstallPeers: false`. That is baseline behavior, not a regression.

## Type surface note

`dsh-llm@0.2.2-rc.1` turned `GenerateOptions.purpose` into a generic that defaults to
`never`; the package documents that forwarding adapters may accept `string`. Widen the
transport projection and adapter signatures plus request fixtures to
`GenerateOptions<string>` instead of casting at call sites.

## The `LlmError` code surface narrowed in rc.3

`dsh-llm@0.2.2-rc.3` changed the constructor parameter from `code: string` to
`code: BuiltinLlmFailureCode` (`keyof LLM_FAILURE_CODES | \`HTTP_${number}\``). A transport
that raises its own provider-neutral codes (`AUTH_FAILED`, `REAUTH_REQUIRED`,
`TOOL_ARGUMENTS_INVALID`, …) keeps them only through the documented
`LlmError.fromFailure({ message, code }, options?)` path — the class comment names exactly that
case ("a failure from another provider, whose code may be any string, is re-raised through
`LlmError.fromFailure`"). Runtime validation is unchanged (non-empty strings), so emitted
`code`/message/cause/provider facts stay identical and existing assertions pass unmodified.
Keep genuinely built-in codes (`ABORTED`, `STREAM_CLOSED`, `UNKNOWN_MODEL`,
`UNSUPPORTED_REASONING_EFFORT`, …) on `new LlmError(...)`; converting them is noise.

A transport package whose `tsconfig.json` includes `tests` must adapt test fixtures that
construct `LlmError` with a custom code too, or the package typecheck fails on the fixture.

## The refusal code changed in rc.5 (`MALFORMED_RESPONSE` → `CONTENT_REFUSED`)

`dsh-llm@0.2.2-rc.5` adds `CONTENT_REFUSED` to `LLM_FAILURE_CODES` and the DeepSeek stream
raises it when the provider refuses the request content; rc.3 raised `MALFORMED_RESPONSE` for
the same event, and rc.5 also emits a `usage` chunk before the error. Nothing narrows at the
type level, so a consumer that only typechecks will not notice.

The behavioral hazard belongs to whoever classifies failures per key. A refusal is
request-shaped: the key is healthy and re-sending the same content on another key cannot
succeed. A key-managing plugin that decides failover/cooldown from the raw code
(`shouldFailover` in `dsh-keys-manager`) must treat `CONTENT_REFUSED` as non-key, otherwise
it cools a healthy key and spends the retry budget looping over keys. Pin the classification
at the shared classifier and at every entry point that consults it (here: `shouldFailover`
and `classifyOAuthFailure`), not just one.

`CONTENT_REFUSED` carries no `retryChoice`, so default host retry policies do not offer it;
do not add it to a custom `retryableCodes` set as a substitute for the classification fix.

## Release-age rows are conditional, not automatic

`minimumReleaseAgeExclude` needs a row only when an effective `minimumReleaseAge` policy
rejects that exact version. Check `pnpm config get minimumReleaseAge` (this checkout returns
`undefined`) before adding rows: an RC published days earlier installs cleanly with none.
Delete the previous cohort's rows on each bump instead of re-pointing them at a version that
was never refused, and keep the comment truthful about the re-add trigger.
