import { sep } from 'node:path'

/**
 * Path handling is the trust boundary of this tool.
 *
 * A documentation set is untrusted input: a link inside it is a string an
 * author (or a contributor, or a generator) wrote, and `../../../../etc/passwd`
 * is a perfectly ordinary string. Resolution therefore happens in two stages,
 * and both must agree before any byte of a target is read:
 *
 *  1. lexical containment, computed without touching the filesystem, so a
 *     traversal target is refused before it is ever stat-ed;
 *  2. real-path containment, so a symlink inside the root cannot be used to
 *     read outside it.
 *
 * Refusal is a reported finding, never a silent skip.
 */

/** A scheme as defined by RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** Characters this tool refuses to hand to the filesystem, whatever they mean. */
const UNSAFE_CHARACTERS = /[\u0000]/

/**
 * True when `candidate` is the root itself or lies beneath it.
 *
 * Both arguments must already be absolute and normalised. The comparison is a
 * plain code unit comparison: on a case-insensitive filesystem a path that
 * differs only by case is reported as outside the root, which refuses access
 * rather than granting it.
 */
export function isInside(rootAbsolute, candidateAbsolute) {
  const root = rootAbsolute.endsWith(sep) ? rootAbsolute.slice(0, -1) : rootAbsolute
  if (candidateAbsolute === root) return true
  return candidateAbsolute.startsWith(root + sep)
}

/** Percent-decode without throwing; a malformed escape is kept as written. */
export function decodePathSegmentSafely(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Classify a raw link target.
 *
 * Returns one of:
 *   { kind: 'empty' }
 *   { kind: 'external', url }              http, https or protocol-relative
 *   { kind: 'scheme', scheme }             mailto, tel, data, anything else
 *   { kind: 'unsafe', reason }             refused before it reaches the filesystem
 *   { kind: 'local', path, fragment, rootRelative }
 *
 * `path` is percent-decoded and may be '' for a same-document fragment link.
 */
export function classifyTarget(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed.startsWith('//')) return { kind: 'external', url: trimmed }
  if (SCHEME_PREFIX.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase()
    if (scheme === 'http' || scheme === 'https') return { kind: 'external', url: trimmed }
    return { kind: 'scheme', scheme }
  }

  const hashIndex = trimmed.indexOf('#')
  const beforeHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const rawFragment = hashIndex === -1 ? '' : trimmed.slice(hashIndex + 1)
  const queryIndex = beforeHash.indexOf('?')
  const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)

  const decodedPath = decodePathSegmentSafely(pathPart)
  const fragment = decodePathSegmentSafely(rawFragment)
  if (UNSAFE_CHARACTERS.test(decodedPath) || UNSAFE_CHARACTERS.test(fragment)) {
    return { kind: 'unsafe', reason: 'it decodes to a NUL byte' }
  }

  return {
    kind: 'local',
    path: decodedPath.startsWith('/') ? decodedPath.replace(/^\/+/, '') : decodedPath,
    fragment,
    rootRelative: decodedPath.startsWith('/'),
  }
}

/** Split an external URL into the part a status import can verify and its fragment. */
export function splitExternalUrl(url) {
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) return { address: url, fragment: '' }
  return { address: url.slice(0, hashIndex), fragment: url.slice(hashIndex + 1) }
}
