# dsh-llm-omp-transports

A DeepSeek Harness LLM transport component for providers whose wire protocols
the vendored `llm-pi-ai` does not speak. It is published from this repository
as `dsh-llm-omp-transports` and installed as a dependency of
`dsh-keys-manager`: installing the Keys Manager plugin brings this component,
and the plugin page lists both bundle components
(`dsh-keys-manager` and `llm-omp-transports`).

| Fact | Value |
|---|---|
| npm package | `dsh-llm-omp-transports` |
| Plugin id | `llm-omp-transports` |
| Routes | `cursor`, `devin`, `google-gemini-cli`, `google-antigravity`, `factory-droid`, `gitlab-duo`, `gitlab-duo-agent` (the seam is provider-generic) |
| Credential scope | `llm-omp-transports/<provider>` — one record per route (`cursor`, `devin`, `google-gemini-cli`, `google-antigravity`, `factory-droid`, `gitlab-duo`, `gitlab-duo-agent`) |
| Runtime | Node 24 (the bundle imports Node builtins only) |
| License | MIT |

The plugin registers its own route on the DSH `llm` seam, so it depends on no
upstream DSH change. `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-catalog` are used at
**build time only**: the build inlines the pinned omp transports into one ESM
artifact per route (`lib/omp/cursor.mjs`, `lib/omp/devin.mjs`), plus one shared
artifact for the two Google routes (`lib/omp/google.mjs`), and the published
package imports nothing from `@oh-my-pi/*` or `bun:*` at runtime.

## Cursor support status

- **Text streaming** — yes. Assistant text and usage are projected onto DSH's
  `StreamChunk` stream.
- **Reasoning streaming** — yes, with the catalog's effort routing. The
  selected effort becomes the routed wire model id; an effort the model does
  not advertise is refused with `UNSUPPORTED_REASONING_EFFORT`.
- **Tool-call handoff** — yes, through DSH's tool loop. Cursor's server drives
  execution over its exec channel, so the transport runs in external-executor
  mode: an unhandled MCP call is emitted as an unresolved tool call and
  answered with a handoff, DSH runs the tool, and the next request replays the
  result from history. The adapter never executes a tool itself.
- **Sign-in and refresh** — yes. The package registers the
  `llm-omp-transports/cursor` authorization flow (a browser login page plus a
  poll, no loopback callback and no device code) and refreshes an expiring
  grant under the credential store's per-key lock. The Keys Manager Web page's
  **Transport accounts** section is the surface that starts the flow.
- **Models** — from the pinned catalog: the Cursor slice of
  `@oh-my-pi/pi-catalog@18.12.3` (123 rows) is generated into
  `src/catalog/cursor.ts` and served without a network call.
- **Route** — `cursor`, declared configurable so the Models page has a profile
  entry for it.
- **Images** — not yet. The route advertises text-only input and refuses image
  blocks with `CONTENT_UNSUPPORTED`; see [known limits](docs/known-limits.md).

## Devin support status

- **Text streaming** — yes. Assistant text and reasoning are projected onto
  DSH's `StreamChunk` stream, with the per-turn usage the chat frames report.
- **Reasoning streaming** — yes as content; no reasoning-effort selector. Both
  pinned rows advertise no efforts, and a request that selects one is refused
  with `UNSUPPORTED_REASONING_EFFORT`.
- **Tool-call handoff** — yes, native to DSH's tool loop. The transport emits
  the call, finishes the turn `toolUse`, and DSH executes it; the result is
  replayed from history on the next request. Unlike Cursor, no call is
  transport-resolved, so nothing is filtered from the handoff.
- **Sign-in** — yes, by pasting the callback. The pinned omp login is a
  declarative `oauth-code` rule whose loopback listener is Bun-only; this
  package registers the `llm-omp-transports/devin` flow, opens the authorize
  page, and asks for the address the browser landed on (or just the code).
  There is **no refresh** (`refresh "none"`): an expired grant demands a new
  sign-in.
- **Models** — from the pinned catalog: the Devin slice of
  `@oh-my-pi/pi-catalog@18.12.3` (2 rows: `swe-1-6`, `swe-1-6-fast`) is
  generated into `src/catalog/devin.ts` and served without a network call.
- **Route** — `devin`, declared configurable so the Models page has a
  `providers.devin` profile with an allow-list.
- **Images** — not yet, same as Cursor: text-only input, image blocks refused
  with `CONTENT_UNSUPPORTED`.

## Google support status

Two routes share one artifact: `google-gemini-cli` (Google's Gemini CLI client)
and `google-antigravity` (the Antigravity hub client). The bundled
`streamGoogleGeminiCli` dispatches on `model.provider`, so the route is a data
difference — separate OAuth client, catalogs, hosts, scopes and credential
records — not a second code path.

- **Text streaming** — yes, including reasoning parts and usage.
- **Reasoning streaming** — yes, with each row's own effort ladder: the
  budget-mode rows send `thinkingConfig.thinkingBudget`, the Gemini-3+ rows send
  `thinkingLevel`. A row with `requiresEffort` refuses a turn that selects no
  effort (`UNSUPPORTED_REASONING_EFFORT`), exactly as omp does.
- **Tool-call handoff** — yes, native to DSH's tool loop, like Devin: the
  transport emits the call and finishes the turn `toolUse`. Antigravity's
  default tool mode (`VALIDATED`) is sent on every request that declares tools.
- **Sign-in** — yes, with a real loopback listener on `127.0.0.1`:
  `:8085/oauth2callback` for Gemini CLI and `:51121/oauth-callback` for
  Antigravity, as the pinned rules declare. The browser redirect completes the
  flow automatically; if the port is taken the listener falls back to an
  ephemeral port and the authorize page names the port it actually bound. The
  full address the browser landed on (or `code#state`) can also be pasted; a
  pasted code without the state is refused, because that is exactly the shape a
  forged callback would have. Anything the listener does not recognise — a
  foreign `state`, an `error=`, a missing code — is answered `400` and dropped
  without ending the attempt, so a stray request cannot kill the sign-in. The
  listener closes on the matching callback, on an aborted attempt and **on a
  timeout** (five minutes, `GoogleFlowOptions.waitMs` for tests): an expired wait
  fails with `AUTH_FAILED` and commits nothing.
- **Refresh** — yes. The resolver refreshes once, under the credential store's
  per-key lock, when `expires - 60 s <= now`, keeps the `projectId` and an
  un-rotated `refresh_token`, and reports a dead sign-in as `REAUTH_REQUIRED`.
- **Credential record** — `llm-omp-transports/<route>` with
  `{access, refresh, expires, projectId, email?}`. The adapter hands the
  transport the structured JSON envelope (`token`, `projectId`, `refreshToken`,
  `expiresAt`, `email`) that omp parses.
- **Project discovery** — sign-in finishes with the Cloud Code Assist project:
  `loadCodeAssist` → (tier onboarding `onboardUser` + LRO poll, or the required
  `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` variable for a
  `legacy-tier`/paid account). Antigravity additionally checks free-tier
  eligibility and bounds onboarding at 30 s.
- **Models** — generated from the pinned `@oh-my-pi/pi-catalog@18.12.3`: 7 rows
  for `google-gemini-cli`, 22 for `google-antigravity`, served without a network
  call.
- **Routes** — both declared configurable, so the Models page has
  `providers.google-gemini-cli` and `providers.google-antigravity` allow-lists.
- **Images** — not yet, same posture as the other routes: text-only input, image
  blocks refused with `CONTENT_UNSUPPORTED`. omp's Antigravity image path
  decodes through `Bun.Image`, which does not exist under Node, so that path is
  dead here by construction; the projection never reaches it.

## Factory Droid support status

- **Text streaming** — yes, including reasoning parts and usage.
- **Wires** — four protocols behind one proxy, selected by the model **id** inside the
  artifact (Anthropic Messages for Claude rows, the Responses API for GPT/Grok, Chat
  Completions for Kimi/GLM/DeepSeek, native generateContent for Gemini). The plugin never
  chooses a backend, and rows carry no base URL: the transport derives the per-wire proxy
  path and honours the account's residency host.
- **Sign-in** — WorkOS **device code**: the flow shows the verification page and the user
  code, the human approves in the browser, and the poll completes the grant. No listener and
  no paste; the attempt's own signal is the only cancellation channel.
- **Refresh** — yes: one refresh inside a 60 s window under the credential store's per-key
  lock, keeping the account scope (`orgId`/`region`/`inferenceRegion`), which the adapter
  forwards to the transport as `oauthIdentity` so a EU account gets its own host.
- **Catalog** — 62 rows from the KDL registry seed (`models.json` has no factory-droid key),
  zero-cost Factory credits.
- **Build** — the graph needs three **entry-scoped build substitutions** (empty catalog data,
  a lean provider registry, a lean env-key map) to fit its ceiling; see the limits below.

## GitLab Duo support status

Two routes over GitLab's AI surface, both registered from one catalog pin.

**`gitlab-duo` (proxy).** The transport POSTs for a direct-access token, substitutes the
row's `upstreamModelId` and delegates to one of three generic wire transports
(Anthropic Messages, OpenAI Responses, Chat Completions) through GitLab's gateway.

- 16 catalog rows carrying the upstream id, the wire and the full compat object.
- **Sign-in** — OAuth code with PKCE, the loopback listener on `localhost:8080/callback`
  **without port fallback** (the redirect is registered exactly) and a paste prompt as the
  fallback path. `GITLAB_CLIENT_ID`/`GITLAB_REDIRECT_URI` support a custom OAuth app, and a
  `GITLAB_TOKEN` personal access token works as the bearer.
- **Refresh** — one refresh inside a 60 s window; the artifact's direct-access token cache
  is keyed on the GitLab token, so a rotated token misses it by construction.

**`gitlab-duo-agent` (Duo Workflow).** One WebSocket workflow per turn; GitLab's
server-side loop yields at every tool call, so DSH's native tool loop executes them and the
next turn replays the result through the goal transcript.

- 1 static row (`claude_sonnet_4_6_vertex`, 1M context); live model discovery is not
  implemented, and the server may pin another model on its side.
- **Sign-in** — paste-only: the browser hands the code to VS Code, so the human pastes the
  full `vscode://gitlab.gitlab-workflow/authentication?code=…&state=…` URL. The state is
  mandatory (no listener means it is the only thing tying the paste to the attempt), and a
  refresh echoes the `vscode` redirect.
- **Session state** — a fresh map per request (plan A6): each turn re-seeds a workflow and
  replays the transcript instead of resuming another turn's socket. Correct but heavier;
  sticky resume is a follow-up.

## Hard constraints

- **Pinned, build-time-only omp.** `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-catalog`
  are pinned to `18.12.3` and declared as devDependencies. No runtime package
  may import them: `tests/build.test.ts` checks that every static import of the
  shipped artifact is a Node builtin.
- **Node 24 load.** The artifact is imported through a plain Node ESM loader
  with no Bun global present, and must expose `streamCursor`. The Bun and
  `@oh-my-pi/pi-utils` surface the bundled graph reaches is covered by the
  shims in `scripts/omp-shim/`; a missing shim symbol or a new shim category
  fails the build.
- **Drift gate.** `scripts/omp-manifest.json` records the pinned versions, the
  measured artifact, the shim surface and the hashes of every source the
  transport depends on, plus the shim symbols the esbuild graph actually
  reaches. `tests/build.test.ts` re-checks all of it, and CI asserts the
  committed manifest is unchanged after a build, so an omp bump that changes
  the contract shows up as a reviewable manifest diff before it can reach a
  request.
- **Generated catalogs.** The model tables (`cursor`, `devin`,
  `google-gemini-cli`, `google-antigravity`) are generated from the pinned
  catalog and are not hand-edited. An omp or catalog bump requires
  `pnpm -C packages/llm-omp run generate:catalog`.

## Limits and risks

- **Unofficial Cursor client.** The transport reuses Cursor's vendor-internal
  OAuth client id and announces a released CLI build through the
  `x-cursor-client-version` / `x-cursor-client-type` request identity. The MIT
  license covers the code, not the service, so relying on this client carries a
  terms-of-service (ToS) risk. If Cursor gates non-IDE clients (a `401`/`403`
  on `Run` with a valid account), this transport stops until the product
  decision recorded as stop condition **S4**.
- **Real endpoints unverified.** The login, poll, refresh and agent endpoint
  shapes are ported from the pinned omp sources; this repository's tests replay
  recorded fixtures and never call Cursor, so live behavior is unverified until
  it is exercised against a real account.
- **In-process checkpoint cache.** Per-conversation checkpoints live in a
  module-level, in-process LRU (128 conversations) inside the bundled omp
  transport. Nothing is persisted: an evicted or lost checkpoint rebuilds from
  the request history, exactly like the first request after a restart, and a
  multi-step tool turn must replay its history.
- **Image input is advertised as text-only.** Forwarding is future work; until
  it lands the projection refuses non-text blocks instead of silently dropping
  them. 100 of the pinned catalog's 123 rows claim image support but are
  advertised text-only.
- **Tool handoff uses DSH's external-executor mode.** A turn that needs a tool
  stops at the handoff; the result is only replayed on the follow-up request.
  Tool declarations travel as MCP definitions, and `toolHistory` is accepted
  but cannot be replayed (the active tool set is the projection).
- **Colliding DSH tools are aliased, not dropped.** The transport keeps
  Cursor's own `read`/`bash`/`write`/`delete`/`ls`/`grep`/`todo` names off the
  MCP advertisement, so a DSH tool with one of those names is advertised as
  `dsh_<name>`; the event stream restores the DSH name on the tool call, while
  history replay keeps the advertised alias so the follow-up request stays
  consistent. The seven `dsh_<native>` names are reserved: a DSH tool that
  already carries one is refused with `TOOL_ALIAS_COLLISION`, which fails the
  whole request and requires renaming the tool. Any other tool name travels
  unchanged. Cursor-native exec frames (`read`, `shell`, `write`, `delete`,
  `grep`, `ls`, `diagnostics`, streamed edits) are still answered by the
  transport with `Tool not available` and are **not** executed by DSH (live
  reachability unverified).
- **Advisory request knobs are ignored.** Cursor's agent protocol has no field
  for an output cap, sampling temperature, stop sequences or an auxiliary-call
  purpose; DSH's `maxTokens`, `temperature`, `stop` and `purpose` never reach
  the wire, and Cursor applies the catalog output limit server-side.
- **Unofficial Devin client.** The transport presents the released Devin CLI
  identity (`ideName: "devin-cli"`, `ideType: "chisel"`, `ideVersion:
  "3000.11.3"`) and a `connect-go` client header the omp sources copy from the
  CLI. Same posture as Cursor's S4: a first live turn rejected with `401`/`403`
  stops the route until a product decision, never a retry under another
  identity.
- **Attribution deviates on one call.** The Devin chat request must keep the
  transport's own `connect-go` client header — the backend gates on it. The
  header-less `GetUserJwt` handshake has no identity of its own, so the adapter
  fills DSH's attribution `user-agent` only where a header is absent. Cursor's
  requests keep full attribution.
- **Devin has no refresh.** The pinned rule declares `refresh "none"`, so the
  record is a static bearer with a derived `expires` (JWT `exp` minus five
  minutes, else one year). An expired or corrupt record is `REAUTH_REQUIRED`,
  not renewed. Because the omp loopback listener is Bun-only and the browser
  half is untestable offline, the flow is paste-only for now; a bare pasted
  code skips the state check (the page is the only place the state could
  travel).

- **The Factory Droid artifact strips the registry-derived env-key map.** Its graph would
  otherwise pull omp's whole provider registry, so one entry-scoped substitution keeps the
  pin's `getEnvApiKey` but not the `PROVIDER_REGISTRY` half — the computed Foundry/ADC/Bedrock
  resolvers are gone. That path is unreachable for this route (every request carries the
  stored WorkOS token), and a catalog-declared plain variable (`OPENAI_API_KEY`, …) still
  resolves. The install id is per-process rather than persisted for the same reason: the
  transport must not write to a user's home.
- **Unofficial Google clients.** The Google routes reuse the OAuth clients and
  client identities the pinned omp rules capture — Gemini CLI
  (`GeminiCLI/0.46.0/...` plus `Client-Metadata`) and Antigravity
  (`antigravity/hub/<version> ...`). Same posture as the Cursor and Devin
  routes: the MIT license covers the code, not the service, and a first live
  turn rejected with `401`/`403` on a valid token stops the route until a
  product decision (stop condition **S4**) — never a retry under another
  identity.
- **Antigravity version lookup.** Before the first Antigravity request the
  artifact reads the client version from the public update manifest (D11),
  because the backend gates newer models on that version. A failed lookup is
  silent and falls back to the pinned `2.19.1` for ten minutes; an explicit
  `PI_AI_ANTIGRAVITY_VERSION` skips the lookup. That is the only outbound
  request the routes make besides the vendor API itself.
- **Google sign-in waits at most five minutes.** The loopback listener is
  bounded by a wait budget (five minutes by default): a browser that never
  returns fails the attempt with `AUTH_FAILED`, closes the socket and commits
  nothing. An aborted attempt is reported as a cancellation, not a failure.
  When the configured port is taken, the fallback is an ephemeral port; a host
  that can bind neither fails the sign-in rather than silently dropping the
  browser half (pasting still works only while the listener is up).
- **Google attribution deviates on both routes.** The Cloud Code Assist wire
  sets a vendor `user-agent` that the backend gates on, so DSH's attribution
  `user-agent` is filled only where a request left the header absent — the same
  fill-absent wrapper the Devin handshake uses.
- **Real Google endpoints unverified.** The wire suite drives the bundled
  transport end to end over a stubbed `fetch` (URL, envelope, headers, SSE,
  in-band errors, Antigravity failover and the version manifest), but it never
  calls Google. A first live sign-in and turn is a manual smoke check, not a
  claim of server acceptance.

## Develop and test

```sh
pnpm -C packages/llm-omp typecheck
pnpm -C packages/llm-omp build
pnpm -C packages/llm-omp test
pnpm -C packages/llm-omp run generate:catalog
```

`build` bundles the pinned omp graphs from `scripts/omp-entry.ts`,
`scripts/omp-entry-devin.ts` and `scripts/omp-entry-google.ts` into
`lib/omp/cursor.mjs`, `lib/omp/devin.mjs` and `lib/omp/google.mjs` and rewrites
`scripts/omp-manifest.json`; run it before `test` after a pin or shim change. CI runs the same sequence and then fails if
the committed manifest drifted.

The install proof lives at the repository root and needs `pnpm` and `dsh` on
`PATH`:

```sh
node scripts/verify-install.mjs
```

It packs both packages, installs the root tarball into a fresh DSH profile,
and asserts that the composed profile carries both loader rows
(`dsh-keys-manager` and `llm-omp-transports`). It does not exercise the
plugin-manager UI or any provider network behavior.

## Release

This package is released from the same release PR and carries the same version
as `dsh-keys-manager`; the root `CHANGELOG.md` and its generated sections cover
the root package only. A release-prep run writes one version to both
`package.json` files, and the Release workflow publishes both and pushes the
`dsh-llm-omp-transports@<version>` tag.
The root [release docs](../../docs/release.md) describe the full flow.

Package documentation is English-only; the root `README.md` /
`README.zh-CN.md` and the root `docs/*.zh-CN.md` files carry the bilingual
plugin surface.

## License

Released under the [MIT License](../../LICENSE).

- **The GitLab Duo proxy is the largest artifact.** It bundles three production wire
  transports plus GitLab's gateway shim, which is why its ceiling is the package's highest;
  the same entry-scoped substitutions keep the model catalog and the builtin registry out.
- **Duo's Anthropic inner wire is not proven end-to-end in the suite.** The transport retries
  a refused turn on that wire, so the test bounds the turn and asserts the request; the SSE
  decode itself is exercised through the OpenAI wires and by the sibling routes' suites.
- **`gitlab-duo-agent`'s checkpoint loop is not proven in-suite.** The suite proves the REST
  bootstrap, the bearer, and that no socket opens before a workflow exists, plus the adapter's
  tool handoff contract; the fake-socket round trip (start frame, checkpoint deltas,
  `runMCPTool` reseed, stall restart) needs a scripted nine-call bootstrap and a checkpoint
  corpus, and is the recorded follow-up. The first live turn is a manual smoke item.

## Deferred

`factory-droid` is **not** part of this component yet. Its omp graph pulls
`providers/register-builtins`, which statically imports every builtin provider,
measuring 327 modules / 16 991 893 B at the current pin — far past the plan's
stop rule — so the route waits for its own plan (tracked as issue `I-000253`,
with a build-substitution remedy as one candidate). Nothing in this package
reads or registers a `factory-droid` route.
