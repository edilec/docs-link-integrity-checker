import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. Two dozen construction sites each carrying
 * their own literal is exactly the shape that drifts silently; these tests
 * assert the single table, the documented catalog and the shipped source all
 * agree.
 */

async function documentedSeverities() {
  const text = await readFile(resolve(projectDirectory, 'docs/link-rules.md'), 'utf8')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/link-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('no rule is emitted that the table does not define', async () => {
  const source = await readFile(resolve(projectDirectory, 'src/index.mjs'), 'utf8')
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))

  for (const ruleId of emitted) {
    assert.ok(
      Object.hasOwn(RULE_SEVERITY, ruleId),
      `${ruleId} is emitted but missing from RULE_SEVERITY`,
    )
  }
})

test('security-relevant refusals are errors, not warnings', () => {
  // These three decide whether a traversal attempt fails the run. Downgrading
  // any of them to a warning would turn a refusal into a green build.
  assert.equal(RULE_SEVERITY['path-escapes-root'], 'error')
  assert.equal(RULE_SEVERITY['unsafe-target'], 'error')
  assert.equal(RULE_SEVERITY['local-target-missing'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
})
