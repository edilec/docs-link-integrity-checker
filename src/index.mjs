import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { classifyTarget, isInside, splitExternalUrl } from './paths.mjs'
import { isParseable, parseDocument } from './parse.mjs'

export const TOOL_ID = 'docs-link-integrity-checker'
export const REPORT_SCHEMA_VERSION = '1'
export const STATUS_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A documentation root is untrusted input, and a link checker that walks it is
 * one deep symlink farm or one generated 200 MB HTML file away from never
 * finishing. Every limit below is explicit, overridable, and reported when it
 * is hit: exceeding one produces a finding and an `incomplete` report, never a
 * quietly shorter answer.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 1048576,
  maxLinksPerFile: 2000,
  maxDepth: 12,
})

export const EXTERNAL_STATES = Object.freeze(['ok', 'broken', 'unknown'])

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes, so it must not be a literal scattered across two dozen construction
 * sites where one can be flipped without anything noticing. Every finding takes
 * its severity from here, and `docs/link-rules.md` is asserted against this
 * table, so the code and the documented catalog cannot drift apart.
 */
export const RULE_SEVERITY = Object.freeze({
  'directory-target': 'warning',
  'directory-too-deep': 'error',
  'duplicate-anchor': 'warning',
  'empty-target': 'warning',
  'external-broken': 'error',
  'file-too-large': 'error',
  'file-unreadable': 'error',
  'fragment-missing': 'error',
  'link-unverified': 'warning',
  'local-target-missing': 'error',
  'path-escapes-root': 'error',
  'symlink-skipped': 'warning',
  'too-many-files': 'error',
  'too-many-links': 'error',
  'unsafe-target': 'error',
  'unsupported-scheme': 'info',
})

/** Fragments the HTML specification resolves without an element of that id. */
const SPECIAL_FRAGMENTS = Object.freeze(['top'])

const SKIPPED_DIRECTORIES = Object.freeze(['node_modules'])
const EVIDENCE_LIMIT = 120
const UNPRINTABLE = /[\u0000-\u001f\u007f\u2028\u2029]/g

function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

/** A bounded, single-line excerpt. Documentation content is data, never an instruction. */
function excerpt(line) {
  const flattened = String(line).replace(UNPRINTABLE, ' ').trim()
  if (flattened.length <= EVIDENCE_LIMIT) return flattened
  return `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * Validate an imported link status document.
 *
 * This tool never reaches the network. The only way an external link becomes
 * verified is an operator importing a status document produced elsewhere, and
 * a malformed one is a configuration error rather than a finding: silently
 * ignoring it would turn "unknown" into "fine".
 */
export function validateStatusImport(status) {
  if (!isRecord(status)) throw new TypeError('Status import must be an object')
  if (status.schemaVersion !== STATUS_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported status import schemaVersion: ${status.schemaVersion ?? 'missing'}`)
  }
  if (!isRecord(status.links)) throw new TypeError('Status import is missing its links object')
  if (status.checkedAt !== undefined && typeof status.checkedAt !== 'string') {
    throw new TypeError('Status import checkedAt must be a string when present')
  }

  for (const [url, entry] of Object.entries(status.links)) {
    if (!isRecord(entry)) throw new TypeError(`Status entry for "${url}" must be an object`)
    if (!EXTERNAL_STATES.includes(entry.state)) {
      throw new TypeError(`Status entry for "${url}" has unsupported state "${entry.state ?? 'missing'}"`)
    }
    if (entry.httpStatus !== undefined && !Number.isInteger(entry.httpStatus)) {
      throw new TypeError(`Status entry for "${url}" has a non-integer httpStatus`)
    }
    if (entry.anchors !== undefined) {
      if (!Array.isArray(entry.anchors) || entry.anchors.some((anchor) => typeof anchor !== 'string')) {
        throw new TypeError(`Status entry for "${url}" must list anchors as strings`)
      }
    }
  }
  return status
}

function createCollector() {
  return { rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ order: -1, ...row })
}

function fragmentResolves(anchors, fragment) {
  if (fragment === '') return true
  if (SPECIAL_FRAGMENTS.includes(fragment.toLowerCase())) return true
  return anchors.has(fragment)
}

/**
 * Walk the documentation root.
 *
 * Entries are sorted by UTF-16 code unit before use, so the order files are
 * visited never depends on the order the filesystem happened to return them.
 * Symlinks are not followed: a link farm is not documentation, and following
 * one is the easy way out of the root.
 */
async function collectDocuments(rootReal, limits, collector) {
  const documents = []
  let stopped = false

  async function walk(absolute, relativePath, depth) {
    if (stopped) return
    if (depth > limits.maxDepth) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'directory-too-deep',
        severity: 'error',
        message: `Directory nesting exceeded the maxDepth limit of ${limits.maxDepth}; its contents were not examined.`,
        suggestion: 'Raise --max-depth or split the documentation set.',
      })
      collector.incomplete = true
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'file-unreadable',
        severity: 'error',
        message: `Directory could not be read: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      return
    }

    entries.sort((left, right) => byCodeUnit(left.name, right.name))

    for (const entry of entries) {
      if (stopped) return
      if (entry.name.startsWith('.')) continue
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)

      if (entry.isSymbolicLink()) {
        record(collector, {
          file: childRelative,
          ruleId: 'symlink-skipped',
          severity: 'warning',
          message: 'Symbolic link was not followed; it was neither scanned nor used to leave the documentation root.',
          suggestion: 'Scan the real location of the file instead.',
        })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue
        await walk(childAbsolute, childRelative, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!isParseable(extname(entry.name).toLowerCase())) continue

      if (documents.length >= limits.maxFiles) {
        record(collector, {
          file: childRelative,
          ruleId: 'too-many-files',
          severity: 'error',
          message: `Documentation root holds more than the maxFiles limit of ${limits.maxFiles}; the scan stopped here.`,
          suggestion: 'Raise --max-files or check a smaller subtree.',
        })
        collector.incomplete = true
        stopped = true
        return
      }
      documents.push({ relative: childRelative, absolute: childAbsolute })
    }
  }

  await walk(rootReal, '', 0)
  documents.sort((left, right) => byCodeUnit(left.relative, right.relative))
  return documents
}

/** Parse a file at most once per run, keyed by its real path. */
function createDocumentLoader(limits) {
  const cache = new Map()
  return async function load(realPath) {
    const cached = cache.get(realPath)
    if (cached !== undefined) return cached

    let result
    try {
      const info = await stat(realPath)
      if (info.size > limits.maxFileBytes) {
        result = { ok: false, reason: 'too-large', detail: `${info.size} bytes` }
      } else {
        const text = await readFile(realPath, 'utf8')
        const parsed = parseDocument(text, extname(realPath).toLowerCase())
        result = parsed === null
          ? { ok: false, reason: 'unparseable', detail: extname(realPath).toLowerCase() }
          : { ok: true, parsed, lines: text.split('\n') }
      }
    } catch (error) {
      result = { ok: false, reason: 'unreadable', detail: error.code ?? 'unknown error' }
    }

    cache.set(realPath, result)
    return result
  }
}

function reportLoadFailure(collector, file, loaded, limits) {
  if (loaded.reason === 'too-large') {
    record(collector, {
      file,
      ruleId: 'file-too-large',
      severity: 'error',
      message: `File exceeds the maxFileBytes limit of ${limits.maxFileBytes} (${loaded.detail}); it was not parsed.`,
      suggestion: 'Raise --max-file-bytes or split the document.',
    })
  } else {
    record(collector, {
      file,
      ruleId: 'file-unreadable',
      severity: 'error',
      message: `File could not be read: ${loaded.detail}.`,
    })
  }
  collector.incomplete = true
}

/**
 * Check every link in one document.
 *
 * Local resolution happens against the containing file, then the result must
 * survive two containment checks before anything is read from disk.
 */
async function checkDocument(context, document) {
  const { collector, limits, load, counts } = context
  const loaded = await load(document.realPath)
  if (!loaded.ok) {
    reportLoadFailure(collector, document.relative, loaded, limits)
    counts.skipped += 1
    return
  }

  counts.documents += 1
  const { parsed, lines } = loaded

  for (const duplicate of parsed.duplicates) {
    record(collector, {
      file: document.relative,
      order: -1,
      ruleId: 'duplicate-anchor',
      severity: 'warning',
      message: `Anchor "${duplicate.anchor}" is defined more than once; a link to it lands on the first definition.`,
      line: duplicate.line,
      column: duplicate.column,
      target: duplicate.anchor,
      suggestion: duplicate.resolved === duplicate.anchor
        ? 'Give one of the definitions a distinct id.'
        : `Rename the heading, or link to "${duplicate.resolved}" for this one.`,
    })
  }

  if (parsed.links.length > limits.maxLinksPerFile) {
    record(collector, {
      file: document.relative,
      ruleId: 'too-many-links',
      severity: 'error',
      message: `File holds ${parsed.links.length} links, above the maxLinksPerFile limit of ${limits.maxLinksPerFile}; none of them were checked.`,
      suggestion: 'Raise --max-links or split the document.',
    })
    collector.incomplete = true
    counts.skipped += 1
    return
  }

  for (const link of parsed.links) {
    counts.links += 1
    const base = {
      file: document.relative,
      order: link.index,
      pointer: `/links/${link.index}`,
      line: link.line,
      column: link.column,
      target: link.target,
      evidence: excerpt(lines[link.line - 1] ?? ''),
    }
    await checkLink(context, document, link, base)
  }
}

async function checkLink(context, document, link, base) {
  const { collector, counts } = context
  const classified = classifyTarget(link.target)

  if (classified.kind === 'empty') {
    record(collector, {
      ...base,
      ruleId: 'empty-target',
      severity: 'warning',
      message: 'Link has an empty target, so it resolves to the containing document.',
    })
    return
  }

  if (classified.kind === 'scheme') {
    counts.other += 1
    record(collector, {
      ...base,
      ruleId: 'unsupported-scheme',
      severity: 'info',
      message: `Target uses the "${classified.scheme}" scheme, which this tool does not resolve.`,
    })
    return
  }

  if (classified.kind === 'unsafe') {
    record(collector, {
      ...base,
      ruleId: 'unsafe-target',
      severity: 'error',
      message: `Target was refused because ${classified.reason}; it was never passed to the filesystem.`,
    })
    return
  }

  if (classified.kind === 'external') {
    counts.external += 1
    checkExternalLink(context, classified.url, base)
    return
  }

  counts.local += 1
  await checkLocalLink(context, document, classified, base)
}

function checkExternalLink(context, url, base) {
  const { collector, statusImport, counts } = context
  const { address, fragment } = splitExternalUrl(url)

  const unverified = (reason) => {
    counts.unverified += 1
    record(collector, {
      ...base,
      ruleId: 'link-unverified',
      severity: 'warning',
      message: `External link is unverified: ${reason}. This tool never fetches anything.`,
      suggestion: 'Import a link status document that covers this address.',
    })
  }

  if (statusImport === null) {
    unverified('no status document was imported')
    return
  }

  const entry = statusImport.links[address]
  if (entry === undefined) {
    unverified('the imported status document has no entry for it')
    return
  }
  if (entry.state === 'broken') {
    counts.verified += 1
    record(collector, {
      ...base,
      ruleId: 'external-broken',
      severity: 'error',
      message: `Imported status records this address as broken${entry.httpStatus === undefined ? '' : ` (HTTP ${entry.httpStatus})`}.`,
    })
    return
  }
  if (entry.state === 'unknown') {
    unverified('the imported status records its state as unknown')
    return
  }
  if (fragment !== '' && !(entry.anchors ?? []).includes(fragment)) {
    unverified(`the imported status does not list the fragment "${fragment}"`)
    return
  }
  counts.verified += 1
}

async function checkLocalLink(context, document, classified, base) {
  const { collector, rootReal, load, limits } = context

  if (classified.path === '') {
    const loaded = await load(document.realPath)
    if (loaded.ok && !fragmentResolves(loaded.parsed.anchors, classified.fragment)) {
      record(collector, {
        ...base,
        ruleId: 'fragment-missing',
        severity: 'error',
        message: `No anchor "${classified.fragment}" is defined in this document.`,
        suggestion: 'Check the heading text, or add an explicit id.',
      })
    }
    return
  }

  const from = classified.rootRelative ? rootReal : dirname(document.absolute)
  const resolved = resolve(from, classified.path)

  // Lexical containment first: a traversal target is refused before it is stat-ed.
  if (!isInside(rootReal, resolved)) {
    record(collector, {
      ...base,
      ruleId: 'path-escapes-root',
      severity: 'error',
      message: 'Target resolves outside the documentation root and was refused; nothing outside the root was read.',
      suggestion: 'Link to a file inside the documentation root, or use an absolute URL.',
    })
    return
  }

  let realTarget
  try {
    realTarget = await realpath(resolved)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      record(collector, {
        ...base,
        ruleId: 'local-target-missing',
        severity: 'error',
        message: 'Target does not exist inside the documentation root.',
      })
      return
    }
    record(collector, {
      ...base,
      ruleId: 'file-unreadable',
      severity: 'error',
      message: `Target could not be resolved: ${error.code ?? 'unknown error'}.`,
    })
    collector.incomplete = true
    return
  }

  // Real-path containment second: a symlink inside the root cannot lead out of it.
  if (!isInside(rootReal, realTarget)) {
    record(collector, {
      ...base,
      ruleId: 'path-escapes-root',
      severity: 'error',
      message: 'Target resolves through a symbolic link that leaves the documentation root and was refused.',
      suggestion: 'Link to a file inside the documentation root, or use an absolute URL.',
    })
    return
  }

  const targetRelative = toPosix(relative(rootReal, realTarget))
  const info = await stat(realTarget)
  if (info.isDirectory()) {
    record(collector, {
      ...base,
      ruleId: 'directory-target',
      severity: 'warning',
      message: 'Target is a directory; this tool does not apply a site generator index convention to it.',
      suggestion: 'Link to the document itself, such as the index file inside that directory.',
    })
    return
  }

  if (classified.fragment === '') return

  if (!isParseable(extname(realTarget).toLowerCase())) {
    record(collector, {
      ...base,
      ruleId: 'fragment-missing',
      severity: 'error',
      message: `Target is not a Markdown or HTML document, so it defines no anchor "${classified.fragment}".`,
    })
    return
  }

  const loaded = await load(realTarget)
  if (!loaded.ok) {
    reportLoadFailure(collector, targetRelative, loaded, limits)
    return
  }
  if (!fragmentResolves(loaded.parsed.anchors, classified.fragment)) {
    record(collector, {
      ...base,
      ruleId: 'fragment-missing',
      severity: 'error',
      message: `No anchor "${classified.fragment}" is defined in ${targetRelative}.`,
      suggestion: 'Check the heading text, or add an explicit id in the target document.',
    })
  }
}

function toFinding(row) {
  const location = { file: row.file }
  if (row.pointer !== undefined) location.pointer = row.pointer
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/link-rules.md.`)
  }
  const finding = { ruleId: row.ruleId, severity, message: row.message, location }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = row.evidence
  if (row.suggestion !== undefined) finding.suggestion = row.suggestion
  if (row.target !== undefined) finding.target = row.target
  if (row.line !== undefined) finding.line = row.line
  if (row.column !== undefined) finding.column = row.column
  return finding
}

/**
 * Check every link in a documentation root.
 *
 * `options.root` is a directory path. `options.status` is an already-parsed
 * status import, or null. Nothing here reads the network, the clock, the
 * locale or the environment, so two runs over the same bytes agree exactly.
 */
export async function checkDocumentationLinks(options = {}) {
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('A documentation root is required')
  }
  const limits = validateLimits(options.limits ?? {})
  const statusImport = options.status === undefined || options.status === null
    ? null
    : validateStatusImport(options.status)

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Documentation root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Documentation root must be a directory')

  const collector = createCollector()
  const counts = {
    documents: 0,
    links: 0,
    local: 0,
    external: 0,
    other: 0,
    verified: 0,
    unverified: 0,
    skipped: 0,
  }
  const context = {
    collector,
    limits,
    rootReal,
    load: createDocumentLoader(limits),
    statusImport,
    counts,
  }

  const documents = await collectDocuments(rootReal, limits, collector)
  counts.skipped += collector.rows.filter((row) => row.ruleId === 'symlink-skipped').length

  for (const document of documents) {
    let realPath
    try {
      realPath = await realpath(document.absolute)
    } catch (error) {
      record(collector, {
        file: document.relative,
        ruleId: 'file-unreadable',
        severity: 'error',
        message: `File could not be resolved: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      counts.skipped += 1
      continue
    }
    await checkDocument(context, { ...document, realPath })
  }

  collector.rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    left.order - right.order ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.target ?? '', right.target ?? ''))

  const findings = collector.rows.map(toFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const incomplete = collector.incomplete || counts.unverified > 0

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: {
      checked: counts.documents,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      links: counts.links,
      localLinks: counts.local,
      externalLinks: counts.external,
      otherLinks: counts.other,
      verified: counts.verified,
      unverified: counts.unverified,
      skipped: counts.skipped,
      statusImported: statusImport !== null,
      statusCheckedAt: statusImport === null ? null : excerpt(statusImport.checkedAt ?? '') || null,
    },
    findings,
  }
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.checked} document(s), ${summary.links} link(s): ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `${summary.externalLinks} external link(s): ${summary.verified} verified from an imported status, ${summary.unverified} unverified.`,
  ]
  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? finding.location.file
      : `${finding.location.file}:${finding.line}:${finding.column}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export { classifyTarget, isInside } from './paths.mjs'
export { parseDocument, parseHtml, parseMarkdown, slugify } from './parse.mjs'
