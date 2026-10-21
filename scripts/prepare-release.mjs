#!/usr/bin/env node
/**
 * Release-prep version and changelog helper (plans dsh-keys-manager-ci-release,
 * task 2 + 4; omp-transport-cursor-tools, task 5; release-changelog-fragments,
 * task 1):
 * resolves the target version — explicit `X.Y.Z` / `X.Y.Z-prerelease`
 * argument (e.g. 0.1.1-alpha.1) or an auto patch bump from package.json —
 * refuses already-released versions (existing `v<version>` git tag), bumps
 * package.json, assembles the release notes from the authored
 * `.changes/unreleased/*.md` fragments, inserts the `## [<version>]` section
 * into CHANGELOG.md (root only — the transports package has no generated
 * changelog), archives the consumed fragments to `.changes/archive/<version>/`,
 * and prints the root and transports versions and tags for the workflow to
 * capture. Node built-ins only, no new dependencies.
 *
 * The fragments ARE the release notes: a release whose rendered body is empty
 * (zero fragments, prose-only fragments, or fragments without `- ` bullet
 * lines) is refused on both a dry run and a real run, so an empty
 * `## [<version>]` section can never be published. Archiving never overwrites
 * an existing `.changes/archive/<version>/` file, and a failed archive reports
 * what moved and what did not. A run prints `ARCHIVED=1` only when it really
 * consumed the fragments.
 *
 * The workspace package `packages/llm-omp` (`dsh-llm-omp-transports`) ships as
 * part of the same release and always carries the same version: the resolved
 * version is written to both package.json files, so one version input drives
 * both tags (`v<version>` and `dsh-llm-omp-transports@<version>`). The
 * transport version is checked against the tag the Release workflow creates
 * after publishing, and the version written here is exactly the one
 * `release.yml` publishes (that workflow skips an already-published version).
 *
 * Usage:
 *   node scripts/prepare-release.mjs           # auto bump
 *   node scripts/prepare-release.mjs 0.2.0     # explicit version
 *   node scripts/prepare-release.mjs --dry-run # validate + print, write nothing
 *
 * Exit codes: 0 = bumped (or dry-run resolved) and printed versions; 1 =
 * rejected (unparseable version, existing tag, no changelog bullets in
 * `.changes/unreleased/`, an archive destination that already exists, an
 * archive move that failed, unparseable current package.json version, invalid
 * prerelease dist-tag, or CHANGELOG.md write error).
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(REPO_ROOT, 'package.json')
const TRANSPORTS_PKG_PATH = join(REPO_ROOT, 'packages/llm-omp/package.json')
const TRANSPORT_PACKAGE = 'dsh-llm-omp-transports'
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md')
const CHANGELOG_HEADER =
  '# Changelog\n\nAll notable changes to dsh-keys-manager are documented here. Assembled from `.changes/unreleased/` fragments by the release-prep workflow.\n'
const UNRELEASED_DIR = join(REPO_ROOT, '.changes/unreleased')
const ARCHIVE_DIR = join(REPO_ROOT, '.changes/archive')
const DEFAULT_CATEGORY = 'Changed'

/**
 * Parse X.Y.Z or X.Y.Z[-prerelease] (numeric parts; optional prerelease
 * suffix); null when not parseable. The suffix character set matches the
 * workflows' guard regex `[0-9A-Za-z.-]+` (keep-simple: no leading-zero or
 * empty-identifier rules), with one tightening: the suffix MUST contain at
 * least one digit, so `1.2.3-alpha.1` / `1.2.3-rc.2` parse but `1.2.3-alpha`
 * (no numeric identifier) and `1.2.3-` (empty suffix) are rejected. Returns
 * { major, minor, patch, prerelease? } — prerelease is the raw suffix text
 * (e.g. 'alpha.1') when present, undefined for formal versions.
 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]*[0-9][0-9A-Za-z.-]*))?$/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? undefined : match[4],
  }
}

/**
 * Refuse a prerelease whose derived npm dist-tag the release workflow would
 * reject, for either package. The tag is the text between the first '-' and
 * the first '.' after it ("alpha.1" -> "alpha").
 */
function assertPublishablePrerelease(prerelease) {
  if (prerelease === undefined) return
  const distTag = prerelease.split('.')[0]
  if (distTag === 'latest' || !/^[a-z][a-z0-9-]*$/.test(distTag)) {
    console.error(
      `Error: prerelease "${prerelease}" maps to invalid npm dist-tag "${distTag}". ` +
        'Use a prerelease such as alpha.1, beta.1, or rc.1.',
    )
    process.exit(1)
  }
}

/**
 * Parse CLI flags. The first non-flag argument is the target version.
 */
function parseArgs(argv) {
  const parsed = { versionArg: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') parsed.dryRun = true
    else if (arg.startsWith('--')) usage(`unknown option "${arg}"`)
    else if (parsed.versionArg === undefined) parsed.versionArg = arg
    else usage(`unexpected extra argument "${arg}"`)
  }
  return parsed
}

function usage(message) {
  console.error(`Error: ${message}.`)
  console.error(
    'Usage: node scripts/prepare-release.mjs [X.Y.Z[-prerelease]] [--dry-run]',
  )
  process.exit(1)
}

/**
 * Resolve an explicit target version, or auto-bump the current one.
 *
 * Auto bump (mirrors sibling dsh-llm-fallbacks autoBumpPatch): parse the
 * current version as X.Y.Z or X.Y.Z-pre, then:
 *  - formal version X.Y.Z            -> X.Y.(Z+1)       (0.1.2 -> 0.1.3)
 *  - prerelease with numeric tail    -> bump only the tail, staying on the
 *    prerelease line (0.1.3-alpha.3 -> 0.1.3-alpha.4)
 *  - prerelease with non-numeric tail (e.g. 0.1.0-alpha) -> cannot auto
 *    bump; require an explicit version argument.
 * The looser regex is deliberate: parseVersion (explicit args) requires a
 * digit in the suffix, so it cannot tell "alpha" from a malformed version;
 * this path needs the raw suffix to reject non-numeric tails with the
 * explicit-version hint.
 */
function resolveTarget(explicit, current, label) {
  if (explicit !== undefined) {
    const target = parseVersion(explicit)
    if (target === null) {
      console.error(
        `Error: invalid version "${explicit}". Expected X.Y.Z or X.Y.Z-prerelease (e.g. 0.2.0, 0.1.1-alpha.1).`,
      )
      process.exit(1)
    }
    return target
  }
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(current)
  if (!m) {
    console.error(`Error: cannot parse current ${label} version "${current}".`)
    process.exit(1)
  }
  const [, major, minor, patch, pre] = m
  if (pre === undefined) {
    return { major: Number(major), minor: Number(minor), patch: Number(patch) + 1 }
  }
  const tail = pre.split('.').at(-1)
  if (tail === undefined || !/^\d+$/.test(tail)) {
    console.error(
      `Error: cannot auto-bump "${current}": prerelease tail "${pre}" is not numeric. ` +
        'Pass an explicit version instead (e.g. `node scripts/prepare-release.mjs 0.1.1-alpha.1`).',
    )
    process.exit(1)
  }
  const prefix = pre.slice(0, pre.length - tail.length) // "alpha." for "alpha.1"
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: `${prefix}${Number(tail) + 1}`,
  }
}

function formatVersion(target) {
  return target.prerelease === undefined
    ? `${target.major}.${target.minor}.${target.patch}`
    : `${target.major}.${target.minor}.${target.patch}-${target.prerelease}`
}

/** Whether an exact tag ref exists. */
function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Split an optional leading `---` frontmatter block off a fragment. Only
 * `key: value` lines are read; the rest of the file is the body.
 */
function parseFrontmatter(text) {
  const frontmatter = {}
  if (!text.startsWith('---')) return { frontmatter, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { frontmatter, body: text }
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z0-9 _-]+):\s*(.*)$/.exec(line)
    if (match) frontmatter[match[1].trim()] = match[2].trim()
  }
  return { frontmatter, body: text.slice(end + 4).replace(/^\n/, '') }
}

/**
 * One fragment file -> its grouping category (undefined = default), its bullet
 * lines, and how many other non-blank body lines were ignored. Only lines that
 * start with `- ` after trimming (and carry text after the dash) are release
 * notes; prose cannot pass for a bullet, so a fragment of prose renders an
 * empty body and the caller refuses the release instead of publishing a
 * paragraph as a changelog entry.
 */
export function parseFragment(file, text) {
  const { frontmatter, body } = parseFrontmatter(text)
  const bullets = []
  let dropped = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('- ') && trimmed.slice(2).trim().length > 0) bullets.push(trimmed)
    else dropped += 1
  }
  return {
    file,
    category: frontmatter.category?.trim() || undefined,
    bullets,
    dropped,
  }
}

/**
 * Fragments in filename order. `README.md` (the format doc) and every
 * non-`.md` entry (`.gitkeep`) are skipped; a missing directory is zero
 * fragments, which the caller refuses for a real release.
 */
export function readFragments(dir = UNRELEASED_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort()
    .map((file) => parseFragment(file, readFileSync(join(dir, file), 'utf8')))
}

/**
 * Render the section body: `### <category>` + its bullets, categories in
 * first-seen order (a fragment without `category:` lands under `Changed`).
 * A fragment with no bullets contributes nothing — not even a bullet-less
 * heading — so "every fragment is empty" really renders an empty body and the
 * caller can refuse it.
 */
export function buildSectionBody(fragments) {
  const groups = []
  for (const fragment of fragments) {
    if (fragment.bullets.length === 0) continue
    const category = fragment.category ?? DEFAULT_CATEGORY
    let group = groups.find((candidate) => candidate.category === category)
    if (group === undefined) {
      group = { category, bullets: [] }
      groups.push(group)
    }
    group.bullets.push(...fragment.bullets)
  }
  return groups
    .map((group) => [`### ${group.category}`, '', ...group.bullets].join('\n'))
    .join('\n\n')
}

/**
 * Why this fragment set cannot be released, or null when it can. The rendered
 * body IS the release notes, so an empty body — no fragments at all, fragments
 * that are prose only, or fragments whose `- ` lines carry no text — would
 * publish an empty section: refuse it. The message names the files that
 * contributed nothing. Exported so a caller (CI, a test) can ask the same
 * question without running the release flow.
 */
export function notesRefusal(fragments) {
  if (buildSectionBody(fragments).trim() !== '') return null
  const empties = fragments
    .filter((fragment) => fragment.bullets.length === 0)
    .map((fragment) => fragment.file)
  return (
    'no changelog bullets in .changes/unreleased/ — nothing to release. ' +
    'Add one `- ` bullet per user-visible change (format: .changes/unreleased/README.md).' +
    (empties.length === 0 ? '' : ` Fragment files without bullets: ${empties.join(', ')}.`)
  )
}

/**
 * Insert a `## [<version>] - <date>` section above the first existing
 * `## [` section (or after the header block when there is none yet).
 * Everything at and below the insertion point keeps its bytes, including the
 * file's trailing-newline state (a split/splice/join round-trip would
 * re-normalize line breaks).
 */
export function insertSection(changelog, version, date, body) {
  const header = `## [${version}] - ${date}`
  const section = body.trim() === '' ? `${header}\n` : `${header}\n\n${body.trim()}\n`
  const firstSectionMatch = /^## \[/m.exec(changelog)
  if (firstSectionMatch === null) {
    // No sections yet — append the new section after the header block.
    return changelog.endsWith('\n')
      ? `${changelog}\n${section}`
      : `${changelog}\n\n${section}`
  }
  return `${changelog.slice(0, firstSectionMatch.index)}${section}\n${changelog.slice(firstSectionMatch.index)}`
}

/**
 * Write the new section into CHANGELOG.md and report whether it was written.
 * Preserves all existing sections; no-op (returns false) when the section for
 * this version already exists, so a re-run must not duplicate it and must not
 * consume fragments it never rendered. A 0-byte or whitespace-only file (e.g.
 * manual truncation) is treated as missing, so it still boots with the
 * standard header instead of a section above no header at all. Write failures
 * exit 1.
 */
function updateChangelog(version, body) {
  let content
  try {
    content = readFileSync(CHANGELOG_PATH, 'utf8')
  } catch {
    content = CHANGELOG_HEADER
  }
  if (content.trim() === '') {
    content = CHANGELOG_HEADER
  }

  if (content.includes(`## [${version}]`)) {
    return false
  }

  const next = insertSection(content, version, new Date().toISOString().slice(0, 10), body)

  try {
    writeFileSync(CHANGELOG_PATH, next, 'utf8')
  } catch (error) {
    console.error(`Error: cannot write ${CHANGELOG_PATH}: ${error.message}`)
    process.exit(1)
  }
  return true
}

/**
 * Move the consumed fragments to `.changes/archive/<version>/`.
 *
 * Authored release notes are never overwritten: a destination file that
 * already exists refuses the whole move before anything is renamed, so a
 * collision cannot leave the fragments half-archived. A move that fails
 * mid-way reports exactly which files were archived and which remain, then
 * exits 1 — a partially archived set must not be silently reported as done.
 * `FS_*` is not needed for that; the paths are printed verbatim.
 */
function archiveFragments(version, fragments) {
  if (fragments.length === 0) return true
  const destination = join(ARCHIVE_DIR, version)
  const moves = fragments.map((fragment) => ({
    file: fragment.file,
    from: join(UNRELEASED_DIR, fragment.file),
    to: join(destination, fragment.file),
  }))

  const collisions = moves.filter((move) => existsSync(move.to)).map((move) => move.to)
  if (collisions.length > 0) {
    console.error(
      `Error: refusing to overwrite archived release notes: ${collisions.join(', ')}. ` +
        'Move the existing files away (or pick another version) and re-run.',
    )
    process.exit(1)
  }

  const fail = (error, archived) => {
    const remaining = moves.slice(archived.length).map((candidate) => candidate.from)
    console.error(`Error: cannot archive fragments: ${error.message}`)
    console.error(
      `Archived (${archived.length}): ${archived.length === 0 ? 'none' : archived.join(', ')}.`,
    )
    console.error(`Remaining (${remaining.length}): ${remaining.join(', ')}.`)
    process.exit(1)
  }

  const archived = []
  try {
    mkdirSync(destination, { recursive: true })
  } catch (error) {
    fail(error, archived)
  }
  for (const move of moves) {
    try {
      renameSync(move.from, move.to)
    } catch (error) {
      fail(error, archived)
    }
    archived.push(move.file)
  }
  return true
}

function main() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  const transportsPkg = JSON.parse(readFileSync(TRANSPORTS_PKG_PATH, 'utf8'))

  const { versionArg, dryRun } = parseArgs(process.argv.slice(2))

  const target = resolveTarget(versionArg, pkg.version, 'package.json')
  const version = formatVersion(target)

  // Validate the npm dist-tag derived by the release workflow. A prerelease
  // identifier like "latest" would move the stable tag, and a numeric one like
  // "1" is not a legal npm tag. Reject both before the release PR is opened.
  assertPublishablePrerelease(target.prerelease)

  // The transports package ships from the same version as the root: one input
  // drives both package.json files, so the two can never drift.
  const transportVersion = version
  const transportTag = `${TRANSPORT_PACKAGE}@${transportVersion}`

  // Reject already-released versions: the tag exists iff the version was
  // released. Works unchanged for prerelease tags (v0.1.1-alpha.1 is a plain
  // tag name). Run from REPO_ROOT so the check is cwd-independent.
  if (tagExists(`v${version}`)) {
    console.error(`Error: tag v${version} already exists — this version is already released.`)
    process.exit(1)
  }
  if (tagExists(transportTag)) {
    console.error(`Error: tag ${transportTag} already exists — this transport version is already released.`)
    process.exit(1)
  }

  // The fragments are the only release-notes source, so a release whose
  // rendered body is empty — no fragments at all, or only fragments with no
  // bullet lines — would publish an empty `## [<version>]` section: refuse
  // instead, on a dry run too (a dry run is release validation, not an
  // exemption). Prose that looks like notes is not a bullet; it is reported
  // below and never rendered.
  const fragments = readFragments()
  for (const fragment of fragments) {
    if (fragment.dropped > 0) {
      console.error(
        `Notice: ${fragment.file}: ignored ${fragment.dropped} non-bullet line(s) — notes publish only "- " bullets.`,
      )
    }
  }
  const refusal = notesRefusal(fragments)
  if (refusal !== null) {
    console.error(`Error: ${refusal}`)
    process.exit(1)
  }
  const body = buildSectionBody(fragments)

  // Whether this run actually moved the fragments into the archive, so a
  // caller can tell "release prepared" from "nothing consumed" (dry run, or an
  // existing section for this version) without guessing from the tree.
  let archived = false

  // Write only outside a dry run: a dry run validates and prints the resolved
  // versions exactly like a real run, then leaves the working tree untouched.
  if (!dryRun) {
    pkg.version = version
    // Preserve repo formatting: 2-space indent + trailing newline. Bumping only
    // the version keeps `git diff package.json` to that one line.
    writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

    transportsPkg.version = transportVersion
    writeFileSync(TRANSPORTS_PKG_PATH, `${JSON.stringify(transportsPkg, null, 2)}\n`, 'utf8')

    // Root changelog only: the transports package has no generated changelog.
    // Fragments are archived only when this run rendered them: an existing
    // section (idempotent re-run) must not consume them unrendered.
    if (updateChangelog(version, body)) {
      archived = archiveFragments(version, fragments)
    } else {
      console.error(
        `Notice: CHANGELOG.md already has a "## [${version}]" section — fragments left in .changes/unreleased/: ${fragments.map((fragment) => fragment.file).join(', ')}.`,
      )
    }
  }

  // The workflow captures VERSION; the remaining lines are informational and
  // let a dry run show both derived tags without touching the tree.
  if (dryRun) console.log('DRY_RUN=1')
  console.log(`FRAGMENTS=${fragments.length}`)
  console.log(`VERSION=${version}`)
  console.log(`TAG=v${version}`)
  console.log(`TRANSPORT_VERSION=${transportVersion}`)
  console.log(`TRANSPORT_TAG=${transportTag}`)
  console.log(`ARCHIVED=${archived ? 1 : 0}`)
}

/**
 * Whether this module is the entry point of the running process. Compared by
 * real path, not by string: a symlinked checkout (macOS `/tmp` ->
 * `/private/tmp`, a linked worktree, an npm bin shim) runs `argv[1]` through a
 * different path than `import.meta.url`, and a string comparison would silently
 * no-op the whole release flow. Importing the module (tests) stays a no-op.
 */
function isDirectExecution() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Run only when executed directly (node scripts/prepare-release.mjs):
// importing the module (tests) must not start the release flow.
if (isDirectExecution()) {
  main()
}
