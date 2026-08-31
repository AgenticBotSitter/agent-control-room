# CR10Q-SEC-010 independent public-release security review

**Date:** 2026-08-29  
**Reviewer identity:** `reviewer:codex:independent:cr10q-sec-010`  
**Review route:** different independent reviewer; effect-free repository review  
**Packet:** `public-security-review:6fc96618cf696e2b0ea82cf8`  
**Effects:** none

## Independence and authority statement

I am the different reviewer assigned for CR10Q-SEC-010. I did not produce the public candidate and did not author the CR10Q architect review or its remediation. I treated the architect report and producer tests as claims to challenge, not as acceptance evidence.

This report is evidence authority for this independent review only. It grants no legal conclusion, license, architecture change, certification, signing authority, repository-visibility change, release-candidate status, installation authority, publication decision, or external-effect authority. I did not remediate any finding.

## Packet, scope, and drift checks

- Before testing, `npm run public:security-review-packet` returned packet ID `public-security-review:6fc96618cf696e2b0ea82cf8`, contract `control-room-public-security-review-packet/v1`, 24 cases, 15 critical cases, 9 high cases, 2 architect findings, 2 findings pending independent verification, `independentReviewObserved: false`, `releaseCandidate: false`, and `externalEffectsAllowed: false`.
- The packet-defined candidate roots, named private enforcement sources, every `tests/public-*.test.ts` file, `tests/proxy-test-helper.ts`, and the direct exact-data/security dependencies used by those sources were inspected. The fixed review-input fingerprint covered 68 files and was `cf0885b45b89bc849e11b6766635a2dac0ac155fdc92b3411fae76d03e0b33b6` both before and after testing.
- The checkout remained on `integration/cr5d-synthetic-executor-1` at `14de468999b1ebf4584c13026114d40a0f66cea7`, with extensive pre-existing owner/architect changes. The report path did not exist at preflight. No existing repository file was changed.
- No GitHub issue or pull-request query was made because the packet expressly prohibited network contact. Local branch, status, refs, and recent-commit evidence were inspected instead.
- The machine-generated packet identity is stable, but the frozen prose scope count is not: the mechanical audit and independent enumeration both contain 36 candidate files, while the review packet, architect report, mechanical-assurance document, and public-tree disposition document say 37. This is finding `CR10Q-IR-003`.
- Post-write packet identity check: `npm run public:security-review-packet` exited 0 and again emitted `public-security-review:6fc96618cf696e2b0ea82cf8`, with 24 review cases (15 critical, 9 high), 2 pending independent findings, `releaseCandidate:false`, and `externalEffectsAllowed:false`.

## Methodology

1. Read the governing status, packet, acceptance, architect review, ADR-083 through ADR-088, public trust/mechanical/disposition contracts, all candidate files, named enforcement sources, their exact-data dependencies, and all relevant tests.
2. Recreated the packet before testing and independently enumerated and fingerprinted the reviewed inputs.
3. Performed fresh, disposable, in-memory hostile-boundary probes. Evidence retained here is limited to behavior, counters, safe reason codes, and counts; no hostile payload, candidate body, or sensitive value is reproduced.
4. Independently checked default-private classification, logical-path rejection, data-shape bounds, method capture, caller-process execution, compatibility semantics, event binding, evidence replay/order, immutable results, supply-chain/legal/release blockers, and absence of release authority.
5. Ran every deterministic verification command required by the packet from the prepared checkout without installation or download.
6. Used only `/private/tmp/cr10q-independent-review.jwwwM1` for disposable probe material. The temporary drivers contained no credentials, provider access, network client, native harness, signer, publisher, or release effect.

The producer regression suite is useful but incomplete: it passes while fresh probes reproduce two high-severity ordinary-data boundary failures.

## Required 24-case matrix

Disposition terms: `satisfied` means the named behavior was independently supported for this repository snapshot; `satisfied_with_blocker` means the fail-closed/non-authorizing behavior was supported while the named future evidence or owner gate remains unresolved; `failed` means a new finding defeats the required determination.

| # | Case ID | Independent observed evidence | Disposition |
|---:|---|---|---|
| 1 | `classification.default_private` | Registry remained default-private with no path-inferred eligibility. A private class presented under a public-looking root was rejected. | `satisfied` |
| 2 | `path.traversal_absolute_encoding` | Six absolute, traversal, alternate-separator, encoded, drive-like, and empty-segment variants were rejected before manifest acceptance. | `satisfied` |
| 3 | `path.case_unicode_alias` | One case-fold collision and two Unicode path variants were rejected. | `satisfied` |
| 4 | `tree.symlink_special_executable` | Independent control-flow and metadata inspection confirmed `lstat`-based root/entry checks, symlink and special-entry rejection, and an executable-bit stop. The current 36 inputs are regular and non-executable. | `satisfied` |
| 5 | `tree.private_identity_history` | Default-private host-identity, production-history, and internal-review classes remain ineligible. Current audit reported no sensitive finding; the independent private-data gate remains unobserved, so the scan is not treated as exhaustive privacy approval. | `satisfied_with_blocker` |
| 6 | `tree.credential_secret_locator` | The fixed scanner retains only safe path, detector kind, and digest and blocks any finding. Current count was zero; independent private-data review and protected investigation remain unresolved. No detected value was copied into this report. | `satisfied_with_blocker` |
| 7 | `data.proxy_accessor_symbol` | Four core data operations rejected Proxies with zero traps; accessor and symbol probes rejected with zero getter execution. However, the broader AF-001 claim is not accepted because a different ordinary-data property shape bypasses the intended copy/sensitive boundary. | `satisfied_with_blocker` |
| 8 | `data.prototype_sparse_cycle_size` | Custom-prototype, sparse-array, cycle, non-finite, depth, array-size, and value-string-size probes all rejected (8/8). A reserved object-prototype property was copied into inherited state, and an oversized property name was accepted. | `failed` (`CR10Q-IR-001`, `CR10Q-IR-002`) |
| 9 | `adapter.hidden_mutable_method` | Added, non-enumerable, symbol, inherited, and accessor-backed members rejected (5/5) with zero getter calls. After definition, mutation of the caller's original method properties produced zero substituted calls; captured original methods ran once each and the adapter wrapper was frozen. | `satisfied` |
| 10 | `adapter.caller_code_not_sandboxed` | In-memory counters proved both supplied adapter functions execute in the caller process (one call each). Four public guides/READMEs truthfully state the validator is not a sandbox or cannot prove arbitrary code effect-free. The separate process/OS isolation blocker remains. | `satisfied_with_blocker` |
| 11 | `adapter.compatibility_result_spoof` | Proxy/accessor compatibility results rejected with zero traps/getters; four semantically invalid decisions rejected with `compatibility_rejected`. A reference adapter nevertheless accepted inherited compatibility evidence created by the ordinary-data copy defect even though the required evidence was not an own property. | `failed` (`CR10Q-IR-001`) |
| 12 | `adapter.normalization_binding_replay` | Foreign tenant, run, sequence, time, schema, source, and duplicate source-key cases all returned `normalization_failed` (7/7). | `satisfied` |
| 13 | `adapter.resource_exhaustion` | Depth, node/value, array, and case limits are present, but property-name length is unbounded and an over-one-million-character name was accepted. Caller-supplied code also remains outside any resource sandbox. | `failed` (`CR10Q-IR-002`) |
| 14 | `dependency.complete_sbom_provenance` | Five local component records and prepared-workspace Zod metadata exist, but `localDependencyEvidenceIndependent` is false and `independent_dependency_provenance` is `not_observed`. | `satisfied_with_blocker` |
| 15 | `license.text_notice_authority` | All five project LICENSE files are 11-byte identifier stubs and all five manifests lack a license field. Complete text and manifest metadata are the two failed gates; author authority and NOTICE review remain unobserved. | `satisfied_with_blocker` |
| 16 | `artifact.inventory_toc_tou` | The audit is a source snapshot only, reports 36 files, and records no release artifact. `final_artifact_inventory` remains `not_observed`; the contradictory frozen count is separately reported. | `satisfied_with_blocker` (`CR10Q-IR-003`) |
| 17 | `build.reproducibility_substitution` | Matching synthetic observations produced only `synthetic_candidate_only`, with actual install and artifact build both false and external evidence still required. | `satisfied_with_blocker` |
| 18 | `signature.key_manifest_provenance` | A signature-shaped digest claim remained `not_verified`, reported no signature bytes and no cryptographic verification. A separately supplied external report still granted neither certification nor publication authority. Current tree signature gate is `not_observed`. | `satisfied_with_blocker` |
| 19 | `install.real_clean_room` | Synthetic assessment explicitly reported no real install or release artifact. `real_clean_room_install` remains `not_observed`. | `satisfied_with_blocker` |
| 20 | `disclosure.private_reporting_channel` | Public security guidance truthfully says no reporting destination is configured and contains no public address or URL. The protected disclosure resource remains an owner blocker. | `satisfied_with_blocker` |
| 21 | `release.rollback_revocation` | The nine-step local plan has no rollback/revocation preparation and the materializer stops before archive creation. No release may advance; exact rollback/revocation remains a later owner-controlled blocker. | `satisfied_with_blocker` |
| 22 | `evidence.replay_reorder_substitution` | Reordered and re-digested packet evidence was rejected. Focused tests also rejected record reorder, foreign binding, stale evidence, and semantic re-digestion. | `satisfied` |
| 23 | `recovery.failure_cleanup_ambiguity` | No release effect path exists in this snapshot. The disabled materializer records no archive, install, or publication attempt; no blind retry or success claim is available. Real failure/cleanup evidence remains a future blocker. | `satisfied_with_blocker` |
| 24 | `owner.publication_authority` | Packet publication decision, packet release-candidate state, and tree release authority are all false; owner publication gate is `not_observed`. | `satisfied_with_blocker` |

## Architect-finding determinations

### CR10Q-AF-001 — not independently verified

The producer's named Proxy, accessor, symbol, sparse-array, cycle, non-finite, depth, array-size, and value-string-size defenses worked in the probes, with zero Proxy traps and zero getter calls. Ordinary valid reports were deeply frozen.

The remediation claim as a whole fails. A reserved object-prototype property accepted as ordinary own data is not preserved as an own property in the copy; it changes the copy's prototype and becomes inherited state. The sensitive-key check then omits that state, and a reference compatibility evaluator can accept inherited evidence that was never supplied as the required own property. Separately, property-name length is not bounded even though value-string length is. These behaviors contradict the bounded ordinary-data, sensitive-exclusion, and compatibility-spoof claims.

Determination: `rejected_due_to_CR10Q-IR-001_and_CR10Q-IR-002`.

### CR10Q-AF-002 — independently verified with retained isolation blocker

The exact public adapter shape rejected five hidden/added/mutable/inherited/accessor-backed variants, executed no getter, captured stable original method references, ignored later mutation of the caller's original method slots, and returned a frozen adapter wrapper. The public documentation truthfully states that supplied adapter code executes in the caller process and is not a sandbox.

The truthfulness test also proves why a release blocker remains: the compatibility and normalization functions executed once each in the caller process. Untrusted third-party code still requires a separate process/OS boundary with capability, resource, credential, filesystem, egress, cleanup, and independent security controls.

Determination: `verified_for_shape_capture_and_truthful_non_sandbox_boundary`; no code-isolation or release authority is granted.

## New findings

### CR10Q-IR-001 — High — ordinary-data copy can convert an own property into inherited prototype state

**Observed behavior:** A reserved object-prototype property represented as an ordinary enumerable data property entered the public snapshot boundary as an own property. The returned copy no longer owned that property, had a non-ordinary prototype, and exposed the nested decision as inherited data. The sensitive-value assertion returned without rejection for a sensitive-shaped key held in that inherited state. A reference compatibility run then accepted inherited compatibility evidence even though the required evidence property was absent as an own property.

**Safe reproducible evidence:** independent probe counters reported input-own `true`, output-own `false`, ordinary-output-prototype `false`, inherited-decision `true`, sensitive rejection absent, and reference compatibility accepted with own required evidence `false`. No payload or sensitive value is retained here.

**Impact:** The AF-001 ordinary-data copy and sensitive-exclusion boundary is not closed. Digest/redaction semantics can omit accepted state, and compatibility can be influenced through inherited data.

### CR10Q-IR-002 — High — property-name length is not bounded

**Observed behavior:** Depth, array length, value-string length, cycles, prototypes, sparse arrays, and non-finite values rejected as designed, but an object containing a property name longer than one million characters was accepted.

**Safe reproducible evidence:** 8/8 named malformed structural/value probes rejected; the oversized-name probe returned accepted. Only the length and boolean outcome are retained.

**Impact:** The implementation's bounded-data claim is false for property names. Up to the key-count ceiling, caller-controlled names can impose unbounded copy, path-construction, canonicalization, hashing, and memory cost.

### CR10Q-IR-003 — Medium — frozen review documents claim 37 files while the bound audit contains 36

**Observed behavior:** `npm run public:mechanical-audit`, independent root enumeration, and the copied fixed-root collector all counted 36 files across all eight classes. The packet prose, architect review, CR10C mechanical assurance document, and public-tree disposition document say 37.

**Safe reproducible evidence:** machine audit `files.length = 36`, eight root classes, 45,528 inspected bytes, five components, two schemas, two fixtures, five links, and zero bounded findings. The packet ID remained exact because it binds the actual source-inventory digest, not the prose count.

**Impact:** The immutable scope identity is cryptographically stable but the human review contract and prior evidence summary are materially inaccurate. A reviewer cannot truthfully attest to an "exact 37-file" scope when only 36 files are bound.

No other new findings were established.

## Verification command ledger

All commands ran from the already-prepared checkout. No install or download occurred.

| Command | Exact result |
|---|---|
| `npm run public:mechanical-audit` | exit 0; 36 files, 8 root classes, 45,528 bytes, 5 components, 2 schemas, 2 fixtures, 5 links, 0 sensitive findings; `mechanical_candidate_only` |
| `npm run public:tree-disposition` | exit 0; 17 gates: 6 `passed_local`, 2 `failed`, 9 `not_observed`; 11 blocker codes; no certification or release authority |
| `npm run public:security-review-packet` (before tests) | exit 0; exact packet ID; 24 cases (15 critical, 9 high); 2 pending architect findings; no independent result, release candidate, or effects |
| `npm run test:cr10b` | exit 0; 41/41 passed, 0 failed/skipped |
| `npm run test:cr10c` | exit 0; 7/7 passed, 0 failed/skipped |
| `npm run test:cr10c-disposition` | exit 0; 9/9 passed, 0 failed/skipped |
| `npm run test:cr10q` | exit 0; 14/14 passed, 0 failed/skipped |
| `npm test` | exit 0; pretest 521/521 passed; main suite 416 total, 414 passed, 0 failed, 2 intentional skips; post-test 44/44 passed |
| `npm run check` | exit 0; TypeScript emitted no diagnostics |
| `npm run lint` | exit 0; ESLint emitted no diagnostics |
| `npm run build` | exit 0; all 5 vinext build stages passed; 479/231/477/235/232 modules transformed respectively; build complete |
| `node --test tests/rendered-html.test.mjs` | exit 0; 2/2 passed, 0 failed/skipped |
| `npm run db:verify` (sandboxed attempt) | exit 1 before verification; local tsx IPC listen denied with `EPERM`; no migration result claimed |
| `npm run db:verify` (authorized effect-free rerun) | exit 0; migrations 0001 through 0026 applied to the disposable verifier; 96 PostgreSQL tables verified |
| `git diff --check` | exit 0; no whitespace errors |
| fixed 68-file review-input fingerprint, before/after tests | exit 0 both times; identical digest `cf0885b45b89bc849e11b6766635a2dac0ac155fdc92b3411fae76d03e0b33b6` |
| independent hostile-boundary driver, first attempt | exit 1 on an over-literal reviewer documentation matcher; no repository failure claimed; temporary matcher only was corrected |
| independent hostile-boundary driver, corrected | exit 0; 24-case evidence collected; 4/4 Proxy boundaries had zero traps, accessors had zero getters, 8/8 named malformed structures rejected, 5/5 adapter-shape variants rejected, 7/7 event-binding variants failed closed, and the two AF-001 defects reproduced |
| copied fixed-root collector driver, first attempt | exit 1 on temporary driver module-format incompatibility; no repository failure claimed; temporary driver only was corrected |
| copied fixed-root collector driver, corrected baseline | exit 0; 36 files; `mechanical_candidate_only` |

The temporary-driver corrections did not change any source, test, package, license, manifest, status, plan, decision, acceptance, or architect-review file.

## Retained blockers

The independent findings above require source and regression remediation by a later authorized block. Independently of those findings, all prior release blockers remain:

- failed: complete project license text and package-manifest license metadata;
- not observed: author licensing authority, independent dependency provenance, NOTICE attribution review, independent private-data review, final artifact inventory, signature verification, real clean-room installation, an accepted independent security result after remediation, and owner publication decision;
- owner/protected-resource blockers: supported-versions and disclosure decisions, private reporting channel, signing resources and key custody, repository visibility, exact rollback/revocation preparation, and the first public release decision; and
- architecture blocker: untrusted adapter execution lacks a separate process/OS capability, resource, credential, filesystem, egress, cleanup, and recovery boundary.

This report does not change any gate to passed, resolve licensing, or create a release candidate.

## Temporary probe and cleanup evidence

- Sole manually created disposable directory: `/private/tmp/cr10q-independent-review.jwwwM1`.
- Repository files written during review before this report: none.
- Cleanup command/result and absence proof: `rm -rf /private/tmp/cr10q-independent-review.jwwwM1` exited 0; `test ! -e /private/tmp/cr10q-independent-review.jwwwM1` exited 0, proving the exact directory is absent.

## No-effect statement

No dependency installation, download, network or registry contact, GitHub write, credential access, provider/native harness use, archive creation, signing, upload, publication, deployment, repository-visibility change, production mutation, branch, commit, push, or external effect occurred. Verification used the prepared local dependency tree and effect-free repository commands only.

## Final disposition

`remediation_required`
