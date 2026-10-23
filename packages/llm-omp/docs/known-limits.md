# Known limits

Current limits and risks of the `dsh-llm-omp-transports` component, as shipped
for the `cursor`, `devin`, `google-gemini-cli` and `google-antigravity` routes. Details and rationale are in the
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
- **`factory-droid` is deferred.** Its omp graph measures 327 modules /
  16 991 893 B at the current pin (it imports every builtin provider), so the
  route waits for its own plan, tracked as issue `I-000253`; nothing here reads
  or registers it.

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
  `dsh_<name>` and an aliased call is mapped back to the DSH name on the event
  stream and in history replay; other tool names travel unchanged. Cursor-native
  exec frames (`read`, `shell`, `write`, `delete`, `grep`, `ls`,
  `diagnostics`, streamed edits) still have no handler: the transport answers
  them with "Tool not available" and they are **not** executed by DSH (live
  reachability unverified).
- Tool declarations travel as MCP definitions. `toolHistory` is accepted but
  cannot be replayed — the active declaration set is what the request
  projects.
- A historical tool call whose arguments are not a JSON object, a malformed
  tool-call event and an unknown event kind fail by name
  (`TOOL_ARGUMENTS_INVALID`, `MALFORMED_TOOL_CALL`, `UNKNOWN_EVENT`).
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
- Three artifacts are built from one pin: `lib/omp/cursor.mjs`,
  `lib/omp/devin.mjs` and `lib/omp/google.mjs` (shared by the two Google
  routes), each with its own calibrated size ceiling and source hashes in
  `scripts/omp-manifest.json`.
