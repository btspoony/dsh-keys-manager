---
category: Fixed
---
- Activating an account no longer holds the global mutation queue while it reads and writes the OAuth credential, so a slow credential store cannot delay unrelated key or settings changes; the activation's errors, returned state and cooldown reset are unchanged.
