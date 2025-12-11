# Link rules, limits and determinism

This document is the reference for what `docs-link-integrity-checker` inspects, what each rule
means, and what the tool refuses to claim. Rule ids are stable: renaming one is a breaking change
and is recorded in the changelog.

## What is scanned

The tool walks the documentation root and parses files with these extensions:

| Extension | Parsed as |
| --- | --- |
| `.md`, `.markdown` | Markdown (plus any raw HTML inside it) |
| `.html`, `.htm` | HTML |

Every other file is still a valid **link target** — a link to `diagram.png` is checked for existence
— it is simply never parsed for links or anchors.

Entries whose name begins with `.` are skipped, as is any directory named `node_modules`. Symbolic
links are never followed.

## What counts as a link

Markdown:

- inline links and images, `[text](target)` and `![alt](target)`, including a `<bracketed target>`
  and a destination containing balanced parentheses;
- reference definitions, `[label]: target`;
- autolinks, `<https://example.com/x>`;
- raw HTML `href` and `src` attributes appearing inside the Markdown.

HTML: every `href` and `src` attribute on any tag.

Excluded before extraction, by masking the region with spaces of the same length: fenced code
blocks, YAML front matter at the top of the file, inline code spans, HTML comments, and the bodies
of `<script>` and `<style>`.

## What counts as an anchor

- **Markdown headings**, ATX (`## Heading`) and setext (an `=` or `-` underline), converted to a
  slug (below).
- **A custom heading id**, `## Heading {#chosen-id}`. When present, only the custom id is
  registered — the derived slug is not.
- **`id` attributes** on any HTML tag, and `name` attributes on `<a>` tags, registered exactly as
  written.

The empty fragment and the fragment `top` always resolve, as they do in a browser.

### Slug derivation

1. Remove HTML tags, Markdown image and link syntax (keeping the visible text) and the inline
   emphasis characters `` ` ``, `*`, `_`, `~`.
2. Trim, then lowercase with `toLowerCase` — never `toLocaleLowerCase`.
3. Remove every character that is not a letter, a number, whitespace, `_` or `-`.
4. Replace **each** whitespace character with `-`. Runs are not collapsed, because the common
   generators do not collapse them, and inventing a shorter anchor would produce false failures.

Repeated slugs are suffixed `-1`, `-2`, … in document order, matching common generator behaviour,
and the repeat is also reported as `duplicate-anchor`.

Fragment matching is exact and case-sensitive against the set of registered anchors.

## Rule catalog

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `local-target-missing` | error | The link resolves inside the root but nothing exists there. |
| `fragment-missing` | error | The target exists but defines no such anchor, or is not a document that can define one. |
| `path-escapes-root` | error | The target resolves outside the documentation root, lexically or through a symlink. It was refused and nothing outside the root was read. |
| `unsafe-target` | error | The target decodes to something this tool refuses to hand to the filesystem, such as a NUL byte. |
| `external-broken` | error | The imported status document records this address as broken. |
| `file-too-large` | error | The file exceeds `maxFileBytes` and was not parsed. Makes the run incomplete. |
| `file-unreadable` | error | A file or directory could not be read. Makes the run incomplete. |
| `too-many-files` | error | The root holds more parseable files than `maxFiles`. Makes the run incomplete. |
| `too-many-links` | error | One file holds more links than `maxLinksPerFile`; none of that file's links were checked. Makes the run incomplete. |
| `directory-too-deep` | error | Nesting exceeded `maxDepth`; that directory's contents were not examined. Makes the run incomplete. |
| `link-unverified` | warning | An external address with no state in an imported status document. Makes the run incomplete. |
| `duplicate-anchor` | warning | Two definitions derive the same anchor, so a link to it is ambiguous. |
| `directory-target` | warning | The target is a directory; no site generator index convention is applied. |
| `empty-target` | warning | The link has an empty target and resolves to its own document. |
| `symlink-skipped` | warning | A symbolic link was neither followed nor scanned. |
| `unsupported-scheme` | info | A scheme this tool does not resolve, such as `mailto:` or `tel:`. |

## External links are never fetched

This tool makes no network request of any kind. An `http`, `https` or protocol-relative address is
verified only from an imported status document produced elsewhere:

```json
{
  "schemaVersion": "1",
  "checkedAt": "2026-09-01T00:00:00Z",
  "links": {
    "https://example.com/urls": { "state": "ok", "httpStatus": 200, "anchors": ["fragments"] },
    "https://example.com/gone": { "state": "broken", "httpStatus": 404 },
    "https://example.com/pending": { "state": "unknown" }
  }
}
```

- `state` is `ok`, `broken` or `unknown`; any other value is a configuration error, not a finding.
- The lookup key is the address with its fragment removed.
- A fragment on an external address is verified only when the entry lists it in `anchors`.
  Otherwise the link is `link-unverified` — a status entry proves the page exists, not that a
  particular section of it does.
- `checkedAt` is recorded in the report as provenance. It is never parsed as a date and never
  compared against a clock.

Anything the import does not cover is **unverified**, and a run with any unverified link reports
`incomplete` and exits `2`. Unverified is not a pass.

## Limits

| Limit | Default | CLI flag |
| --- | ---: | --- |
| `maxFiles` | 2000 | `--max-files` |
| `maxFileBytes` | 1048576 | `--max-file-bytes` |
| `maxLinksPerFile` | 2000 | `--max-links` |
| `maxDepth` | 12 | `--max-depth` |

Exceeding a limit always produces a finding naming the limit and marks the report `incomplete`.
Nothing is ever silently truncated.

There is deliberately **no wall-clock timeout**. A cutoff that depends on how fast the host is
would make the output machine-dependent, which is exactly what the determinism guarantee forbids.
The limits above bound the work instead.

## Report

```json
{
  "schemaVersion": "1",
  "tool": "docs-link-integrity-checker",
  "status": "pass",
  "summary": {
    "checked": 3, "errors": 0, "warnings": 0, "info": 1,
    "links": 12, "localLinks": 9, "externalLinks": 2, "otherLinks": 1,
    "verified": 2, "unverified": 0, "skipped": 0,
    "statusImported": true, "statusCheckedAt": "2026-09-01T00:00:00Z"
  },
  "findings": []
}
```

`status` is:

- `incomplete` if any evidence was missing or bounded out — an unverified external link, an
  unreadable file, or any limit that was hit. This takes precedence over `fail`, because a report
  that failed *and* could not see everything is still a report that could not see everything.
- `fail` if the run was complete and produced at least one error.
- `pass` otherwise.

A finding carries `ruleId`, `severity`, `message`, `location` (`file` relative to the root, and
`pointer` `/links/<index>` for link findings), and where they apply `evidence`, `suggestion`,
`target`, `line` and `column`. `location.file` is always relative — no absolute host path reaches
the report. `evidence` is the source line, flattened to one line, stripped of control characters
and bounded to 120 characters.

## A status import that will not parse

The diagnostic names the offset the parse failed at -- position, line and column -- and never the
text it failed on. V8 reports a parse failure two ways and one of them quotes the input back,
`Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, which reproduces the first ten
characters of the file, or the whole file when it is shorter than that. A status import short
enough to be nothing but a credential would otherwise be printed in full to stderr, on the one path
an unparseable file is guaranteed to take. The quoted half is dropped before the message is built;
the offset, which says nothing about content, is kept whole. A failure to *read* the file is
reported separately and still names the syscall.

## Determinism guarantee

Two runs over the same bytes produce byte-identical stdout.

- Directory entries are sorted by UTF-16 code unit before use, so filesystem enumeration order
  never reaches the output.
- Every comparison is a plain `a < b ? -1 : a > b ? 1 : 0`. `localeCompare` is never used: it
  depends on the ICU data compiled into the Node build.
- Findings sort by `location.file`, then document order of the link (`-1` for file-level findings),
  then `ruleId`, then the raw target.
- No clock, no random source, no locale, no environment variable and no network affects the output.
  The only time value that can appear is `checkedAt`, copied verbatim from the imported status
  document.
