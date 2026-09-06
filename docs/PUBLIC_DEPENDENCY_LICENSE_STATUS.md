# Dependency license observations

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
