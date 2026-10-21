---
category: Added
---
- Several API keys per provider, each with an alias and a health state, instead of one shared key.
- Each session is pinned to one key, with round-robin selection for new sessions.
- A failed request retries on the same key within a bounded budget, then fails over to another key.
- A failing key cools down exponentially, capped at seven days, and returns to the rotation on its own.
- The plugin detail page gains a search-driven manager, and the existing model cards show a "managed by Keys Manager" badge.
