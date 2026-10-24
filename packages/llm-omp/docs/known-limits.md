# Known limits

Current limits and risks of the `dsh-llm-omp-transports` component, as shipped
for the `cursor`, `devin`, `google-gemini-cli`, `google-antigravity`, `factory-droid`,
`gitlab-duo` and `gitlab-duo-agent` routes. Details and rationale are in the
[package README](../README.md); the bilingual plugin surface lives in the
repository root docs.

## Cursor client

- The transport is an **unofficial Cursor client**. It reuses Cursor's
  vendor-internal OAuth client id and presents a released CLI build's identity
  (`x-cursor-client-version`, `x-cursor-client-type`).
- The MIT license covers the code, not the service, so relying on this client
  carries a terms-of-service (ToS) risk. If Cursor gates non-IDE clients
  (`401`/`403` on `Run` with a valid account), the transport stops until the
  decision recorded as stop condition **S4**.
- The real Cursor endpoints and protocol behavior are **unverified**: tests
  replay recorded fixtures and never call Cursor. Treat a first live sign-in
  and turn as a manual check.
- One grant per route is stored at `llm-omp-transports/cursor`. Expiry,
  refresh rejection and removal are fail-loud: the route stops serving until
  the account is signed in again from the Keys Manager page.

## Devin client

- The transport is an **unofficial Devin client**. It presents the released
  Devin CLI identity (`ideName: "devin-cli"`, `ideType: "chisel"`,
  `ideVersion: "3000.11.3"`) and copies the CLI's `connect-go` client header;
  the backend gates behavior on that tuple.
- The MIT license covers the code, not the service. A first live turn rejected
  with `401`/`403` stops the route until the decision recorded as stop
  condition **S4** — never a retry under another identity.
- **Attribution deviates on the handshake.** The chat request must keep the
  `connect-go` client header, so DSH's attribution `user-agent` is filled only
  where a request left the header absent (the header-less `GetUserJwt`
  handshake). Cursor's requests keep full attribution.
- The real Devin endpoints and protocol behavior are **unverified**: tests drive
  Connect frames through the bundled transport with a stubbed `fetch` and never
  call Devin. Treat a first live sign-in and turn as a manual check.
- One grant per route is stored at `llm-omp-transports/devin`.
- **There is no refresh.** The pinned rule declares `refresh "none"`, so the
  record is a static bearer with a derived `expires` (JWT `exp` minus five
  minutes, else one year). An expired or present-but-unreadable `expires` is
  `REAUTH_REQUIRED`; an absent one is served as a static bearer.
- **Sign-in is paste-only** for now: omp completes this login with a Bun-only
  loopback listener on `127.0.0.1:59653`, so this package opens the authorize
  page and asks for the address the browser landed on. Nothing listens on that
  port, so the browser's redirect target fails to load and the code stays in the
  address bar to paste. A full callback URL or `code#state` is state-checked; a
  bare code skips the check (documented weakening of CSRF protection).

## Google clients

- The two Google routes are **unofficial clients** of Google's Cloud Code
  Assist surface. They reuse the OAuth clients and identities the pinned omp
  rules capture: `GeminiCLI/0.46.0/<model> (platform; arch; terminal)` with
  `Client-Metadata` for `google-gemini-cli`, and
  `antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64;
  cl=963137146)` for `google-antigravity`.
- Same posture as the other routes: the MIT license covers the code, not the
  service. A first live turn rejected with `401`/`403` on a valid token stops
  the route until the decision recorded as stop condition **S4** — never a
  retry under another identity.
- **Sign-in is a real loopback listener** on `127.0.0.1` (`:8085/oauth2callback`
  and `:51121/oauth-callback`). If the port is taken the listener binds an
  ephemeral one and the authorize page carries that port; the pasted
  address is the fallback, and a pasted callback must carry this attempt's
  `state` (`code#state` is enough) — a bare code is refused. A callback the
  listener did not mint answers `400` and is dropped without ending the attempt;
  only a state-matching code, the deadline or the abort settles it, so one stray
  request cannot cancel a sign-in. The whole browser wait is **bounded at five
  minutes** (`GoogleFlowOptions.waitMs` in tests): expiry closes the socket,
  fails with `AUTH_FAILED` and commits nothing. An aborted attempt reads as a
  cancellation instead.
- One grant per route is stored at `llm-omp-transports/google-gemini-cli` and
  `llm-omp-transports/google-antigravity`, as
  `{access, refresh, expires, projectId, email?}`. The adapter converts it to
  the structured JSON envelope omp's transport parses.
- The resolver refreshes when `expires - 60 s <= now`, once, under the
  credential store's per-key lock: it keeps the `projectId` and an un-rotated
  refresh token, and reports a missing or rejected refresh token as
  `REAUTH_REQUIRED`.
- **Attribution deviates on both routes.** The wire needs its vendor
  `user-agent`, so DSH's attribution `user-agent` is filled only where a
  request left the header absent — the same wrapper the Devin handshake uses.
- **The Antigravity version is discovered, not pinned.** The first request
  reads the public update manifest (D11) because the backend gates newer models
  on the client version; a failed lookup is silent and falls back to `2.19.1`
  for ten minutes, and `PI_AI_ANTIGRAVITY_VERSION` skips the lookup. This is
  the only outbound call besides the vendor API.
- **Images are refused.** Both routes advertise text-only input and reject
  image blocks with `CONTENT_UNSUPPORTED`. omp's Antigravity image path decodes
  through `Bun.Image`, absent under Node, so the path is dead by construction.
- **The real endpoints are unverified.** `tests/adapter-wire-google.test.ts`
  drives the bundled transport end to end with a stubbed `fetch` (URL, request
  envelope, headers, SSE text/thinking/tool-call/usage, in-band errors,
  Antigravity daily→sandbox failover, manifest lookup), but no test calls
  Google. A first live sign-in and turn is a manual smoke check.

## Factory Droid

- The route **ships**: the graph that once measured 327 modules / 16 991 893 B
  (issue `I-000253`) is built through the accepted entry-scoped substitutions, at
  200 modules / 2 008 434 B.
- The transport is an **unofficial Factory client**: it presents `factory-cli/0.237.0` plus
  the vendor identity headers the backend gates on.
- **Three entry-scoped build substitutions** keep the artifact at ~2 MB: the model catalog is
  empty for this entry (data only; `models.ts` keeps its real code), `providers/register-builtins`
  is replaced by a verbatim copy of its watchdog wrapper plus the three real streams, and
  `env-api-key`'s `PROVIDER_REGISTRY` half is dropped. **The last one is a known loss:** the
  computed Foundry/ADC/Bedrock env-key resolvers do not exist here. It is unreachable for this
  route (every request carries the stored WorkOS token) and catalog-declared plain variables
  still resolve.
- The install id is generated per process instead of persisted at `~/.omp/install-id`; it only
  feeds telemetry attribution.
- **EU accounts:** the adapter forwards the stored account scope as `oauthIdentity`. Without a
  stored `region` the transport falls back to the token's `external_org_id` claim and the
  global host, so a EU account whose record lost its region talks to the global endpoint.
- No reasoning-effort selector: the pin declares no effort ladder for this provider, so a
  selected effort is refused rather than guessed.
- Images are refused even though 54 of the 62 rows advertise image input.
- The catalog is the KDL registry seed and can be wider than an account's entitlements; a
  401/403 on the first live turn is a product decision, never a retry under another identity.

## GitLab Duo (proxy)

- **The bundled OAuth client is GitLab's own** and GitLab rejects it when the registered
  redirect drifts; `GITLAB_CLIENT_ID` + `GITLAB_REDIRECT_URI` register a custom app, and a
  `GITLAB_TOKEN` personal access token is accepted as the bearer.
- The loopback callback is `localhost:8080/callback` with **no port fallback**: a busy 8080
  surfaces the rule's instructions and leaves the paste prompt as the only path.
- Duo must be enabled for the account: a 403 on the direct-access bootstrap ends the turn as
  an auth failure ("Duo not enabled"), never a silent empty answer.
- The direct-access token is cached 25 minutes **inside the artifact**, keyed on the GitLab
  access token; a refresh rotates it and therefore misses the cache by construction.
- The catalog is the pin's 16-row alias table; each row carries the upstream id and the wire
  it routes to.
- **Unproven in-suite:** the Anthropic inner wire retries a refused turn, so the wire suite
  bounds the turn and asserts the request instead of decoding that SSE; the OpenAI wires and
  the sibling routes cover the decode path.

## GitLab Duo agent

- **Paste-only sign-in:** the browser hands the code to VS Code, so the human pastes the full
  `vscode://gitlab.gitlab-workflow/authentication?code=…&state=…` URL. There is no listener,
  the state is mandatory, and a refresh echoes the `vscode` redirect.
- **A fresh workflow per request** (plan A6): each turn re-seeds the workflow and replays the
  goal transcript instead of resuming a socket; correct but heavier, and sticky resume is a
  follow-up.
- The catalog offers one static row; live model discovery is not implemented, and the server
  may pin another model. `GITLAB_TOKEN` works as the bearer here too.
- **The checkpoint loop is not proven in-suite:** the suite covers the REST bootstrap, the
  bearer, that no socket opens before a workflow exists, and the adapter's tool handoff. The
  fake-socket round trip (start frame, checkpoint deltas, `runMCPTool` reseed, stall restart)
  is a recorded follow-up, and the first live turn is a manual smoke item (the Node 24 global
  `WebSocket` accepts the `{headers}` extension; `webSocketFactory` is the seam).
- Tool execution stays on DSH's side: the server loop yields at every call, so one
  `runMCPTool` action is in flight at a time.

## Model coverage

- Models come only from the pinned `@oh-my-pi/pi-catalog@18.12.3` Cursor
  slice (123 rows). A model that Cursor adds later is unknown
  (`UNKNOWN_MODEL`) until the pin and the generated table are refreshed.
- 19 of the 123 rows advertise reasoning efforts without routing them; on
  those rows every advertised effort resolves to the row's own wire id, so
  selecting an effort is a wire-level no-op (the same behavior as omp).
- **Image input is advertised as text-only.** Image and file blocks are
  refused with `CONTENT_UNSUPPORTED` rather than dropped; forwarding is future
  work. 100 of 123 catalog rows claim image input but are advertised as
  text-only.
- The Cursor route ignores `maxTokens`, `temperature`, `stop` and auxiliary
  `purpose`: Cursor's agent protocol has no fields for them.
- The Google catalogs have 7 (`google-gemini-cli`) and 22 (`google-antigravity`)
  pinned rows. Rows with `requiresEffort` refuse a turn that selects no effort;
  budget-mode rows send `thinkingConfig.thinkingBudget`, Gemini-3+ rows send
  `thinkingLevel`. Antigravity rewrites `maxOutputTokens` to the captured
  per-wire-id cap (e.g. 65 535 for `gemini-pro-agent`, 64 000 for Claude), as
  the real client does.
- The Devin catalog has 2 pinned rows (`swe-1-6`, `swe-1-6-fast`) and no
  reasoning efforts. The projection forwards `maxTokens`, `temperature` and
  `stop` (as `stopPatterns`) and reuses `sessionId` as the cascade id; `purpose`
  is still ignored.

## Turns and tools

- Tool execution happens in DSH, not in the transport. An unhandled MCP call
  ends the turn with a handoff; the result is replayed on the next request.
  The adapter never runs a tool.
- **Colliding DSH tools are aliased, not dropped.** The transport keeps
  Cursor's own `read`/`bash`/`write`/`delete`/`ls`/`grep`/`todo` names off the
  MCP advertisement, so a DSH tool with one of those names is advertised as
  `dsh_<name>`; the event stream restores the DSH name on the tool call, while
  history replay keeps the advertised alias so the follow-up request stays
  consistent. The seven `dsh_<native>` names are reserved: a DSH tool that
  already carries one is refused with `TOOL_ALIAS_COLLISION`, which fails the
  whole request and requires renaming the tool. Any other tool name travels
  unchanged. Cursor-native `read`, `shell` (batch and streamed),
  `mini_swe_agent_bash`, `write` and `grep` exec frames are handed to DSH's own
  tool loop the same way (unresolved call, result replayed on the next
  request), translated into the DSH tool's parameters. Frames with no DSH
  equivalent (`delete`, `ls`, `diagnostics`, background-shell spawn/stdin,
  streamed edits) still have no handler: the transport answers them with "Tool
  not available" and they are **not** executed by DSH (live reachability
  unverified).
- **The `pi*` exec frames have no handoff and are not gated client-side.**
  `piReadArgs`/`piBashArgs`/`piEditArgs`/`piWriteArgs`/`piGrepArgs`/
  `piFindArgs`/`piLsArgs` are dispatched whenever Cursor's server sends them:
  this client advertises no capability set that would suppress them, so they
  *can* reach a live DSH session. Unanswered, each one synthesizes a settled
  call and answers the server with a `Tool not available` error result, so a
  turn that chooses one gains nothing. If one shows up in a live seat it needs
  its own translation — the Pi result schemas differ from the modern ones
  (`PiBashExecResult` carries `output`/`truncation`, not `stdout`/`exitCode`).
- A streamed shell frame that is handed off is answered with `start` →
  `rejected` (handoff reason) → `exit` code 1 instead of running the command,
  mirroring the batch branch's refusal. A server that needs streamed stdout to
  keep the turn alive gets none, so such a turn ends on the reject.
- The exec-frame handoff translation is **lossy**. `grep`'s `ignoreCase`,
  `literal`, `context` and `offset` flags have no slot in DSH's `grep` tool and
  are dropped; `shell`'s millisecond budget is dropped and its working
  directory is folded into the command as a leading `cd <dir> && …`. The model
  sees the DSH tool's own schema, so a call that needed a dropped flag may
  behave differently than under Cursor's native tool.
- Tool declarations travel as MCP definitions. `toolHistory` is accepted but
  cannot be replayed — the active declaration set is what the request
  projects.
- A historical tool call whose arguments are not a JSON object, a malformed
  tool-call event, an unknown event kind and a DSH tool already named like a
  reserved alias fail by name (`TOOL_ARGUMENTS_INVALID`, `MALFORMED_TOOL_CALL`,
  `UNKNOWN_EVENT`, `TOOL_ALIAS_COLLISION`).
- A system message that is not part of the leading prompt is refused rather
  than reordered or dropped.

## State

- The per-conversation checkpoint cache is **in-process** (a 128-entry LRU
  inside the bundled omp transport) and is never persisted. A lost, evicted or
  restarted cache rebuilds from the request history, so a multi-step turn
  replays its history.
- Antigravity keeps one piece of per-request state: the `Map` the adapter
  creates for endpoint failover (last-good host, agent/trajectory ids). It is
  per request and never persisted.
- No route state is shared between DSH hosts or Harness homes.

## Build and runtime

- The published artifact depends on **no** `@oh-my-pi/*` package and loads
  under Node 24 with Node builtins only. `@oh-my-pi/pi-ai` and
  `@oh-my-pi/pi-catalog` remain pinned at `18.12.3` and are build-time
  dependencies.
- The build output is drift-gated by `scripts/omp-manifest.json`,
  `tests/build.test.ts` and a CI manifest diff. A pin bump without a rebuild,
  or a shim gap, fails before runtime.
- The generated catalogs are not hand-editable; run
  `pnpm -C packages/llm-omp run generate:catalog` after a pin bump.
- Six artifacts are built from one pin — `cursor`, `devin`, `google` (both Cloud Code
  Assist routes), `factory-droid`, `gitlab-duo` and `gitlab-duo-agent` — each with its own
  calibrated size ceiling and source hashes in `scripts/omp-manifest.json`. The GitLab and
  Factory entries use entry-scoped build substitutions and per-entry `pi-utils` extensions;
  the shared shims never change, which is why the first four artifacts keep their bytes.
