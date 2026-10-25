# Changelog

All notable changes to dsh-keys-manager are documented here. Assembled from `.changes/unreleased/` fragments by the release-prep workflow.

## [0.2.9] - 2026-10-25

### Fixed

- Read a provider card's plan usage from the credential that actually serves the route: an OAuth account managed natively by DSH no longer shows "sign in again" (and no longer re-prompts after a successful sign-in), and when that credential is unreadable the row says "managed by DSH" instead of pretending the provider reports no usage.

### Changed

- Plan usage now renders as one muted line at the bottom of each key or account row (`W 61% · 5h 32% · 3 天后重置`) instead of a separate block on the provider card, so the card no longer grows a usage section.
- A route that cannot report usage shows nothing at all — no block, no line, no placeholder; the "sign in again" note stays for an OAuth account whose grant needs renewing.
- Usage coverage now includes Command Code, xAI SuperGrok and Cline, alongside Claude, Codex, Z.AI, Kimi, MiniMax and OpenCode Go.

## [0.2.8] - 2026-10-24

### Changed

- Name all seven transport routes in the known limits, and stop describing `factory-droid` as deferred.
- Restructure both READMEs into grouped capability areas with comparison tables for accounts, transport routes and failure policy; the extra-provider catalog stays as a folded list.
- Regroup provider coverage into four groups — DSH built-in, plugin extra built-in, OAuth accounts and transport routes — with the supported and not-pooled lists folded into two details blocks; `kilo` and `zai` are OAuth accounts signed in by the plugin's bundled clients, not a separate category.
- Bump the `@oh-my-pi/*` build-time pin from 18.12.3 to 18.12.6 (whole cohort: pi-ai, pi-catalog, pi-utils, pi-natives, pi-wire, omptype) and regenerate the pi-ai patch; the cursor exec-frame handoff patch body is unchanged.

### Fixed

- Restore the `legacy-tier` case in the Google transport note — the README now names both `legacy-tier` and paid accounts that must set `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID`.
- Cursor route: native `shell` (batch and streamed), `mini_swe_agent_bash`,
- The handoff translation into DSH's tool schemas is lossy: every `GrepArgs`
- The pinned `@oh-my-pi/pi-ai@18.12.3` is now patched via
- A transport route with no stored credential no longer appears in DSH's model picker or the Settings → Models provider list; the route's provider card and sign-in entry stay on the Keys Manager page.

### Added

- Show each managed account's plan usage on its provider card: a compact one-line hint when collapsed, and an expanded strip with one thin bar per window (session and weekly), the used percentage and the reset countdown.
- Quota reads are pull-only, cached in memory with TTL jitter and failure backoff, and never touch key selection or cooldown; a provider whose plan cannot be read shows "not reported" (or "sign in again" on a stale OAuth account) instead of a zero bar.

## [0.2.7] - 2026-10-24

### Changed

- The published transport package's API docs and the root README (EN/ZH) now name every route the transport registers — all seven (`cursor`, `devin`, the two Google routes, `factory-droid` and the two GitLab Duo routes) — instead of claiming a Cursor-only plugin or four routes, so a reader sees the surface the package actually serves.
- An unmanaged extra provider's account button now shows a "signing in" label instead of "Adopting…" while it starts a sign-in, matching a path that never adopts.
- The static-bearer transport docs (README and known limits, EN/ZH) now say a grant with no expiry shows no expiry time and no countdown, matching the blank expiry cell instead of claiming there is no expiry line.
- A concurrent credential refresh no longer reports a missing credential for a healthy GitLab or Factory Droid account: the losing request now reads the refresh the winner already committed instead of failing.
- The model picker now projects the `gitlab-duo` (16 rows) and `gitlab-duo-agent` (1 row) catalogs: this plugin's route-to-accessor table was missing the two GitLab entries, so both routes reported a missing catalog and offered no models even though the transport package ships them.
- Bump the `@deepseek-ai/dsh-*` peer cohort to `^0.2.1-rc.3` (corridor `dsh-v0.2.1-rc.2` → `dsh-v0.2.1-rc.3`: More menus for browsing/creating plugins; New Session draft fix after switching sessions; DeepSeek API-key adapter model-list updates aligned with account sign-in). Session format v4 unchanged. README DSH badges follow.

### Added

- Add the bundled `factory-droid` transport (`lib/omp/factory-droid.mjs`, 200 modules / ~2.0 MB) with a 62-row catalog generated from the pinned KDL registry seed, a WorkOS device-code sign-in, a refreshing credential record and a configurable `providers.factory-droid` allow-list. Three entry-scoped build substitutions (empty catalog data, a verbatim lean provider registry, a lean env-key map) keep the artifact small; the stripped env-key map is documented in `packages/llm-omp/docs/known-limits.md`.
- Add the bundled `gitlab-duo` proxy transport (`lib/omp/gitlab-duo.mjs`, 231 modules / 2.65 MB) over GitLab's AI gateway, with a 16-row alias catalog (upstream id + wire + compat per row), OAuth sign-in with PKCE on a loopback `localhost:8080/callback` (no port fallback, paste as the fallback path), and a refreshing credential record. `GITLAB_CLIENT_ID`/`GITLAB_REDIRECT_URI` register a custom app and `GITLAB_TOKEN` works as the bearer.
- Add the bundled `gitlab-duo-agent` Duo Workflow transport (`lib/omp/gitlab-duo-agent.mjs`, 118 modules / ~1.0 MB) with a one-row static catalog, paste-only `vscode://` sign-in, and a fresh per-request workflow seed so each turn replays the goal transcript through DSH's native tool loop.
- Register all three routes with their five sibling-shaped surfaces: a Models-page entry (`declared: false`, `providers.<route>`), a catalog projection for host pickers (`factoryDroidCatalogModels()`, `gitlabDuoCatalogModels()`, `gitlabDuoAgentCatalogModels()`), a lazy artifact load (`TRANSPORT_UNAVAILABLE` at request time), and one credential record per route at `llm-omp-transports/<route>`. Factory Droid also forwards the stored account scope to the transport as `oauthIdentity`.

## [0.2.6] - 2026-10-24

### Added

- Add the bundled `lib/omp/google.mjs` artifact: omp's Gemini Cloud Code Assist provider, shared by the `google-gemini-cli` and `google-antigravity` routes and dispatching on `model.provider`, with a manifest entry, pinned source hashes and a calibrated size ceiling.
- Add the generated Google model tables (`google-gemini-cli`, `google-antigravity`) and their `googleGeminiCliCatalogModels()` / `googleAntigravityCatalogModels()` projections for host-side model pickers.
- Add the `google-gemini-cli` and `google-antigravity` sign-in flows: a loopback listener on `127.0.0.1` (port fallback to an ephemeral port, five-minute bounded wait, abort-safe), a paste fallback, Cloud Code Assist project discovery and a single-window token refresh that preserves the project and an un-rotated refresh token.
- Register both Google routes: configurable `providers.google-gemini-cli` / `providers.google-antigravity` allow-lists, catalog-model exports for host pickers, and lazy loading of the shared `lib/omp/google.mjs` artifact (a missing build reaches the request as `TRANSPORT_UNAVAILABLE`, never a failed start).
- Project the transport package's model catalogs into the Keys Manager model picker for the `google-gemini-cli`, `google-antigravity` and `factory-droid` routes, each from its own catalog export.
- A transport build that registers one of these routes without shipping its catalog reports the missing catalog in the picker's response instead of showing an unexplained empty model list.

### Fixed

- Fix the Cursor route's file and shell tools: DSH tools whose names collide with Cursor's native exec channel (`read`, `bash`, `write`, `delete`, `ls`, `grep`, `todo`) are advertised as `dsh_<name>` so the transport keeps them in its MCP tool list; the event stream restores the DSH name on the tool call, while history replay keeps the advertised `dsh_<name>` alias so the follow-up request matches. The seven `dsh_<native>` names are reserved: declaring a DSH tool under one fails the request with `TOOL_ALIAS_COLLISION` instead of being silently resolved.

## [0.2.5] - 2026-10-23

### Added

- Sign in to Kilo and Z.AI (GLM Coding Plan) from Keys Manager: Kilo polls a device-code page, Z.AI opens a browser URL and accepts the pasted redirect URL or code.
- Both sign-ins mint a static credential stored as an ordinary key row (`signin:kilo` / `signin:zai-coding-plan`); Sign in again replaces that row's literal in place.
- The first Kilo sign-in creates its plugin route and first key; Z.AI joins an adopted route as one more pool row, and neither writes a `llm-pi-ai` grant.
- Add the `devin` transport route: a second omp-backed artifact (`lib/omp/devin.mjs`) speaking Devin's Connect-framed chat protocol, with its own generated catalog (`swe-1-6`, `swe-1-6-fast`), manifest entry, drift gate and calibrated size ceiling.
- Add the `llm-omp-transports/devin` sign-in flow: PKCE authorize page plus a paste-the-callback prompt (the pinned loopback listener is Bun-only), a token exchange and a static bearer with a derived `expires`; there is no refresh.
- Register the Devin adapter, its Models-page profile, `providers.devin.models` allow-list and provider info beside Cursor's, sharing one route-parameterised adapter and projection.
- Fill DSH attribution headers only where a request left them absent, so Devin's chat call keeps its required `connect-go` client identity while the header-less `GetUserJwt` handshake still carries the harness `user-agent`.

### Fixed

- Document the `devin` transport route in the root README (EN/ZH): paste-only sign-in, no refresh token, unverified endpoints, and the corrected "one grant per route" wording.
- Root known limits now name Kilo and Z.AI Coding Plan as in-process sign-in routes and state the transport `expires` contract per resolver.
- The sign-in dialog masks a pasted authorization code (Z.AI and Devin) behind a reveal toggle, resets the reveal on every new prompt, and uses `autocomplete="new-password"` so a saved password is never filled in.
- A transport grant with a usable token and no `expires` stays `active` on the Devin route with no expiry cell, while the Cursor route (which needs a dated grant) reports `needs-reauth`.
- A transport route whose installed build ships no model catalog now reports it once in the state warnings instead of showing an empty model list without explanation.
- Signing in to Kilo seeds the route from the plugin catalog instead of waiting for endpoint model discovery before the key row appears.
- The model picker explains an empty catalog instead of rendering a bare empty list when the installed transport build ships no catalog for the route; Save is off until the catalog exists.
- Adopting a catalog route that has no Models profile now creates one from the installed catalog, so the connection test and the Models page can select the route's models instead of refusing with "no settings profile yet".

## [0.2.4] - 2026-10-22

### Fixed

- A per-key connection test against a healthy provider reports success again (a one-token answer ends with `max-tokens`, which is a completion), and a failed re-authentication no longer deletes the grant record its surviving account row references; an account whose grant record was lost is now healed on the read path (activation or a connection test) from the route's live projection, instead of staying unusable.
- Cursor now appears as a configured provider wherever providers are listed (DSH Models, fallback chains, third-party plugins), and its transport card gains a collapsible model picker that narrows the route to the selected catalog models; an empty selection keeps the full catalog.
- The transport model picker fails closed when the settings store cannot be read: it reports the read error with a Retry action and keeps Save disabled, instead of showing the all-models state whose one save would have cleared a narrowed selection; a stored model id the shipped catalog no longer offers is filtered out of the picker so the remaining selection still saves.

## [0.2.3] - 2026-10-22

### Added

- The provider list gains five single-select quick filters — All, Built-in, Plugin, OAuth-capable and Transport — that narrow the managed and available lists and compose with the existing search.
- OAuth-capable uses the same verdict as a row's Add account button, so it lists exactly the routes that can start a sign-in right now.
- The chosen filter also governs the transport accounts section, which appears under All and Transport; with Transport selected and no accounts it stays visible with a `0` count and the existing empty copy.
- The quick-filter chips show a visible focus ring, the row is announced as a labelled group, the unattributed count keeps its number in its accessible name, and an empty transport list says so instead of reusing the search-empty copy.

### Fixed

- A transport-plugin route (Cursor) now renders as a plugin Transport provider card and can no longer be adopted, key-bound or tested as a pi-ai provider; its account controls moved into that card.
- A transport account whose route id collides with an ordinary provider's id keeps its row (and its only sign-in/remove control) instead of being treated as card-owned by a card that never rendered it.
- Activating an account no longer holds the global mutation queue while it reads the OAuth credential, so a slow credential store cannot delay unrelated key or settings changes; the activation's errors, returned state and cooldown reset are unchanged.
- An activation now writes its credential projection only while the route still serves the value it read, and never deletes a grant another writer replaced. A rejected state flush puts the projection back — removing it only when the activation created it — so a refused activation leaves nothing behind.
- A refused activation restores the route's owner classification along with the projection it puts back, so requests keep using the restored credential and failures keep attributing to it instead of falling back to the key pool; the activated account keeps its claim whenever its projection is still serving.
- Provider rows show an `Unattributed` count for stream attempts a route served with no account owner — whether its ownership read had not landed yet or had failed — and the count clears once a later read attributes the route. A failover retry is a new attempt, so one request can be counted more than once.
- A request waiting on ownership hydration no longer keeps the process alive for the rest of the bounded wait.

### Changed

- Release notes are now assembled from authored `.changes/unreleased/` fragments instead of `git log` subjects, and a release with no changelog bullets is refused.
- Backfill `CHANGELOG.md` for 0.1.0–0.2.2 with authored notes; earlier sections listed merge subjects.

## [0.2.2] - 2026-10-21

### Added

- Extra providers can declare environment-sourced request headers; values are read from your environment when the provider is added and refused loudly when missing, blank or credential-bearing.
- `coreweave` joins the catalog through that carrier with `COREWEAVE_API_KEY` and `COREWEAVE_PROJECT` for its `OpenAI-Project` header, and providers with declared headers use their seed catalog instead of model discovery.
- Changing the environment later surfaces as a state warning, and removing the provider drops only the header value it set.
- New published component `dsh-llm-omp-transports` serves Cursor through DSH's LLM seam: text and reasoning deltas, usage before a single finish, finish kinds, error classification and abort.
- Tool calls are projected from DSH into the transport and unresolved calls hand off to DSH's tool loop; transport-resolved native frames are not re-dispatched.
- Cursor sign-in uses a PKCE flow with poll and refresh, and a generated 123-row model table comes from a pinned catalog.
- The install now mounts two components (the plugin detail page lists both), and the keys manager lists, activates, removes and re-authenticates the resulting Cursor accounts beside the pi-ai pool.
- Key and account rows gain a Test action that runs one real request through the LLM seam and reports whether that credential serves the route, without touching health, cursor or binding state.

### Changed

- Release prep drives both published packages from one version input: the resolved version is written to both manifests with both tags, and a transport manifest that disagrees with it is refused.

### Fixed

- An OAuth-served route no longer fails with `MISSING_CREDENTIAL`: a broker reference is written only while the key pool actually serves the route, so pi-ai can reach its own grant, and a broken binding left by an earlier version is healed at startup.
- A login harvest that aborts because the attempt already settled now demotes the pi-ai projection it had written, so the route stops serving a superseded grant instead of staying bound to it.

### Docs

- README documents the Desktop/Web install path.
- README lists the extra providers in a collapsible table.

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
