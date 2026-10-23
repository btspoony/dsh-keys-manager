---
category: Fixed
---
- Document the `devin` transport route in the root README (EN/ZH) with its paste-only sign-in, no-refresh expiry and unverified endpoints; correct the stale "one route, one grant" and Cursor-only wording.
- Root known limits now name Kilo and Z.AI Coding Plan as in-process sign-in routes and state the transport `expires` contract: a usable grant without `expires` is `active` with no expiry line.
- A transport route whose installed build ships no model catalog now reports it once in the state warnings instead of rendering an empty model list.
- The sign-in dialog masks a pasted authorization code behind a reveal toggle and turns autofill off, because the code is the only secret in the exchange.
- A transport grant with a usable token and no `expires` is reported `active` with no expiry line instead of asking for a re-login.
- Signing in to Kilo seeds the route from the plugin catalog instead of waiting for endpoint model discovery before the key row appears.
