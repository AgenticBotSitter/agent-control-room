# Third-party code and distribution scope

Agent Control Room's Apache-2.0 license covers its original project code. It does
not replace the licenses of third-party software.

## What this source preview contains

This preview distributes source code and contributor documentation. Its source
file set excludes installed dependencies, compiled browser/server output, native
modules, WASM payloads, fonts and container images. Those local build products are
not public release assets merely because they exist in a developer's checkout.

`package.json` and `pnpm-lock.yaml` declare the separately installed dependencies.
Preparing the project downloads or reuses those packages under their own licenses.
Keep their accompanying notices intact. A package being a development dependency
does not mean its code cannot appear in a later compiled build.

The retained [Control Center attribution](third_party/control-center/NOTICE.md)
and [MIT license](third_party/control-center/LICENSE) document the project's upstream
curation, discovery, article-reading presentation and bounded HTTP-reader
adaptations included under `src/vendor/control-center` and the news snapshot UI.
The notice maps upstream revision, original files and local changes. Including
this source does not qualify live collection or agent execution.

The [RSS parser notice](third_party/rss-parser/NOTICE.md) and
[original MIT license](third_party/rss-parser/LICENSE) cover the selected
rss-parser dependency. The lockfile also pins fast-xml-parser and their respective
transitive dependencies. Preserve each installed package's own notices; neither
this document nor our Apache license replaces those terms. Full-article content
is not vendored, and feed metadata does not grant republication rights.

## Notices retained from upstream rather than from the package

Two installed packages state a license but do not ship its text, so an install
alone produces no notice to preserve. Both texts are retained here from the
packages' own upstream repositories:

- [`@nodable/entities`](third_party/nodable-entities/NOTICE.md) and its
  [MIT license](third_party/nodable-entities/LICENSE). Reached transitively through
  `fast-xml-parser`. Its npm tarball ships only `src` and `README.md`, and the
  README names MIT without reproducing it, so the required copyright notice is
  absent from the installed tree. The notice also records why that package and the
  rest of the version-5 dependency expansion were checked against the npm registry
  rather than taken at face value.
- [`postgres`](third_party/postgres/NOTICE.md) and its
  [Unlicense](third_party/postgres/UNLICENSE). A public-domain dedication requiring
  no attribution, retained only so the tree does not state a license it lacks.

Finding these took walking the resolved dependency closure, not the top level of
`node_modules`; pnpm links transitive packages beneath their dependents, so a
top-level scan reports most of the closure as absent.

## Before distributing additional artifacts

If a release adds bundled JavaScript, a container, native libraries, WASM, fonts,
images or vendored source, review that exact artifact's contents and applicable
notices/source obligations first. The source-preview inventory is not clearance
for those different distributions. Do not copy an installed dependency tree into
a release or assume the project LICENSE covers it.

That warning has a concrete case behind it. The full installed closure, including
development dependencies, is 417 packages, of which 20 state a license and ship no
text for it. They are not distributed today, because this preview excludes
installed dependencies, so no notice is retained for them here. Two are worth
naming before any bundle is built:

- `@resvg/resvg-wasm` is MPL-2.0 and ships a compiled `.wasm` payload. MPL is not
  a notice-only license: it attaches source-availability obligations to the files
  it covers. Bundling it is a different decision from installing it.
- `workerd` and `@humanfs/types` are Apache-2.0, whose section 4(d) governs NOTICE
  retention, and neither ships one.

Whoever prepares the first compiled release should re-run that inventory against
the artifact's actual contents rather than against this repository's source list.

This file explains the source-preview scope. It is not legal certification, a
complete software bill of materials or clearance for additional distribution formats.
