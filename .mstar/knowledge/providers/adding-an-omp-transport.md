# Adding a second omp-backed transport to `dsh-llm-omp-transports`

Proven across issue #15 batches: the Cursor transport (PR #28) and the Devin transport
(iteration `iter-2026-Q4-omp-batch2`, 2026-10-23). This is the repeatable procedure for serving
another provider whose wire protocol `llm-pi-ai` cannot express, without changing DSH upstream.

The seam facts that make this possible are in
[`oauth-grant-pool-integration.md`](./oauth-grant-pool-integration.md) and in the transport research
report (`.mstar/reviews/2026-10-20-omp-transport-research/report.md` §2–§5). Those do not change per
provider; the per-provider work is below.

## When a transport is the right answer

Use a transport only when the provider's wire is not one of `openai-completions`,
`openai-responses`, `anthropic-messages`. If the vendored pi-ai already ships the provider (for
example `cloudflare-workers-ai`, or `muse-code` as its `meta` provider), the answer is a route, not a
transport. A transport is a ~1 MB build artifact with a pinned upstream source and a drift gate; do
not pay that price for a protocol the host can already speak.

## The three deliverables

1. **A build artifact, not a runtime dependency.** Add one esbuild entry per transport under
   `packages/llm-omp/scripts/` (`omp-entry-<provider>.ts`), reusing the existing pi-utils / `bun:*`
   shims. The manifest goes to schema v2 with **per-entry** `moduleCount`, `bytes`, `metafile`,
   `shimImports` and `sourceHashes`, plus a per-entry byte ceiling calibrated from the first real
   build (~1.5×) and asserted in a test. `@oh-my-pi/*` stays a build-time-only exact pin.
2. **One parameterised adapter, not a second class.** `OmpTransportAdapter` over a
   `TransportRoute` record (id, displayName, credentialKey, profile, models, project, efforts) and a
   `RouteProfile` for request/event projection. The differences between providers belong in the
   route/profile data: forwarded sampling knobs, `wireModelId`, `externalToolExecutor`,
   `sessionId`→provider-specific id, header policy. The base `call()` ordering
   (aborted → row → project → credential → validate → abort re-check → transport) is shared.
3. **A generated catalog + credential seam.** Generate `src/catalog/<provider>.ts` from the pinned
   `pi-catalog/src/models.json` with a source hash and row count in the test, and export
   `<provider>CatalogModels()` beside the existing one so the root package's `transportCatalogOf`
   can project it. Register the route (`registerAdapter`), its configurable provider
   (`providers.<route>.models` allow-list) and its authorization flow
   (`llm-omp-transports/<provider>`) — in that order, and prove the order in a single ordered-call
   log test.

## Provider-specific traps that cost real review rounds

- **Header merge order decides attribution.** If the transport merges caller headers *last* (Devin
  does), passing DSH's attribution headers through `options.headers` would overwrite the vendor's
  client identity. Use a fill-absent `fetch` wrapper instead, and prove on the wire which requests
  carry DSH's `user-agent` and which keep the transport's own.
- **A `Request` input is not `init.headers`.** A fill-absent wrapper must seed its base from
  `input.headers` when given a `Request`, or it silently drops the transport's identity and auth
  header. Both current call sites pass URL + init, so pin the type to `string | URL` or merge from
  the `Request`.
- **Classify errors by what the wire actually raises.** A frame-decoder error carries no HTTP
  status, so it cannot become a `SERVER` failure; asserting the real classification and correcting
  the plan is the honest fix. Do not add a mapping to satisfy a stale acceptance line.
- **Static-bearer credentials need `expires`.** The root derives account status from
  `grant.expires`; a payload without it (or with a corrupt one) must be treated deliberately:
  absent = static bearer, corrupt = `REAUTH_REQUIRED`, and the resolver never writes.
- **No loopback listener unless the batch needs one.** A paste-the-failed-callback-URL prompt is
  enough for a headless `oauth-code` flow; a Node listener is shared work worth deferring to the
  batch that truly needs it (the Google family).

## Test layers that caught real defects

| Layer | Shape | What it proves |
|-------|-------|----------------|
| build / drift | two builds byte-identical, artifact imports under plain Node with no `Bun`, manifest numbers match measured ones | the pinned upstream still bundles the same way |
| event-level adapter | scripted transport replaying recorded events | chunk sequence, finish mapping, error classification, abort |
| projection | request options and refusals for the new profile | no cursor behaviour change; the provider's option surface is what the brief says |
| wire-level | the **real** bundled artifact over a stubbed `fetch`, frames built with the pinned codecs | handshake, framing/gzip, tool-call turn, trailer error, oversize frame, 401 retry |
| registration/auth | fake ctx call log, stubbed fetch | two routes/adapters/flows, lazy artifact load, `TRANSPORT_UNAVAILABLE` for both routes, flow commit shape |

## Checklist for the next transport

- [ ] Read the provider file and the declarative auth rule (`compat/rules/auth/<provider>.kdl`) before designing; the login protocol is usually a rule, not bespoke code.
- [ ] Decide: handoff vs in-stream tool execution (DSH's loop owns execution — handoff unless the wire requires otherwise).
- [ ] One pin, one manifest schema, per-entry accounting and ceilings.
- [ ] Generated catalog + exported catalog accessor + root `transportCatalogOf` branch.
- [ ] Fill-absent attribution wrapper, with the RA/`Request` trap handled.
- [ ] Fixture-only suites at all five layers; no live endpoint in any test.
- [ ] `docs/known-limits.md` names the unofficial client, the no-refresh/expiry contract, the attribution deviation and the manual smoke check.
- [ ] `.changes/unreleased/` fragment with **single-line** bullets (wrapped bullets are silently dropped by `prepare-release.mjs`).

## Lessons from the Google family (issue #15 batch 5, iteration `iter-2026-Q4-omp-batch3`)

Two routes (`google-gemini-cli`, `google-antigravity`) that share one provider file shipped as **one**
artifact serving **two** route registrations, plus one Node loopback sign-in. Four rules earned there:

1. **Keep released artifacts byte-identical with a per-entry shim, not a shared-shim edit.** Adding
   `fetchWithRetry` / `readSseJson` to the shared `pi-utils.ts` changed the released cursor/devin
   bytes. The fix is a per-entry composition module (`scripts/omp-shim/pi-utils-google.ts`) that
   re-exports the base surface plus the new symbols, recorded in the manifest as that entry's
   `piUtilsShim` and re-derived by the drift test. Marking the real modules `sideEffects: false` does
   **not** shrink the graph — measure before trusting a bundler trick.
2. **A provider that imports `providers/register-builtins` inherits the whole catalog.** `factory-droid`
   measured 327 modules / 16 991 893 B because the registry pulls every builtin provider and
   `getBundledModel()`, retaining the 12.46 MB `models.json`. The stop rule (>2× cursor) fired and the
   route was deferred with its measurement (`I-000253`). The two remedies for its own batch: ship the
   full graph with a calibrated ceiling, or a build-time redirect to a lean registry module + lean
   `getBundledModel` (≈4–5 MB) — the latter is a new build-substitution category and needs its own
   design decision.
3. **A shared callback parser must stay provider-agnostic.** Hoisting Devin's paste parser into the
   Google listener made a Google-only policy (`error=` query) run on Devin's shipped path. Keep the
   parser to `code`/`state` and malformed-URL handling; put provider-specific rejection
   (`refusedSignIn`) at each caller. A loopback listener must also wrap its request-target parsing:
   one malformed raw target otherwise throws synchronously and can exit the host.
4. **Structured credentials and identity-preserving refresh.** When omp's transport parses a JSON
   `apiKey` (Google's `{token, projectId, refreshToken, expiresAt}`), the plugin resolves that envelope
   and refreshes inside `modifyRecord`, carrying identity fields (`projectId`) across the refresh that
   the token endpoint never returns. Attribution stays a *fill-absent* `fetch` wrapper: the transport
   merges caller headers last, so passing headers destroys the vendor identity.

## Lessons from the M3 closing batch (issue #15 batch 6, iteration `iter-2026-Q4-m3-close`)

Three routes (`factory-droid`, `gitlab-duo`, `gitlab-duo-agent`) closed the provider list. Five rules earned:

1. **A provider that imports `providers/register-builtins` inherits the whole catalog — solve it with
   importer-guarded, entry-scoped *build substitutions*, not a shim category.** The remedy that worked:
   S1 replaces `pi-catalog/models.json` with `{}` (`getBundledModel` returning `undefined` is its
   documented "not bundled" state); S2 redirects `register-builtins` to a tracked lean module that
   re-exports the **real** stream functions (marker-delimited verbatim regions + containment asserts);
   S2b does the same for the `../stream` edge; S2c substitutes the registry-derived `getEnvApiKey` map,
   which is reachable only if a request omits an explicit credential — proven by a poisoned-env test at
   the wire boundary. Result: 17 MB → 2.0 MB. Every redirect is importer-guarded and installed only for
   the entry that needs it, so the released artifacts' bytes cannot move; `sourceHashes` + metafile
   assertions ("no `models.json`, no real `register-builtins`") catch a substitution that silently stops
   firing.
2. **A server-orchestrated workflow transport can still use DSH's native tool loop.** GitLab's Duo
   Workflow yields ordinary `toolcall_*` events at every tool boundary and re-seeds from the goal
   transcript when no `providerSessionState` survives; a fresh per-request state map is correct and
   cheaper to build than sticky resume. Prove it with one adapter driven across two requests (a new
   workflow id, a new socket, the tool result in the second goal) — a fresh adapter per case hides
   cross-request regressions.
3. **Refresh identity is per route, not per provider family.** Two routes sharing a GitLab OAuth family
   still need their own client id/redirect on refresh; an expired grant with the sibling's identity fails
   server-side. Test an **expired** grant, not only a fresh one.
4. **Per-entry shim extensions keep released artifacts byte-identical; a shared-shim edit does not.**
   `pi-utils-google.ts`, `pi-utils-gitlab-duo.ts` and the lean modules are recorded per entry in the
   manifest, so the drift gate measures each graph separately.
5. **Attribution stays fill-absent and the wire owns its own paths.** When a vendor encodes the proxy path
   in the transport (Factory's `/api/llm/{a,o,g}/v1/...`), generated rows must not carry the seed's host
   `baseUrl`; the wire suite that asserts the final URL catches it, the adapter tests do not.
