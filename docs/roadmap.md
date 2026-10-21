# Roadmap

[English](roadmap.md) | [简体中文](roadmap.zh-CN.md) — Back to [README](../README.md)

This page consolidates the open work items — the GitHub issues that describe
product scope and the local issue store that carries engineering residuals —
into an ordered plan. It is a planning document, not a promise: items move
between milestones as constraints change, and every item keeps its own
acceptance criterion in its source record.

Snapshot: 2026-10-21, at `main` = `25d7fc8` (PR #28 merged). Issue-store
rollup: 47 open — 0 critical, 5 high, 2 medium, 33 low, 7 nit.

## Direction

The plugin owns two things: **provider coverage** (which routes can be pooled
at all) and **pool quality** (how well a request is routed across the
credentials a route has). Coverage work is additive and safe; pool quality is
where the current gap is largest, because an OAuth account pool that serves
exactly one projected grant per provider is a pool in name only.

The ordering rule that follows from that: **fix routing correctness before
widening coverage.** Adding providers multiplies whatever the routing layer
does; if account attribution or step-scoped retries are wrong, more providers
mean more wrong decisions.

## Delivered baseline

- **API-key pool**: 21 plugin built-in routes plus 33 DSH built-in routes;
  sticky sessions, round-robin, step-scoped retry failover, escalating
  cooldowns, recovery grace.
- **OAuth accounts** for the seven providers whose flows `llm-pi-ai`
  implements (Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex,
  OpenRouter, Radius, xAI). One projected grant per provider; the key pool is
  the fallback.
- **Cursor transport** via the separately published
  `dsh-llm-omp-transports` (`can1357`-style bundled omp wire code, 123 model
  rows, text/reasoning streaming, MCP tool handoff, PKCE sign-in and refresh).
- **`coreweave`** served once a header carrier existed (issue #11).

## M1 — Pool quality: multiple accounts and quota-aware routing

Why first: this is the difference between "you can sign in" and "the pool
schedules". Everything else in the roadmap is coverage.

| Item | Source | Acceptance signal |
| --- | --- | --- |
| Quota-aware ordering: among accounts with remaining quota, the one resetting soonest wins; 5-hour-only windows are demoted until others fail; cooling accounts sort last | #22 | Selection order is a pure function of account quota state, pinned by a table-driven test |
| Per-account rotation in the selection ring (sticky, round-robin, failover, cooldown per account rather than per provider) | `I-000110` | A second account takes traffic on a new session; failure cools only the account that failed |
| Login harvest prefers a real identity over an email-only row; activation does not hold the global queue while awaiting a credential write | `I-000110` | Two concurrent activations do not serialize; harvested row keeps its org/project fields |
| Hydrate projection ownership concurrently, so one stalled provider read cannot disable the rest | `I-000121`, `I-000114`, `I-000115`, `I-000116`, `I-000119` | A stalled hydration for provider A leaves B servable within the wait budget; no reaction leaks onto the never-settling promise |
| Serve an unowned request loudly instead of silently | `I-000120` | The timeout path is observable (warn-once is not the only trace) |
| Consecutive identical select prompts reseed | `I-000123` | Two identical prompts in a row are both answerable |

Exit criterion: a provider with two accounts routes, fails over, cools and
recovers per account, and the state surface reports it.

## M2 — Coverage: remaining API-key routes

Source: issue #2, Phase 1. Each entry is a normal `llm-pi-ai` route — no
broker change.

| Batch | Routes |
| --- | --- |
| High confidence | `siliconflow`, `siliconflow-cn`, `litellm`, `charm-hyper` |
| Then | `typesafe`, `zhipu-coding-plan`, `alibaba-token-plan`, `meta` |
| Then | `abliteration`, `commandcode`, `firepass`, `yolo-auto`, `cline-pass` |

`meta` and `typesafe` need a check against the installed pi-ai chat catalog
before they are added: DSH's generated metadata lists them, but the catalog
may not serve them.

## M3 — Coverage: OAuth transports

Source: issue #15. Each provider here speaks a wire protocol `llm-pi-ai`
cannot serve, so it needs a transport slice like the Cursor one.

| Order | Provider | Note |
| --- | --- | --- |
| 1 | `devin` | Also has an API-key path, so it can partially land earlier |
| 2 | `google-gemini-cli` | Highest user value in this group; flow differs from Cursor |
| 3 | `google-antigravity` | Same family as above |
| 4 | `factory-droid` | Device flow, no API-key product |
| 5 | `gitlab-duo`, `gitlab-duo-agent` | OAuth or `GITLAB_TOKEN` |
| 6 | `muse-code`, `ollama-cloud`, `qwen-portal`, `xai-oauth`, `snowflake` | Lower demand; `snowflake` also needs a multi-field credential (M4) |

Dependency: M1 first. A second transport multiplies the account-routing
surface, and the Cursor route still keeps exactly one grant per route.

## M4 — Multi-field credentials

Source: issue #2, Phase 3. These routes cannot be represented by one API-key
reference, so the decision per provider is "managed native credential" versus
"configure natively in Models and stay outside the pool".

- `bedrock-mantle` and `amazon-bedrock` (SigV4 / credential chain)
- `snowflake` (account plus OAuth/PAT)
- `cloudflare-ai-gateway`, `cloudflare-workers-ai` (account/gateway id)
- `coreweave` follow-ups: header attribution by value equality can delete a
  user-authored header (`I-000129`), release does not restore the recorded
  env name (`I-000132`), repair misreports unreadable settings (`I-000135`,
  `I-000137`), drift is only surfaced on add/repair (`I-000166`), and the docs
  give no action for an unattributable header (`I-000138`).

## M5 — UX

| Item | Source | Notes |
| --- | --- | --- |
| Provider filter bar (built-in, OAuth-capable, transport) | #16 | Becomes necessary once coverage passes ~60 routes |
| Transport account diagnostics | `I-000170`, `I-000154` | Single sign-in entry, a real settings contract or none, documented seam-side retry ownership |
| Docs corrections | `I-000139`, `I-000169` | README still describes the known-limits page as covering deferred providers |

## M6 — Release and supply chain

Required before the next `npm publish`, not before the next PR.

- `I-000173` — the transport publish guard rejects an empty or non-ancestor
  `gitHead` but cannot prove who published; needs publisher-bound provenance
  (attestation + tarball digest).
- `I-000046` — the `@deepseek-ai/dsh-llm` `latest` dist-tag is stale.
- `I-000124` — the workflow-close attestation recorded two inexact values.
- `I-000090` — the credential seam has no compare-and-delete primitive.

## M7 — Cursor transport hardening

Blocking nothing, but each item is a papercut a reader or operator will hit.

- Shim surface: `I-000143` (JSON stubs and `Bun.deepEquals`/`gunzipSync`
  reachability), `I-000155` (logger bound to raw console), `I-000156` (LRU
  cache diverges from omp).
- Drift gate: `I-000158` (thinking-mode sub-fields), `I-000164`,
  `I-000165`.
- Behaviour: `I-000159` (three of eight error branches unimplemented),
  `I-000151` (`PI_REQ_DEBUG` dumps land in the host cwd), `I-000153` (extract
  the row-test state machine), `I-000177` (removal versus attempt-cache
  eviction window), `I-000169` (unpinned foreign-history refusal).
- Known product limits, documented rather than scheduled: image input is
  refused rather than forwarded, Cursor-native exec frames are not bridged to
  DSH, the client is unofficial (ToS risk, stop condition S4), and no live
  Cursor endpoint has been exercised.

## Hygiene backlog

Small, independent, safe to batch into any milestone: `I-000091`, `I-000092`,
`I-000093`, `I-000102`, `I-000109`, `I-000126`, `I-000127`, `I-000128`,
`I-000117`, `I-000118`, `I-000133`, `I-000140`, `I-000180`, `I-000185`.

## Explicitly out of scope

- Local and keyless engines: `ollama`, `lm-studio`, `llama.cpp`, `vllm`,
  `apple` — nothing to pool.
- Re-implementing provider wire protocols that `llm-pi-ai` already serves:
  those stay on the pi-ai route, not on a transport.
