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
