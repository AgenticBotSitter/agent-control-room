# RC10 checker per-package alternative

2026-09-08, baseline `1449c64`. **Actual license-checker-rseidelsohn 4.4.2 supports this per-physical-package call, but selects one license file and normalizes its text. Prefer the already-exercised public CycloneDX gatherer for preserving multiple originals.** This finding is independent of the checker's previously failed whole-app graph traversal; no blanket rejection of the checker or license correctness follows.

## Source and executed seam

Published release 4.4.2, prior registry gitHead `e26286663bdc0fafa52e5491cac0f89f6e189e80`; actual `lib/index.js` SHA256 `922d5ffded97d3cd511c549c6f601784744bc23acd2aa7c3f8120b4c3c359ce1` checked before import. Actual helper `lib/license-files.js` SHA256 `aa1c11f2c7df94a502c6dc089f1633bce4df20a3d9dfa4c5dc14b7d84b56054c` recorded (not a separate pre-import guard). BSD-3-Clause; Node >=18/npm >=8. Full resolved dependency identities/integrities and source hashes retained in acquisition JSON, not a claim every transitive source was audited. Upstream tests were not shipped in this registry package or run in this cohort. Earlier source/test inspection is in `f9-collector-fit.md`; the authored actual runtime fixture is new evidence.

Actual `lib/index.d.ts` exposes `start`, `direct`, `customFormat`, `clarificationsFile`. `init` passes direct depth to read-installed-packages (`lib/index.js:379`); the harness calls public `init` at the package's actual physical directory with `direct:0` and `production:true`. It asserts unchanged app manifest/lock, exact prior type-fest manifest/text hashes, and the sole actual output identity `type-fest@5.9.0`. Only manifests/license text are read, not executed application code. Actual checker and dependencies execute.

`lib/license-files.js:17–32` loops precedence regexes but uses `some`, stopping after the first match in each category. `lib/index.js:198–218` iterates those candidates, but only `index===0` assigns `licenseFile` and full text. Lines245–261 trim text or perform CSV normalization; lines310–316 retain one NOTICE path, not a full-text attachment array. Lines182–183 allow one explicitly named clarification file; checksum verification occurs before that override (lines218–236). These implemented constraints explain the outputs, not README interpretation.

## Actual results

| Scenario | Observed result |
| --- | --- |
| Existing physical type-fest5.9.0 with `license-cc0` and `license-mit` | One package record, selected only `license-cc0`; output text not byte-identical to that file. Prior real gatherer preserved both originals. |
| Owned dual fixture with LICENSE-MIT, LICENSE-APACHE and NOTICE | Selected only LICENSE-APACHE; separate NOTICE path present; trimmed text loses leading/trailing whitespace. Missing LICENSE-MIT is not included as a second text. |
| Owned MIT-labelled package without text | Success with empty licenseText/licenseFile; completeness policy must detect this. |
| Same owned package with explicit retained clarification | Checksum-matched supplied text including whitespace preserved exactly. No installed app package modified. Prior cohort already tested mismatch rejection; not repeated here. |

All assertions passed on the first fixture execution. No fixture repair. Initial isolated acquisition failed DNS ENOTFOUND, then approved scoped network retry installed successfully with scripts disabled; this is a setup failure, not a product finding. Runtime receipt is direct tool stdout parsed into JSON; only absolute checkout and owned fixture output path prefixes were replaced by `<checkout>`/`<owned>`. Status, names, license original contents and hashes are unchanged. Acquisition manifest retains needed identity/license/engines/dependency fields rather than irrelevant publisher metadata.

## Comparative cost and disposition

The checker remains usable for SPDX inventory, selected-file reporting and checksum clarifications. Its per-path interface is not fundamentally incompatible with pnpm. To deliver all original texts, however, a wrapper would need independent multiple-file discovery or an explicit per-file manifest, repeated single-file clarification calls/staging, separate NOTICE reading, and original-byte reads rather than relying on normalized licenseText. Those are precisely the discovery/attachment responsibilities the real CycloneDX public gatherer already handles in one call per package. Declared OR licensing may permit selecting one license legally; this engineering comparison deliberately tests our stated preservation of all original texts, not a claim that one-file attribution always violates a license.

Recommend no additional checker dependency for this narrow collector job; use pnpm for the previously proven production graph, CycloneDX public library for actual texts, existing reviewed exceptions and CR-specific checksum/completeness policy. Keep bundle plugin evaluation separate. Do not replace existing exception provenance with inferred SPDX strings. Do not add a generic custom walker. No app files deleted or added; potential savings are avoided duplicate discovery, repeated staging and maintaining a 73-package checker runtime for a single-text interface. Existing checker checksum logic is useful, but does not outweigh the multi-text mismatch here. This is a scoped recommendation for root integration review, not whole licensing clearance.

Rubric0–5, narrow text-preservation responsibility: checker fit2 (single text), effort2 (additional discovery/staging), custom avoided2 (some inventory/checksum, missing desired attachment set), maintenance2–3 (compatible older line; two deprecated dependencies warned), resource score unknown (13 MiB owned installation+cache measured, no same-workload CPU/RSS comparison). CycloneDX prior rubric fit4/effort4/custom4/maintenance3–4/resources unknown remains supported by the actual 39-identity/40-text fit. Keep existing records alone is not an automatic inventory; minimal adapter is still required either way. No weighted numerical total turns unknowns into zero.

## Acquisition and cleanup

139 GiB free before acquisition; owned `/private/tmp/cr-f9-checker-path.55Po9R` reached 13 MiB, under60 MiB cohort bound. Exact4.4.2 installed73 packages, lock resolves75 including two omitted optional packages (`@pkgjs/parseargs0.11.0`, `graceful-fs4.2.11`). Scripts disabled, own cache, no app install or services. Deprecated glob10.5.0/read-package-json6.0.4 warnings retained; no security audit was run. Full lock/URL/integrity evidence in `f9-checker-path-acquisitions.json`. After terminal receipts the exact root was removed and absence test succeeded. No live handle remains. No production/GitHub/Git writes or credentials accessed.
