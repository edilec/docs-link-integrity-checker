# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- lexical Markdown and HTML extraction that finds inline links, images, reference
  definitions, autolinks and raw `href` / `src` attributes, while masking fenced
  code, front matter, inline code spans, HTML comments and `script` / `style`
  bodies so they are never mistaken for links;
- anchor resolution from Markdown ATX and setext headings, custom heading ids,
  HTML `id` attributes and `<a name>`, with a documented slug algorithm, GitHub
  style `-1` suffixing for repeats, and a `duplicate-anchor` finding when a
  repeat makes a link ambiguous;
- containment of every local target to the documentation root, checked lexically
  before the filesystem is touched and again against the real path, so neither a
  relative traversal nor a symbolic link can read outside the root;
- `checkDocumentationLinks`, reporting missing targets, missing fragments,
  refused paths, unsafe targets, directory targets and empty targets;
- an imported link status document as the only source of external link state,
  with `ok`, `broken` and `unknown` entries and optional per-address `anchors`;
  anything it does not cover is reported `link-unverified`, which makes the run
  `incomplete` rather than a pass;
- explicit file, byte, links-per-file and directory-depth limits, each reported
  by name when hit and each making the run `incomplete` instead of truncating;
- a CLI with `--help`, `--json`, limit flags, the report on stdout, diagnostics
  on stderr, and exit codes 0 / 1 / 2;
- runnable healthy and deliberately broken example documentation sets and an
  example status import; the broken set spreads its findings over two documents,
  so the documented finding order is demonstrated as well as the rules;
- the rule catalog, limits, report shape and determinism guarantee in
  `docs/link-rules.md`.

### Fixed

- the `--status` diagnostic no longer republishes the document it could not
  parse. V8 reports a parse failure two ways, and one of them quotes the input
  back -- `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` --
  which reproduces the first ten characters of the file, or the whole file when
  it is shorter than that. The CLI interpolated that message whole onto stderr,
  so a status import short enough to be nothing but a credential was printed in
  full. `parseFailureDetail` in `src/index.mjs` now keeps the offset, line and
  column and drops the quoted half, and the read failure is caught separately so
  an ENOENT still names the syscall. `test/parse-failure.test.mjs` plants the
  canary through the real binary and asserts it is absent from stdout, from
  stderr and from every prefix of it down to eight characters, because V8 quotes
  only ten.

No release has been published.
