# Release

[English](release.md) | [简体中文](release.zh-CN.md) — Back to [README](../README.md)

## CI

CI (`.github/workflows/ci.yml`) runs root typecheck, build, tests, and a
packed tarball assertion for `lib/index.js`, `lib/client.js`, and
`bundle/cordis.patch.yml`. It then runs the `dsh-llm-omp-transports`
workspace package's typecheck, build, tests, and drift-manifest check.

The job installs a pinned `@deepseek-ai/dsh` (`0.2.1-rc.2`) before the suite
and ends with an explicit install/load proof step (`vitest run
tests/install.test.ts`): both tarballs are packed, the root plugin is installed
into a fresh profile, and the composed loader tree must carry both components.
`tests/install.test.ts` fails instead of skipping only when
`INSTALL_PROOF=required` is set, which that step alone does; the earlier `Test`
step excludes the file, and the release workflows run the plain suite without
the flag — they install no CLI and skip the proof rather than fail before
publishing.

## Release flow

Releases are PR-driven:

1. Actions → **Release prep** → Run workflow. Leave the version empty for an
   automatic patch bump, or pass `X.Y.Z` / `X.Y.Z-prerelease`. The transports
   version is optional: leave it empty for its automatic patch bump, pass a
   formal `X.Y.Z` to pin it, or `skip` to leave that package unchanged.
2. The workflow bumps both `package.json` versions (the transports package on
   its own line), updates the root `CHANGELOG.md` from git log, validates the
   build, and opens a `release v<version>` PR.
3. Merge the release PR. The **Release** workflow publishes
   `dsh-keys-manager@<version>` and `dsh-llm-omp-transports@<transport
   version>` to npm with provenance (the transport is skipped when that exact
   version is already published), pushes tag `v<version>` and the package tag
   `dsh-llm-omp-transports@<transport version>`, and creates the GitHub
   Release.

## The transports package

`packages/llm-omp` publishes `dsh-llm-omp-transports` from the same release PR
but on its own version line. The root package depends on it, so `pnpm pack`
rewrites the `workspace:^` spec to a semver range and the published root
tarball asks for that transport version.

- `scripts/prepare-release.mjs` patches the transport's patch line on every
  run. `--transport X.Y.Z` pins one, `--skip-transport` leaves it untouched,
  and `--dry-run` validates and prints both package versions and tags without
  writing. The workflow exposes the same choice as the optional
  `transport_version` input (`skip` or `X.Y.Z`).
- The transports package has no generated changelog. `CHANGELOG.md` and its
  `## [<version>]` sections stay root-only; the transport is described by its
  own README and git history.
- `release.yml` publishes the transport only when its exact `package.json`
  version is not already on npm, so a re-run or a root-only release is
  idempotent. The tag step always ensures `dsh-llm-omp-transports@<version>`
  exists.
- Transport prereleases are refused by release prep: the transport publish has
  no dist-tag rule yet, so a prerelease would move npm's `latest`. Release the
  transport with a formal `X.Y.Z`.

## npm publishing

npm publishing uses OIDC trusted publishing (no `NPM_TOKEN`). Configure a
Trusted Publisher for this repository and the `Release` workflow on
npmjs.com before the first release. **Each published package needs its own
Trusted Publisher**: `dsh-keys-manager` and `dsh-llm-omp-transports` are two
npm packages, and one publisher entry does not cover the other. Prerelease
versions publish to a prerelease dist-tag and never move `latest`.

The `Release` workflow publishes the transports package **before** the root
package, and the transports step is not conditional on anything the root needs
at that moment: if it fails, the root publish never runs. That is deliberate —
the transport is a real dependency of the installed root, so a half-published
release is worse than none — but it means a transport-side npm problem blocks
the root. Fix the transport and re-run: the transports step skips itself once
its exact version is on npm.

## Actions pull-request permission

The Release prep workflow opens its PR with `GITHUB_TOKEN`. If the repository
disables Actions-created PRs, enable **Settings → Actions → General → Allow
GitHub Actions to create and approve pull requests**, or point the workflow at
a fine-grained PAT secret instead.
