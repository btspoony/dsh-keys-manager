---
category: Removed
---

- Removed the retired direct Cloud Code Assist Antigravity route: its route record,
  adapter subclass, projection profile, auth facts, credential key, its own generated
  catalog table (`src/catalog/google-antigravity.ts`), and the Antigravity-only cases
  in the Google suites are gone. The `google-gemini-cli` route — its catalog, facts
  and cases — is untouched, and `antigravity-cli` stays the only Antigravity path.
