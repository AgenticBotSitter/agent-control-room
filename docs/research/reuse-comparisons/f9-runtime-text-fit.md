# RC10 actual runtime package text fit

2026-09-08, baseline `4d204e6`. **Actual public CycloneDX library 10.2.0 collected byte-identical original root license texts for 35 of 39 existing runtime package identities. Four named retained exceptions passed the same real collector through owned staging, bringing observed identity coverage to 39 and text count to 40.** This is local runtime-text fit, not complete distribution/legal clearance or whole-RC10 approval.

## Actual seam and results

`research/reuse-comparisons/f9-runtime-text-fit.mjs` translates the previously prepared pnpm 11.19.0 graph's physical path suffixes to current installed packages. No new graph walker, graph reinstall, application build, production action, or provider call. The previously prepared manifest and lock hashes are enforced unchanged; actual manifests must match all 39 expected package names/versions. Each returned base64 attachment is decoded and compared byte-for-byte with its actual original file; hashes remain in `f9-runtime-text-evidence.json`. No mismatch was skipped: processed 39, mismatches 0.

The public `LicenseEvidenceGatherer` uses a supported injected filesystem port, with `lstatSync` rather than default symlink-following `statSync`, immediate-directory read confinement and 2 MB file bound. The actual installed implementation SHA256 is checked before import. Filename selection and attachment production are upstream code, not a copied look-alike. Application package code is not evaluated. This proves the selected current pnpm physical-package seam locally (E3 narrow fit); it is not a generated deployable distribution or native runtime qualification.

| Observed result | Count/detail |
| --- | --- |
| Default identities with text | 35 / 39 |
| Default original files | 36; `type-fest@5.9.0` includes both `license-cc0` and `license-mit` |
| Default callback errors | 0 |
| Uncollected root names under supplementary LICENSE/COPYING/NOTICE/COPYRIGHT diagnostic | 0 |
| Default missing texts | `@nodable/entities@3.0.0`, `pg-types@2.2.0`, `pgpass@1.0.5`, `postgres@3.4.7` |
| Named retained exceptions collected | 4 / 4, exact original retained bytes |
| Combined identity coverage / text files | 39 / 40 |

Missing default texts are not a finding of unlicensed software. Root separately revalidated retained evidence in `f9-runtime-exceptions-evidence.json`. The companion `f9-runtime-text-exceptions.mjs` stages only those four exact texts as LICENSE in owned disposable packaging directories, checks their retained checksums, and calls the same actual gatherer. It preserves source metadata and distinguishes installed README sections from upstream release texts. `pg-types` and `pgpass` README/manifest/section hashes match. `postgres` current version and retained text match, but this does not prove whole-package source correspondence. Entities retains its explicit upstream manifest 2.2.0 versus registry 3.0.0 discrepancy while eight code files and retained MIT text match. These are unresolved provenance qualifications, not erased by 39/39 coverage.

Default missing results remain in the first receipt. The second receipt contains actual returned attachments and identity-union assertions, not an arithmetic-only assertion that four exceptions probably work. Its initial harness assumed the wrong root receipt envelope (`actualStdout` versus `output`), failed before staging, and passed after one focused repair; failure and direct final output are retained in `f9-runtime-text-exceptions-evidence.json`.

Coverage is these 39 identities' selected root text files plus four explicit exceptions. Nested/vendor/license obligations, bundled build dependencies, assets, alternate-platform optional packages and full source correspondence are not established. A root filename diagnostic is not recursive notice discovery. No claim is made that every possible notice in those packages was found.

## Comparative disposition and implementation cost

Recommend **narrow adaptation of the public library for runtime text assembly**, combined with already-selected clean pnpm production graph and existing exception receipts. Do not implement generic license filename discovery or graph traversal. Keep the current reviewed exception/provenance records, fail on changed identity/text hashes or missing required text, preserve multiple returned files, and carry original source names in packaging metadata even when a named exception is staged canonically. This is a provisional preferred evidenced option, awaiting independent review; a viable per-path checker alternative remains incompletely tested.

| Alternative | Actual evidence and remaining question |
| --- | --- |
| pnpm native inventory only | Correct prepared 39-identity graph; no full text for those SPDX-labelled packages. Keep for graph, not sufficient alone for texts. |
| rollup-plugin-license 3.7.1 | Actual build-module provenance and first LICENSE plus separate NOTICE works; first-match behavior cannot preserve both type-fest texts alone. Complement for bundle scope, not runtime collector replacement. |
| license-checker-rseidelsohn 4.4.2 | Current full-graph execution omitted transitives; this alone does not reject configuring it per physical package path. That viable per-path interface's complete multiple-text behavior remains unresolved. 5.x Node24 floor is incompatible with present Node22 baseline. |
| CycloneDX npm CLI 6.0.1 | Actual current graph resolution failed through npm; public library's explicit per-directory interface bypasses that unrelated graph dependency without suppressing errors. CLI graph failure is not library failure. |
| Keep existing records only | Preserve proven exceptions but manual enumeration alone does not assemble all current package originals. No reason to discard those useful records. |
| New generic custom collector | Could encode filename rules, but actual maintained public API now covers tested discovery and attachment responsibilities. Custom glue remains needed for existing graph mapping, bounded filesystem port, exact exceptions, checksum policy and final notice rendering. No new generic walker justified. |

Current research harnesses are small orchestration examples, not production implementation. Production changes so far: zero. Removal eligibility: avoid a proposed new generic text walker and duplicate graph discovery; no existing application files are demonstrated safe to delete. No database migration, service, native dependency or upstream fork required. Add one pinned library as build-time notice tooling if selected, retain its Apache license/NOTICE, run without optional validator peers for this exercised public entry, and test pin updates against unchanged fixtures and current graph. Rollback is removing that tooling integration while retaining prior notices; it must not ship a knowingly incomplete generated notice artifact.

## Mandatory rubric, scoped judgments (0–5)

These are judgments, not benchmarks or a weighted proof. All compare the narrow per-package text responsibility; unknowns remain unknown.

| Candidate | Fit 30% | Effort 25% | Custom avoided 20% | Maintenance 15% | Resources 10% |
| --- | --- | --- | --- | --- | --- |
| Public library plus existing exceptions | 4: all current identities, caveats explicit | 4: supported port, no fork | 4: real discovery/attachments | 3–4: pinned public API, update regression required | Unknown comparative CPU/RSS; owned install+cache measured 8 MiB |
| pnpm alone | 1: graph not texts | 2: still needs collector | 2: graph only | 4: existing pinned manager | Unknown same-workload comparison |
| Plugin alone | 2: misses multiple original texts | 2–3: supplementary collector needed | 3: bundle provenance useful | 3–4: actual Vite exercise, integration remains | Unknown same-workload comparison |
| Checker per path | Unknown until multi-text fit executed | Unknown | Unknown | 2–3: compatible older line vs Node24 current | Unknown |
| Existing records plus generic custom discovery | 3 potential, not executed | 2: new policy maintenance | 1: mostly custom | 2: own discovery burden | Unknown |

Pin/source/test/license details: `f9-text-fit.md` and `f9-text-acquisitions.json`; this cohort's archive integrity, exact one-package closure, commands and completed cleanup are in `f9-runtime-text-acquisitions.md`. Actual run receipts are retained separately. No meaningful CPU/RSS comparison was measured; do not interpret tool-reported wall time as a performance benchmark. Next action: root review this fit and decide whether the unresolved checker-per-path comparison could materially change selection, then implement bounded assembly and separately close bundle/vendor/asset provenance. This report does not close the entire tooling choice or licensing work.
