# Release

[English](release.md) | [简体中文](release.zh-CN.md) — Back to [README](../README.md)

## CI

CI (`.github/workflows/ci.yml`) runs typecheck, build, tests, and a packed
tarball assertion for `lib/index.js`, `lib/client.js`, and
`bundle/cordis.patch.yml`.

## Release flow

Releases are PR-driven:

1. Actions → **Release prep** → Run workflow. Leave the version empty for an
   automatic patch bump, or pass `X.Y.Z` / `X.Y.Z-prerelease`.
2. The workflow bumps `package.json`, updates `CHANGELOG.md` from git log,
   validates the build, and opens a `release v<version>` PR.
3. Merge the release PR. The **Release** workflow publishes
   `dsh-keys-manager@<version>` to npm with provenance, pushes tag
   `v<version>`, and creates the GitHub Release.

## npm publishing

npm publishing uses OIDC trusted publishing (no `NPM_TOKEN`). Configure a
Trusted Publisher for this repository and the `Release` workflow on
npmjs.com before the first release. Prerelease versions publish to a
prerelease dist-tag and never move `latest`.

## Actions pull-request permission

The Release prep workflow opens its PR with `GITHUB_TOKEN`. If the repository
disables Actions-created PRs, enable **Settings → Actions → General → Allow
GitHub Actions to create and approve pull requests**, or point the workflow at
a fine-grained PAT secret instead.
