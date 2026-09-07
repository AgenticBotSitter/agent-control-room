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
curation adaptation. That adapted curation implementation is not included in this
initial demo source subset; these notices do not imply the news module is ready.

## Before distributing additional artifacts

If a release adds bundled JavaScript, a container, native libraries, WASM, fonts,
images or vendored source, review that exact artifact's contents and applicable
notices/source obligations first. The source-preview inventory is not clearance
for those different distributions. Do not copy an installed dependency tree into
a release or assume the project LICENSE covers it.

This file explains the source-preview scope. It is not legal certification, a
complete software bill of materials or clearance for additional distribution formats.
