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

## Before distributing additional artifacts

Formatted results use unchanged react-markdown 10.1.0 and remark-gfm 4.0.1.
Their original [react-markdown license](third_party/react-markdown/LICENSE) and
[remark-gfm license](third_party/remark-gfm/LICENSE) are retained byte-for-byte.
Upstreams: https://github.com/remarkjs/react-markdown and
https://github.com/remarkjs/remark-gfm. Control Room's local rendering restrictions
are wrapper behavior, not upstream modifications. Transitive notices remain part
of release-artifact reconciliation.

The selected JWT verifier retains its [notice](third_party/jsonwebtoken/NOTICE.md)
and [original MIT license](third_party/jsonwebtoken/LICENSE). Its Apache-licensed
consumer wrapper does not relicense the dependency or its transitive packages.

The [node-postgres notice](third_party/pg/NOTICE.md) and
[original MIT license](third_party/pg/LICENSE) cover the selected pg runtime
dependency. Its transitive packages and development-only declarations retain
their own licenses; preserve these when preparing a bundled release.

If a release adds bundled JavaScript, a container, native libraries, WASM, fonts,
images or vendored source, review that exact artifact's contents and applicable
notices/source obligations first. The source-preview inventory is not clearance
for those different distributions. Do not copy an installed dependency tree into
a release or assume the project LICENSE covers it.

This file explains the source-preview scope. It is not legal certification, a
complete software bill of materials or clearance for additional distribution formats.
