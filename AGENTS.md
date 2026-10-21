# AGENTS.md

Conventions for coding agents working in this repository.

## CHANGELOG.md is generated — never edit it by hand

`CHANGELOG.md` is generated from git log by the release-prep workflow
(`scripts/prepare-release.mjs`, `updateChangelog`), and the file header says
so. Do not edit `CHANGELOG.md` manually — this includes its already-published
`## [<version>]` sections.

To document a fix or feature, write a clear commit message and PR title; the
next `release-prep` run derives the new changelog section from those notes
automatically.

## Two-package pnpm workspace

The repository is a pnpm workspace: the root is the `dsh-keys-manager` plugin
and `packages/llm-omp` is the separately published
`dsh-llm-omp-transports` component. The root depends on the transport package
rather than vendoring it, and the transport versions and releases on its own
line.

- The transport's build must precede its own tests: the drift gate imports the
  built `lib/omp/cursor.mjs`. CI runs root typecheck/build/test first, then
  the transport's typecheck/build/test; the install proof builds each package
  through its own `prepack`.
- `@oh-my-pi/*` is a build-time pin for the transport bundle. It must never
  appear as a runtime dependency of either published package.

## Development is worktree-driven

All development changes MUST be made in a dedicated git worktree on a
feature branch; the worktree's location and naming follow whichever tooling
convention the agent uses. The primary checkout stays on `main` at all
times and is used only as the control/coordination root. Feature branches
merge back to `main` through PRs.
