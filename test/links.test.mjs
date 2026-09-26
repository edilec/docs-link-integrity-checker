import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  checkDocumentationLinks,
  classifyTarget,
  isInside,
  parseMarkdown,
  slugify,
  validateStatusImport,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cleanRoot = join(projectDirectory, 'examples/docs-clean')
const brokenRoot = join(projectDirectory, 'examples/docs-broken')

const STATUS = {
  schemaVersion: '1',
  checkedAt: '2026-09-01T00:00:00Z',
  links: {
    'https://example.com/urls': { state: 'ok', httpStatus: 200, anchors: ['fragments'] },
    'https://nodejs.org/api/path.html': { state: 'ok', httpStatus: 200 },
  },
}

function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

/** Build a throwaway documentation tree; files is a map of relative path to text. */
async function withTree(files, run) {
  const base = await mkdtemp(join(tmpdir(), 'docs-link-integrity-'))
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = join(base, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents, 'utf8')
    }
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('the healthy example passes with an imported status document', async () => {
  const report = await checkDocumentationLinks({ root: cleanRoot, status: STATUS })

  assert.equal(report.status, 'pass')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'docs-link-integrity-checker')
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.links, 12)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.unverified, 0)
  assert.equal(report.summary.verified, 2)
  assert.equal(report.summary.statusCheckedAt, '2026-09-01T00:00:00Z')
})

test('a link to a file that is not there is an error that fails the run', async () => {
  await withTree(
    {
      'docs/index.md': '# Index\n\nA [missing file](gone.md) link.\n',
    },
    async (base) => {
      const report = await checkDocumentationLinks({ root: join(base, 'docs') })
      const missing = findingsFor(report, 'local-target-missing')

      // The severity is the whole point of the tool: a broken local link must
      // fail the run, not merely mention itself in a warning.
      assert.equal(missing.length, 1)
      assert.equal(missing[0].severity, 'error')
      assert.equal(missing[0].target, 'gone.md')
      assert.equal(missing[0].location.file, 'index.md')
      assert.equal(report.findings.length, 1)
      assert.equal(report.summary.errors, 1)
      assert.equal(report.summary.warnings, 0)
      assert.equal(report.status, 'fail')
    },
  )
})

test('broken local fragments are located by file, line and anchor', async () => {
  const report = await checkDocumentationLinks({ root: brokenRoot })
  const fragments = findingsFor(report, 'fragment-missing')

  assert.equal(report.status, 'fail')
  assert.equal(fragments.length, 3)

  const crossFile = fragments.find((finding) => finding.target === 'notes.md#instalation')
  assert.equal(crossFile.location.file, 'index.md')
  assert.equal(crossFile.location.pointer, '/links/1')
  assert.equal(crossFile.line, 9)
  assert.equal(crossFile.severity, 'error')
  assert.match(crossFile.message, /notes\.md/)

  const samePage = fragments.find((finding) => finding.target === '#overveiw')
  assert.equal(samePage.location.file, 'index.md')
  assert.equal(samePage.line, 15)
  assert.match(samePage.message, /this document/)

  const inGuide = fragments.find((finding) => finding.location.file === 'guide/reference.md')
  assert.equal(inGuide.target, '#refrence')
  assert.equal(inGuide.severity, 'error')
})

test('a heading that does exist resolves, including its duplicate suffix', async () => {
  const report = await checkDocumentationLinks({ root: brokenRoot })
  const offenders = report.findings.filter((finding) => finding.location.file === 'notes.md')

  assert.deepEqual(offenders, [])
  assert.equal(findingsFor(report, 'duplicate-anchor').length, 1)
  assert.match(findingsFor(report, 'duplicate-anchor')[0].suggestion, /overview-1/)
})

test('a traversal link is refused and nothing outside the root is read', async () => {
  await withTree(
    {
      'outside/credentials.md': '# Outside\n\nMARKER-OUTSIDE-THE-ROOT\n',
      'docs/index.md': '# Index\n\nA [traversal](../outside/credentials.md) attempt.\n',
    },
    async (base) => {
      const report = await checkDocumentationLinks({ root: join(base, 'docs') })
      const refusals = findingsFor(report, 'path-escapes-root')

      assert.equal(refusals.length, 1)
      assert.equal(refusals[0].severity, 'error')
      assert.equal(refusals[0].location.file, 'index.md')
      assert.equal(refusals[0].target, '../outside/credentials.md')
      assert.equal(report.status, 'fail')
      assert.equal(JSON.stringify(report).includes('MARKER-OUTSIDE-THE-ROOT'), false)
      assert.equal(JSON.stringify(report).includes(base), false)
    },
  )
})

test('a root-relative link cannot climb out of the root either', async () => {
  await withTree(
    {
      'outside/credentials.md': '# Outside\n',
      'docs/index.md': '# Index\n\nA [root-relative escape](/../outside/credentials.md).\n',
    },
    async (base) => {
      const report = await checkDocumentationLinks({ root: join(base, 'docs') })

      assert.equal(findingsFor(report, 'path-escapes-root').length, 1)
      assert.equal(findingsFor(report, 'local-target-missing').length, 0)
    },
  )
})

test('a symlink pointing out of the root is refused at resolution time', async () => {
  await withTree(
    {
      'outside/secret.md': '# Secret\n\n## Real Heading\n',
      'docs/index.md': '# Index\n\nVia [an alias](alias.md#real-heading).\n',
    },
    async (base) => {
      await symlink(join(base, 'outside/secret.md'), join(base, 'docs/alias.md'))
      const report = await checkDocumentationLinks({ root: join(base, 'docs') })

      const refusals = findingsFor(report, 'path-escapes-root')
      assert.equal(refusals.length, 1)
      assert.match(refusals[0].message, /symbolic link/)
      assert.equal(findingsFor(report, 'symlink-skipped').length, 1)
      assert.equal(report.summary.checked, 1)
    },
  )
})

test('external links are unverified without an imported status, which is never a pass', async () => {
  const report = await checkDocumentationLinks({ root: cleanRoot })
  const unverified = findingsFor(report, 'link-unverified')

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.unverified, 2)
  assert.equal(unverified.length, 2)
  assert.match(unverified[0].message, /never fetches/)
})

test('an imported status can verify, break or leave an address unknown', async () => {
  await withTree(
    {
      'docs/index.md': [
        '# Index',
        '',
        '- [ok](https://example.com/ok)',
        '- [gone](https://example.com/gone)',
        '- [unknown](https://example.com/pending)',
        '- [fragment](https://example.com/ok#section)',
        '',
      ].join('\n'),
    },
    async (base) => {
      const status = {
        schemaVersion: '1',
        links: {
          'https://example.com/ok': { state: 'ok', httpStatus: 200 },
          'https://example.com/gone': { state: 'broken', httpStatus: 404 },
          'https://example.com/pending': { state: 'unknown' },
        },
      }
      const report = await checkDocumentationLinks({ root: join(base, 'docs'), status })

      assert.equal(findingsFor(report, 'external-broken').length, 1)
      assert.match(findingsFor(report, 'external-broken')[0].message, /HTTP 404/)
      assert.equal(findingsFor(report, 'link-unverified').length, 2)
      assert.equal(report.status, 'incomplete')

      const covered = { ...status }
      covered.links = {
        ...status.links,
        'https://example.com/pending': { state: 'ok' },
        'https://example.com/ok': { state: 'ok', anchors: ['section'] },
      }
      const second = await checkDocumentationLinks({ root: join(base, 'docs'), status: covered })
      assert.equal(second.summary.unverified, 0)
      assert.equal(second.status, 'fail')
    },
  )
})

test('a malformed status import is a configuration error, not a silent pass', async () => {
  await assert.rejects(
    () => checkDocumentationLinks({ root: cleanRoot, status: { schemaVersion: '2', links: {} } }),
    /Unsupported status import schemaVersion/,
  )
  await assert.rejects(
    () => checkDocumentationLinks({ root: cleanRoot, status: { schemaVersion: '1', links: { 'https://a': { state: 'maybe' } } } }),
    /unsupported state/,
  )
  assert.throws(() => validateStatusImport({ schemaVersion: '1', links: { 'https://a': { state: 'ok', anchors: [7] } } }), /anchors as strings/)
})

test('an unreadable root and an unknown limit are refused', async () => {
  await assert.rejects(() => checkDocumentationLinks({ root: join(cleanRoot, 'nope') }), /could not be read/)
  await assert.rejects(() => checkDocumentationLinks({ root: '' }), /root is required/)
  await assert.rejects(
    () => checkDocumentationLinks({ root: cleanRoot, limits: { maxThings: 3 } }),
    /Unknown limit/,
  )
  await assert.rejects(
    () => checkDocumentationLinks({ root: cleanRoot, limits: { maxDepth: 0 } }),
    /positive integer/,
  )
})

test('a file over the byte limit is reported, never silently skipped', async () => {
  await withTree(
    {
      'docs/index.md': `# Index\n\n${'padding '.repeat(200)}\n`,
    },
    async (base) => {
      const report = await checkDocumentationLinks({ root: join(base, 'docs'), limits: { maxFileBytes: 64 } })

      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'file-too-large').length, 1)
      assert.match(findingsFor(report, 'file-too-large')[0].message, /maxFileBytes limit of 64/)
      assert.equal(report.summary.skipped, 1)
      assert.equal(report.summary.checked, 0)
    },
  )
})

test('the entry, link and depth limits each report rather than truncate', async () => {
  await withTree(
    {
      'docs/a.md': '# A\n',
      'docs/b.md': '# B\n',
      'docs/c.md': '# C\n',
      'docs/nested/deep/deeper/leaf.md': '# Leaf\n',
      'docs/many.md': `# Many\n\n${'[x](a.md) '.repeat(5)}\n`,
    },
    async (base) => {
      const root = join(base, 'docs')

      const files = await checkDocumentationLinks({ root, limits: { maxFiles: 2 } })
      assert.equal(files.status, 'incomplete')
      assert.equal(findingsFor(files, 'too-many-files').length, 1)

      const links = await checkDocumentationLinks({ root, limits: { maxLinksPerFile: 4 } })
      assert.equal(links.status, 'incomplete')
      assert.match(findingsFor(links, 'too-many-links')[0].message, /none of them were checked/)

      const depth = await checkDocumentationLinks({ root, limits: { maxDepth: 2 } })
      assert.equal(depth.status, 'incomplete')
      assert.equal(findingsFor(depth, 'directory-too-deep').length, 1)
      assert.equal(findingsFor(depth, 'directory-too-deep')[0].location.file, 'nested/deep/deeper')
    },
  )
})

test('the same input produces a byte-identical report twice', async () => {
  const first = await checkDocumentationLinks({ root: brokenRoot })
  const second = await checkDocumentationLinks({ root: brokenRoot })

  // Comparing two empty reports would agree for the wrong reason.
  assert.equal(first.findings.length, 11)
  assert.equal(JSON.stringify(first, null, 2), JSON.stringify(second, null, 2))

  const clean = await checkDocumentationLinks({ root: cleanRoot, status: STATUS })
  const cleanAgain = await checkDocumentationLinks({ root: cleanRoot, status: STATUS })
  assert.equal(clean.summary.links, 12)
  assert.equal(JSON.stringify(clean), JSON.stringify(cleanAgain))
})

test('findings sort by file, then document order, then rule', async () => {
  const report = await checkDocumentationLinks({ root: brokenRoot })

  // The whole order is pinned, over a fixture with findings in two documents,
  // so reversing any sort key is a failure rather than an invisible reshuffle.
  // The duplicate-anchor row is file-level, so it sorts ahead of every link
  // finding in its file even though its line is the last one.
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.line, finding.ruleId]),
    [
      ['guide/reference.md', 6, 'local-target-missing'],
      ['guide/reference.md', 7, 'fragment-missing'],
      ['index.md', 17, 'duplicate-anchor'],
      ['index.md', 8, 'local-target-missing'],
      ['index.md', 9, 'fragment-missing'],
      ['index.md', 10, 'path-escapes-root'],
      ['index.md', 11, 'path-escapes-root'],
      ['index.md', 12, 'unsafe-target'],
      ['index.md', 13, 'directory-target'],
      ['index.md', 14, 'empty-target'],
      ['index.md', 15, 'fragment-missing'],
    ],
  )
})

test('findings that share a document order break the tie by rule, then target', async () => {
  await withTree(
    {
      'docs/ties.md': [
        '# Ties',
        '',
        '## Beta',
        '',
        '## Beta',
        '',
        '## Alpha',
        '',
        '## Alpha',
        '',
        '[a](ties.md) [b](ties.md) [c](ties.md)',
        '',
      ].join('\n'),
    },
    async (base) => {
      const report = await checkDocumentationLinks({
        root: join(base, 'docs'),
        limits: { maxLinksPerFile: 2 },
      })

      // Every row here is file-level, so all three share document order -1 and
      // are recorded in the order beta, alpha, too-many-links: the rule id
      // decides first, then the raw target.
      assert.deepEqual(
        report.findings.map((finding) => [finding.ruleId, finding.target ?? null]),
        [
          ['duplicate-anchor', 'alpha'],
          ['duplicate-anchor', 'beta'],
          ['too-many-links', null],
        ],
      )
    },
  )
})

test('code, comments and scripts are not mistaken for links', async () => {
  await withTree(
    {
      'docs/index.md': [
        '# Index',
        '',
        '```md',
        '[fenced](nowhere-fenced.md)',
        '```',
        '',
        'Inline `[code](nowhere-inline.md)` stays code.',
        '',
        '<!-- [commented](nowhere-comment.md) -->',
        '',
        'A [real](other.md) link.',
        '',
      ].join('\n'),
      'docs/other.md': '# Other\n',
      'docs/page.html': [
        '<h1 id="page">Page</h1>',
        '<script>var x = "<a href=\'nowhere-script.md\'>x</a>";</script>',
        '<!-- <a href="nowhere-html-comment.md">x</a> -->',
        '<a href="other.md">real</a>',
      ].join('\n'),
    },
    async (base) => {
      const report = await checkDocumentationLinks({ root: join(base, 'docs') })

      assert.equal(report.status, 'pass')
      assert.equal(report.summary.links, 2)
      assert.equal(JSON.stringify(report).includes('nowhere'), false)
    },
  )
})

test('anchors come from Markdown headings and from HTML id attributes', () => {
  const parsed = parseMarkdown([
    '# Getting Started',
    '',
    '## Install the CLI',
    '',
    '## Install the CLI',
    '',
    '<span id="manual">x</span>',
    '',
    '### Custom {#chosen-id}',
    '',
  ].join('\n'))

  assert.deepEqual(
    [...parsed.anchors].sort(),
    ['chosen-id', 'getting-started', 'install-the-cli', 'install-the-cli-1', 'manual'].sort(),
  )
  assert.equal(parsed.duplicates.length, 1)
  assert.equal(parsed.duplicates[0].line, 5)
})

test('slugs are derived without locale-dependent folding', () => {
  assert.equal(slugify('Getting Started'), 'getting-started')
  assert.equal(slugify('`code` and **bold**'), 'code-and-bold')
  assert.equal(slugify('What? Why!'), 'what-why')
  assert.equal(slugify('Section 2.1 — Details'), 'section-21--details')
  assert.equal(slugify('<em>Tagged</em>'), 'tagged')
})

test('target classification separates local, external, scheme and unsafe', () => {
  assert.deepEqual(classifyTarget('  '), { kind: 'empty' })
  assert.equal(classifyTarget('https://example.com/a').kind, 'external')
  assert.equal(classifyTarget('//example.com/a').kind, 'external')
  assert.deepEqual(classifyTarget('mailto:a@example.com'), { kind: 'scheme', scheme: 'mailto' })
  assert.equal(classifyTarget('guide/x%00.md').kind, 'unsafe')
  assert.deepEqual(classifyTarget('guide/x.md?v=2#top'), {
    kind: 'local',
    path: 'guide/x.md',
    fragment: 'top',
    rootRelative: false,
  })
})

test('containment never accepts a sibling directory with a shared prefix', () => {
  assert.equal(isInside('/docs', '/docs/a.md'), true)
  assert.equal(isInside('/docs', '/docs'), true)
  assert.equal(isInside('/docs/', '/docs/a.md'), true)
  assert.equal(isInside('/docs', '/docs-private/a.md'), false)
  assert.equal(isInside('/docs', '/etc/passwd'), false)
})

test('the declared default limits are the documented ones', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    maxFiles: 2000,
    maxFileBytes: 1048576,
    maxLinksPerFile: 2000,
    maxDepth: 12,
  })
})
