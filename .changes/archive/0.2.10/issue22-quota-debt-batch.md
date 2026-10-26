---
category: Fixed
---
- A plan-usage read that never answers now gives up after a bounded wait and reports "not reported" (retrying on the slow cadence), and an answer that arrives later is discarded instead of overwriting a newer reading.
- Plan-usage reads now probe at most four accounts at once and skip the credential lookup entirely for a cached account, so a wide key pool no longer opens one vendor request per key on every refresh.
- Dead cache entries are evicted when a key is removed or a provider is released, and a displayed snapshot can no longer be mutated by a caller.
