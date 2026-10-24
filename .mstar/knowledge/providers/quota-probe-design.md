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

Proven in issue22-quota-visibility (2026-10-24): the Keys Manager shows per-account plan usage on the provider card. Reference facts came from reading `yetone/magpie`, `junhoyeo/tokscale` and the local `oh-my-pi` checkout; **no live request was made**, so treat every field name as "as implemented by those three" until a real account proves it.

## Shape that works: one GET per account, normalized to windows

```
QuotaWindow { id: 'session' | 'week'; usedFraction: 0..1; resetsAt: epochMs }
QuotaSnapshot { status: 'ok' | 'absent' | 'unauthorized' | 'error'; fetchedAt; windows[]; stale? }
```

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

## Rules that prevented wrong data

- **Absent ≠ zero.** A 404 / unknown route is `absent`, never `0% used`. Only `ok` renders bars.
- **A present-but-invalid count is not "missing".** If `used` is negative or `remaining > limit`, drop the window; fall back to another field **only** when it is `undefined`. A `??` chain over an invalid value resurrects a fake healthy 0% (found by QC on both Z.ai and MiniMax).
- **HTTP 200 can carry a refusal.** MiniMax `base_resp.status_code != 0` and Z.ai `success: false` map to `error`, not to a snapshot.
- **401/403 → `unauthorized`; 404 → `absent`; everything else → `error`.** A probe must never throw out of its boundary.
- **Duplicate window ids lose data silently** because consumers usually `find()` the first match — collapse with the tighter fraction at parse time.

## Cache policy (the part that keeps vendors happy)

- 300 s TTL with ±25% jitter; clients must align their staleness threshold with the **server's maximum** freshness (`ttl * (1 + jitter)`), or the first post-TTL read is a guaranteed cache hit and the UI looks stuck.
- Single-flight per (provider, account); failure backoff 10 s, 60 s for `unauthorized`; keep last-good with a `stale` flag for up to 24 h.
- No background polling: refresh on first use / on an explicit client pull. Deleted keys and released providers need eviction, and a projected snapshot must be copied (not shared by reference) so a view edit cannot mutate the cache.

## What is not portable into a plugin

- magpie's Claude path shells out to `claude -p /usage` and parses text; the header-derived path (`anthropic-ratelimit-unified-*`) only exists if you proxy the traffic.
- tokscale's Antigravity reader needs a local IDE language-server port; Amp returns human markdown; Sakana needs a cookie and HTML scrape.
- A plugin that holds an OAuth access token can use the HTTP endpoints — but this repo does **not** refresh tokens itself (pi-ai does, lazily, on the projection record), so a stale `access` yields 401. Degrade to `unauthorized`; never write cooldown from a quota read.

## Display-only first, ranking second

Quota visibility (this work) and quota-aware routing are separable: the snapshot API is useful on its own, and ranking changes `doSelectKey` semantics (tiers by soonest reset, session-only accounts last once ≥90% used, cooling accounts last) — a change that deserves its own plan. Note that while an OAuth projection exists, the host skips key selection entirely, so ranking only affects key-pool routes unless the projection switch itself is changed.
