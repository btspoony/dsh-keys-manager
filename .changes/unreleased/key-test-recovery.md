---
category: Fixed
---
- A per-key connection test against a healthy provider reports success again (a one-token answer ends with `max-tokens`, which is a completion), and a failed re-authentication no longer deletes the grant record its surviving account row references; an account whose grant record was lost is now healed on the read path (activation or a connection test) from the route's live projection, instead of staying unusable.
