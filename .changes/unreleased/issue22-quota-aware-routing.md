---
category: Added
---
- Key-pool routes now prefer the account whose plan quota resets soonest (weekly window first, then a session window below 90% used), so leftover quota is spent before it expires; routes without usage data and equally-ranked accounts keep the existing cursor rotation.
