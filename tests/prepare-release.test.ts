/**
 * Release tooling: the changelog section is assembled from authored
 * `.changes/unreleased/*.md` fragments. The fragment parsing/grouping and the
 * section insertion are pure helpers, so they are asserted directly; the
 * directory reader is exercised on a temp directory (skip rules + filename
 * order). The zero-fragment refusal itself lives in `main()` (it exits the
 * process), so the reader's empty list is what is asserted here.
 */
// @ts-ignore — scripts/prepare-release.mjs is plain Node ESM without type declarations.
import { buildSectionBody, insertSection, parseFragment, readFragments } from '../scripts/prepare-release.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a throwaway fragment directory holding exactly `files`. */
function fragmentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-release-fragments-'))
  tempDirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('parseFragment', () => {
  it('keeps bullet lines verbatim and defaults to no category', () => {
    const fragment = parseFragment('plain.md', '- add provider foo\n- keep  inner spacing\n\n')

    expect(fragment).toEqual({
      file: 'plain.md',
      category: undefined,
      bullets: ['- add provider foo', '- keep  inner spacing'],
    })
  })

  it('reads the category from frontmatter and drops the frontmatter from the body', () => {
    const fragment = parseFragment('added.md', '---\ncategory: Added\n---\n- new transport\n')

    expect(fragment.category).toBe('Added')
    expect(fragment.bullets).toEqual(['- new transport'])
  })
})

describe('buildSectionBody', () => {
  it('groups by category in first-seen order and defaults to Changed', () => {
    const body = buildSectionBody([
      parseFragment('a.md', '- first change\n'),
      parseFragment('b.md', '---\ncategory: Added\n---\n- new provider\n'),
      parseFragment('c.md', '- second change\n'),
    ])

    expect(body).toBe('### Changed\n\n- first change\n- second change\n\n### Added\n\n- new provider')
  })

  it('renders nothing for zero fragments so the caller refuses the release', () => {
    expect(buildSectionBody([])).toBe('')
  })

  it('renders nothing for a frontmatter-only fragment (no bullets to publish)', () => {
    const body = buildSectionBody([
      parseFragment('empty.md', '---\ncategory: Added\n---\n'),
      parseFragment('blank.md', '\n   \n'),
    ])

    expect(body).toBe('')
  })
})

describe('readFragments', () => {
  it('reports an empty list for an empty fragment directory', () => {
    expect(readFragments(fragmentDir({}))).toEqual([])
  })

  it('reads .md fragments in filename order and skips README.md, .gitkeep and non-.md entries', () => {
    const dir = fragmentDir({
      'README.md': '# Change fragments\n',
      '.gitkeep': '',
      'b-second.md': '- second\n',
      'a-first.md': '- first\n',
      'notes.txt': '- not a fragment\n',
    })

    const fragments = readFragments(dir)

    expect(fragments.map((fragment: { file: string }) => fragment.file)).toEqual([
      'a-first.md',
      'b-second.md',
    ])
    expect(fragments.map((fragment: { bullets: string[] }) => fragment.bullets)).toEqual([
      ['- first'],
      ['- second'],
    ])
  })
})

describe('insertSection', () => {
  const changelog = '# Changelog\n\nIntro line.\n\n## [0.2.2] - 2026-10-21\n\n- old entry\n'

  it('places the new section above the existing versions and keeps the header block', () => {
    const next = insertSection(changelog, '0.3.0', '2026-10-22', '### Added\n\n- new provider')

    expect(next).toBe(
      '# Changelog\n\nIntro line.\n\n## [0.3.0] - 2026-10-22\n\n### Added\n\n- new provider\n\n' +
        '## [0.2.2] - 2026-10-21\n\n- old entry\n',
    )
  })

  it('appends after the header block when no version section exists yet', () => {
    const next = insertSection('# Changelog\n\nIntro line.\n', '0.1.0', '2026-10-21', '### Changed\n\n- first')

    expect(next).toBe(
      '# Changelog\n\nIntro line.\n\n## [0.1.0] - 2026-10-21\n\n### Changed\n\n- first\n',
    )
  })
})
