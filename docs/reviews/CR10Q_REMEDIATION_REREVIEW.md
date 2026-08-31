# CR10Q-SEC-025 independent remediation security re-review

**Date:** 2026-08-29
**Reviewer identity:** `reviewer:codex:independent:cr10q-sec-025`
**Review route:** genuinely different, report-only independent re-review
**Remediation packet:** `public-security-remediation-review:32d741a6b5773158f4decf41`
**Remediated candidate packet:** `public-security-review:e965af191cb495d5edfc61f6`
**Original reviewed packet:** `public-security-review:6fc96618cf696e2b0ea82cf8`
**Effects:** none

## Independence and authority boundary

I am the different reviewer assigned for CR10Q-SEC-025. I did not author the candidate, the original CR10Q independent report, the architect review, or the remediation. I treated producer tests, the architect report, and remediation claims as claims to challenge rather than acceptance evidence. I inspected the implementation and enforcement dependencies and used fresh defensive probes to determine the result.

This report is evidence for this exact effect-free repository snapshot only. It does not grant or imply licensing, legal, architectural, release, publication, deployment, credential, native, signing, repository-visibility, external-effect, or owner authority. I did not repair or otherwise modify product source, tests, metadata, configuration, Git state, or prior evidence.

## Frozen identity, scope, and drift checks

- The required report path did not exist before review work. The only repository write made by this reviewer is this report.
- Before testing, the remediation projection returned `public-security-remediation-review:32d741a6b5773158f4decf41`, the remediated candidate returned `public-security-review:e965af191cb495d5edfc61f6`, and the remediation packet bound original packet `public-security-review:6fc96618cf696e2b0ea82cf8`.
- Before testing, the remediation packet bound exactly 36 candidate files, three remediation findings (two high and one medium), and all 24 original case IDs in their exact original order. It required full reexecution and named this report path.
- The original report was byte-identical before and after testing at `sha256:11a4710620e3e8487a5834df30277b5c915959ac52224fb25322d15b13a0919f` and retains `remediation_required` as its historical disposition.
- A fixed review-input fingerprint covered 89 files: the complete eight candidate roots; the public contract, packet, mechanical, disposition, release, exact-data, project-workspace, and security enforcement dependencies; governing documents; relevant scripts; all eight `tests/public-*.test.ts` files plus the Proxy helper; and package/lock metadata. It was `sha256:c69dedf4f29157821819aa15d415e2d2834b87ce7f5b6dd63c2549bbe710392d` both before and after testing.
- After testing, both generated packet projections returned the same packet IDs and counts. The original packet ID, original report digest, required report path, and 24-case order remained exact.
- The machine audit and an independent `lstat` enumeration each found the same set of 36 regular, non-executable candidate files across eight roots. Six current normative scope assertions checked in BUILD_STATUS, the mechanical/disposition documents, the review packet, and the architect review all truthfully use 36. The 37-versus-36 mismatch remains visible in the byte-identical original report and in current documents only where it is explicitly described as historical evidence.
- The checkout remained on `integration/cr5d-synthetic-executor-1` at `14de468999b1ebf4584c13026114d40a0f66cea7`. Extensive pre-existing owner/worker changes were preserved. Network use was prohibited, so no live GitHub issue or pull-request query was made; local branch, worktree, refs, and recent commits were inspected instead.

## Methodology

1. Read the governing repository instructions, current build status, remediation and acceptance contracts, original and architect reviews, review packet, ADR-083 through ADR-089, mechanical/disposition evidence, complete candidate roots, private enforcement dependencies, packet producers, scripts, and relevant public tests.
2. Recreated all frozen identities before executing probes and independently fingerprinted the complete review input.
3. Executed all 24 original cases with a fresh, local, credential-free, provider-free, network-free defensive driver. Only behavior, reason codes, counters, lengths, and counts are retained below.
4. Re-attacked AF-001 and AF-002 and independently challenged all three CR10Q-IR remediations, including reserved names before nested behavior/callbacks, null-prototype own-state preservation, exact name-length boundaries, machine/human scope agreement, and original-report immutability.
5. Ran the complete required verification ledger from the prepared checkout without install, download, release materialization, signing, provider/native access, or network contact.
6. Recreated packet identities and the fixed fingerprint after testing, checked scope drift, removed the one exact disposable directory, and proved it absent before writing this report.

## Required 24-case matrix

Disposition terms: `satisfied` means the required behavior was independently supported for this exact snapshot. `satisfied_with_blocker` means the fail-closed or non-authorizing behavior was supported while named independent, owner, legal, release, or isolation evidence remains unresolved.

| # | Case ID | Independent safe evidence | Disposition |
|---:|---|---|---|
| 1 | `classification.default_private` | Eight public and nine default-private classes remained exact. A private class placed under a public-looking root was rejected. | `satisfied` |
| 2 | `path.traversal_absolute_encoding` | Six absolute, traversal, alternate-separator, encoded, drive-like, and empty-segment classes were rejected. | `satisfied` |
| 3 | `path.case_unicode_alias` | One case-fold collision and two Unicode alias variants were rejected. | `satisfied` |
| 4 | `tree.symlink_special_executable` | Independent enumeration covered eight roots and found exactly 36 regular, non-executable files. The collector uses `lstat` and fails closed on symlink, special, and executable entries. | `satisfied` |
| 5 | `tree.private_identity_history` | Three private material classes remained default-private; the bounded scan found zero current findings. Independent private-data review remains `not_observed`, so this is not exhaustive privacy approval. | `satisfied_with_blocker` |
| 6 | `tree.credential_secret_locator` | Current bounded finding count was zero. A synthetic detection stopped the audit and retained only three safe metadata fields; no detected value was retained. Protected independent investigation remains unresolved. | `satisfied_with_blocker` |
| 7 | `data.proxy_accessor_symbol` | Four core boundaries rejected Proxies with zero traps; accessors executed zero getters; four symbol-bearing variants rejected; a revoked Proxy failed closed. | `satisfied` |
| 8 | `data.prototype_sparse_cycle_size` | Ten malformed prototype, sparse, cyclic, numeric, depth, node/key, array, value, and name-bound variants rejected; four exact boundary variants accepted. All 12 reserved-name/operation combinations rejected before nested behavior, with zero traps. Accepted records had null prototypes and explicit own state. | `satisfied` |
| 9 | `adapter.hidden_mutable_method` | Five added, hidden, symbol, inherited, and accessor-backed shape variants rejected with zero getter calls. Two captured originals ran; later replacements ran zero times; the wrapper was frozen. | `satisfied` |
| 10 | `adapter.caller_code_not_sandboxed` | Compatibility and normalization functions each executed once in the caller process. Four public documents truthfully describe the non-sandbox/isolation boundary. Separate process/OS isolation remains required for untrusted code. | `satisfied_with_blocker` |
| 11 | `adapter.compatibility_result_spoof` | Proxy/accessor decisions rejected with zero traps/getters; four invalid decision shapes returned `compatibility_rejected`; all three reserved evidence names rejected before the callback. | `satisfied` |
| 12 | `adapter.normalization_binding_replay` | Seven tenant/run/sequence/time/schema/source/duplicate binding variants returned `normalization_failed`. | `satisfied` |
| 13 | `adapter.resource_exhaustion` | Ten malformed/bound-exceeding data variants rejected. Exactly 100 conformance cases were accepted; 101 rejected before either adapter function ran. Caller-supplied code still has no separate resource sandbox. | `satisfied_with_blocker` |
| 14 | `dependency.complete_sbom_provenance` | Five local component records remained complete for the candidate snapshot. Independent dependency provenance remains `not_observed`. | `satisfied_with_blocker` |
| 15 | `license.text_notice_authority` | Five project license files remain identifier-only stubs and all five manifests lack license declarations. Two license gates remain failed; author authority and NOTICE review remain unobserved. | `satisfied_with_blocker` |
| 16 | `artifact.inventory_toc_tou` | Source inventory is exactly 36 files, but no final release artifact exists and `final_artifact_inventory` remains `not_observed`. | `satisfied_with_blocker` |
| 17 | `build.reproducibility_substitution` | Matching synthetic evidence produced only `synthetic_candidate_only`; actual install and artifact build remained false, with external independent evidence still required. | `satisfied_with_blocker` |
| 18 | `signature.key_manifest_provenance` | The claim remained `unverified_signature_digest` / `not_verified`, contained no signature bytes, and did not change the `not_observed` signature gate. | `satisfied_with_blocker` |
| 19 | `install.real_clean_room` | The synthetic assessment explicitly reported no actual installation. `real_clean_room_install` remains `not_observed`. | `satisfied_with_blocker` |
| 20 | `disclosure.private_reporting_channel` | No configured destination or public address/URL was claimed. The protected disclosure resource remains an owner blocker. | `satisfied_with_blocker` |
| 21 | `release.rollback_revocation` | The nine-step plan contains no rollback/revocation execution step; the disabled materializer stopped before archive creation and made zero effect attempts. Exact rollback/revocation preparation remains future owner-controlled work. | `satisfied_with_blocker` |
| 22 | `evidence.replay_reorder_substitution` | Five reorder, foreign-binding, stale, and semantic-substitution variants rejected. | `satisfied` |
| 23 | `recovery.failure_cleanup_ambiguity` | No release effect path exists and effect-attempt count remained zero; therefore no retry, cleanup, or success ambiguity could be manufactured. Real failure/cleanup evidence remains a future blocker. | `satisfied_with_blocker` |
| 24 | `owner.publication_authority` | Packet publication authority, release-candidate state, and tree release authority remained false; `owner_publication_decision` remains `not_observed`. | `satisfied_with_blocker` |

## Independent remediation determinations

### CR10Q-IR-001 — verified remediated

- The three reserved names `__proto__`, `constructor`, and `prototype` were each challenged through snapshot, deep freeze, digest, and sensitive-value enforcement: 12/12 combinations rejected.
- Each reserved-name probe placed behavior behind the nested value. Nested trap count was zero, demonstrating rejection before nested behavior.
- Accepted record snapshots used a null prototype and retained supplied ordinary fields as explicit own properties. No inherited compatibility state was present.
- All three reserved names were also challenged in compatibility evidence. The conformance boundary rejected each before `evaluateCompatibility`; callback count was zero.

Determination: `verified_remediated_for_this_snapshot`.

### CR10Q-IR-002 — verified remediated

- Snapshot, deep freeze, digest, and sensitive-value paths accepted property-name lengths 1, 255, and exactly 256: 12/12 accepted combinations.
- The same four paths rejected empty and 257-character names: 8/8 rejected combinations.
- A Unicode/code-unit boundary variant at 256 code units accepted, while the next tested whole-character variant at 258 code units rejected.
- Conformance-relevant compatibility evidence and normalized event-frame data each accepted 256-character names and rejected 257-character names.

Determination: `verified_remediated_for_this_snapshot`.

### CR10Q-IR-003 — verified remediated

- Machine audit inventory: 36.
- Independent regular-file inventory: 36, exact set match.
- Current normative human assertions checked: six, all truthfully 36.
- Original report: byte-identical at the required SHA-256 and still records the historical mismatch and negative disposition.

Determination: `verified_remediated_for_this_snapshot`.

## Architect-finding determinations

### CR10Q-AF-001 — independently verified for the bounded ordinary-data boundary

Four core and four conformance Proxy boundaries rejected with zero traps. Accessor getter count was zero. Symbol, sparse-array, custom-prototype, cycle, non-finite, depth, node/key, array, string-value, and property-name controls failed closed at their tested boundaries. Valid reports and captured records remained immutable. IR-001 and IR-002 re-attacks no longer reproduced the original inherited-state or unbounded-name defects.

Determination: `independently_verified_for_this_snapshot`.

### CR10Q-AF-002 — independently verified with retained isolation blocker

Five exact-shape variants rejected; accessor getter count was zero; two original captured methods ran and replacement calls stayed zero. Compatibility and normalization each ran once in the caller process, and four public documents truthfully state the non-sandbox/separate-isolation boundary.

Determination: `independently_verified_for_shape_capture_and_truthful_non_sandbox_boundary`. This does not prove arbitrary adapter code effect-free and does not supply process/OS isolation, capability restriction, resource controls, credential/filesystem isolation, egress controls, or cleanup/recovery evidence.

## Packet and safe-projection authority challenge

The current public-security projection contained 13 fields; the remediation projection contained 16. Independent top-level key inspection found zero path fields, zero digest fields, and zero truthy authority-grant/candidate/effect fields in either projection. Both reported `releaseCandidate: false` and `externalEffectsAllowed: false`. The review projection's only true boolean requires owner authorization for a different reviewer; the remediation projection additionally requires full original-case reexecution. These are restrictions, not grants. The full remediation packet separately records report-only review, no independent result before this report, and no legal, licensing, publication, release, or effect authority.

Neither this report nor either safe projection can grant authority or reveal bound repository paths/evidence digests.

## New findings

No new security finding was established. The three independent findings are independently verified as remediated for this exact snapshot. No finding was silently repaired.

Disposable-driver parser, module-mode, assertion-specificity, set-order, and static-token false-positive failures occurred before the final evidence run. Each was a reviewer-owned temporary harness defect, was corrected only inside the one disposable directory, and is not treated as repository evidence or a pass. The final corrected driver exited 0 and produced the safe counts recorded in this report.

## Verification command ledger

All commands used the already-prepared checkout. No install, download, or network access occurred.

| Command | Exact result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | exit 0; `ready_for_runtime_check`; Node `>=22.13.0`, pnpm `11.19.0`, two dependencies resolved, all three native build-policy flags false |
| `npm run public:mechanical-audit` | exit 0; 36 files across 8 classes, 46,045 inspected bytes, 5 components, 2 schemas, 2 fabricated fixtures, 5 local links, 0 bounded sensitive findings; `mechanical_candidate_only` |
| `npm run public:tree-disposition` | exit 0; 17 gates: 6 `passed_local`, 2 `failed`, 9 `not_observed`; 11 blockers; `blocked_before_independent_review`; no release authority |
| `npm run public:security-review-packet` (pre/post) | exit 0 both times; exact `public-security-review:e965af191cb495d5edfc61f6`; 24 cases (15 critical, 9 high), 2 architect findings, no independent result, release candidate, or effects encoded |
| `npm run public:security-remediation-review-packet` (pre/post) | exit 0 both times; exact `public-security-remediation-review:32d741a6b5773158f4decf41`; original and remediated packet IDs exact; 36 files; 3 findings (2 high, 1 medium); 24 original cases; full reexecution required; report-only/no effects |
| `npm run test:cr10b` | exit 0; 41/41 passed, 0 failed/skipped |
| `npm run test:cr10c` | exit 0; 7/7 passed, 0 failed/skipped |
| `npm run test:cr10c-disposition` | exit 0; 9/9 passed, 0 failed/skipped |
| `npm run test:cr10q` | exit 0; 22/22 passed, 0 failed/skipped |
| `npm test` | exit 0; pretest 521/521 passed; main suite 416 total, 414 passed, 0 failed, 2 intentional skips; post-test 52/52 passed |
| `npm run check` | exit 0; TypeScript emitted no diagnostics |
| `npm run lint` | exit 0; ESLint emitted no diagnostics |
| `npm run build` | exit 0; all 5 vinext stages passed; 479/231/477/235/232 modules transformed; build complete |
| `node --test tests/rendered-html.test.mjs` | exit 0; 2/2 passed, 0 failed/skipped |
| `npm run db:verify` (sandboxed attempt) | exit 1 before migration verification; local `tsx` IPC listen was denied with `EPERM`; no evidence claimed from this attempt |
| `npm run db:verify` (authorized effect-free local IPC rerun) | exit 0; migrations 0001 through 0026 applied in the disposable verifier; 96 PostgreSQL tables verified |
| `git diff --check` | exit 0; no whitespace errors |
| fixed 89-file review-input fingerprint (pre/post testing) | exit 0 both times; identical `sha256:c69dedf4f29157821819aa15d415e2d2834b87ce7f5b6dd63c2549bbe710392d` |
| original-report byte hash (pre/post testing) | exit 0 both times; exact `sha256:11a4710620e3e8487a5834df30277b5c915959ac52224fb25322d15b13a0919f` |
| independent 24-case defensive driver, final corrected run | exit 0; 36 files/46,045 bytes; all 24 case IDs executed in order; 12 reserved-name operation rejects, 0 nested traps, 0 pre-rejection compatibility calls; 4 core plus 4 conformance Proxy boundaries, 0 traps/getters; 5 shape variants rejected; 7 binding variants rejected; exact 100/101 case ceiling; IR-001/002/003 and AF-001/002 determinations collected |
| safe-projection challenge | exit 0; 13-field review and 16-field remediation projections; 0 path fields, 0 digest fields, 0 truthy authority-grant/candidate/effect fields; true booleans only impose different-reviewer authorization and full-case reexecution requirements |

The first disposable-driver invocation failed at parse time before any probe ran. Subsequent temporary-only corrections exposed one driver syntax error, one module-mode mismatch, an over-literal documentation matcher, an ordered-list-versus-set comparison, and an overly broad static token matcher. No repository result was claimed from those attempts. Only the final exit-0 defensive run is used as probe evidence.

## Retained release blockers

The current tree disposition remains unchanged. This report is evidence for a later controlled gate update; it does not mutate the disposition or convert any gate itself.

- Failed (2): `complete_project_license_text`; `package_manifest_license_metadata`.
- Not observed (9): `author_license_authority`; `independent_dependency_provenance`; `notice_attribution_review`; `independent_private_data_review`; `final_artifact_inventory`; `signature_verification`; `real_clean_room_install`; `independent_security_review`; `owner_publication_decision`.
- Protected/owner resources remain absent: licensing authority, complete legal review, supported-version and disclosure decisions, a private reporting channel, signing resources and key custody, repository-visibility approval, exact rollback/revocation preparation, and first-publication authority.
- Untrusted adapter execution still lacks a separately reviewed process/OS isolation boundary with capability, resource, credential, filesystem, network-egress, cleanup, and recovery controls.
- No actual release artifact, independent clean-room install, signature, private-data review, disclosure resource, rollback/revocation exercise, or owner publication decision was supplied by this review.

## Temporary cleanup and scope-drift evidence

- Sole disposable directory: `/private/tmp/cr10q-sec025-review.AAJq4h`.
- It contained only reviewer probe/fingerprint drivers and a captured local test log; it contained no credentials, sensitive values, provider state, native harness, signer, publisher, or release artifact.
- Exact cleanup: `rm -rf /private/tmp/cr10q-sec025-review.AAJq4h` exited 0.
- Absence proof: `test ! -e /private/tmp/cr10q-sec025-review.AAJq4h` exited 0.
- No second disposable directory was created.
- Pre/post packet identities, original-report hash, candidate inventory, branch/commit, and fixed 89-file fingerprint were unchanged. The sole review-authored repository delta is this report.

## No-effect statement

No dependency installation, download, network or registry contact, GitHub write, credential or secret access, provider/native harness use, persistent service, archive creation, signing, upload, publication, deployment, repository-visibility change, production mutation, branch creation, commit, push, or external effect occurred. The sandbox-denied migration attempt did not execute migration verification; the authorized rerun used only a local temporary IPC socket and the repository's effect-free disposable verifier.

## Final disposition

`accepted_effect_free_repository_snapshot_with_release_blockers`
