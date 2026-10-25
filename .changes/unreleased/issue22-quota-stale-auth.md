---
category: Fixed
---
- An expired stored OAuth credential no longer asks the user to sign in again for plan usage: the card says the account is managed by DSH instead, because only a model request refreshes that token.
- Plan-usage states that are not reported now refresh on a ten-minute cadence (and keep their last known label while doing so), instead of sticking until the card is remounted.
