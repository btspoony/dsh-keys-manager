---
category: Fixed
---
- A per-key connection test against a healthy provider reports success again (a one-token answer ends with `max-tokens`, which is a completion), and a failed re-authentication no longer deletes the grant record its surviving account row references; a startup hydration also restores such a lost record from the route's live projection instead of leaving the account unusable.
