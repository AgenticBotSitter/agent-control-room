# Dependency license observations

## Current actionable summary

**2026-09-06 owner decision:** Apache-2.0 is now approved and applied to original code
in the isolated public candidate, with the agreed project attribution NOTICE. Earlier
statements below that original-code licensing is undecided are historical. This decision
does not change upstream terms or certify the remaining distribution review.

**Draft delivery file assembled:** `research/DEPENDENCY_NOTICES_DRAFT.txt` combines
36 distinct retained notice texts with component/version labels. It includes direct
roots, the selected runtime graph, known bundle owners, resolved Vite gaps and PGlite's
alternate PostgreSQL notice. `research/notice-draft-assembly.json` records its 189,118
bytes, hash and each original notice's source hash. All 36 texts and labels match the
retained sources after explicitly declared LF newline normalization (TypeScript source
used CRLF). Original evidence is unchanged. No original-code license is selected.

This is an attribution draft, not an assembled source candidate or complete legal
clearance. Final transitive/generated/platform scope, asset rights and delivery checks
remain. Do not ship a private research directory wholesale: select this reviewed draft
only after matching it to actual distributed components and resolving remaining duties.

At `bb5c209`, **all 28 current direct dependencies have a resolved root notice-text
location**. `research/direct-notice-retention.json` now preserves 16 distinct complete
installed root texts (142,018 bytes) across 23 packages and references the five existing
immutable-upstream evidence records for missing package roots. Current root manifest,
installed manifest and notice hashes were checked. This is comprehensive direct-root
retention, not comprehensive license review: texts added by this consolidation are
explicitly marked retained/not newly full-text reviewed. No download or install.

Prioritize Vite's 108,466-byte multi-component LICENSE.md for full-text/vendor review,
then the other newly retained development texts. Do not repeat missing-root searches
for the five packages already resolved. The actual candidate still needs applicable
notice delivery and transitive/bundled/native scope decisions; this private inventory
is not itself a completed public attribution file or a grant for original project code.

At `4461a31`, full notice text has been read and retained for **all 26 production-root
dependency snapshots** in the current lockfile. The consolidated
[`research/runtime-notice-coverage.json`](research/runtime-notice-coverage.json) maps
each peer-qualified snapshot to installed manifest hashes and exact notice text hashes:
23 packages have root notice files (including both alternatives for type-fest), two use
embedded README notices, and Postgres.js uses its pinned upstream notice. Seventeen
distinct texts are retained without removing copyright/author attribution. Original
project licensing is still undecided; no distribution-compliance clearance is claimed.

The practical remainder is now:

1. Retain applicable framework/browser-bundle/vendor and CSS-tooling notices with the
   chosen source or built deliverable; the existing runtime map is not that full scope.
2. Complete development-package provenance and nested/bundled notice review. The
   earlier Cloudflare root-text retrieval gaps are now resolved below; they no longer
   need repeated location searches. Do not discard useful build tools.
3. Complete source/asset privacy and rights decisions and original-code license choice.
4. Prepare and test the actual clean source candidate and usable synthetic demo, then
   independent review and exact owner publication approval. A map of notice texts is
   not proof of a working contributor setup.

Prebuilt database/native/WASM archive redistribution is separately scoped future work,
not an implicit requirement to package every installed cache file into the first source
preview. No install, download, runtime behavior or package manifest changed in this pass.

2026-09-06. Inspected installed packages at baseline `5e424f6`. No dependency changes,
downloads/installations, project license selection or publication.

## Observed metadata

The local evidence file `research/direct-dependency-license-observations.json` records
all 28 directly declared installed packages: five runtime and 23 development entries.
Each record includes requested/installed versions, the package's declared license,
manifest hash, and names/hashes of root license/notice files. The application lock hash
is recorded. No absolute package-cache paths or credential configuration are included.

| Declared license | Direct entries |
|---|---:|
| MIT | 24 |
| Apache-2.0 | 2 |
| Unlicense | 1 |
| MIT OR Apache-2.0 | 1 |

Every entry remains `metadata_observed_not_cleared`. License identifiers alone are not
complete notices, provenance, legal advice or a grant covering our original code.
The runtime entries are pg-boss, postgres, React, React DOM and Zod. PGlite and TypeScript
declare Apache-2.0; Wrangler declares an alternative MIT/Apache expression.

## Gaps to resolve, not presumed violations

No root file matching license/copying/notice names was found for postgres,
@cloudflare/vite-plugin, @next/eslint-plugin-next, @vitejs/plugin-rsc or wrangler.
This does not prove no license exists: texts can be upstream or embedded elsewhere.
Do not remove useful packages merely because this limited scan did not find a file.

For Postgres.js, the upstream version-tagged
[v3.4.7 UNLICENSE](https://raw.githubusercontent.com/porsager/postgres/v3.4.7/UNLICENSE)
was readable and consistent with the installed package's Unlicense declaration.
That resolves where to investigate the text, not a verified npm-to-source provenance
chain. Pin the corresponding immutable source and retain required material with the
final distribution review. No downloaded license file was added in this step.

Vite's local LICENSE.md contains notices for bundled components in addition to its own
license. This is a concrete reason not to summarize distribution obligations using
only the top-level `MIT` field. PGlite's local LICENSE contains the full Apache text;
its bundled database/WASM components still need their own provenance/notice accounting.

The existing Control Center adaptation has a local source revision, original file and
hashes in `third_party/control-center/NOTICE.md`, plus its MIT text. Preserve both with
any included adapted code. This observation does not license unrelated upstream files.

## Installed transitive reconnaissance

### Notice-location follow-up

At private baseline `ab97537`, inspected installed manifests and package files to
three directory levels for the five direct packages with no matching root notice.
The scan skipped nested `node_modules` and symlinks; it is not an exhaustive bundled
license scan. No packages or license files were downloaded into the workspace.

| Exact installed package | Observed notice location | Remaining limitation |
|---|---|---|
| @vitejs/plugin-rsc 0.5.26 | Installed `dist/vendor/react-server-dom/LICENSE` contains Meta's MIT notice; the [plugin release-tag root license](https://raw.githubusercontent.com/vitejs/vite-plugin-react/plugin-rsc@0.5.26/LICENSE) contains the Vite contributors' MIT notice | The vendor notice is not a replacement for the plugin's own notice; retain both where applicable and verify source/package provenance |
| @next/eslint-plugin-next 16.2.6 | [Next.js v16.2.6 root license](https://raw.githubusercontent.com/vercel/next.js/v16.2.6/license.md) contains Vercel's MIT notice | Its installed manifest points to the monorepo package; an upstream tag alone does not prove exact npm source correspondence |
| postgres 3.4.7 | Version-tagged UNLICENSE identified above; no matching nested file observed in this scan | Retain exact applicable text/provenance with any distribution rather than treating metadata as the notice |
| wrangler 4.92.0 | Installed manifest points to workers-sdk/packages/wrangler; [release-tag repository listing](https://github.com/cloudflare/workers-sdk/tree/wrangler@4.92.0) lists root LICENSE-MIT and LICENSE-APACHE | License bodies could not be retrieved from the tag in this check; listing is location evidence only |
| @cloudflare/vite-plugin 1.37.1 | Installed manifest points to workers-sdk/packages/vite-plugin-cloudflare and declares MIT | No matching nested notice observed; attempted release-tag license retrieval failed, so exact text remains unresolved |

The initial direct-dependency JSON remains historical root-file evidence; do not
rewrite its observations as though the nested notice was originally inspected.
These findings reduce the unknown notice locations, not the obligations of the final
distribution. Source-only setup, browser bundles and packaged native tooling still
need separate inclusion accounting. Failed retrieval is neither proof of absent
licensing nor authority to substitute a current-main license for the installed version.

At baseline `e03f1c9`, a read-only scan of physical package directories under the
local pnpm virtual store observed 476 package manifests. Symlink-only entries were
not followed. This is an installed-package observation, not lockfile reachability,
a complete bundled-code SBOM, or a description of the final public distribution.
It can include development, optional/platform-specific or stale installed packages.
No packages were downloaded, removed or changed.

Declared metadata totals: MIT 398; Apache-2.0 27; ISC 17; BSD-2-Clause 10;
MPL-2.0 8; BSD-3-Clause 5; MIT OR Apache-2.0 3; CC0-1.0 2; and one each of
LGPL-3.0-or-later, Python-2.0, CC-BY-4.0, BlueOak-1.0.0, Unlicense, and
`(MIT OR CC0-1.0)`. These are declarations, not compliance clearance.

Prioritized paths observed in dependency/optionalDependency declarations:

| Component | Observed path into the installed toolchain | Review needed |
|---|---|---|
| libvips platform payload, LGPL-3.0-or-later | miniflare 4.20260515.0 → sharp 0.34.5 → @img/sharp-libvips-darwin-arm64 1.2.4 | Whether native payloads are distributed; corresponding notices/source obligations |
| @vercel/og 0.8.6, MPL-2.0 | vinext 1.0.0-beta.2 → @vercel/og → satori 0.16.0 and @resvg/resvg-wasm 2.4.0 | Actual source/bundle inclusion and notices for image-generation dependencies |
| lightningcss, MPL-2.0 | @tailwindcss/node 4.2.1 → lightningcss 1.31.1; vite 8.0.13 declares ^1.32.0 | Build-tool versus shipped native/bundled content; local versions 1.31.1 and 1.33.0 |
| axe-core 4.13.0, MPL-2.0 | eslint-plugin-jsx-a11y 6.10.2 declares axe-core ^4.10.0 | Development-only scope versus any redistributed tooling |
| caniuse-lite 1.0.30001809, CC-BY-4.0 | browserslist 4.28.8 declares caniuse-lite ^1.0.30001809 | Data attribution if redistributed |

These declaration edges are investigation leads, not proof of runtime execution or
the final resolved distribution graph. In particular, do not remove image tooling,
CSS tooling or accessibility checks merely because their metadata differs from MIT.

Mozilla's [MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) explains that MPL
permits combining covered files with other licenses, while distribution can require
notices and access to covered source. Its browser-delivered code distinction matters
here: a hosted application is not automatically outside distribution review. Read
the applicable license against the actual deliverable; this report is not legal advice.

Next practical step: decide source-only developer preview versus packaged binaries,
then trace these specific paths into that deliverable and retain the required notices.
Keep the existing dependencies while that scoped review proceeds.

## Next licensing batch

### Remaining Vite quoted MIT/ISC terms reviewed

At `04fa0a0`, compared all 71 remaining quoted MIT/ISC sections by removing Markdown
quote prefixes and collapsing whitespace, keeping every component attribution prefix.
Read all five resulting terms variants and all attribution prefixes. Exact block hashes,
normalized quote hashes, prefixes and terms are recorded in
`research/vite-normalized-terms-review.json`. The original 108,466-byte Vite notice
remains unchanged and authoritative; normalized comparison text is not a replacement.

Three MIT variants differ in quotation punctuation; the ISC wording is separate.
Lodash's variant also has a CC0 documentation-sample statement and an explicit caveat
for separately maintained node_modules/vendor libraries. Keep that exception and its
jQuery/Underscore attribution instead of flattening it into a generic MIT notice.

Together with the previously read Apache/BSD blocks and resolved metadata-only upstream
notices, this closes the planned Vite notice-text comparison pass. It does not prove
source-to-installed-bundle equivalence or identify every component shipped by our
eventual output. The next Vite-specific task is preserving applicable complete notices
with the chosen deliverable and checking actual output scope, not rereading the same
71 quoted sections. No downloads, package changes or original-license selection.

### Vite's three declared patches inspected

At `648d96f`, retrieved the exact release's pnpm-workspace.yaml and all three declared
patches, not just sirv. Full inert texts are retained in
`research/vite-upstream-patch-review.json`. The patch SHA-256 values match the source
lock's previously observed patch_hash values for sirv 3.0.2, chokidar 3.6.0 and
dotenv-expand 13.0.0. Download log: 7,514 bytes after checking 102 GiB free.

Read all three patches. Sirv adds a development lookup shouldServe callback and avoids
an extra directory separator. Chokidar skips ignored-file callbacks; dotenv-expand
uses the full parsed input in its expansion. The patches change code/types, not license
files or copyright notices. Preserve component notices plus Vite's attribution for
modifications. No patch was applied, no downloaded scripts executed, and no installed
package changed. These observations do not qualify their runtime security or make a
development server a production protection boundary.

This resolves the particular unknown sirv patch and the other two declared patch
contents. The full Vite bundle has not been reproduced; remaining MIT/ISC text review
and final notice delivery still stand. No new original-project license was chosen.

### Four Vite notice locations resolved through release sources

At `abb55eb`, Vite v8.0.13 peels to
`a46f11a6c218f74b08ffb3e33a25c2ce02ba6643`. Its source lock records
@polka/compression 1.0.0-next.25, @polka/url 1.0.0-next.29, sirv 3.0.2 and
string-hash 1.1.3. Exact-version registry integrity fields match all four source-lock
entries. Registry gitHead values identify immutable upstream source locations; this
is not reproducible proof of every byte in Vite's generated bundle.

`research/vite-missing-notice-source-trail.json` retains the full Luke Edwards MIT
notice from both Polka commits and the sirv commit, plus string-hash's release README
with its Dark Sky CC0 dedication. Full texts were read. string-hash's root tree has no
license file; its README is the actual declaration location, so the initial lowercase
license 404 is resolved rather than treated as an unlicensed package. Its matching
manifest is retained; its tiny source was read without execution and only its hash kept.

Disk check: 102 GiB free before retrieval. Total response bodies: 526,834 bytes,
including Vite's lockfile, registry metadata, tree listing and one 404 response. Only
selected source metadata/hashes and relevant notice/README/manifest texts are retained;
no package tarballs, installs, clones, downloaded-code execution or GitHub writes.

These four notice-location gaps no longer require searching. The source lock identifies
a patch on sirv, which still needs inspection when accounting for bundled modifications.
Other MIT/ISC Vite blocks have not all been read; complete source/bundle correspondence
and final distribution notice delivery remain unproved. This does not select a license
for original Agent Control Room code or approve publication.

### Vite bundled notice structure and four missing bodies

At `fb3a922`, indexed all 78 bundled-component sections of the retained Vite 8.0.13
LICENSE.md. `research/vite-bundled-notice-index.json` preserves heading, declared
licenses and exact block hashes/lengths. There are 82 declaration lines (some sections
group multiple components): 70 MIT, eight ISC, two BSD-2-Clause, one Apache-2.0 and
one CC0-1.0. These are declarations, not independently verified component licenses.

Fully read the Apache block for @vercel/detect-agent, both BSD blocks (dotenv-expand
and entities), and string-hash's short CC0 entry. Other sections are explicitly indexed
as structure-only, not claimed fully reviewed. The unchanged complete source text stays
in the earlier retention record, including all author notices and differing terms.

Four sections contain metadata only, without a quoted license body: @polka/compression,
@polka/url and sirv (MIT), and string-hash (CC0-1.0). Direct inspection confirmed the
absence of a body in these four sections; this is not a claim the upstream project is
unlicensed. Their exact bundled versions/commits and applicable texts need identifying
before accepting this as complete bundled attribution. Neither the lockfile nor the
installed Vite manifest contained a string-hash entry in the bounded search. Do not
substitute today's upstream main notice or generic MIT text without its attribution.

Next: resolve these four pinned-source/text gaps and review remaining terms; then
carry applicable notices with the actual candidate. Retaining the Vite file alone
does not close this step. No download, install, source modification or license selection.

### Next lint root notice and PostCSS notice retained

At `8c24388`, Next.js tag v16.2.6 resolves to immutable commit
`ee6e79b1792a4d401ddf2480f40a83549fe8e722`. Its root MIT notice and lint-package
manifest are retained verbatim in `research/next-postcss-notice-evidence.json`, with
URLs, hashes, byte counts and cleanup guidance. The upstream manifest is byte-identical
to the installed @next/eslint-plugin-next 16.2.6 manifest. That supports provenance
but does not prove equivalence of the generated dist files. The root-text gap is now
resolved, alongside the earlier Postgres.js, RSC and Cloudflare root-text gaps.

Downloaded 1,794 bytes after checking 102 GiB free; manifests were parsed as data,
not executed. Also retained the installed PostCSS 8.5.26 root MIT notice (1,095 bytes),
resolved through the existing Tailwind PostCSS package, without a download. All exact
notice text, sizes and hashes were checked. These records preserve public upstream
author attribution; they contain no owner credentials or deployment configuration.
Nested vendors, final delivery notices, assets and original-code rights remain separate.

### Tailwind root notice coverage

At `9c1a238`, read the complete installed root MIT texts for `tailwindcss`,
`@tailwindcss/postcss`, `@tailwindcss/node` and `@tailwindcss/oxide`, all 4.2.1.
All four are byte-identical (1,071 bytes). Exact package-manifest hashes and the full
shared text are retained in `research/tailwind-notice-evidence.json`. No download,
installation or executed package entrypoint was needed; package paths were resolved
and files read as data. Package export restrictions were handled by locating the
manifest beside its resolved entry, not changing installed files.

This closes these four root-notice retention tasks, not all CSS-tooling obligations.
The node package declares Lightning CSS 1.31.1; its rights are separate. Oxide's
platform-specific payloads were not included or reviewed. CSS header/reference inspection
found CSS Remedy and browser issue links, not an additional copyright/license block;
that bounded search is neither a full source review nor proof of copied code. The actual
candidate's bundled stylesheet/notice delivery still needs verification. Keep all
useful tools; no original Agent Control Room license has been selected.

### Cloudflare root notice retrieval gaps resolved

At `ac4dbfa`, public annotated tags for `wrangler@4.92.0` and
`@cloudflare/vite-plugin@1.37.1` both peeled to commit
`a3fa623f2abf192e57d876c727bfa107aa297ec9` in workers-sdk. Direct immutable-source
retrieval succeeded for `LICENSE-MIT`, `LICENSE-APACHE` and both package manifests.
Read the full license texts; the manifests confirm the requested versions and their
MIT / MIT OR Apache-2.0 declarations respectively. Previous failed web-cache/tag-body
retrievals remain historical, not unresolved root-text locations.

[`research/cloudflare-notice-evidence.json`](research/cloudflare-notice-evidence.json)
retains the four exact files as text, including URLs, sizes, hashes, commit, release tags
and cleanup guidance. Total retained content: 18,855 bytes after checking 102 GiB free.
The downloaded package manifests were parsed as data, never executed. No package install,
CI, credential operation, repository clone, push or publication occurred.

These root notices do not establish a complete npm-to-source binary correspondence or
cover every nested/generated vendor component. Retain applicable notices with the final
deliverable and continue its scoped dependency review. Retaining Apache text for an
upstream tool is not choosing Apache-2.0 for original Agent Control Room code.

### PGlite extension pins and preview scope recommendation

At `ecf8d99`, inspected `.gitmodules`, `.buildconfig` and `wasm-build/build-ext.sh`
from database source commit `1195d5388bd5529e0013c45fa816cfcd953d84e0`. The config
declares PostgreSQL 17.5 (`REL_17_5_WASM`) and SDK 3.1.74.11.11. These are source
configuration values, not a measured version assertion for the installed WASM binary.
The complete recursive Git tree (`truncated: false`) records:

| Extension source | Git submodule commit |
|---|---|
| sraoss/pg_ivm | `f4b40e93a60478a1ea9d69f0fd305452e5c00690` |
| fboulnois/pg_uuidv7 | `c707aae2411181be4802f5fa565b44d9c0bcbc29` |
| theory/pgtap | `6e3acbf4e0cb19997edeafeabf1b18870ea68a5e` |
| pgvector/pgvector | `2627c5ff775ae6d7aef0c430121ccf857842d2f2` |

The extension build script processes PostgreSQL contrib directories with platform-
dependent skips and invokes extra extension scripts. The tree lists extra scripts for
pg_ivm, pg_uuidv7 and vector; do not infer the complete pgTAP packaging path from that
list alone. Build-cache branches and platform settings are additional reasons source
pins do not by themselves establish exact npm archive correspondence.

Read-only retrieval log (no new retained source files or executable downloads):
[submodule declarations](https://raw.githubusercontent.com/electric-sql/postgres-pglite/1195d5388bd5529e0013c45fa816cfcd953d84e0/.gitmodules),
[build configuration](https://raw.githubusercontent.com/electric-sql/postgres-pglite/1195d5388bd5529e0013c45fa816cfcd953d84e0/.buildconfig),
[extension build script](https://raw.githubusercontent.com/electric-sql/postgres-pglite/1195d5388bd5529e0013c45fa816cfcd953d84e0/wasm-build/build-ext.sh),
and GitHub's recursive tree API for the same commit. Disk check reported 102 GiB free.
The responses were inspected, not executed; this document retains only findings/links.

**Recommendation for the first developer preview:** distribute reviewed application
source, lockfile, notices and synthetic contributor tests, with frozen package setup;
do not also copy `node_modules`, prebuilt PGlite WASM/data/extension archives or an
operator database into that repository. This does not remove PGlite from tests or
waive source/setup/dependency review. It separates the already-proposed source preview
from a later packaged-binary deliverable, which would require full payload attribution
and provenance before release. Do not require a binary-distribution evidence claim
for a source-only candidate that does not distribute those binaries. Conversely,
browser-bundled code remains distributed if we publish a hosted/compiled demo, so its
notice delivery must still be covered. No candidate assembly/publication is approved
by this recommendation; exact scope and the existing preview requirements remain.

### PGlite alternate notice and binary-source trail pinned

At `85e8c4c`, direct read-only retrieval succeeded where the web cache had missed:
the exact release's `POSTGRES-LICENSE` contains PostgreSQL/University of California
permission and disclaimer text. It is retained with `.gitmodules` and root
`package.json` in [`research/pglite-source-notice-evidence.json`](research/pglite-source-notice-evidence.json).
The retained files total 2,620 bytes, with exact source URLs, sizes and SHA-256 hashes;
disk check showed 102 GiB free. No scripts were executed or dependencies installed.

The release tree pins `postgres-pglite` as a Git submodule at
`1195d5388bd5529e0013c45fa816cfcd953d84e0`, resolved to the sibling repository
`electric-sql/postgres-pglite` by `.gitmodules`. The root package scripts build inside
that submodule, copy `dist/bin/pglite.*` into the package release directory, and copy
`dist/extensions/*.tar.gz` alongside them. This identifies the intended binary source
trail, not an independently reproducible match to the installed npm payloads.

Read-only lookup also queried the release tree and a guessed root `Makefile` (404).
Those lookup responses were inspected but not retained as additional files; the three
source files above are the retained download set. Nothing was extracted, installed,
started, pushed or published. Exact extension versions/build inputs belong to the
pinned submodule review next. Do not substitute current-main extensions or infer that
all archived components share the root package license.

### PGlite development payloads and license-description difference

At `ca332b5`, inspected installed `@electric-sql/pglite` **0.3.14** without importing
or executing it. Its manifest declares Apache-2.0; its installed README's License
section explicitly describes an Apache-2.0/PostgreSQL License choice and says changes
to the PostgreSQL source are under the PostgreSQL License. Record both sources rather
than silently changing metadata or treating the manifest as exhaustive. The current
[official description](https://pglite.dev/docs/about) also describes PGlite as a WASM
Postgres build; current documentation is not a substitute for version-specific rights.

| Installed input | Size / observation | SHA-256 |
|---|---|---|
| package.json | Version and Apache-2.0 declaration | `a540c379fd1d820810793681d25fa7ad5dadfcee2b190d14a6553fdb469cfe3c` |
| README.md | Embedded dual-license description | `b2cea4405c74047b42e92ff2a7590539ce40a378d6b48b3afa27b7f2edeb935a` |
| dist/pglite.wasm | 8,859,436 bytes | `8140392c5f70c5aecb40f514db242fce4223cfdd5f37a2b101dbdc30208dc49d` |
| dist/pglite.data | 4,939,155 bytes | `4703ec26f5710abb62db42acad229478b75c51ef7f3bb037286bb2bac139a930` |

The distribution also contains **51 extension tar.gz archives**, totaling 1,235,651
compressed bytes. Read-only `tar -tzf` listing found 336 archive members and no member
whose name matched license/notice/copying/copyright. No archive was extracted or loaded.
That filename result does not establish absent notices or uniform extension licensing;
SQL/source headers and exact extension source versions still need examination if those
payloads are redistributed. Examples include vector, pg_ivm and pgtap, alongside
PostgreSQL-contributed extensions. Do not infer use from installation alone.

A targeted literal import search for `@electric-sql/pglite/` in repository source,
tests and scripts found no matches; root-package loading is already used by test
fixtures. This does not exclude runtime-selected extensions or embedded core payloads.
Keep PGlite available for contributor tests, not as production write authority. A
source-only contributor installation and a distribution copying node_modules/WASM
have different packaging scope; do not claim either is cleared by the bundle owner list.

Read-only tag resolution found the relevant package release (not the similarly named
pglite-sync release): `@electric-sql/pglite@0.3.14` peels to
`6b7d56e56429259fb0241ffa17d484af2bddf00a`. Attempted web retrieval of that commit's
`POSTGRES-LICENSE` returned a cache miss; the exact alternate text was not retained or
treated as absent. Next: inspect that immutable release's license/build inputs and
extension provenance before packaging its binary payloads. No download/install,
license choice, service, credential access or production database change occurred.

### Two upstream notice sources pinned and retained

At `05663eb`, resolved the public annotated release tags using read-only `git ls-remote`
and retained notice text from each peeled commit, rather than mutable tag/main URLs:

| Package | Release commit | Retained notice |
|---|---|---|
| postgres 3.4.7 | `9b92b65da6a5121545581a6dd5de859c2a70177f` | [UNLICENSE](https://raw.githubusercontent.com/porsager/postgres/9b92b65da6a5121545581a6dd5de859c2a70177f/UNLICENSE), 1,212 bytes |
| @vitejs/plugin-rsc 0.5.26 | `65d378fc4d9bd8d383dc7598817261b3bdcb0861` | [Plugin repository LICENSE](https://raw.githubusercontent.com/vitejs/vite-plugin-react/65d378fc4d9bd8d383dc7598817261b3bdcb0861/LICENSE), 1,103 bytes |

[`research/pinned-upstream-notice-texts.json`](research/pinned-upstream-notice-texts.json)
is the download log and retained exact-text artifact: URLs, commits, tags, byte sizes,
SHA-256 hashes, date and cleanup guidance. Disk check before download reported 102 GiB
available. Total downloaded notice content was 2,315 bytes. No package, repository clone,
installation, GitHub write or Actions run occurred. Initial sandbox DNS failure on the
read-only tag lookup was resolved through scoped network permission, not remote mutation.

These resolve immutable source location and text retention for the two notices. They
do not prove the entire installed npm package corresponds to that source commit, or
resolve every bundled/vendor attribution. The plugin's own Vite-contributor MIT text
and its separate installed React vendor notice must not be conflated. Neither this
Unlicense nor this MIT notice selects a license for original Agent Control Room code.

### Embedded README notices resolve two location gaps

At `ec74c11`, inspected the installed README license sections for **pg-types 2.2.0**
and **pgpass 1.0.5**. Both contain full MIT permission/disclaimer text: Brian M. Carlson
for pg-types and Hannes Hörl for pgpass. The root-license filename scan had missed these
embedded sections. These two notice-location gaps are now resolved; previous observations
remain historical and do not indicate absent licensing.

[`research/embedded-runtime-notice-texts.json`](research/embedded-runtime-notice-texts.json)
retains each exact section with full README, manifest and section SHA-256 hashes plus
verified installed versions. No package execution, credential read or download was used.
Read-only upstream tag listings were also inspected:
[pg-types v2.2.0](https://github.com/brianc/node-pg-types/tree/v2.2.0) and
[pgpass v1.0.5](https://github.com/hoegaarden/pgpass/tree/v1.0.5).
Guessed standalone LICENSE paths returned 404; the retained text comes from installed
README bytes, not a replacement current-main license. Final notice delivery and package
provenance remain separate; Postgres.js and the RSC plugin own-notice tasks remain open.

### Exact installed notice texts retained

At `0ec9a0e`, read the full installed notices for React, React DOM, React Server DOM
Webpack, Scheduler, Vinext and Zod, plus the RSC plugin's nested React vendor notice.
[`research/installed-bundle-notice-texts.json`](research/installed-bundle-notice-texts.json)
preserves seven version-checked source locations and three distinct exact texts keyed
by SHA-256. The React-family/vendor copies contain the same Meta MIT text; Vinext's
root text names Cloudflare and Zod's names Colin McDonnell. No new download occurred.

This is a private evidence archive, not a complete distribution NOTICE or selection of
the original project's license. The plugin's vendor text does not cover the plugin's
own original code. The earlier exact-tag root license location remains a separate
provenance/retention task. A bounded notice-name walk to depth five in Vinext and the
RSC plugin found the root/nested notices described here; inline/generated code and other
names may carry further attributions. No exhaustive absence claim is made.

For the eventual candidate, assemble applicable notices alongside the actual delivered
code/assets and verify that build packaging retains them. Merely keeping this private
research JSON does not satisfy the planned public artifact's notice delivery. The
Postgres.js provenance gap and pg-types/pgpass notice locations remain unresolved.

### Build module attribution follow-up

At `a422fb2`, rebuilt the unchanged standalone application with a local observation-only
`generateBundle` hook. It inspected emitted chunk module records and found each package's
nearest installed manifest; it emitted no added application asset and changed no source
configuration. The final pass for each environment is retained in
[`research/bundled-package-observations.json`](research/bundled-package-observations.json),
with package versions, declared licenses, chunk references and exact output hashes.
Preliminary RSC/SSR analysis passes with zero rendered lengths were not mistaken for
the final outputs. Build log: `/private/tmp/cr-bundle-module-observations.log`.

| Final build environment | Package owners observed in chunk module records |
|---|---|
| Browser | @vitejs/plugin-rsc, react, react-dom, react-server-dom-webpack, scheduler, vinext, zod |
| RSC server | @vitejs/plugin-rsc, postgres, react, react-dom, react-server-dom-webpack, vinext, zod |
| SSR server | @vitejs/plugin-rsc, react-server-dom-webpack, vinext, zod |

All final environments had zero unresolved package owners among the inspected
`node_modules` module records. This makes dependency grouping more precise: framework
packages listed as development dependencies still contribute browser/server code;
Postgres.js is bundled, while pg-boss remains external as previously observed. The
recorded module lengths are bundler metadata, not downloadable/compressed file sizes.

Next notice review should include these exact package texts and nested/vendor notices,
especially React server component tooling, plus the separate external pg-boss subtree.
Nearest-manifest attribution is not proof that every byte originated with that package's
authors. This is not a complete SBOM: CSS/Tailwind output, native/WASM payloads, computed
runtime imports, framework-generated code and copied source need separate accounting.
No absence of MPL/LGPL from this selected chunk-owner list clears the entire toolchain.
No license choice, dependency removal, new installation or publication occurred.

### Runtime lockfile reachability at `2246647`

A read-only traversal of importer `.` production dependencies in `pnpm-lock.yaml`
resolved **26 distinct snapshot keys**, following both `dependencies` and
`optionalDependencies` recursively. Peer-qualified snapshot keys were preserved; every
visited key resolved. The lockfile SHA-256 remains
`51e1e83929e1b806c7316b2ca9b1b2326ae89aec3935f15c9e99a157bc531ad0`.
The existing ESLint dependency's installed `js-yaml` parser read the lock; no parser,
package or service was installed. `pnpm list --prod --depth Infinity --json` could not
open its local SQLite database, so its error was not treated as a dependency listing.

| Reachable package / version | Installed license declaration | Root notice file observed |
|---|---|---|
| cron-parser 5.10.0 | MIT | LICENSE |
| luxon 3.7.2 | MIT | LICENSE.md |
| non-error 0.1.0 | MIT | license |
| pg-boss 12.30.0 | MIT | LICENSE |
| pg-cloudflare 1.4.0 | MIT | LICENSE |
| pg-connection-string 2.14.0 | MIT | LICENSE |
| pg-int8 1.0.1 | ISC | LICENSE |
| pg-pool 3.14.0 (pg 8.23.0 peer) | MIT | LICENSE |
| pg-protocol 1.16.0 | MIT | LICENSE |
| pg-types 2.2.0 | MIT | Not found at root |
| pg 8.23.0 | MIT | LICENSE |
| pgpass 1.0.5 | MIT | Not found at root |
| postgres-array 2.0.0 | MIT | license |
| postgres-bytea 1.0.1 | MIT | license |
| postgres-date 1.0.7 | MIT | license |
| postgres-interval 1.2.0 | MIT | license |
| postgres 3.4.7 | Unlicense | Not found at root; upstream location above |
| react-dom 19.2.6 (react 19.2.6 peer) | MIT | LICENSE |
| react 19.2.6 | MIT | LICENSE |
| scheduler 0.27.0 | MIT | LICENSE |
| serialize-error 13.0.1 | MIT | license |
| split2 4.2.0 | ISC | LICENSE |
| tagged-tag 1.0.0 | MIT | license |
| type-fest 5.9.0 | MIT OR CC0-1.0 | license-cc0 and license-mit |
| xtend 4.0.2 | MIT | LICENSE |
| zod 4.1.12 | MIT | LICENSE |

Totals: 22 MIT declarations, two ISC, one Unlicense and one alternative MIT/CC0.
These are installed metadata/root filename observations, not full notice text review
or source provenance clearance. `pg-types` and `pgpass` add two concrete notice-location
follow-ups. A filename's absence is not proof that no license applies. Optional edges
are included conservatively; this is not evidence every package executes on this host.

The previous 476-package store scan and this 26-snapshot graph answer different
questions. Neither is the final bundle inventory. Do not strip development dependencies:
the contributor preview needs its compiler, framework, tests and CSS build tooling.
Do not remove the `pg` subtree as a duplicate of Postgres.js: pg-boss brings its own
database-driver dependency; replacing that would be upstream modification, not cleanup.

### Current compiled import boundary

Parsed all generated `.js` files under `dist-vps/server` and `dist-vps/client` using
the already-installed TypeScript parser, inspecting literal imports, exports, dynamic
imports and direct `require` calls. The build is the fresh local output recorded at
`2246647`. Excluding Node built-ins, server external specifiers observed were `pg-boss`,
`react`, `react-dom`, `react-dom/server.edge`, and `react/jsx-runtime`. No bare external
package specifier was observed in the client output.

This does **not** mean the client has no third-party code or that bundled Postgres.js,
Zod/framework code is absent. Bundling removes the original package import names.
Computed imports, runtime-selected paths and bundled module identities are not established
by this literal-import pass. Next use build module provenance or equivalent exact output
accounting to distinguish bundled browser/server code from external runtime packages.
Continue the separate native/WASM/tooling review before any packaged-binary claim.

1. Identify the final source versus built-artifact distribution scope. Development
   dependencies and bundled output differ; do not assume devDependencies cannot be
   present in the shipped artifact.
2. Follow the selected lockfile's transitive packages and bundled third-party notices,
   including code generated by framework tooling, platform-specific components and
   native/WASM payloads. Runtime import aliases also require source resolution.
3. Resolve missing notice locations from exact upstream versions; retain provenance
   and texts rather than copying current-main notices onto an older package blindly.
4. Confirm original-code rights and the owner's chosen license, then add complete
   license text and appropriate package metadata. Existing Apache identifier placeholders
   do not authorize that choice.
5. Resolve artwork and final attribution, review exact export bytes, and only then
   request the owner decision to publish the specified candidate.

No complete SBOM, all-transitive license clearance, final NOTICE or artifact compliance
claim is made. The package inventory is a concrete starting list for that review.
