#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { checkDocumentationLinks, formatReport } from '../src/index.mjs'

const HELP = `docs-link-integrity-checker

Resolve Markdown and HTML documentation links, anchors and relative paths
inside a documentation root. Nothing is ever fetched.

Usage:
  docs-link-integrity-checker --root DIR [--status FILE] [--json] [limits]

Options:
  --root DIR            Documentation root to scan (required)
  --status FILE         Imported link status document for external addresses
  --json                Emit the machine-readable report on stdout
  --max-files N         Maximum documents to scan (default 2000)
  --max-file-bytes N    Maximum bytes per document (default 1048576)
  --max-links N         Maximum links per document (default 2000)
  --max-depth N         Maximum directory depth below the root (default 12)
  -h, --help            Show this help

A link that resolves outside the documentation root is refused and reported,
not followed. External links are never fetched: without an imported status
document covering them they are reported unverified, and an unverified run is
"incomplete", never a pass.

Exit codes:
  0  every link resolved and the run was complete
  1  the documentation failed the check
  2  invalid usage, unreadable input, or evidence that was missing or bounded out
`

const LIMIT_FLAGS = new Map([
  ['--max-files', 'maxFiles'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-links', 'maxLinksPerFile'],
  ['--max-depth', 'maxDepth'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { root: null, status: null, json: false, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--status') options.status = takeValue('--status')
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (!options.root) throw new Error('--root is required')
  return options
}

async function loadStatus(path) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`Could not read status import: ${error.message}`)
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    const status = options.status === null ? null : await loadStatus(options.status)
    report = await checkDocumentationLinks({ root: options.root, status, limits: options.limits })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unverified} unverified external link(s), ${report.summary.skipped} document(s) not examined.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
