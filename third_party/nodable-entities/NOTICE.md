# Nodable entities dependency

Source: https://github.com/nodable/val-parsers
Package: `@nodable/entities@3.0.0`, MIT, copyright (c) 2026 Nodable.
Author: Amit Gupta (https://solothought.com), published to npm as `amitgupta`.

Not a direct dependency. It arrives transitively through `fast-xml-parser@5.11.0`,
which in version 5 was split into several packages by its own author rather than
kept as one module.

## Why this notice is retained here

MIT requires the copyright notice and permission text to travel with the software.
The published npm tarball does not carry them: the package's `files` field ships
only `src` and `README.md`, and the README names the license without reproducing
it, so an install produces no copyright notice at all.

The text therefore comes from the package's own upstream repository rather than
from `node_modules`. Retained verbatim in LICENSE from `nodable/val-parsers` at
blob `561468f111a66df52cc0f1934642bb9fdd22a212` (1,064 bytes), repository head
`d2070d76a8ba07e6c7fa142caeb51ffd756e47eb`, fetched 2026-09-12.

This records the notice the license requires. It does not modify the license, and
it is not a statement that the upstream package should be relied on as-is.

## Provenance check

The version-5 dependency expansion introduces several small packages whose names
give no obvious connection to `fast-xml-parser`: `@nodable/entities`,
`fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `xml-naming`, `anynum`
and `strnum`. That shape resembles a dependency-injection attack, so it was
checked rather than assumed.

All seven are published to npm by `amitgupta`, the same account that has published
`fast-xml-parser` since 2017. The remaining two transitive packages, `non-error`
and `tagged-tag`, are published by `sindresorhus`. The `author` field in a manifest
is self-asserted and proves nothing; the registry publisher is what was checked.

Exact package and transitive integrity hashes are in `pnpm-lock.yaml`.
