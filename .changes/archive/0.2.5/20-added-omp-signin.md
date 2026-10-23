---
category: Added
---
- Sign in to Kilo and Z.AI (GLM Coding Plan) from Keys Manager: Kilo polls a device-code page, Z.AI opens a browser URL and accepts the pasted redirect URL or code.
- Both sign-ins mint a static credential stored as an ordinary key row (`signin:kilo` / `signin:zai-coding-plan`); Sign in again replaces that row's literal in place.
- The first Kilo sign-in creates its plugin route and first key; Z.AI joins an adopted route as one more pool row, and neither writes a `llm-pi-ai` grant.
