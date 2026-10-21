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
| Route | `cursor` (first provider; the seam is provider-generic) |
| Credential scope | `llm-omp-transports/<provider>`, today `llm-omp-transports/cursor` |
| Runtime | Node 24 (the bundle imports Node builtins only) |
| License | MIT |

The plugin registers its own route on the DSH `llm` seam, so it depends on no
upstream DSH change. `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-catalog` are used at
**build time only**: the build inlines the pinned omp Cursor transport into one
ESM artifact (`lib/omp/cursor.mjs`), and the published package imports nothing
from `@oh-my-pi/*` or `bun:*` at runtime.

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
- **Generated catalog.** The Cursor model table is generated from the pinned
  catalog and is not hand-edited. An omp or catalog bump requires
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
- **Only MCP calls are handed off.** Cursor-native exec frames (`read`, `shell`,
  `write`, `delete`, `grep`, `ls`, `diagnostics`, streamed edits) are answered
  by the transport with `Tool not available` and are **not** executed by DSH
  (live reachability unverified).
- **Advisory request knobs are ignored.** Cursor's agent protocol has no field
  for an output cap, sampling temperature, stop sequences or an auxiliary-call
  purpose; DSH's `maxTokens`, `temperature`, `stop` and `purpose` never reach
  the wire, and Cursor applies the catalog output limit server-side.

## Develop and test

```sh
pnpm -C packages/llm-omp typecheck
pnpm -C packages/llm-omp build
pnpm -C packages/llm-omp test
pnpm -C packages/llm-omp run generate:catalog
```

`build` bundles the pinned omp graph from `scripts/omp-entry.ts` into
`lib/omp/cursor.mjs` and rewrites `scripts/omp-manifest.json`; run it before
`test` after a pin or shim change. CI runs the same sequence and then fails if
the committed manifest drifted.

The install proof lives at the repository root and needs `pnpm` and `dsh` on
`PATH`:

```sh
node scripts/verify-install.mjs
```

It packs both packages, installs the root tarball into a fresh DSH profile,
and asserts that the composed profile carries both loader rows
(`dsh-keys-manager` and `llm-omp-transports`). It does not exercise the
plugin-manager UI or any Cursor network behavior.

## Release

This package versions independently of `dsh-keys-manager`; the root
`CHANGELOG.md` and its generated sections cover the root package only. A
release-prep run bumps the transports version by default (opt out with
`--skip-transport`, or pin one with `--transport X.Y.Z` / `X.Y.Z-prerelease`)
and the Release workflow publishes it and pushes the
`dsh-llm-omp-transports@<version>` tag.
The root [release docs](../../docs/release.md) describe the full flow.

Package documentation is English-only; the root `README.md` /
`README.zh-CN.md` and the root `docs/*.zh-CN.md` files carry the bilingual
plugin surface.

## License

Released under the [MIT License](../../LICENSE).
