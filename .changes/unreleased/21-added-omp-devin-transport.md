---
category: Added
---
- Add the `devin` transport route: a second omp-backed artifact (`lib/omp/devin.mjs`) speaking Devin's Connect-framed chat protocol, with its own generated catalog (`swe-1-6`, `swe-1-6-fast`), manifest entry, drift gate and calibrated size ceiling.
- Add the `llm-omp-transports/devin` sign-in flow: PKCE authorize page plus a paste-the-callback prompt (the pinned loopback listener is Bun-only), a token exchange and a static bearer with a derived `expires`; there is no refresh.
- Register the Devin adapter, its Models-page profile, `providers.devin.models` allow-list and provider info beside Cursor's, sharing one route-parameterised adapter and projection.
- Fill DSH attribution headers only where a request left them absent, so Devin's chat call keeps its required `connect-go` client identity while the header-less `GetUserJwt` handshake still carries the harness `user-agent`.
