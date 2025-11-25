# Docs Link Integrity Checker

Resolve Markdown and HTML documentation links, anchors and relative paths inside a bounded
documentation root — without fetching anything.

- **Repository:** [edilec/docs-link-integrity-checker](https://github.com/edilec/docs-link-integrity-checker)
- **Area:** Docs & Knowledge
- **License:** MIT

## Why it exists

Documentation rots in three quiet ways. A file moves and the links to it keep pointing at where it
used to be. A heading gets reworded and every `#anchor` aimed at it silently lands at the top of
the page instead. And an external link just stops working, somewhere else, without telling anyone.

Most link checkers answer the first two and paper over the third by making HTTP requests — which
turns a docs check into a flaky, network-dependent, rate-limited job that quietly passes when a
site is merely slow. This tool separates the questions. Local structure is resolved exactly, on
disk, deterministically. External addresses are never fetched: they are verified only from a status
document captured elsewhere, and anything that document does not cover is reported **unverified**,
which is not a pass.

The third thing it does is refuse to be used as a file reader. A documentation set is untrusted
input, and `[x](../../../../etc/passwd)` is just a string someone typed. Every target is contained
to the documentation root twice — once lexically, before the filesystem is touched at all, and
again against the real path, so a symlink cannot be used to step outside either.

## Requirements

- Node.js 22 or newer
- no runtime dependencies, and no network access at any point

## Quick start

```sh
node bin/docs-link-integrity-checker.mjs \
  --root examples/docs-clean \
  --status examples/link-status.json
```

```text
3 document(s), 12 link(s): 0 error, 0 warning, 1 info, status pass.
2 external link(s): 2 verified from an imported status, 0 unverified.
INFO    index.md:19:18 unsupported-scheme Target uses the "mailto" scheme, which this tool does not resolve.
```

Drop the imported status and the same documentation is no longer a pass, because two of its links
can no longer be spoken for:

```sh
node bin/docs-link-integrity-checker.mjs --root examples/docs-clean
```

```text
3 document(s), 12 link(s): 0 error, 2 warning, 1 info, status incomplete.
2 external link(s): 0 verified from an imported status, 2 unverified.
WARNING index.md:14:34 link-unverified External link is unverified: no status document was imported. This tool never fetches anything.
WARNING index.md:15:38 link-unverified External link is unverified: no status document was imported. This tool never fetches anything.
```

The deliberately broken set demonstrates each failure rule:

```sh
node bin/docs-link-integrity-checker.mjs --root examples/docs-broken
```

```text
3 document(s), 11 link(s): 6 error, 3 warning, 0 info, status fail.
WARNING index.md:17:1 duplicate-anchor Anchor "overview" is defined more than once; a link to it lands on the first definition.
ERROR   index.md:8:20 local-target-missing Target does not exist inside the documentation root.
ERROR   index.md:9:23 fragment-missing No anchor "instalation" is defined in notes.md.
ERROR   index.md:10:25 path-escapes-root Target resolves outside the documentation root and was refused; nothing outside the root was read.
ERROR   index.md:11:28 path-escapes-root Target resolves outside the documentation root and was refused; nothing outside the root was read.
ERROR   index.md:12:27 unsafe-target Target was refused because it decodes to a NUL byte; it was never passed to the filesystem.
WARNING index.md:13:17 directory-target Target is a directory; this tool does not apply a site generator index convention to it.
WARNING index.md:14:21 empty-target Link has an empty target, so it resolves to the containing document.
ERROR   index.md:15:29 fragment-missing No anchor "overveiw" is defined in this document.
```

## Commands

| Command | What it does |
| --- | --- |
| `--root DIR` | documentation root to scan (required) |
| `--status FILE` | imported link status document for external addresses |
| `--json` | emit the machine-readable report on stdout |
| `--max-files N` | maximum documents to scan (default 2000) |
| `--max-file-bytes N` | maximum bytes per document (default 1048576) |
| `--max-links N` | maximum links per document (default 2000) |
| `--max-depth N` | maximum directory depth below the root (default 12) |
| `-h`, `--help` | show usage |

## Inputs

- **A documentation root.** `.md`, `.markdown`, `.html` and `.htm` files are parsed; every other
  file is still a valid link target. Dot-entries, `node_modules` and symbolic links are skipped.
- **An optional status import** (`--status`), the only way an external address is ever verified.
  Its format and semantics are in [`docs/link-rules.md`](./docs/link-rules.md).

Both are data. Nothing in a documentation set or a status import changes what this tool does.

## Outputs

`--json` writes the v1 report envelope to stdout and nothing else, so it can be piped straight into
a parser. Operational diagnostics go to stderr.

```json
{
  "schemaVersion": "1",
  "tool": "docs-link-integrity-checker",
  "status": "pass",
  "summary": { "checked": 3, "errors": 0, "warnings": 0, "info": 1, "links": 12, "unverified": 0 },
  "findings": []
}
```

`location.file` is always relative to the root — no absolute host path reaches the report — and
`evidence` is the source line, flattened and bounded to 120 characters. The full rule catalog, the
slug algorithm, the limits and the determinism guarantee are in
[`docs/link-rules.md`](./docs/link-rules.md).

## Library usage

```js
import { checkDocumentationLinks } from 'docs-link-integrity-checker'

const report = await checkDocumentationLinks({
  root: 'docs',
  status: importedStatus, // or null
  limits: { maxFileBytes: 262144 },
})
```

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every link resolved and the run was complete |
| `1` | the run was complete and the documentation failed the check |
| `2` | invalid usage, unreadable input, or evidence that was missing or bounded out |

`incomplete` takes precedence over `fail`: a run that both failed and could not see everything is
still a run that could not see everything.

## Limits and non-goals

What this tool **cannot** conclude:

- **That an external link works.** It never makes a request. A verified external link means an
  imported status document said so, at whatever moment that import was captured; the address may
  have broken since, and `checkedAt` is copied into the report but never compared against a clock.
  Without an import, external links are `unverified` and the run is `incomplete`.
- **That a fragment on an external page exists**, unless the status entry lists it in `anchors`.
- **That a link is correct.** A link that resolves may still point at the wrong document.
- **That your site generator agrees with it.** Anchors are derived with one documented slug
  algorithm and matched exactly. A generator with different slug rules, a directory-to-index
  convention, redirects, or a base path will disagree; a link to a directory is reported as
  ambiguous rather than guessed at.
- **Anything about a file it did not parse.** Skipped symlinks, dot-entries and `node_modules` are
  out of scope by design, and any file that hit a limit is reported and makes the run `incomplete`
  rather than being quietly dropped.
- **That the whole Markdown specification was applied.** The parsers are lexical. Notably, links
  inside 4-space indented code blocks are still checked (use fenced blocks), reference *usages*
  such as `[text][label]` are not resolved — only the definitions they point at are checked — and a
  Markdown link split across two lines is not read as one link.
- **That passing means the documentation is good.** This is a resolution check, not a review, and
  not a release approval.

## Development

```sh
npm test          # behaviour tests, through the API and the real CLI
npm run check     # lint, tests, runnable example, packaging check
```

## License

MIT. See [LICENSE](./LICENSE).
