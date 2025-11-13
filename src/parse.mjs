/**
 * Markdown and HTML extraction.
 *
 * The parsers here are deliberately small and lexical. They are not renderers:
 * they find the link targets a reader could follow and the anchors a fragment
 * could land on, and they say so with a line and a column. Everything they do
 * is a pure function of the input text, so the same bytes always produce the
 * same links in the same order.
 *
 * Masking, not deletion, is how code is excluded. A fenced block, an HTML
 * comment, a script body and an inline code span are replaced by spaces of the
 * same length, which keeps every surviving offset pointing at the original
 * text.
 */

export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown'])
export const HTML_EXTENSIONS = Object.freeze(['.html', '.htm'])

const HTML_COMMENT = /<!--[\s\S]*?-->/g
const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi
const STYLE_BLOCK = /<style\b[\s\S]*?<\/style\s*>/gi
const TAG = /<([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g
const ATTRIBUTE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*)>/g
const REFERENCE_DEFINITION = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:[ \t]*(<[^>\n]*>|\S+)/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const CUSTOM_ID = /\{#([^}\s]+)\}[ \t]*$/
const ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
])

function blank(value) {
  return value.replace(/[^\n]/g, ' ')
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES.get(entity) ?? entity)
}

/**
 * Derive a heading slug the way common documentation generators do.
 *
 * Lowercasing uses `toLowerCase`, never `toLocaleLowerCase`: a locale-aware
 * fold would make the slug depend on the machine that ran the check.
 */
export function slugify(text) {
  const withoutTags = text.replace(/<[^>]*>/g, '')
  const withoutImages = withoutTags.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  const withoutInlineLinks = withoutImages.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
  const withoutReferenceLinks = withoutInlineLinks.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  const plain = decodeEntities(withoutReferenceLinks).replace(/[`*_~]/g, '')
  const kept = plain.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '')
  // Each whitespace character becomes one hyphen, matching the widely used
  // generator behaviour: collapsing runs here would invent anchors that the
  // rendered documentation does not actually have.
  return kept.replace(/\s/g, '-')
}

/** Offset to one-based line and column, by binary search over line starts. */
export function createLineLocator(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return { line: low + 1, column: offset - starts[low] + 1 }
  }
}

/** Blank inline code spans, keeping the line length identical. */
function maskCodeSpans(line) {
  const characters = [...line]
  let index = 0
  while (index < characters.length) {
    if (characters[index] !== '`') {
      index += 1
      continue
    }
    const openStart = index
    let openLength = 0
    while (index < characters.length && characters[index] === '`') {
      openLength += 1
      index += 1
    }
    let cursor = index
    while (cursor < characters.length) {
      if (characters[cursor] !== '`') {
        cursor += 1
        continue
      }
      let closeLength = 0
      while (cursor < characters.length && characters[cursor] === '`') {
        closeLength += 1
        cursor += 1
      }
      if (closeLength === openLength) {
        for (let position = openStart; position < cursor; position += 1) characters[position] = ' '
        index = cursor
        break
      }
    }
    if (cursor >= characters.length) break
  }
  return characters.join('')
}

/**
 * Blank fenced code and YAML front matter, and report which lines were code.
 * Line count and every offset are preserved.
 */
function maskMarkdownBlocks(text) {
  const lines = text.split('\n')
  const isCode = new Array(lines.length).fill(false)
  const masked = new Array(lines.length)
  let fence = null
  let frontMatter = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.replace(/\r$/, '')

    if (index === 0 && /^---[ \t]*$/.test(trimmed)) {
      frontMatter = true
      isCode[index] = true
      masked[index] = blank(line)
      continue
    }
    if (frontMatter) {
      isCode[index] = true
      masked[index] = blank(line)
      if (/^(?:---|\.\.\.)[ \t]*$/.test(trimmed)) frontMatter = false
      continue
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(trimmed)
    if (fence === null) {
      if (fenceMatch && !(fenceMatch[1].startsWith('`') && fenceMatch[2].includes('`'))) {
        fence = { character: fenceMatch[1][0], length: fenceMatch[1].length }
        isCode[index] = true
        masked[index] = blank(line)
        continue
      }
      masked[index] = maskCodeSpans(line)
      continue
    }

    isCode[index] = true
    masked[index] = blank(line)
    if (
      fenceMatch &&
      fenceMatch[1][0] === fence.character &&
      fenceMatch[1].length >= fence.length &&
      fenceMatch[2].trim() === ''
    ) {
      fence = null
    }
  }

  return { masked: masked.join('\n'), isCode }
}

/** Markdown inline destination: `<...>` or a balanced run up to the closing paren. */
function readDestination(text, start) {
  let index = start
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
  if (index >= text.length) return null
  if (text[index] === '<') {
    const end = text.indexOf('>', index + 1)
    if (end === -1) return null
    const raw = text.slice(index + 1, end)
    if (raw.includes('\n')) return null
    return { raw, offset: index + 1 }
  }

  const offset = index
  let depth = 0
  let raw = ''
  while (index < text.length) {
    const character = text[index]
    if (character === '\n') return null
    if (character === '\\' && index + 1 < text.length) {
      raw += text[index + 1]
      index += 2
      continue
    }
    if (character === ' ' || character === '\t') break
    if (character === '(') depth += 1
    if (character === ')') {
      if (depth === 0) break
      depth -= 1
    }
    raw += character
    index += 1
  }
  if (raw === '') return text[index] === ')' ? { raw: '', offset: index } : null
  return { raw, offset }
}

function hasOpeningBracket(text, closeIndex) {
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    const character = text[index]
    if (character === '\n') return false
    if (character === '[' && (index === 0 || text[index - 1] !== '\\')) return true
  }
  return false
}

/** Collect `href` and `src` targets plus `id` / `<a name>` anchors from tags. */
function scanTags(masked, links, anchors) {
  TAG.lastIndex = 0
  let tagMatch = TAG.exec(masked)
  while (tagMatch !== null) {
    const tagName = tagMatch[1].toLowerCase()
    const attributesOffset = tagMatch.index + 1 + tagMatch[1].length
    ATTRIBUTE.lastIndex = 0
    let attributeMatch = ATTRIBUTE.exec(tagMatch[2])
    while (attributeMatch !== null) {
      const name = attributeMatch[1].toLowerCase()
      const value = decodeEntities(attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '')
      const offset = attributesOffset + attributeMatch.index
      if (name === 'href' || name === 'src') {
        links.push({ target: value, syntax: `html-${name}`, offset })
      } else if (name === 'id' || (name === 'name' && tagName === 'a')) {
        if (value !== '') anchors.push({ anchor: value, offset, source: 'attribute' })
      }
      attributeMatch = ATTRIBUTE.exec(tagMatch[2])
    }
    tagMatch = TAG.exec(masked)
  }
}

function registerAnchors(candidates) {
  const anchors = new Set()
  const duplicates = []
  const headingCounts = new Map()

  for (const candidate of [...candidates].sort((left, right) => left.offset - right.offset)) {
    if (candidate.source === 'heading') {
      const base = candidate.anchor
      const seen = headingCounts.get(base) ?? 0
      headingCounts.set(base, seen + 1)
      const anchor = seen === 0 ? base : `${base}-${seen}`
      if (seen > 0) duplicates.push({ anchor: base, resolved: anchor, offset: candidate.offset })
      anchors.add(anchor)
      continue
    }
    if (anchors.has(candidate.anchor)) {
      duplicates.push({ anchor: candidate.anchor, resolved: candidate.anchor, offset: candidate.offset })
      continue
    }
    anchors.add(candidate.anchor)
  }

  return { anchors, duplicates }
}

export function parseMarkdown(text) {
  const commentless = text.replace(HTML_COMMENT, blank)
  const { masked, isCode } = maskMarkdownBlocks(commentless)
  const lines = commentless.split('\n')
  const maskedLines = masked.split('\n')
  const lineStarts = [0]
  for (let index = 0; index < lines.length - 1; index += 1) {
    lineStarts.push(lineStarts[index] + lines[index].length + 1)
  }

  const links = []
  const anchorCandidates = []

  for (let index = 0; index < lines.length; index += 1) {
    if (isCode[index]) continue
    const line = lines[index].replace(/\r$/, '')

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      const body = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
      const custom = CUSTOM_ID.exec(body)
      const anchor = custom ? custom[1] : slugify(body)
      if (anchor !== '') {
        anchorCandidates.push({
          anchor,
          offset: lineStarts[index],
          source: custom ? 'attribute' : 'heading',
        })
      }
      continue
    }

    if (SETEXT_UNDERLINE.test(line) && index > 0 && !isCode[index - 1]) {
      const previous = lines[index - 1].replace(/\r$/, '')
      const looksLikeText =
        previous.trim() !== '' &&
        !SETEXT_UNDERLINE.test(previous) &&
        !ATX_HEADING.test(previous) &&
        !/^ {0,3}>/.test(previous) &&
        !/^ {0,3}(?:[-*+]|\d+[.)])[ \t]/.test(previous) &&
        !REFERENCE_DEFINITION.test(previous)
      if (looksLikeText) {
        const anchor = slugify(previous)
        if (anchor !== '') {
          anchorCandidates.push({ anchor, offset: lineStarts[index - 1], source: 'heading' })
        }
      }
      continue
    }

    const definition = REFERENCE_DEFINITION.exec(maskedLines[index])
    if (definition) {
      const raw = definition[2]
      const stripped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
      const column = definition[0].lastIndexOf(raw) + (raw === stripped ? 0 : 1)
      links.push({
        target: stripped,
        syntax: 'markdown-reference',
        offset: lineStarts[index] + column,
      })
    }
  }

  for (let index = 0; index + 1 < masked.length; index += 1) {
    if (masked[index] !== ']' || masked[index + 1] !== '(') continue
    if (!hasOpeningBracket(masked, index)) continue
    const destination = readDestination(masked, index + 2)
    if (destination === null) continue
    links.push({ target: destination.raw, syntax: 'markdown-inline', offset: destination.offset })
  }

  AUTOLINK.lastIndex = 0
  let autolink = AUTOLINK.exec(masked)
  while (autolink !== null) {
    links.push({ target: autolink[1], syntax: 'markdown-autolink', offset: autolink.index + 1 })
    autolink = AUTOLINK.exec(masked)
  }

  scanTags(masked, links, anchorCandidates)

  return finish(text, links, anchorCandidates)
}

export function parseHtml(text) {
  const masked = text.replace(HTML_COMMENT, blank).replace(SCRIPT_BLOCK, blank).replace(STYLE_BLOCK, blank)
  const links = []
  const anchorCandidates = []
  scanTags(masked, links, anchorCandidates)
  return finish(text, links, anchorCandidates)
}

function finish(text, links, anchorCandidates) {
  const locate = createLineLocator(text)
  const ordered = [...links].sort((left, right) => left.offset - right.offset)
  const seen = new Set()
  const resolvedLinks = []

  for (const link of ordered) {
    const key = `${link.offset}\u0000${link.target}`
    if (seen.has(key)) continue
    seen.add(key)
    const { line, column } = locate(link.offset)
    resolvedLinks.push({
      target: link.target,
      syntax: link.syntax,
      line,
      column,
      index: resolvedLinks.length,
    })
  }

  const { anchors, duplicates } = registerAnchors(anchorCandidates)

  return {
    links: resolvedLinks,
    anchors,
    duplicates: duplicates.map((duplicate) => ({
      anchor: duplicate.anchor,
      resolved: duplicate.resolved,
      ...locate(duplicate.offset),
    })),
  }
}

/** Parse by extension. Returns null for a file type that carries no links. */
export function parseDocument(text, extension) {
  if (MARKDOWN_EXTENSIONS.includes(extension)) return parseMarkdown(text)
  if (HTML_EXTENSIONS.includes(extension)) return parseHtml(text)
  return null
}

export function isParseable(extension) {
  return MARKDOWN_EXTENSIONS.includes(extension) || HTML_EXTENSIONS.includes(extension)
}
