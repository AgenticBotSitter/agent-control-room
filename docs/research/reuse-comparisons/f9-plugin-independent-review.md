# Independent F9 Vite notice-plugin review

2026-09-08. Source/receipt review of retained harness, fit report, acquisitions, direct evidence and actual `vite.vps.config.ts`. Downloaded plugin/dependencies are cleaned, so I could not independently re-inspect their implementation or verify the historical closure digest. No execution, downloads, build, services or application changes by this reviewer.

## Finding

**P3 — narrow the statement “no dependency-code evaluation.”** The actual plugin and Vite imports necessarily evaluate dependency/tooling JavaScript. What this fixture avoids is running the authored application/package module bodies as an application (they are bundled as source), together with app config loading and app execution. Change the phrase to say “no fixture application runtime execution; actual plugin/Vite and their tooling dependencies executed.” Existing `configFile:false`, `envFile:false`, `publicDir:false` and `write:false` do not make build tooling non-executable.

## Evidence and boundaries

- The harness uses actual `vite.build` and actual plugin hooks, with disposable package manifests, synthetic full license/NOTICE markers and authored imports. It is not a replacement scanner. Published plugin and Vite entry hashes are checked before their imports; the report correctly avoids claiming independent verification of the entire Vite runtime/dependency/native closure.
- Six groups agree with the retained corrected receipt. The used package supplies both full text and separate NOTICE. Unused source disappears from emitted code and attribution; external code remains an import without bundled-package attribution. Copied project-local and virtual source remain in output without a distinct third-party package record. That supports separate provenance/external inventory requirements, not a claim those cases are license-free.
- Private-by-default omission and explicit rendered-self inclusion are concrete observations. Correcting the self fixture to contain rendered code is disclosed along with the earlier failed assertion, rather than presenting a re-export-only module as passed self coverage.
- SPDX MIT acceptance with null licenseText establishes that the selected plugin policy is not a full-text completeness gate. The report explicitly requires a separate thin check on plugin records and retained overrides. Configured unlicensed rejection is not legal compatibility clearance.
- ES/CJS outputs are two formats, **not** separate client/RSC/SSR environments. Actual VPS config has client and RSC environment options, vinext-created server/SSR outputs, an explicit pg-boss external and separately emitted favicon asset. The report correctly leaves environment aggregation, external closure and assets unqualified.
- The saved manifest digest/file count is a provenance record, not a reproducible complete-file verifier by itself. Exact lock versions/integrities support reacquisition, while cleaned source prevents my independent byte-level review here. No current product install, shipped notice artifact or public publication is established.

## Recommendation and next acceptance

Accept rollup-plugin-license as the **leading bounded bundle-discovery/extraction implementation**, conditional on the stated real packaging acceptance. Do not read the opening “adopt” as authorization to change the product now. A thin project-specific aggregation/completeness layer using plugin callbacks and existing provenance is justified; a new generic dependency traversal/license engine is not supported by these results.

Keep the full-text/installed-graph collector comparison for external packages and link layouts; do not force the bundle plugin to solve that different responsibility or declare F9 complete from these six groups. The next actual build must reconcile exact package identities/text digests across environments, copied Control Center provenance, external dependencies, project license and emitted assets. Missing full text or an orphan component must fail packaging with a traceable exception path, not be inferred satisfied from SPDX metadata.

Disposition: no blocking fidelity defect for the six-group miniature-build comparison; one wording correction. Multi-environment integration, complete distribution notices and final selected-release acceptance remain open.

## Focused correction disposition

2026-09-08, source-only recheck. **P3 addressed:** the report now explicitly distinguishes executed Vite/plugin/build dependencies from synthetic fixture application modules that were bundled but not run as an application. No new execution or independent cleanup verification occurred during this recheck. No remaining finding blocks the bounded miniature-build evidence; multi-environment/distribution acceptance remains open.
