---
category: Added
---
- Devin now lists the account's own models instead of a single seed row: a signed-in route discovers them through `GetCliModelConfigs` (cached five minutes, seed kept when the read fails).
- Devin sign-in offers a second method that imports the seat key the official Devin CLI already stores, so a machine already signed in with `devin auth login` needs no browser.
- The Devin account row renders one sign-in button per method the transport flow declares, and the model picker refreshes an account-scoped catalog before it renders.
