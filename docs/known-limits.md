# Known limits

[English](known-limits.md) | [简体中文](known-limits.zh-CN.md) — Back to [README](../README.md)

Current design boundaries of the Keys Manager plugin:

- CoreWeave Serverless Inference resolves `COREWEAVE_PROJECT` (the
  `<team>/<project>` pair) from the DSH process environment at add time and
  stores it as a static `OpenAI-Project` header on the route profile, so
  requests keep sending the project that was set when the provider was added.
  To change it, release the provider from Keys Manager first, then restart
  DSH with the new value and add the provider again. Release removes the
  `OpenAI-Project` value this plugin wrote while it still equals the current
  environment value; a value it cannot attribute is kept and reported in the
  UI warnings, and a hand-written header that happens to equal the
  environment value is removed by the same rule. A profile the plugin created
  is removed and recreated on the next add, while an adopted profile is kept
  and re-adopted; in both cases the plugin only fills a declared header the
  profile does not already carry and never overwrites a stored value.
- OAuth2 account pools ship as increment 1 for seven pi-ai-backed providers;
  see the OAuth accounts limits below. Anthropic key pools still manage a
  plain `ANTHROPIC_API_KEY` — its OAuth/federation token paths are separate
  account rows, not key-pool members.
- Cloudflare AI Gateway and Workers AI require a Cloudflare account ID (and a
  gateway ID for AI Gateway) in addition to the API key. They are reported as
  unsupported key pools and should be configured natively in Models.
- Provider-native cloud credential chains (for example an AWS profile used by
  a Bedrock route) are not split into per-key rows; those providers are shown
  with an explanatory reason unless they also expose an API-key variable.
- A release restores the profile's `apiKeyEnv`, but other provider edits made
  by the user in Models are preserved. Releasing an extra provider whose route
  profile the plugin created removes that route, including later edits; the
  confirmation text says so.
- Cooldown counters are local to this Harness home; they are not shared
  between hosts.
- Retry identity is ambient: retry pins and request steps are recorded per
  session and provider, not per HTTP request. When several steps of the same
  session and provider run concurrently, a retry stream may fail to consume
  its own pin, or a finishing step may clear another step's pin. A direct
  stream without a `purpose` may also consume one pending retry pin while its
  window is open. The pin window is 60 seconds, which bounds this exposure
  but does not eliminate it; concurrent multi-step retry behavior remains
  best-effort.

## OAuth accounts (increment 1)

- Account sign-in through the `llm-pi-ai` seam covers the seven providers
  whose OAuth flows that host implements: Anthropic, GitHub Copilot, Kimi
  Coding, OpenAI Codex, OpenRouter, Radius, and xAI. Two more routes sign in
  through this plugin's own bundled clients — Kilo and Z.AI Coding Plan; see
  [In-process sign-in](#in-process-sign-in-kilo-zai-coding-plan) below.
  Extending coverage beyond these routes is tracked in
  [issue #15](https://github.com/btspoony/dsh-keys-manager/issues/15).
- Grant refresh failure is fail-loud: the account cools down. A
  key-capable route falls back to the provider's key pool; an OAuth-only
  route has no API-key pool and stops serving requests until an account is
  signed in again. Re-authentication is manual —
  re-login from the account menu.
- Only one active grant per provider is kept.
- Conditional delete is a credential-seam capability this plugin does not
  have: the store offers `deleteRecord(key)` with no compare/version guard,
  so demoting or compensating the `llm-pi-ai/<provider>` projection is a
  decide-then-delete pair. A native grant written in the sub-microtask window
  between the final comparison and the delete's queue entry can therefore be
  deleted even though it no longer belongs to the account being removed. The
  manager narrows the window (a compare inside the seam's per-key lock plus a
  pre-delete re-read) and a regression test pins the residual exactly. The
  upstream capability request is store issue I-000090 (credential seam:
  compare-and-delete / versioned delete primitive).
- Increment 1 keeps the selection model key-centric: the provider's API
  keys form the sticky/round-robin/failover/cooldown ring, and exactly one
  projected OAuth grant serves the provider. Per-account ranking
  (rotating between accounts) is future work, not part of this increment.

## In-process sign-in (Kilo, Z.AI Coding Plan)

- Both flows are unofficial clients extracted from
  `@oh-my-pi/pi-ai@18.12.3` at build time. The provider can change its login
  endpoints, scopes or responses at any time; a break shows up as the
  provider's own error text in the sign-in dialog, not as a crash.
- Kilo's credential is a one-year bearer token with no refresh token
  (`refresh: ''`). It cannot be renewed in the background: when it expires,
  sign in again from that row.
- Z.AI Coding Plan's flow ends in a minted API key (`<id>.<secret>`), not a
  login grant. The key appears in the Z.AI console named `oh-my-pi`; deleting
  or rotating it there invalidates the row, which then cools down like any
  other key. The same flow does not cover `zai-coding-cn` (the China
  endpoint), which is a separate route.
- These sign-ins can only be started from the Keys Manager page. Nothing in
  the DSH CLI or the Models page starts them, and no `llm-pi-ai/<provider>`
  grant record is written.
- The minted credential is one more row in the provider's pool: there is no
  per-account rotation or ranking, exactly as with the seven pi-ai OAuth
  accounts above.

## Transport routes (Cursor, Devin, Google)

- Each transport route (`cursor`, `devin`, `google-gemini-cli`,
  `google-antigravity`) keeps exactly one grant at
  `llm-omp-transports/<route>`: there is no key pool behind it and no
  per-account rotation to configure.
- A stored grant is `active` when its `access` token is usable and its route
  can serve it: a dated `expires` in the future, or — on `devin` only — no
  `expires` at all, the static-bearer shape its resolver accepts. No shipped
  flow writes such a record today (Devin derives an expiry from the token), and
  it shows no expiry value. The Cursor resolver needs a dated grant, so the
  same record on `cursor` reports `needs-reauth`. An `expires` that is present
  but unreadable is a corrupt record, not a static bearer, and the route reports
  `needs-reauth`.
- An expired grant does not fail the same way on Cursor and Devin: Devin has no
  refresh token, so it stops until you sign in again; Cursor refreshes on the
  credential seam and keeps serving, and stops only when the refresh is
  rejected or no refresh token is stored.
- The Cursor and Devin clients are unofficial and their live endpoints are
  unverified. Their specifics (vendor identities, ToS risk, no image input, no
  Devin refresh) are in
  [the transports package known limits](../packages/llm-omp/docs/known-limits.md).
- The two Google routes share one generated `lib/omp/google.mjs` artifact and
  nothing else: separate grant records, account rows and catalogs. Their grant
  is `{access, refresh, expires, projectId, email?}` and refreshes on the
  credential seam, so an expired token is renewed while the refresh token stays
  valid; a rejected refresh stops that route until you sign in again.
- The Google sign-in listener is local-only: `node:http` bound on `127.0.0.1`
  (`8085` `/oauth2callback` for `google-gemini-cli`, `51121`
  `/oauth-callback` for `google-antigravity`), falling back to another free port
  when the default is taken and closing on abort or timeout. Nothing outside
  this machine can reach it. The paste path — the full address the browser
  landed on, or `code#state` — runs as a second sign-in path beside the
  listener, so a blocked or unreachable redirect still finishes the login.
- Sign-in also resolves the Google Cloud project the route bills and sends. When
  Google demands a `GOOGLE_CLOUD_PROJECT` instead, the login fails with
  `AUTH_FAILED`; there is no project-less fallback.
- `google-antigravity` reads a version manifest from Google once per process
  (5 s budget, pinned fallback when the read fails or times out), so a blocked
  network delays but does not break its first turn. A failed read is not retried
  for ten minutes, so a flaky network costs one 5 s delay per window rather than
  one per turn; `PI_AI_ANTIGRAVITY_VERSION` skips the lookup entirely.
- The Google clients are unofficial and present vendor-internal OAuth
  identities, like the shipped routes. A `401`/`403` on the first live turn with
  a token that looks valid is a stop to report to the maintainers — the client
  is never retried with another identity. Every transport claim in this
  repository is proven against fixtures only; the first live turn is a manual
  smoke check.
- `factory-droid` is deferred to its own follow-up batch (tracked as
  `I-000253`), so no `factory-droid` route ships in this release. Its planned
  sign-in is a device-code poll — verification URL plus user code, no local
  listener — and nothing of it is available to configure yet.

## `muse-code`

- `muse-code` needs no transport: the vendored pi-ai `meta` provider already
  serves the Muse models (`openai-responses` against
  `https://api.meta.ai/v1`), and pi-ai ships that provider's own sign-in flow.
- That verification is static: the provider's catalog entry and its client
  source agree on the route and credential shape. No live request was made
  while developing this; the first live call is a manual smoke check, and its
  result is not recorded here.
