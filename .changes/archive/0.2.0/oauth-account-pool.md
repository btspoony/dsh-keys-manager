---
category: Added
---
- OAuth accounts are pool members beside keys for Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex, OpenRouter, Radius and xAI: each provider card offers "Add account" next to "Add key".
- Account rows show the signed-in identity, status (active, cooling, paused, missing), last-used time and counters, with activate, re-authenticate and remove actions.
- Sign-in runs through the DSH authorization seam, bridging device-code and paste prompts into the plugin dialog.
- Accounts inherit sticky, round-robin, failover and cooldown behaviour; a failing account cools down and the provider falls back to its key pool, and re-activating the account restores it.
- Refresh rotations upstream are synced back into the owning account, and grant tokens stay in the DSH credential store: the manager keeps references and identity metadata only.
