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
