# Known limits

Current limits and risks of the `dsh-llm-omp-transports` component, as shipped
for the `cursor` and `devin` routes. Details and rationale are in the
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
  page and asks for the address the browser landed on. The page cannot load.
  A full callback URL or `code#state` is state-checked; a bare code skips the
  check (documented weakening of CSRF protection).

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
- The Devin catalog has 2 pinned rows (`swe-1-6`, `swe-1-6-fast`) and no
  reasoning efforts. The projection forwards `maxTokens`, `temperature` and
  `stop` (as `stopPatterns`) and reuses `sessionId` as the cascade id; `purpose`
  is still ignored.

## Turns and tools

- Tool execution happens in DSH, not in the transport. An unhandled MCP call
  ends the turn with a handoff; the result is replayed on the next request.
  The adapter never runs a tool.
- **Only MCP calls are handed off.** Cursor-native exec frames (`read`, `shell`,
  `write`, `delete`, `grep`, `ls`, `diagnostics`, streamed edits) have no
  handler: the transport answers them with "Tool not available" and they are
  **not** executed by DSH (live reachability unverified).
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
- No Cursor state is shared between DSH hosts or Harness homes.

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
- Two artifacts are built from one pin: `lib/omp/cursor.mjs` and
  `lib/omp/devin.mjs`, each with its own calibrated size ceiling and source
  hashes in `scripts/omp-manifest.json`.
