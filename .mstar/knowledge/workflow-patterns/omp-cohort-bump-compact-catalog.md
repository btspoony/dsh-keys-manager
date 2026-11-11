---
module: dependency-upgrades
date: 2026-11-11
problem_type: workflow_issue
category: workflow-patterns
severity: medium
plan_id: omp-pin-18-18-8-reasoning-efforts
tags: [oh-my-pi, pi-catalog, compact-catalog, pin-bump, patch-port, drift-gates]
---

# Bumping the @oh-my-pi cohort when the catalog format changes

`applies_when`: the pinned `@oh-my-pi/*` cohort moves and the transport bundles, the catalog
generators or the identity drift gates stop building.

## Procedure

1. Move the whole cohort (they are version-locked): the three direct `devDependencies` in both
   manifests, every `@oh-my-pi/*` entry in `pnpm-workspace.yaml` `minimumReleaseAgeExclude`, and the
   `patchedDependencies` key. `pnpm install --no-frozen-lockfile`.
2. Re-generate the patch with `pnpm patch` + `pnpm patch-commit`; never hand-edit it. Prove fidelity by
   comparing the added/removed line sequence against the previous patch — hunk headers and context lines
   may move, the semantics may not.
3. Rebuild the bundles so `scripts/omp-manifest.json` (and the root OAuth manifest) carry the new version
   and fresh hashes. Build failures, not typecheck, are the real compatibility gate.
4. Regenerate every committed table from the new pin, recalibrate literal measurements to the measured
   value (never widen a ceiling), and re-point every wire-identity copy at what the pin now sends.
5. Run root and transport `typecheck`/`build`/`test`.

## What 18.18.8 changed under us (2026-11-11)

- **The catalog is no longer a plain map.** `pi-catalog/src/models.json` became a compact encoded
  catalog (`{version, keys, booleanShapes, nodes, compat, providers}`) readable only through
  `src/model-catalog-format.ts`, and the package's `exports` map points `import` at `.ts` sources with
  no JS `dist`. Bundling that module pulls `pi-utils` and therefore `bun:*` specifiers, so the workable
  move is a **dependency-free port** of the decoder/encoder (`scripts/model-catalog-format.mjs`) used by
  both generators; prove it by decoding the installed catalog and comparing against the pin's own
  implementation, and by `encodeModelCatalog` byte-equality. The root package's `files` includes
  `scripts`, so that port is published — it must carry the upstream MIT notice.
- **New module-scope runtime requirements** needed shim substitutions in the bundle: a `ws` stand-in
  (the responses client falls back to SSE, which is what these routes did anyway) and a well-formed
  empty catalog stand-in (the catalog module now validates the encoded shape at import).
- **Wire identities moved silently**: Cursor's profile read became a Connect RPC
  (`aiserver.v1.DashboardService/GetMe` comparing the token's full `sub` to `authId`), Antigravity's
  `cl` and build version, Devin's `ideVersion`, Factory's CLI user agent and its dropped
  `x-stainless-*` telemetry, Devin's 1 KiB compression floor, Antigravity's first-turn step numbering.
  Each drift gate needs the new value **and** the pin's `path:line`.
- **Vocabulary**: an external-handoff turn now ends `done.reason: "toolUse"` instead of `"stop"`; check the
  consumer mapping (`projection.ts` `doneFinish`) before treating it as a behaviour change.

## What does not work

- Reimplementing the compact-catalog format from the JSON without comparing against upstream: the
  encoder interns keys/nodes/shapes, and a decode that "looks right" is easy to get subtly wrong.
- Bundling `model-catalog-format.ts` directly with esbuild: `bun:ffi`, `bun:sqlite`, `bun` specifiers
  arrive through `pi-utils`, and the transport shim is not a general Bun runtime.
- Loosening a drift gate whose upstream value moved: recalibrate to the measured value and cite the pin.
- Deferring the wire-identity recalibrations as "out of scope": the transport suite stays red and the
  package is not mergeable.
