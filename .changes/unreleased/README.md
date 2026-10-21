# Change fragments

Each file in this directory is one authored changelog fragment. The release
prep workflow (`scripts/prepare-release.mjs`) assembles them into the next
`## [<version>] - <date>` section of `CHANGELOG.md`, then moves the consumed
fragments to `.changes/archive/<version>/`. `CHANGELOG.md` is never edited by
hand.

A release with **zero** fragments is refused: the fragments are the release
notes, so prepare-release exits 1 instead of publishing an empty section.

## Format

- **Filename**: any slug ending in `.md` (e.g. `add-foo.md`); fragments are
  assembled in filename order. `README.md` and `.gitkeep` are ignored.
- **Frontmatter** (optional): a `category:` key groups the fragment's bullets
  under a `### <category>` heading in the changelog (default: `Changed`).
- **Body**: one or more English bullet lines (`- ` prefix), rendered verbatim.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

Keep each fragment focused on a single user-visible change.
