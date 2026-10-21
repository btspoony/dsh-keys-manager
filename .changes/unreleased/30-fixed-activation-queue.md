---
category: Fixed
---
- Activating an account no longer holds the global mutation queue while it reads and writes the OAuth credential, so a slow credential store cannot delay unrelated key or settings changes; the activation's errors, returned state and cooldown reset are unchanged.
- An activation that is refused (shutdown, read-only state, or a provider or account that disappeared mid-flight) now rolls back the credential projection it committed instead of leaving it behind, and never deletes a projection another writer replaced.

