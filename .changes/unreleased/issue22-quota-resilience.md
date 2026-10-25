---
category: Fixed
---
- A rejected plan-usage refresh now shows a localized "not reported" state and retries on the slow ten-minute cadence, instead of leaving the account row pending for the rest of the card session.
- A credential-store read that fails transiently is retried once and then reported as a temporary failure, so a momentary blip no longer looks like a refused or expired credential (the last known numbers stay visible and no sign-in is prompted).
