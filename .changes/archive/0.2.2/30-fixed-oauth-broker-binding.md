---
category: Fixed
---
- An OAuth-served route no longer fails with `MISSING_CREDENTIAL`: a broker reference is written only while the key pool actually serves the route, so pi-ai can reach its own grant, and a broken binding left by an earlier version is healed at startup.
- Key and account rows gain a Test action that runs one real request through the LLM seam and reports whether that credential serves the route, without touching health, cursor or binding state.
