# Changelog

All notable changes to dsh-keys-manager are documented here. Assembled from `.changes/unreleased/` fragments by the release-prep workflow.

## [0.2.2] - 2026-10-21

### Added

- Extra providers can declare environment-sourced request headers; values are read from your environment when the provider is added and refused loudly when missing, blank or credential-bearing.
- `coreweave` joins the catalog through that carrier with `COREWEAVE_API_KEY` and `COREWEAVE_PROJECT` for its `OpenAI-Project` header, and providers with declared headers use their seed catalog instead of model discovery.
- Changing the environment later surfaces as a state warning, and removing the provider drops only the header value it set.
- New published component `dsh-llm-omp-transports` serves Cursor through DSH's LLM seam: text and reasoning deltas, usage before a single finish, finish kinds, error classification and abort.
- Tool calls are projected from DSH into the transport and unresolved calls hand off to DSH's tool loop; transport-resolved native frames are not re-dispatched.
- Cursor sign-in uses a PKCE flow with poll and refresh, and a generated 123-row model table comes from a pinned catalog.
- The install now mounts two components (the plugin detail page lists both), and the keys manager lists, activates, removes and re-authenticates the resulting Cursor accounts beside the pi-ai pool.

### Fixed

- An OAuth-served route no longer fails with `MISSING_CREDENTIAL`: a broker reference is written only while the key pool actually serves the route, so pi-ai can reach its own grant, and a broken binding left by an earlier version is healed at startup.
- Key and account rows gain a Test action that runs one real request through the LLM seam and reports whether that credential serves the route, without touching health, cursor or binding state.
- A login harvest that aborts because the attempt already settled now demotes the pi-ai projection it had written, so the route stops serving a superseded grant instead of staying bound to it.

### Docs

- README documents the Desktop/Web install path and lists the extra providers in a collapsible table.

### Changed

- Release prep drives both published packages from one version input: the resolved version is written to both manifests with both tags, and a transport manifest that disagrees with it is refused.

## [0.2.1] - 2026-10-20

### Fixed

- The plugin declares `authorization` in its inject list, so loading no longer fails with `cannot get property "authorization" without inject`.

## [0.2.0] - 2026-10-20

### Added

- OAuth accounts are pool members beside keys for Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex, OpenRouter, Radius and xAI: each provider card offers "Add account" next to "Add key".
- Account rows show the signed-in identity, status (active, cooling, paused, missing), last-used time and counters, with activate, re-authenticate and remove actions.
- Sign-in runs through the DSH authorization seam, bridging device-code and paste prompts into the plugin dialog.
- Accounts inherit sticky, round-robin, failover and cooldown behaviour; a failing account cools down and the provider falls back to its key pool, and re-activating the account restores it.
- Refresh rotations upstream are synced back into the owning account, and grant tokens stay in the DSH credential store: the manager keeps references and identity metadata only.

### Docs

- The install documentation states that a registry install ships a prebuilt tarball and runs no build on your machine, while the clone/link path builds during `pnpm i`.
- The per-language documentation links moved into each README's Documentation section; no link changed target.

## [0.1.0] - 2026-10-19

### Added

- Twelve extra API-key providers from oh-my-pi are available as ordinary `llm-pi-ai` routes: siliconflow, siliconflow-cn, litellm, charm-hyper, zhipu-coding-plan, alibaba-token-plan, abliteration, cline-pass, commandcode, firepass, yolo-auto, and ollama-cloud.
- An extra provider is added with its API key, shows a seed model list until runtime discovery overrides it, and is released back to the plain route when removed.
- Several API keys per provider, each with an alias and a health state, instead of one shared key.
- Each session is pinned to one key, with round-robin selection for new sessions.
- A failed request retries on the same key within a bounded budget, then fails over to another key.
- A failing key cools down exponentially, capped at seven days, and returns to the rotation on its own.
- The plugin detail page gains a search-driven manager, and the existing model cards show a "managed by Keys Manager" badge.

### Fixed

- Retry pins expire after 60 seconds, and starting a new step no longer deletes another in-flight step's pin.
- Request-step records are keyed to the provider the request finally uses, and unmanaged providers are skipped before anything is recorded.

### Docs

- README rebuilt around a quick start, the two supported install paths (`dsh plugin --profile web add` and clone plus `dsh plugin --profile web link .`), the provider table and the managed-state notes, with a full Chinese translation.
- Development, release and known-limit pages moved to `docs/` in both languages, and the known limits for concurrent steps, ambient request identity and purpose-scoped streams are stated instead of implied.
