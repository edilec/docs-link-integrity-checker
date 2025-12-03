import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(projectDirectory, 'bin/docs-link-integrity-checker.mjs')

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: projectDirectory, encoding: 'utf8' })
}

const CLEAN = ['--root', 'examples/docs-clean']
const BROKEN = ['--root', 'examples/docs-broken']
const STATUS = ['--status', 'examples/link-status.json']

test('the healthy example with an imported status exits zero', () => {
  const result = run([...CLEAN, ...STATUS])

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /status pass/)
  assert.match(result.stdout, /2 verified from an imported status, 0 unverified/)
})

test('a single broken local link fails the run and exits one', async () => {
  const base = await mkdtemp(join(tmpdir(), 'docs-link-integrity-cli-'))
  try {
    await writeFile(join(base, 'index.md'), '# Index\n\nA [missing file](gone.md) link.\n', 'utf8')
    const result = run(['--root', base, '--json'])
    const report = JSON.parse(result.stdout)

    // One broken local link is the only thing wrong here, so the exit code and
    // the status are pinned to that single error and nothing else.
    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].ruleId, 'local-target-missing')
    assert.equal(report.findings[0].severity, 'error')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.status, 'fail')
    assert.equal(result.status, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the broken example exits one and names every rule it broke', () => {
  const result = run(BROKEN)

  assert.equal(result.status, 1)
  assert.match(result.stdout, /status fail/)
  for (const ruleId of [
    'local-target-missing',
    'fragment-missing',
    'path-escapes-root',
    'unsafe-target',
    'directory-target',
    'empty-target',
    'duplicate-anchor',
  ]) {
    assert.match(result.stdout, new RegExp(ruleId))
  }
})

test('a traversal link is refused through the real CLI', () => {
  const result = run([...BROKEN, '--json'])
  const report = JSON.parse(result.stdout)
  const refusals = report.findings.filter((finding) => finding.ruleId === 'path-escapes-root')

  assert.equal(refusals.length, 2)
  assert.deepEqual(refusals.map((finding) => finding.target).sort(), [
    '../../../../etc/passwd',
    '/../../secrets.txt',
  ])
  assert.equal(result.stdout.includes('/etc/passwd:'), false)
})

test('external links without an imported status make the run incomplete, never a pass', () => {
  const result = run(CLEAN)

  assert.equal(result.status, 2)
  assert.match(result.stdout, /status incomplete/)
  assert.match(result.stdout, /link-unverified/)
  assert.match(result.stderr, /incomplete: 2 unverified external link\(s\)/)
})

test('--json puts the report on stdout and diagnostics on stderr', () => {
  const passing = run([...CLEAN, ...STATUS, '--json'])
  assert.equal(passing.stderr, '')
  const report = JSON.parse(passing.stdout)
  assert.equal(report.tool, 'docs-link-integrity-checker')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.status, 'pass')

  const incomplete = run([...CLEAN, '--json'])
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete')
  assert.notEqual(incomplete.stderr, '')
})

test('no finding leaks an absolute host path', () => {
  const report = JSON.parse(run([...BROKEN, '--json']).stdout)

  // An empty findings array would satisfy the loop below for the wrong reason.
  assert.equal(report.findings.length, 11)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false)
    assert.equal(finding.location.file.includes(projectDirectory), false)
  }
})

test('repeated runs produce byte-identical stdout', () => {
  const args = [...BROKEN, '--json']
  const broken = run(args)

  // Two crashed runs would also agree on an empty stdout.
  assert.equal(broken.status, 1)
  assert.equal(JSON.parse(broken.stdout).findings.length, 11)
  assert.equal(broken.stdout, run(args).stdout)

  const cleanArgs = [...CLEAN, ...STATUS, '--json']
  const clean = run(cleanArgs)
  assert.equal(clean.status, 0)
  assert.equal(JSON.parse(clean.stdout).summary.links, 12)
  assert.equal(clean.stdout, run(cleanArgs).stdout)
})

test('a bound that is exceeded is reported and exits two', () => {
  const result = run([...CLEAN, ...STATUS, '--max-file-bytes', '64', '--json'])
  const report = JSON.parse(result.stdout)

  assert.equal(result.status, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 3)
  assert.equal(report.findings.every((finding) => finding.ruleId === 'file-too-large'), true)
  assert.equal(report.summary.checked, 0)
})

test('--help documents the surface and exits zero', () => {
  const result = run(['--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /--root DIR/)
  assert.match(result.stdout, /--status FILE/)
  assert.match(result.stdout, /Exit codes/)
  assert.equal(result.stderr, '')
})

test('invalid usage exits two without writing a report', () => {
  const missingRoot = run(['--json'])
  assert.equal(missingRoot.status, 2)
  assert.equal(missingRoot.stdout, '')
  assert.match(missingRoot.stderr, /--root is required/)

  const unknown = run([...CLEAN, '--fetch'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown option "--fetch"/)

  const badLimit = run([...CLEAN, '--max-depth', 'deep'])
  assert.equal(badLimit.status, 2)
  assert.match(badLimit.stderr, /positive integer/)
})

test('unreadable input exits two rather than passing', () => {
  const missingRoot = run(['--root', 'examples/does-not-exist'])
  assert.equal(missingRoot.status, 2)
  assert.equal(missingRoot.stdout, '')
  assert.match(missingRoot.stderr, /could not be read/)

  const missingStatus = run([...CLEAN, '--status', 'examples/does-not-exist.json'])
  assert.equal(missingStatus.status, 2)
  assert.match(missingStatus.stderr, /Could not read status import/)
})
