# F9 established notice/SBOM tooling comparison

2026-09-08, baseline `a9a9a35`. Research only. No application dependency install/build, credential access, services or GitHub write. Provisional direction: combine installed-dependency inventory with a bundle-aware notice plugin; **do not build a generic notice engine**. Finalist runtime tests remain outstanding.

## Actual pinned implementation and tests

| Tool | Source/test inspected | Fit and remaining test |
|---|---|---|
| Installed npm10.9.8 | Actual `lib/commands/sbom.js` uses Arborist loadActual/loadVirtual, rejects graph errors; CLI/source hashes in evidence | Executed baseline inventory. Includes installed-unused packages, omits full license text. Not bundle provenance |
| license-checker-rseidelsohn5.0.1, registry gitHead `2f83a3bd92e6bd1c8513b1a8a2234ab5a59a7330` | Published lib/index.js reads license files/custom licenseText and checksum-verified clarifications. Actual Arborist adapter follows link targets/on-disk metadata. Pinned tests/arborist-adapter-test.js covers links, hidden-lock license preservation, peers/legacy licenses | Strong full-text installed-graph collector and existing clarification mechanism for entities exception. Not chunk membership. CLI not run; needs Arborist9.6.0/package-json7.0.5 and declared closure |
| @cyclonedx/cyclonedx-npm6.0.1, registry gitHead `3dbc1f2cc4689d9f0729e3930778a054a346b677` | Actual builders call npm ls, support gatherLicenseTexts/reproducibility/package-lock-only. npmRunner may discover npm via temporary npm run unless npm_execpath supplied. Pinned integration/cli.from-setups.test.js has license-text and lock-only cases | Rich standardized SBOM, not pnpm-lock parser or bundle analyzer. Installed-tree route might work with pnpm; test before rejection. CLI not run; needs cyclonedx-library10/commander14/normalize-package-data/packageurl-js/SPDX/xmlbuilder2 |
| rollup-plugin-license3.7.1, v3.7.1 peeled commit `6faf8f51c7e5f48f1a8dc0be313b038c054a84af` | Actual published renderChunk uses chunk.modules with renderedLength>0/nonasset; generateBundle scans dependencies. Reads LICENSE/LICENCE and NOTICE. Actual pinned test/license-plugin.spec.js checks notice extraction/private/self handling | Best match for bundled full-text notices; external imports and copied project-local source need separate mapping. Vite8/Rolldown and multi-environment compatibility untested; Rollup4 support alone is not proof |

All three published tarballs and selected source/tests have hashes in acquisition receipt. Root texts inspected: checker BSD-3-Clause/Yahoo, CycloneDX Apache-2.0+NOTICE, Rollup plugin MIT. No transitive license clearance. Tag/gitHead associations do not prove reproducible source-to-published-dist builds. Upstream tests above were read, not run.

## Actual executed baseline

`node research/reuse-comparisons/f9-tooling-npm-fit.mjs /private/tmp/cr-f9-tools.XhLdwn` passed (exit0). Real npm CLI, sterile offline environment, two manually authored synthetic packages; no install or package-code execution. Three checks: npm ls and CycloneDX include both installed packages; SBOM omits full synthetic LICENSE text; removing required dependency causes ESBOMPROBLEMS. Direct stdout/status is retained in f9-tooling-npm-evidence.json. The label unused is conceptual fixture context, **not an actual tree-shaking experiment**. No claim of full pnpm/peer/optional graph acceptance.

Installed pnpm11.19.0/npm10.9.8 availability verified. The three candidate packages were not already in the application's installed graph. No newly acquired CLI or plugin was executed. Initial captured run records observed CLI/source hashes and separately checked version, not pre-execution identity enforcement. Following review the retained script now asserts those exact CLI/source hashes and package-derived version before execution; this guard-only change was source checked, not rerun. Its known installed npm path is macOS-specific; these two hashes do not freeze all npm transitive implementation files.

Cleanup complete: exact owned `/private/tmp/cr-f9-tools.XhLdwn` removed after evidence retention and absence checked. No services or installations remain.

## Concrete next decision/removal batch

1. Test rollup-plugin-license first in a fresh isolated miniature current-Vite8 build: used/unused modules, external import, missing license, separate notice, private/self package, two outputs, virtual module and copied-source mapping. Assert exact notices rather than successful build alone. Actual plugin dependencies include moment2.30.1 (4,350,323 unpacked bytes), lodash4.17.21 (1,412,415) and six smaller packages. Current cohort reached5.8MiB; installation was not attempted, not denied or rejected. Resolve/account exact closure in a fresh bounded cohort; active goal already permits this comparison.
2. Test checker against flat and pnpm-like link graphs with peers, full text and checksum-pinned override. Compare actual pnpm inventory with npm baseline. Use CycloneDX CLI only if richer standardized evidence is needed; do not create a foreign lock just to make npm-specific tooling appear authoritative.
3. If plugin passes, reuse its package traversal, license/NOTICE extraction, output formatting and SPDX policy instead of writing parallel infrastructure. If checker passes, reuse its clarification/checksum mechanism for retained source exceptions. Reuse existing full-text indexes; don't redownload resolved notices.
4. Keep only the genuinely project-specific integration: exact build/lock-to-artifact binding, external graph reconciliation, explicit Control Center copied-file provenance and missing/changed/orphan-notice gates. Final tool choice is pending the decision-changing tests, not settled by this source screen. No production deletion yet.

Package inventory and bundle notices are complementary. None replaces original Apache/third-party full texts or grants publication/legal clearance. Existing30dependency distribution gap remains.

## Acquisitions and cleanup

140GiB free checked before owned `/private/tmp/cr-f9-tools.XhLdwn`;5.8MiB allocated, below10MiB. npm pack used ignore-scripts/private cache/dev-null userconfig; no dependencies installed. Public registry metadata, selected GitHub tree metadata and three test files only. Exact package URLs: registry.npmjs.org/license-checker-rseidelsohn/-/license-checker-rseidelsohn-5.0.1.tgz; registry.npmjs.org/@cyclonedx/cyclonedx-npm/-/cyclonedx-npm-6.0.1.tgz; registry.npmjs.org/rollup-plugin-license/-/rollup-plugin-license-3.7.1.tgz. Tests use raw.githubusercontent.com at pins above and paths described. One metadata repair: unprefixed tag404/unquoted shell-query refusal, corrected v-tag/quoted URL succeeded. No runtime repair.

Cleanup completed as recorded above. Source links: [checker](https://github.com/RSeidelsohn/license-checker-rseidelsohn/tree/2f83a3bd92e6bd1c8513b1a8a2234ab5a59a7330), [CycloneDX](https://github.com/CycloneDX/cyclonedx-node-npm/tree/3dbc1f2cc4689d9f0729e3930778a054a346b677), [Rollup plugin](https://github.com/mjeanroy/rollup-plugin-license/tree/6faf8f51c7e5f48f1a8dc0be313b038c054a84af). Findings derive from actual acquired code, not search summaries.
