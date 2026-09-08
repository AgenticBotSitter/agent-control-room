# F9 actual Vite bundle-notice plugin fit

2026-09-08; baseline b24b272. **Adopt rollup-plugin-license as the leading implementation for bundled-package discovery and notice extraction, subject to actual Control Room multi-environment packaging acceptance.** It passed the bounded real Vite8 miniature test; do not replace it with a new generic scanner. No product edits or publication approval.

## Identity and execution

Installed isolated rollup-plugin-license3.7.1 with `--ignore-scripts --no-audit --no-fund --legacy-peer-deps`, private cache and /dev/null user config. Peer installation was deliberately omitted; the test imports existing real Vite8.0.13, not a newly installed Rollup executable. Exact plugin published dist SHA256 `4b9b0a5b186701f7eb0e56edf993dcb337cd1aa2a3b671ebcd7859e9ea517e25` and Vite entry SHA256 `9b3e72282cfda2f0e60ad5b123e2c8a89e27b9b7cc7c892ae7b34036db5f92ef` asserted before imports; installed Vite version asserted. Full resolved plugin dependency lock (registry URLs/integrities), closure byte/file count and sorted whole-file manifest digest retained in f9-plugin-acquisitions.json. This is not a claim every Vite transitive/native module was independently verified.

`research/reuse-comparisons/f9-plugin-fit.mjs` uses actual Vite build and actual plugin hooks against authored disposable package files. configFile/envFile disabled, publicDir false, write:false; no Control Room app build, config loading, server or synthetic fixture application-module runtime execution. Actual Vite/plugin code and their build dependencies did execute. Plugin itself writes only synthetic notice output inside owned root. Its template captures the real plugin's dependency records, not a replacement scanner. All licenses/NOTICE bodies are intentionally synthetic fixture markers, not redistributed third-party code.

## Six assertion groups passed

| Scenario | Actual observation | Integration consequence |
|---|---|---|
| Used, unused/tree-shaken, external, virtual, copied project-local source | Only used npm package reported; full license and separate NOTICE captured; external remains import; unused literal removed; copied/virtual values remain in bundle | Reuse actual bundle-aware selection. Maintain external dependency inventory and copied-source provenance separately |
| Private default | Rendered private dependency omitted | Set includePrivate explicitly for selected release scope, rather than assuming default complete |
| Rendered private+self with flags | Both recorded with full synthetic texts | IncludeSelf only observes rendered project files, not an independent project-license packaging guarantee |
| MIT manifest without LICENSE file | SPDX MIT policy succeeds but licenseText null | Configure explicit full-text completeness check using plugin records/existing retained overrides; SPDX policy alone is insufficient |
| No license metadata/text | Configured failOnUnlicensed/failOnViolation rejects | Reuse plugin failure policy; this does not establish legal compatibility |
| ES+CJS output formats | Two bundles and two notice callback invocations, identical used-package set | Output aggregation must be deterministic; this is not yet separate client/RSC/SSR environment proof |

The first run failed only the self expectation: its entry merely re-exported an imported binding, leaving no rendered self module. That matches plugin's renderedLength filtering, not a Vite incompatibility. One focused fixture correction adds own rendered expression. Corrected six-group run passed; a tool orchestration `.then` typo occurred **after** successful stdout and lost the saved return value, so unchanged corrected harness was repeated solely to retain direct stdout/exit. Both facts are preserved in f9-plugin-evidence.json. No hidden failed assertion is converted to upstream acceptance.

## Exact reuse/removal decision

Use plugin's existing package traversal, nearest-package lookup, license/NOTICE reading and SPDX-expression validation. Do not implement generic equivalents. Existing diagnostic f9-distribution-inventory is not a production dependency engine to expand. Keep historical evidence/index files as provenance, not competing runtime scanners.

One focused integration batch remains: attach separately configured plugin instances to actual Vite client/RSC/SSR builds; merge/deduplicate outputs by exact package identity plus full-text digest; retain original Apache text, Control Center copied-file map, entities pinned-text exception and external pg-boss/React notices; reject null required text, orphan component, changed lock/build, missing file and inconsistent outputs. Prefer plugin output callbacks/configuration plus existing hash indexes for those project-specific rules. No new generic notice assembler is justified by this test.

Incomplete: actual vinext multi-environment build, dynamic/chunk splitting, symlink/monorepo/optional-peer identity, CSS/fonts/assets, virtual modules carrying third-party code, nested license subfiles, external transitive closure and full artifact packaging. Current test only shows ordinary fixture virtual/copied code lacks separate package attribution; it does not certify arbitrary virtual-module handling. Two formats are not two environments. No actual Control Center code or real license missing from the app was altered.

Plugin root MIT retained in installed package during test; full transitive declared-license metadata in lock is inventory, not legal clearance. Prior pinned source/tests remain in F9 tooling report at upstream commit6faf8f51c7e5f48f1a8dc0be313b038c054a84af; this experiment exercised the published artifact rather than rebuilding upstream source.

## Resource and cleanup

140GiB available checked. Exact owned root `/private/tmp/cr-f9-plugin.UtNOAa`;14MiB including isolated dependencies/cache/fixtures, within30MiB cap. No global/application install, native credentials, external service/provider, GitHub write or app build. No listeners or background service started. Evidence retained; exact owned root removed and absence checked. No temporary installed dependencies or fixtures retained.
