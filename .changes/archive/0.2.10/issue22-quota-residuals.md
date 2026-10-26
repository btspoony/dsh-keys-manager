---
category: Fixed
---
- The plan-usage label now trusts the expiry of the credential actually used, so a stale account-row timestamp can neither mask a real refusal nor fake an expired account.
- A stale usage reading is re-checked on the slow (ten-minute) cadence instead of sticking until the card is remounted.
