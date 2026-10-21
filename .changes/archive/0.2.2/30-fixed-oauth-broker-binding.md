---
category: Fixed
---
- An OAuth-served route no longer fails with `MISSING_CREDENTIAL`: a broker reference is written only while the key pool actually serves the route, so pi-ai can reach its own grant, and a broken binding left by an earlier version is healed at startup.
