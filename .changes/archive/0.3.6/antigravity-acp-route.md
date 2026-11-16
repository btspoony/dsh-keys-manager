---
category: Changed
---

- The Antigravity route now runs omp's `antigravity-cli` provider over the official
  `agy` CLI (ACP) instead of calling Cloud Code Assist directly, so a Google One /
  Antigravity account signs in through agy's own Google flow. `agy` is downloaded
  and verified by the plugin (Google's release manifest, SHA-512; `PI_AGY_PATH`
  overrides), so no manual install is needed.
- The route ids split by account: `google-gemini-cli` for Google Cloud projects,
  `antigravity-cli` for Antigravity entitlement accounts. The direct
  `google-antigravity` route is gone — an account signed in to it must sign in
  again under the new route.
