---
module: dsh-keys-manager/quota
date: 2026-10-24
problem_type: api_design
category: api-design
severity: medium
plan_id: issue22-quota-visibility
applies_when:
  - Adding a provider quota probe for a coding-plan subscription
  - Reviewing code that turns vendor usage payloads into displayed usage bars
tags:
  - quota
  - usage
  - provider-probe
  - cache
  - api
---

# Reading subscription plan usage from coding-plan vendors

Proven in issue22-quota-visibility (2026-10-24) and extended in issue22-quota-ui-probes (2026-10-25) and issue62-quota-absent-semantics (2026-10-28): the Keys Manager shows per-account plan usage as one muted line on the key/account row, and nothing at all for a route that cannot report usage. Reference facts came from reading `yetone/magpie`, `junhoyeo/tokscale` and the local `oh-my-pi` checkout; **no live request was made**, so treat every field name as "as implemented by those three" until a real account proves it.

## Shape that works: one GET per account, normalized to windows

```
QuotaWindow { id: 'session' | 'week'; usedFraction: 0..1; resetsAt: epochMs }
QuotaSnapshot { status: 'ok' | 'absent' | 'unauthorized' | 'error'; fetchedAt; windows[]; stale?; absentCause? }
```

`absent` is two facts, not one, and `absentCause` keeps them apart on the wire: `'no-probe'` (no probe is registered for the route — nothing was ever asked, so the card explains the route) versus `'reported-nothing'` (a probe ran and the vendor had nothing usable). The field is unset when the read never reached a probe at all (no readable credential).

Three reset-time encodings coexist and every parser must accept all of them: ISO string (Claude, OpenCode Go), epoch seconds/ms (Codex `reset_at`, Z.ai `nextResetTime`), and relative seconds (Codex `reset_after_seconds`). Normalize once, at the boundary.

## Endpoint facts worth keeping

| Provider | Endpoint | Auth | Window mapping |
|---|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` | Bearer + `anthropic-beta: oauth-2025-04-20` | `five_hour` → session, `seven_day` → week; **`utilization` is USED percent — invert it** |
| Codex | `chatgpt.com/backend-api/wham/usage` | Bearer + `chatgpt-account-id` (from the id_token claim) | classify by `limit_window_seconds` (~18000 session, ~604800 week), not by slot name |
| Z.ai / GLM plan | `api.z.ai/api/monitor/usage/quota/limit` | **bare key, no `Bearer`** | `unit` 3 = hours, 6 = weeks; `number` gives the length |
| Kimi | `api.kimi.com/coding/v1/usages` | Bearer | short durations → session, multi-day → week; numbers may be strings |
| MiniMax | `.../coding_plan/remains` | Bearer (`sk-cp-…`) | interval counters → session, weekly counters → week |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` | Bearer | `rolling` → session, `weekly` → week, `monthly` ignored |
| Command Code | `api.commandcode.ai/alpha/billing/credits` | Bearer + `Accept: application/json` | `windowLimits.fiveHour` → session, `.weekly` → week, each `{ used, cap, resetAt }`; a balance-only payload has no window → `error` |
| xAI SuperGrok | `cli-chat-proxy.grok.com/v1/billing?format=credits` | Bearer + `X-XAI-Token-Auth: xai-grok-cli` + UA | `currentPeriod.type` must contain WEEK → week, `creditUsagePercent` USED; `isUnifiedBillingUser: true` is `error` (the credits payload alone cannot say whether the weekly pool applies, so an inferred 0 % would be fake health), and a monthly period is `error` too |
| Cline (ClinePass) | `api.cline.bot/api/v1/users/me/plan/usage-limits` | key + Cline desktop headers (`X-CLIENT-TYPE: cline-desktop`, `X-CLIENT-VERSION`) | `limits[].type` `five_hour` → session, `weekly` → week, `monthly` dropped; `percentUsed` USED; 404 = no ClinePass → `absent` |

## Rules that prevented wrong data

- **Absent ≠ zero.** A 404 / unknown route is `absent`, never `0% used`. Only `ok` renders usage.
- **A present-but-invalid count is not "missing".** If `used` is negative or `remaining > limit`, drop the window; fall back to another field **only** when it is `undefined`. A `??` chain over an invalid value resurrects a fake healthy 0% (found by QC on both Z.ai and MiniMax).
- **HTTP 200 can carry a refusal.** MiniMax `base_resp.status_code != 0` and Z.ai `success: false` map to `error`, not to a snapshot.
- **401/403 → `unauthorized`; 404 → `absent`; everything else → `error`.** A probe must never throw out of its boundary.
- **Duplicate window ids lose data silently** because consumers usually `find()` the first match — collapse with the tighter fraction at parse time.
- **A window the UI cannot represent is dropped, never relabelled.** The wire model has only `session` and `week`, so Cline's `monthly` limit is dropped and a monthly-only payload is `error`; xAI's unified-billing payload is `error` too (`isUnifiedBillingUser: true`, even when its period type says WEEKLY — the credits payload alone cannot say whether that weekly pool applies). Monthly and unified periods are never rendered as a week.

## Cache policy (the part that keeps vendors happy)

- 300 s TTL with ±25% jitter; clients must align their staleness threshold with the **server's maximum** freshness (`ttl * (1 + jitter)`), or the first post-TTL read is a guaranteed cache hit and the UI looks stuck.
- Single-flight per (provider, account); failure backoff 10 s, 60 s for `unauthorized`; keep last-good with a `stale` flag for up to 24 h.
- No background polling: refresh on first use / on an explicit client pull. Deleted keys and released providers need eviction, and a projected snapshot must be copied (not shared by reference) so a view edit cannot mutate the cache.

## What is not portable into a plugin

- magpie's Claude path shells out to `claude -p /usage` and parses text; the header-derived path (`anthropic-ratelimit-unified-*`) only exists if you proxy the traffic.
- tokscale's Antigravity reader needs a local IDE language-server port; Amp returns human markdown; Sakana needs a cookie and HTML scrape.
- A plugin that holds an OAuth access token can use the HTTP endpoints — but this repo does **not** refresh tokens itself (pi-ai does, lazily, on the projection record), so a stale `access` yields 401. Degrade to `unauthorized`; never write cooldown from a quota read.

### Routes rejected after reading the reference source

| Route | Reference | Why it stays `absent` |
|---|---|---|
| `cursor` | tokscale `usage/cursor.rs` | Shape is known (Connect POST `GetCurrentPeriodUsage`, `Connect-Protocol-Version: 1`), but the route is a **transport** account: its grant lives under `llm-omp-transports/cursor` and is read only inside the host service, while `quotaRefresh` walks the pi-ai key-pool record only. A 401 additionally needs refresh-grant rotation with write-back, which belongs to the transport adapter. |
| `factory-droid` | magpie `factory_usage.go` (marked PLUGIN-SERVED / retired) | Same transport-route reachability as cursor (`llm-omp-transports/factory-droid`), and the endpoint expects droid's `X-Factory-Org-Id` from a sign-in record the quota path cannot see. |
| `openrouter` | tokscale / magpie / oh-my-pi | No reference implements a usage read (tokscale has model pricing only, magpie the chat base, oh-my-pi no openrouter usage provider), so `GET /api/v1/key`'s field shape is unconfirmed — no guessed parser. |
| `ollama-cloud` | oh-my-pi `usage/ollama.ts` | States there is no standalone quota API for Ollama; a balance read would carry no window to normalize. |

Cline's `X-CLIENT-VERSION` is a hard-coded desktop release (`3.5.54`, copied from magpie) — a maintenance risk if Cline starts version-gating the usage endpoint.

### Three endpoints that exist but cannot map to a usage window (issue #62)

These routes have a reachable usage endpoint; they stay `absent` because their
number is not a `session`/`week` window. Recording it here keeps the decision
from being re-litigated as "someone forgot a probe" (`I-000312`, `I-000318`).

| Route | Endpoint | Evidence source | Why it stays `absent` |
|---|---|---|---|
| `deepseek` | `GET https://api.deepseek.com/user/balance` (Bearer) | Vendor API docs: "Get User Balance" — <https://api-docs.deepseek.com/api/get-user-balance> | The answer is `balance_infos[].{currency, total_balance, granted_balance, topped_up_balance}`: **money, no period**. A balance has no reset instant and no denominator, so any `usedFraction` would be invented. |
| `openrouter` | `GET https://openrouter.ai/api/v1/key` | Vendor API docs: "Limits" / `GetKeyResponse` — <https://openrouter.ai/docs/api-reference/limits>. No reference implementation reads a usage endpoint either (tokscale has pricing only, magpie the chat base, oh-my-pi no openrouter usage provider — `I-000318`). | `data.{usage, limit, limit_remaining, limit_reset}` is a **key budget**, not a plan window: `limit` may be a lifetime cap, and `limit_reset` is a period *name* (`daily`/`weekly`/`monthly`) or null — never a reset timestamp, so no `resetsAt` exists. |
| `github-copilot` | `GET {github-api}/copilot_internal/user` | Local reference `oh-my-pi/packages/ai/src/usage/github-copilot.ts:187` (fetch) and `:86-95` (`buildWindow`: `quota_reset_date` → `{ id: 'monthly', label: 'Monthly', resetsAt }`). | Copilot's `quota_snapshots.*` quota resets **monthly**. The window model has only `session`/`week`, and a monthly period is dropped, never relabelled — same rule as Cline's `monthly` limit and Cursor's monthly billing bucket. |

Both vendor-doc rows are recorded from the published API reference, not from a live account: a real capture is still what `I-000301` asks for. Reopen any of the three only if the window model gains a `month`/balance window that can carry the vendor's own period.

## Display-only first, ranking second

Quota visibility (this work) and quota-aware routing are separable: the snapshot API is useful on its own, and ranking changes `doSelectKey` semantics (tiers by soonest reset, session-only accounts last once ≥90% used, cooling accounts last) — a change that deserves its own plan. Note that while an OAuth projection exists, the host skips key selection entirely, so ranking only affects key-pool routes unless the projection switch itself is changed.

## Live-probe lessons: expired credentials, stale states, uninterpretable payloads

Measured on a real installation (credential store + direct vendor calls, 2026-10-25), after the first release of the quota surface. Three rules came out of it that no amount of source reading had produced.

### 1. An expired stored credential is not a sign-in prompt

The pool row and the pi-ai projection for one route carried the **same** access token, twelve hours past its `expires`. The vendor answered `401 invalid_authentication_error`. The card said "sign in again" — advice the user could not act on, because:

- re-running the pool sign-in does not refresh the *projection* credential, and
- pi-ai only refreshes lazily **on model traffic**, and this plugin has no refresh API (`ctx.authorization` exposes `list`/`describe`/`begin`; pi-ai is not an importable dependency).

So a `401/403` on a credential whose `expiresAt` is in the past means "a model request will fix this", not "your credential is wrong". Label it as a natively-managed/unavailable state; keep the actionable "sign in again" for an *unexpired* credential that is still refused.

### 2. A non-`ok` snapshot must have its own retry cadence

Gating freshness on `status === 'ok'` alone makes every failure permanent: the client is the only thing that triggers a refresh, so a transient 5xx, a rate-limited probe, or a token that later gets refreshed by model traffic all stick on screen until the card is remounted. Give non-`ok` states a slower cadence (ten minutes was chosen) and keep the per-signature retry budget and the rejected-RPC one-shot lock — those exist to stop loops, not to make failures permanent.

### 3. `error` from a probe is not always a credential problem

The same payload can be valid and uninterpretable: an xAI account on unified billing returns `200` with a weekly period and a monthly quota at once, so a weekly percentage cannot be trusted. The probe returns `error` on purpose, and the UI must not promote that to an auth failure. Distinguish three outcomes explicitly — *credential refused*, *payload not usable*, *no usage API for this route* — because each deserves a different label; `absentCause` makes the third machine-readable instead of a `reason` string to match on.

Two smaller findings worth keeping: the fetch layer folds `401` and `403` into one `unauthorized` status (so a scoped/revoked grant looks like an expired one), and the cache's last-good `ok` snapshot (24 h) outranks any newer non-ok state — a row that once showed numbers keeps them after the credential expires.

### How to reproduce the measurement

Read the grant from the DSH credential store (`~/.dsh/.credentials.yaml`, records keyed `keys-manager/<provider>-<hash>` and `llm-pi-ai/<provider>`), take `payload.access`, and call the vendor endpoint directly with the same headers the probe uses. Never print the token; report only status, timing and the response body. The plugin's own `resolveQuota` can be exercised the same way against a build, which is how the xAI "unified billing" reason was confirmed as by-design rather than a bug.
