# Change fragments

Each file in this directory is one authored changelog fragment. The release
prep workflow (`scripts/prepare-release.mjs`) assembles them into the next
`## [<version>] - <date>` section of `CHANGELOG.md`, then moves the consumed
fragments to `.changes/archive/<version>/`. `CHANGELOG.md` is never edited by
hand.

A release whose assembled notes body is **empty** — no fragments here, or only
fragments without `- ` bullet lines — is refused on both a dry run and a real
run: prepare-release exits 1 and names the files with no bullets. A dry run
prints `FRAGMENTS=<n>` so the count is visible before anything is written.

## Format

- **Filename**: any slug ending in `.md` (e.g. `add-foo.md`); fragments are
  assembled in filename order. `README.md` and `.gitkeep` are ignored.
- **Frontmatter** (optional): a `category:` key groups the fragment's bullets
  under a `### <category>` heading in the changelog (default: `Changed`).
- **Category order**: `### <category>` blocks appear in the order their category
  is first seen in filename order, so a fixed order needs a filename prefix —
  name fragments `10-added-foo.md`, `20-changed-bar.md`, `30-fixed-baz.md`,
  `40-docs-qux.md` (as `.changes/archive/0.2.2/` does).
- **Body**: one or more English bullet lines (`- ` prefix), rendered verbatim.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

Keep each fragment focused on a single user-visible change.
