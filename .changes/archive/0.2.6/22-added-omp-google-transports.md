---
category: Added
---
- Add the bundled `lib/omp/google.mjs` artifact: omp's Gemini Cloud Code Assist provider, shared by the `google-gemini-cli` and `google-antigravity` routes and dispatching on `model.provider`, with a manifest entry, pinned source hashes and a calibrated size ceiling.
- Add the generated Google model tables (`google-gemini-cli`, `google-antigravity`) and their `googleGeminiCliCatalogModels()` / `googleAntigravityCatalogModels()` projections for host-side model pickers.
- Add the `google-gemini-cli` and `google-antigravity` sign-in flows: a loopback listener on `127.0.0.1` (port fallback to an ephemeral port, five-minute bounded wait, abort-safe), a paste fallback, Cloud Code Assist project discovery and a single-window token refresh that preserves the project and an un-rotated refresh token.
- Register both Google routes: configurable `providers.google-gemini-cli` / `providers.google-antigravity` allow-lists, catalog-model exports for host pickers, and lazy loading of the shared `lib/omp/google.mjs` artifact (a missing build reaches the request as `TRANSPORT_UNAVAILABLE`, never a failed start).
