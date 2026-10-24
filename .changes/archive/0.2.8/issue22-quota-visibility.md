---
category: Added
---
- Show each managed account's plan usage on its provider card: a compact one-line hint when collapsed, and an expanded strip with one thin bar per window (session and weekly), the used percentage and the reset countdown.
- Quota reads are pull-only, cached in memory with TTL jitter and failure backoff, and never touch key selection or cooldown; a provider whose plan cannot be read shows "not reported" (or "sign in again" on a stale OAuth account) instead of a zero bar.
