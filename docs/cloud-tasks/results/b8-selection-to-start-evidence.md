# b8-selection-to-start evidence — PLAN r5 / R3

Specification-only revision on plan/b8-selection-to-start. Previous committed plan: `a53d57ada3ac98147759fcf2a41580431656b451` (r4). Candidate is this file's containing r5 commit; the external R3 selection report records its exact SHA after commit. No self-referential commit identifier or Git configuration change.

Source: `origin/cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`, inspected read-only from Git objects. Contract reference: **approved B8 selection spec R4**, S1 frozen-binding admission ordering and checker context. Task/playbook are delivery-base documents. NEW/predecessor interfaces remain future contracts.

Review input: HIGH 0 / MEDIUM 2 / LOW 1 for this ID. MEDIUM-1: single timing budget/reserve in §4.2 with nonzero-preparation and shortened-window tests. MEDIUM-2: T12-P preview evidence in U81-A; T12 admission evidence in U81-B. LOW-1: explicit cancellable execution/cleanup/lock deliverable and four-hour implementation allowance within each six-hour continuation. Each finding has a separate revision-history entry; independent re-review of this containing commit is pending. No CLEAN or product gate claimed.

Fixed points read without edits: paid-cap `fba6ae026cbd7be1178df1844e15288caebeb53b`; default-start `3e265a34e87fa9cecdf585e38a7ca0045ce0bc56`. Named-presets and CLEAN all-provider-choice were also compared. Frozen encoder/decoder/merger signatures, override envelope/reset, launcher-only independence, whole-pair priceRowDigest and consumed paid authority remain intact; paid readiness stays false. The saved-selections branch's prior optional third merger argument remains a separate pending correction; this revision retains the fixed two-argument predecessor signature and caller-owned complete route replacement.

Executed `python3 .test-tmp/b8-r3-selection-audit.py` from the parent clone, exit 0: 5 result documents; 43 existing source paths; 17 existing V1 symbols and 16 explicitly NEW/predecessor V1 symbols; 17 existing npm/pnpm scripts and 4 NEW names; 14 explicit filename/line bounds; 73 existing method/interface checks at owning source files. NEW/generated/delivery references are classified separately. Scope, status/fence, whitespace and bounded public-text privacy checks passed.

Executed `python3 .test-tmp/b8-r3-selection-contract-audit.py`, exit 0: 882 timing combinations including preparation/forwarding, shortened/exhausted windows, configured caps and sub-floor allowances; 16 exact-content source anchors plus 21 shorthand source-range bounds; T12-P/T12 ownership, cancellation deliverables, six-hour continuation arithmetic, frozen predecessor signatures and unchanged sibling refs passed. §4.2 is the single timing definition; T12 supplies deciding examples. These are document/source checks, not product behavior tests.

Actual result lines:

- `RESULT R3 selection source audit plans=1 files=5 method_checks=73 fixed_points=unchanged scope_errors=0 whitespace_errors=0 bounded_privacy_matches=0 exit=0`
- `RESULT R3 contract audit timing_cases=882 semantic_anchors=16 shorthand_ranges=21 seams=PASS frozen_signatures=PASS sibling_refs=unchanged exit=0`

Exact final commit and cleanup receipts are recorded in the external R3 selection report and separate progress file. Independent re-review is still required.

NOT RUN: all product/unit/PG17/tools/browser/native/worker/device/Linux/CI lanes; full private-name denylist gate (no list supplied). No network, downloads, package install, credential read, live install/port, model/provider launch or background process. Commands complete in the foreground; disposable-worktree cleanup is recorded externally after commit. Branch retained; no push.

## U81-A BUILD evidence (lead continuation)

Reviewed plan head: 936cef0483ce0a151ff17591ae5c97c697ee4de1; integrated predecessor 412d0c149fe8e272c491900d7a9164f80ecb612a. Only the foundation seam is implemented. D20 clarifies the nonblocking T13-project/T13-saved and T10 labels; U81-B remains deferred.

Environment: native Node v22.23.4, pnpm 11.19.0, PostgreSQL 17.11 (existing Homebrew PG17). No tools/packages downloaded. Commands use CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1, scripted checker/snapshot fixtures and no real provider. No adapter, admission, migration, process wiring, UI or paid-cap family edit.

Red-first command: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection.test.ts`. Old behavior: exit 1, tests 3 / pass 0 / fail 3 / skipped 0. Each expected invalid_request but got loop_policy_refused from the checker sentinel through existing ImproveControlRoomLoopServiceV1.mutate; malformed slot/count edits reached P71 checking. No missing-import/setup red. Same three tests then pass after consumer validation.

Focused green command: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection.test.ts tests/private-node-handler.test.ts`: exit 0, tests/pass 32, fail 0, skipped 0, duration 31168.866084 ms. Includes real intake structural refusals and reset, P71 expectedVersion reload/stale save, owner authority and checker-only projections, actual six-second fake checker and zero authority writes, plus project preview through both outer Node handlers without a listener.

Broad command: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm_config_offline=true pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false run test:improve-control-room -- --test-concurrency=1`: exit 0, tests 477, pass 469, fail 0, skipped 8, duration 160784.891208 ms. Eight pre-existing qualification skips are B3a recovery, B3b monitoring and six B6 real-roster cases; none replace a U81-A deciding assertion. P71 real tools remains in its existing separate lane. No qualification green from these skips.

Both `pnpm run check` and `pnpm run check:demo` with the same cached-only pnpm flags pass (exit 0). Initial plain pnpm run tried dependency reconciliation and aborted before installation; disabling verify-deps-before-run is necessary for the shared node_modules symlink and does not change it.

Standard `pnpm run build` (cached-only flags): exit 1, sandbox EPERM writing Vite bundled config under symlinked node_modules/.vite-temp. Supplemental production compilation through the same Vite createBuilder/buildApp configuration with configLoader=runner and envFile=false: exit 0, VPS Node artifact compiled; no source build-script/dependency edits. Exact required build command remains environment-blocked; supplemental compilation is not mislabelled as its pass.

Loader guard passes; loader regression tests 42 pass / 0 fail / 0 skip; all 932 test files reachable from GitHub Actions; declared mutation anchors match once; quarantine list valid (0 entries); migration ledger verified (181 files); no changed migrations against the predecessor. Branch affected-tests CLI exits 1 on its pre-existing DOCS_ONLY printer assumption because HEAD contains plan docs only: result.join is not a function. Product changes cannot enter HEAD while index.lock is refused. No script outside U81-A was edited to hide this.

Offline `pnpm run test:hygiene`: exit 1, ENOTCACHED for Squawk, no download. Direct tests produce 10 pass / 2 fail / 0 skip, both failures are missing Squawk. Affected/mutation/PG checks are still in progress; exact final results will be appended.

Initial expanded-test fixture typo used SQL arrays for jsonb grants (42804); corrected fixture encoding, then all focused tests passed. Initial private DELETE assertion expected 400 but outer private handler correctly returns 405 (Mac-local reaches handler 400); corrected expected refusal without changing transport. Initial expanded test type inference produced never[] on empty arrays; typed the fixture with the shared selection type; both checks pass. These are repaired build/test setup failures, not red evidence.

Progressive commit attempt: index.lock creation refused (exit 128); no commit, staging or Git config change. The lead commits the final working-tree change per the continuation. Independent code/attack/CI review and later tools/snapshot/native/Linux qualification are not claimed.

## Final U81-A handoff

Branch `cook/b8-selection-to-start`; unchanged HEAD `936cef0483ce0a151ff17591ae5c97c697ee4de1`, predecessor `412d0c149fe8e272c491900d7a9164f80ecb612a`. No product commit: index.lock was refused, and the brief delegates the commit to the lead in that case. Runtime/test/package fingerprint (8 files, not a commit): `05f0500c85ca5374e45c981bf3cdd9deb1d72efd7b3ac027a5c62bdd4f4f28a4`. Elapsed at finalization: 47.72 minutes of the four-hour budget.

The final R1 tests were strengthened with a recorded in-process adapter that returns an accepted durable receipt. An isolated copy at unchanged product HEAD, with only those tests added, prints `accepted=true checker_calls=1` for each extra-slot-key/four-code-reviews/count-mismatch case. Command: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection.test.ts` from the old-product copy. Exit 1, pass 0 / fail 3 / skip 0; each is the intended missing rejection, never import/setup failure. New code refuses invalid_request with zero checker calls and rows.

Two additional build-time red/green repairs preserve valid non-B8 role members in P71 run edits, and reset omitted switches in overrides-only edits. The latter's one-test red observed inherited true/true instead of false/false; after repair the explicit three-cell matrix and full-selection cases pass through actual intake/checker.

| Final command/check | Actual result |
|---|---|
| §9.1 affected command below, after final changes | exit 0; tests/pass 212, fail 0, skip 0, duration 306947.531125 ms |
| `PG_BIN=/opt/homebrew/opt/postgresql@17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=61580 CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:improve-control-room-postgres` with cached-only pnpm flags | exit 0; tests/pass 72, fail 0, skip 0; duration 1038361.051458 ms; owned teardown cleanedUp=true, leftovers=0 |
| Final native P71 production-grants/source/audit/down test below | exit 0; tests/pass 1, fail 0, skip 0; duration 13029.592459 ms |
| `pnpm run check` and `pnpm run check:demo` with cached-only flags | exit 0; final recorded adapter implements the full typed interface |
| Production Vite createBuilder/buildApp with configLoader=runner, envFile=false | exit 0; same production artifact configuration; standard bundled-loader command remains EPERM-blocked |
| Seven U81-A guard-off probes on byte-identical current-source overlay | exit 0 overall; seven intended one-test assertion failures, seven restored one-test passes, zero skips |
| Native `test:improve-control-room-loop-bridge-mutations` | exit 0; tests/pass 27, fail 0, skip 0; duration 256165.842291 ms |
| Native `test:improve-control-room-loop-lineage-mutations` | exit 0; tests/pass 30, fail 0, skip 0; duration 162621.987125 ms; peak workers 2; owned cluster leftovers 0 |
| `test:improve-control-room-loop-ui-mutations` | exit 0; tests/pass 6, fail 0, skip 0 |
| `test:private-postgres-production-boundary` with private TMPDIR | exit 0; tests/pass 11+4, fail 0, skip 0; durations 5894.588792/347.761834 ms |
| Loader regressions/coverage/anchors/quarantine/ledger/migration delta | 42 tests pass; all 932 files CI-reachable; anchors match; quarantine 0; ledger 181 files verified; no changed migrations |
| Exact `pnpm run build` with cached-only flags | exit 1: .vite-temp write through shared node_modules refused; no dependency tree/source build-script edit |
| Offline `pnpm run test:hygiene` | exit 1: Squawk ENOTCACHED; direct fallback 10 pass / 2 missing-Squawk failures / 0 skip; no download/substitute |
| Existing loop and provider browser commands | each exit 1, 0 pass / 2 failed browser starts; cached Chromium unavailable; no download |
| `node scripts/ci/affected-tests.mjs 412d0c149fe8e272c491900d7a9164f80ecb612a` | exit 1: DOCS_ONLY printer assumes array because only plan docs are in HEAD; uncommitted product changes await lead commit |

Final affected command (P71 real-tools test remains in its separate mandatory qualification lane):

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-skip-pattern='^P71 real settings check$' tests/loop-selection.test.ts tests/loop-policy.test.ts tests/improve-control-room-loop-bridge.test.ts tests/improve-control-room-loop-ui.test.tsx tests/loop-providers.test.ts tests/private-node-handler.test.ts tests/improve-control-room-loop-bridge-b2.test.ts tests/improve-control-room-loop-attention.test.tsx
```

Final adjacent PG command:

```sh
PG_BIN=/opt/homebrew/opt/postgresql@17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=61580 CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^P71 PostgreSQL production grants, immutable sources/audit, copies and retained down$' tests/improve-control-room-loop-bridge-postgres.test.ts
```

Cached-only pnpm flags for all package commands: `npm_config_offline=true npm_config_verify_deps_before_run=false npm_config_manage_package_manager_versions=false pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false run <script>`. No packages, tools or browsers downloaded.

Next-door fact: the shared P71 consumer still preserves ordinary non-B8/scalar-role behavior and its existing grant/save/version/journal boundaries. The final 212-test lane plus final native P71 test prove it through existing callers. Inherited mutation scripts clone committed HEAD, so their green results are predecessor regression only. The seven new guard-off probes use an overlay of all eight actual current source/test/package files, and verify loaded assertion failure, restoration and positive pass. Their requested-hash log label denotes requested-slot projection binding; no admission cryptographic/current-reader proof is inferred. Snapshot/fallback/family assertions remain scripted contract tests.

Private boundary diagnosis: root fixture ancestry under the external worktree has a writable, non-sticky 0775 ancestor. The protected boundary correctly refuses there, even natively. Changing only TMPDIR to an owned 0700 directory under /private/tmp makes the unchanged suite pass; the directory is removed. No boundary or directory permission was weakened.

Cleanup: all owned commands ended; all native clusters report clean teardown, two explicit copies and offline scratch cache removed, private boundary temp count 0. Global shared-memory counts 14 before initial PG, later 16 before additional native checks and 16 after; no unrelated processes/segments touched. node_modules remains an untracked symlink. No push, real provider/model/worker launch or client credential access. Changed files remain uncommitted per the explicit lock-refusal rule.

Later/not run: U81-B's released T-TOOLS/T-SNAPSHOT reader, cancellation, admission/SQL/new migration/selection-PG/mutation packet and broader production lifecycle/ledger generation; U81-C's new selection browser/process/UI integration; independently authorized real tools/actual worker/device and pinned Node22 Linux/nproc=2 qualification; independent exact-product-head review. No deferred lane earns green from a fake or an absent-env skip. No SELECTION-TO-START-GREEN.

Build inspection unresolved product findings: HIGH 0 / MEDIUM 0 / LOW 0. LOW-1 labels fixed in D20; LOW-2 remains respected by the A-only stop. Lead must commit and rerun the remaining exact HEAD/environment gates, then obtain independent review.

Final audit command: `python3 .test-tmp/u81a/final-audit.py` — RESULT exit=0; files=11 allowed=true; whitespace/privacy PASS; dependencies unchanged; node_modules symlink retained and untracked; staged_changes=0; HEAD unchanged; final source fingerprint matches; disposable copies=0; protected temp=0.


## U81-B prerequisite inspection — 2026-11-04T22:25:51.735249+00:00

Product predecessor/unchanged executable HEAD: `7105bd85159e3273cb692135ececa84f0ab379cb`, branch `cook/b8-selection-u81b`. Reviewed spec head remains `936cef0483ce0a151ff17591ae5c97c697ee4de1`. The supplied read-only tools checkout resolves to `03c3595f40317de0d1bdc97675377ce3ae4f58e3` as requested. No product implementation or test change is made: the spec's prerequisite gate fails before red-first implementation can begin.

Deciding static audit: `python3 - <<'PY'` with pathlib/subprocess assertions over the pinned tracked source; exit 0, checks 9 / confirmed 9 / unexpected 0, elapsed 0.041 s. This is inspection evidence of a BLOCKED prerequisite, not a product test pass. Exact code facts:

- T-TOOLS: pinned `bridge/a2-contract.mjs:241-243` requires `exact(context, ["operation", "commandId"])`; the section 5 selectionDispatch context would be rejected. Contract return at lines 309–313 has no selectionProjection pin. Pinned `cr.py:9602-9606` registers only settings/availability/json for check-lineup; no admission context input is released.
- T-SNAPSHOT: `src/web/v1/loop-selection-service.ts:11-17` declares the port/capsule only. The guard type has one tracked product source reference and zero implementations. `loop-policy-service.ts:84-86` compares only P71 defaults/layers/text/hash. No released physical reader/producer files or serialization protocol are named by this continuation.
- Section 4.4 A/Av migration names remain placeholders. They are deferred intact to B2, not allocated opportunistically.

D21 records the precise LOW-2 split into B1 admission/cancellation and B2 complete SQL/PG integration; LOW-1 is already resolved by D20. B1 remains blocked by sections 5/6/8.1, so no partial mock admission is committed. This is a missing technical release, not an owner policy question or a claim that the reviewed spec permits a replacement mechanism.

NOT RUN: R2/R3/R4 red cases, admission T1–T9/T11/T12/T14 unit/mutation/real-reader proof; every section 9.1/9.2 required product, DB, type/build, loader/lane/ledger/hygiene/browser command; section 9.3 real-tools qualification; native/worker/device/Linux gates. None can qualify this absent implementation, and no inherited A result is relabelled as B green. No PG17 cluster was started and the shared-memory threshold was not exercised. No network, secret/provider/model call, live install/port, tools write, package download or process remains.

Only decisions/evidence/status and the assigned external report/progress are changed. Documentary validation and commit receipts follow in the report; this candidate contains handoff documentation only. Product U81-B1 and U81-B2 remain NOT BUILT.


Final documentary checks: `git diff --check` exit 0. Python document audit exit 0: documents=3, allowed_files=3, last_lines=3, bounded added-line privacy matches=0, product files changed=0, staged files=0, node_modules remains untracked symlink. No executable change required a product regression run.

Commit attempt: `git add -- docs/cloud-tasks/results/b8-selection-to-start-decisions.md docs/cloud-tasks/results/b8-selection-to-start-evidence.md docs/cloud-tasks/results/b8-selection-to-start-status.md` failed with `RESULT git_add exit=128`: index.lock creation was refused (Operation not permitted). Per the lead's explicit fallback, leave these documents uncommitted for the lead; no escalation/retry or commit command after failed staging. Product HEAD remains `7105bd85159e3273cb692135ececa84f0ab379cb`; new commit SHAs: none; no push.

## T-SNAPSHOT candidate evidence

Base product: `37efe4975ce588f42806c17be65cbadfbfc5189e`. Read-only T-TOOLS candidate: `dfb58d206bce494fbfcfaa8b370548926433ba84`.

Red-first existing-entry tests failed on the base: monitor published while the source fence was held; roster seed ignored source-busy before its first write. Tests 2, passed 0, failed 2, skipped 0, exit 1. Both pass after implementation. Additional tests exercise the actual DB roster reader and source files, outer COMMIT custody, rollback/uncertain outcomes, revisions, freshness, publication faults and selected transport.

Portable required command: tests 149, passed 142, failed/cancelled 0, skipped 7 existing optional real-roster cases, exit 0. This is not zero-skip qualification. Eight independent source/transport guard mutations were caught and restored (9 Node tests including parent, all passed, skipped 0). Registration/host-wrapper fixtures: 68 tests passed, failed/skipped 0; includes actual fixture CLI nonzero results and independent exact-name guard-off proof. Both process constructors now have real-source startup/preview composition tests.

Cached network-disabled Linux image with Node 22 and nproc=2 ran the portable command, registration fixtures and eight mutations: same 149/142/7, 68/68/0 and 9/9/0 counts; exit 0. Dependencies prepared offline from the existing cache. Final follow-up checks and candidate commit are recorded in the external build report.

The counted host wrapper failed closed before qualification children because required lead-supplied product SHA/pins/receipt were absent. PG17 failed closed before cluster creation because PG_BIN and an isolated port range were absent; the native shared-memory inspection was denied, so its downstream zero was not used. No native cluster/model/real worker was launched. No host or PG pass is claimed.


The round-1 blockers and uncommitted handoff above are historical; the round-2 continuation below supersedes that handoff.

## T-SNAPSHOT round-2 evidence

Delivery base: `7b174ead9a647b470f960021c5598cab6f5f50cb`. Tools: `064eb462f3a055da9d3487502108a5292e21eeb0`. M1 uses the explicit lead acceptance in D23; M2 is covered by B7's merged strict legacy decoder and real-tools checks.

Four new tests first fail on the existing current/previous/invalidate/publish entry points after the retained owner nonce changes (0/4 pass), then pass after the custody fix (4/4). The independent nonce guard-off mutation fails the intended assertion and passes after restoration. All nine source/transport mutants are caught/restored: 10 Node tests including the parent, zero skips.

B7 policy/enforcement/provider suites pass 110/110 without skips, including the three real-tools host cases. B7 native S3 passes with 20 callers, one winner/19 losers, zero leftovers. Expanded native PG17 snapshot qualification uses shipped migrations and production web connections: 24 distinct authorized owners/projects, observed 24 arrivals/one winner/23 source-busy losers, 24 first-seed refusals, 24 writers refused while admission holds the fence, explicit successful writer retry after release, exporter-first admission refusal, monitor busy/no-publication then scheduled retry, custody through observed COMMIT, rollback and precommit expiry rollback; teardown has zero leftovers.

B8 portable tests: 106 tests, 105 pass, zero failures, one inherited B3b monitoring integration skip. That skip is not host qualification. Registration fixtures pass 69/69; ledger verifies 186 files at sha256:ca6abe60f7af052f0775c838b1ce997de29e01106760dfbd54b95faff5adf31b. Cached Linux Squawk passes all 29 migrations outside the committed baseline against `73e1321fc`. Both standard typechecks pass. Linux portable rerun and the mandatory complete macOS pair receipt are tracked in the external round-2 build report against the final containing commit; no earlier/superseded host run qualifies it.

The test-only PG socket fallback keeps sockets inside configured scratch roots and retains the 100-byte bound. Its regression fails before the fallback and passes afterward; no product driver is changed. No package/tool install, download, network, live install, real model/worker launch or migration change belongs to this round.

The standalone U81 real-tools diagnostic initially exposed fractional-monotonic subtraction rounding in the five-second window validator. A deterministic red regression now passes after comparing the deadline directly to frozenMono+5000; strictly longer windows still refuse. Final source tests pass 27/27; the real U81 diagnostic passes the exact 38 named subcases plus parent (39/39, zero skips), with all 30 stable check-through-commit measurements and max 323.147 ms. This is diagnostic evidence, not the complete tools/product pair gate.

Final cached Linux validation exits 0: migration/registration guards 117/117, broad B7/B8 tests 211 total / 202 pass / 0 fail / 9 inherited integration skips, all nine mutations caught/restored (10/10 Node tests), both standard typechecks pass. Snapshot tests include the fractional-clock fix. Linux host-only tools cases do not run; the inherited skips are not counted as qualification. The exact final native PG17/snapshot-mutation command passes 11/11 with zero skips and clean cluster teardown.

Round-2 Git staging exits 128 (index.lock creation refused); the brief requires leaving changes uncommitted. The mandatory complete gate exits 1 on dirty qualification tree, with no PASS receipt. The lead must commit and rerun it on the resulting clean product SHA. Standalone diagnostic/portable results do not replace that qualification.


## U81-B round-2 B1a checker execution evidence

Predecessor: ecd87444bed284677fbcbf23c77a60ecbfc8394b, on the assigned branch. The lead's round-2 continuation supplies the qualified T-TOOLS/T-SNAPSHOT pair at tools 064eb462f3a055da9d3487502108a5292e21eeb0; no missing-prerequisite claim from earlier attempts is carried forward as current. No tools or paid-cap file was changed.

D24 defines the clean B1a/B1b/B2 split. B1a completes only the existing cancellable checker execution boundary and accepted LOW fixes. It creates no candidate authority or new claim/record/schema. B1b service integration and B2 SQL/PG are unbuilt; no U81-B admission, T12-complete, native or selection-to-start green is claimed.

Red through existing callable boundaries, against unchanged product: 16 tests, 4 pass, 12 intended failures, zero skips; exit 1. Failures demonstrate absent reserve/cutoff/integer validation, elapsed forwarding, public error sanitization, post-COMMIT release classification, exact script registration and authority-field refusal. The direct handler 413 and same-nonce directory-inode tests are existing-behavior regression positives. Green after changes: 17 focused tests including a confirmed-rollback release regression, 17 pass, zero failures/skips. Independent deadline vectors expect 3800/400/50-ms child allowances for W=5000/1500/1100 with preparation 200/100/50; controlled timers isolate arithmetic from Python startup. A real TERM-ignoring Python fixture is killed, reaped and cleaned before rejection. No provider call is made.

The real adapter captures call entry before preparation, deducts one 1000-ms reserve only for admission, validates positive integer per-call allowance independently of the unchanged legacy configuration floor, refuses exhausted/aborted preparation and rechecks the cutoff before returning decoded output. Policy forwarding deducts elapsed time without another reserve. Public source operations sanitize filesystem/decoder failures; internal missing-file bootstrap still works. Successful COMMIT followed by refused fence release reports database_outcome_uncertain and poisons custody; rollback retains its original error. Same-nonce root/fence swaps directly exercise both inode arms. The adapter also sanitizes a malformed dispatch snapshot.

Command: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-snapshot-mutations.test.ts. Final exit 0, 17/17 Node tests, zero skips; all 16 source/transport/execution mutants loaded, caught on the intended assertion and restored green. Command: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-loop-monitoring-mutations.test.ts. Exit 0, 6/6, zero skips.

Both standard typechecks, build, loader guard, 42 loader tests, 71 lane/affected fixtures, 951-file lane reachability, mutation anchors, zero-entry quarantine, 186-file ledger generation/verification and migration lint against the exact predecessor pass. No migration changed. Affected planner exits 0 with ALL; that output is planning, not execution. Full portable/B7/adjacent command passes with exit 0: 450 tests, 440 passes, zero failures and 10 inherited integration skips (monitoring 1, provider PG 1, F10c 2, roster tools 6); no new B8 case skipped. Exact command is recorded in the external build report. The corrected portable command excludes all three exact merged host-only names, preserving their required external qualification; explicit real-tools script includes the required anchored U81 name. Its native test now passes integer remaining-to-D, without a second reserve.

Required PG17 snapshot test refuses before cluster startup because no lead-supplied isolated port range is present (exit 1, 0/1 pass, zero skips). A valid read-only native shared-memory inspection found one segment, below 20; the earlier denied inspection was not counted. PostgreSQL binary is 17.11. No cluster was started. Offline hygiene exits 1, Squawk ENOTCACHED; no download attempted. Independent Linux, host, actual worker/device qualification and B1b/B2 PG/migration/claim proofs are pending; these results cannot replace them.

Git staging exits 128 because index.lock creation is refused. No retry/escalation, new commit or push; the lead must commit the dirty candidate. HEAD remains the predecessor. Native host qualification is lead-owned after that commit. Current review LOW dispositions and remaining boundaries are recorded in D24 and the external build report.


## U81-B round 4 — baseline resolved, transport prerequisite mismatch

Lead decision D26 corrects section 4.4 to application/native counts 264/265. Those existing pins remain unchanged. The assigned predecessor is af113aee3c16d5660b483f0255419da849e7d6e9; no product implementation is retained in round 4.

D27 is a reproduced conditional integration blocker. Service lines 111–115 add six custody fields; line 885 dispatches the owned envelope when intakeDriver is present. Adapter lines 736–737 compare selectionDispatch.bindingDigest to the invoked envelope, and lines 748–749 forward it to the tools expectation. The actual released tools selection codec closes the binding keys and rejects custody additions. The pure probe returns base_context=accepted, base_expectation=accepted, owned_product_schema=accepted, capsule_matches_owned_binding=false, owned_expectation=refused and owned_expectation_with_rehashed_capsule=refused (exit 0, all assertions passed). Reproduced after restoring product sources to HEAD.

Temporary implementation experiments included one intended red R2 failure, seven passing scripted admission tests and one passing native PG17 SQL matrix with unchanged 265 native tables, timestamp/optional-record/freshness/delayed/copied-record/down/re-up/rollback checks. These experiments were removed at the mandatory contract stop; they are not tests of the final tree and do not establish B1b/B2 completion. The assigned external round-4 report contains exact commands, intermediate failures, cleanup and scratch evidence. No admission, SQL-backed completion, actual worker or selection-to-start green claim.


## U81-B round 5 — retained product custody transport; D28 stop

Ground: 0d3269bad6a263db5e1cccb25f304b65b6d012f2, tools ec2359ece1921a7510ce191cc078ab5e7e3175cb. No commit/push; Git add exited 128 on index.lock creation. Lead owns replacement receipt/full host gate.

Red-first existing service/adapter tests: corrected-fixture run exited 1, 2 tests / 0 pass / 2 fail / 0 skip: dispatch added custody fields to the signed binding, and configured intakeDriver accepted missing custody. Retained-tree green: focused recovery/custody 5/5; native real selection 42/42, zero skips; product TAP validator accepts all 41 named children and proves the original 38 are an unchanged prefix. Delta +3: unchanged checked-binding/receipt with sibling, missing/changed custody refusal, locked-CLI completed-intake durable replay. Two custody guard mutations fail the intended assertions and restore green (3 TAP tests total). TypeScript production/demo and lane reachability pass. Detailed commands, failed experiments, actual exits and cleanup are in BUILD-B8-SELECTION-U81B-R5.md.

Next-door legacy recovery and the B5/B7 signed-settings decoder remain covered. Pure grant-scope probe: unchanged predecessor role files accepted, then required timestamp-helper EXECUTE alone refused by desiredMacGrantsV1. Native product upgrade cases independently reproduce upgrade_grant_source_refused. Section 4.4 does not authorize the required Mac upgrade allowlist file; mandatory stop D28 applies. No new function/SQL/grant/pin is retained. Earlier draft 17/17 admission, native SQL and 20-caller successes are experimental only and do not qualify this final transport slice.

Required full U81-B lanes remain incomplete/not run after D28. Missing cached Squawk prevents positive offline lint/hygiene evidence; no download attempted. Boundary suite failure remains unqualified. No independent code/attack/CI review or Linux parity claimed. No actual model/provider/worker qualification. Owned PG helper cleanup and foreground process teardown are recorded externally.


## U81-B round 6 — second Mac grant boundary

Predecessor: cook/b8-selection-u81b at 666bc96c1c9ebe0bd6bffad0d0f57b2a7acb475d, clean. D27 transport remains unchanged. The lead authorizes exactly one allowedFunctionGrant entry under D28, with full host qualification lead-owned at tools ec2359ece1921a7510ce191cc078ab5e7e3175cb. No tools source changed.

Before product edits: `pnpm run test:private-postgres-production-boundary` exits 1; 11 tests, 2 pass, 9 fail, zero skips. With the draft restored plus the authorized entry and again after restoring all product changes: same exit/counts and exact nine failing titles. These are pre-existing failures; the suite is unchanged. Its subsequent owner-tool-host command is not reached because the first command fails.

Red-first: `node --import tsx --test --test-name-pattern="selection timestamp grant" tests/mac-local-database-upgrade.test.mjs` exits 1 (0/1 pass), upgrade_grant_source_refused. `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-name-pattern="^U81-B R[234]" tests/loop-selection.test.ts` exits 1, 3 tests / 0 pass / 3 fail / zero skips: intent invalid_request and absent full checker context. These reach existing entry points, with no missing import/setup failure.

Draft-only: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-name-pattern="^U81-B" tests/loop-selection.test.ts` exits 0, 17/17, zero skips; `pnpm run check` exits 0. These results do not qualify the final restored tree as B1b/B2. The grant convergence regression after the authorized entry exits 1, 2 tests / 1 pass / 1 fail / zero skips, upgrade_unexpected_function_grant from grantSql. A disposable module comparison isolates the additional knownFunctionGrant fence; exact source acceptance and SQL application are different boundaries. The diagnostic module permits the one helper signature and private-web grant, refuses wrong role/signature, and the original control refuses again, exit 0 for the probe. No real SQL or provider invocation.

The brief's spec/code stop rule applies: knownFunctionGrant is outside the explicit one-entry scope. No partial function/grant/migration/service change is submitted. The report names the exact second entry needed and retains experiments in ignored scratch. B1b/B2 implementation, PG/down-chain fixes, required broad/SQL/guard-off/browser/Linux/review gates remain incomplete/not run. No reviewer, host, worker or selection-to-start green is claimed.

Native preflight: initial sandbox ipcs permission denial is not counted; native authorized inspection returns 2 segments, PG17.11. No cluster or long-running child was started. All foreground commands complete. Final restored ledger verification and diff check results are in the external round-6 report. No index retry, push or network/download operation.

Round-6 Git staging exits 128: index.lock creation refused. No retry, commit or push; final HEAD remains 666bc96c1c9ebe0bd6bffad0d0f57b2a7acb475d. Final diff and ledger verification exit 0. Only these result documents are dirty.

## U81-B round-7 retained implementation candidate

Base: cook/b8-selection-u81b at 666bc96c1c9ebe0bd6bffad0d0f57b2a7acb475d; D28 round-7 authorizes complete grant convergence for only the timestamp helper. B1b freezes the full checked candidate/command identity and transports its immutable dispatch capsule; rechecks authority, lineage, exact bytes, source snapshot and admission deadline before writes/commit; copies acknowledgement only from verified accepted results; exposes the internal exact saved target and safe acceptance status. B1a cancellation remains the single-reserve execution path. Product wiring/UI stay U81-C.

B2 adds 0316/0317 plus downs, strict closed SQL record/intent/timestamp/fresh-claim checks, schema-owned helper with PUBLIC revocation and private-web EXECUTE, aligned grants/ledger/pins/fixture/preflight and existing rollback/upgrade chains. Application/native-public table counts stay 264/265; web/updater pins measure equal at 9d11236d62e7ec8de304aa13683dba653923d87d2e70604ecc14e9023bbb4980. No landed migration or signed JSON is rewritten.

Deciding results: service admission 23/23; helper/convergence regression file 23/23; selection guard mutations 9/9 (8 guards + parent), baseline/altered/restored; SQL PG17 2/2, including 8 independently loaded/caught/restored CHECK mutations and 20 callers at intake/Confirm/Start barriers (60 checker candidates, 3 claims/dispatches, 19 conflicting Start losers). Real-tools product lane passes 44/44, zero skips; original 41 host child titles preserved with 2 additive real-current-reader cases, covering intake and Start drift before new claims/workers. Recorded engine Start methods never launch a worker. UI guard mutation lane passes 6/6. Typecheck/demo/build/loaders/registration/ledger/diff checks pass as recorded externally.

Limits: full host gate remains lead-owned; these standalone product results are not its receipt. Boundary suite remains 2/11 pass, 9 identical pre-existing failures, zero skips at baseline and candidate; no boundary file changed. Existing B5 consumed-action regression also reproduces invalid_request against both unchanged and candidate service. Cached Squawk/Chromium are absent, so migration lint/hygiene/browser are not qualified; offline npm attempts download nothing. Full broad/PG final results, exact-head independent reviews and Linux parity remain pending in the external R7 report. Legacy mutation commands clone committed HEAD and hard-code nonreserved ports; they cannot qualify this uncommitted candidate on the supplied range. No alternate-port or unreviewed harness rewrite is claimed.

Git add is refused at index.lock (exit 128). No retry/escalation, commit or push. Candidate is retained uncommitted; the lead must commit and run exact-head qualification. Precise downstream remainder is U81-C process wiring, saved-target HTTP/client and UI/browser integration, plus the separately authorized host/Linux/worker/device qualification. U82 and preset/default consumers remain separate.

### R7 deciding next-door regression

Required P71 real-provider intake fails in the retained draft: the existing native defaults already have structured roles/counts, so the broad B8 detector sends a legacy no-context caller into mandatory B8 guard admission. This caller has neither a selection guard nor the later configured-provider selection hook. Section 4.2 requires preserving that legacy lane, while sections 3/5 require B8 missing-guard/provider-hook refusal. A generic fallback or rewriting the existing positive would weaken those fences. Stop dependent implementation pending a reviewed server-derived discriminator for native legacy settings versus new product B8 commands, including retained Confirm/Start. D28 grant convergence is resolved; the rest is a blocked draft, not completed B1b/B2. Independent code/attack/CI reviews and full qualification remain pending.

R7 final: HIGH 1 / MEDIUM 1 / LOW 0. The additional MEDIUM is the P72 empty-down/re-up case in tests/loop-policy-enforcement.test.ts, whose chain also needs acknowledgement migrations but is outside the exact allowed file set. Leave it unchanged pending the lead's narrow test-ordering authorization. Full improvement: 913 tests, 902 pass, 7 fail, 4 inherited skips; initial full improvement PG: 86 tests, 79 pass, 7 fail, zero skips, with the repaired seven bridge chains subsequently 7/7. Production ledger prefix: 3/3; main production: 118 tests, 79 pass, 39 fail; seven caused grant-pruner failures repaired and rerun 7/7, remaining 32 unchanged setup-hook errors not qualified. No consolidated broad PASS is claimed.

The redundant production_table_grants.sql DO grant was removed after it broke the existing grants pruner. That file matches HEAD; helper EXECUTE is granted by the authorized private-web role source and converged by the exact known/allowed helper entries. Final ledger verification and grant regression 23/23 pass; final native SQL/20-caller/deadline-lock lane 2/2 passes. No table-count or schema-pin weakening. The legacy routing regression and missing P72 allowed-test entry remain blocking. Candidate is a retained uncommitted draft; staging was refused. All started foreground commands returned; native harness teardown and final cleanup are recorded externally.

Status: BLOCKED: next-door legacy P71 compatibility FAIL; P72 rollback chain outside allowed set


## U81-B round 8 — blocked draft

Base: `b671cccbdf91e0ab56fef039cba4c47e26455548`, branch `cook/b8-selection-u81b`.

Red reproduction: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-name-pattern='P71 real provider settings check' tests/loop-policy.test.ts` with qualified tools environment: exit 1, 0 pass / 1 fail / 0 skipped, `loop_bridge_contract_unavailable` at the retained settings-shape detector.

Draft adds the server issuance operation, explicit source kind/resolver/copy checks, raw factory guard/readiness and additive provenance migration. B8 fixtures are partly converted to the new operation. No completion or security qualification is claimed. `pnpm run check`: exit 2, six TS2345 errors because the required typed error code is absent from the out-of-scope constructor union (see decisions R8 scope stop). `pnpm db:ledger`: exit 0, 188 entries. `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection.test.ts`: exit 1, 49 pass / 1 fail / 0 skipped; T3 fixture still uses native tools overrides after conversion to B8 and needs a scoped fixture update. This partial green does not cover D29's new deciding cases. `git diff --check`: exit 0.

Not run after the mandatory scope stop: five-file constrained command, new real-factory/readiness/residual/history/provenance cases, guard mutations, affected/broad/PG/production/boundary reruns, browsers, lint/hygiene, loader/CI/build verification, provider/native requalification. No native PostgreSQL cluster was started. The diagnostic `ipcs -m` is denied in this sandbox, so its apparent piped zero is not a valid admission preflight. Cached Squawk at the supplied location is absent. Previous round evidence remains historical and does not qualify this changed candidate. Migration-derived web/updater digest pins are still the retained R7 pins and MUST be measured/updated before any deployment; no table count change is intended.

R8 findings: HIGH 1 (typed-error scope blocker), MEDIUM 0, LOW 0; draft and pending checks remain unqualified. No push, PR action, real worker/provider or credential access.


## U81-B round 9 — D32 resolved; exact-shape migration conflict

Base b671cccbdf91e0ab56fef039cba4c47e26455548. D32 adds only service_unavailable to the WebAccessError type union. TypeScript exit 0; existing HTTP 503 mapping reused. The retained R8 draft now has explicit D29 factory tests for both applications: absent/pending/failed/unseeded/export-failed sources refuse B8 before capture/writes; a ready source reaches raw coordinator assertion/commit; recording legacy structured intake/Confirm/Start preserves exact settings bytes/hash, native provenance and no selection dispatch/checker context. Combined D29 diagnostic: 22 pass, zero failures/skips. Earlier full selection unit: 50/50, zero skips. Helper-grant regression: 23/23. Ledger: 188 files verified.

Required policy suite: 51 pass / 1 fail / zero skips. The failure is the unchanged P72 exact restoration assertion after the authorized D30 chain. Native PG17 selection suite: 1 pass / 1 fail / zero skips. Twenty separate callers still reach three checker barriers, sixty candidates, three claims/dispatches and nineteen conflicting Start losers. The native down/re-up failure has the same pair of schema digests as P72.

Native single-variable diagnosis (PG17.11): run only the 0317/0316 downs then 0316/0317 ups on a fresh disposable cluster. Exactly one schema manifest row differs: control_loop_policy_input_sources.admission_kind, attnum 7 before and 8 after. Fresh digest 2bbd9c8d6a2ec92afc08b8d6eccb101b11293842e20ec3c22be4b0618062a2f6 equals the updater's independent reader; re-up digest 1c2f8faf3fbde0cf4b315386ec94410d6c3b624038139521839c4e5d579581bd. Cleanup confirmed true, zero leftovers. Both digest implementations include attnum; PostgreSQL leaves a dropped-column tombstone. No assertion, reader, trigger or table-recreation workaround is made. This is the new mandatory spec/code stop, not a D32 scope stop.

Migration lint command exits 0 but sees no changed tracked migrations (the new pair is untracked); that is not lint qualification. Direct cached Squawk is absent (exit 127); offline hygiene reports an uncached package, without download. Full host gate remains lead-owned. Current diagnostics, exact commands/counts and pending checks are recorded in the round-9 report. No end-to-end B1b/B2 completion, retained-history proof or actual worker/provider qualification is claimed.

R9 final constrained diagnostic: all five files explicitly executed in one command, exit 1, 140 tests / 136 pass / 4 fail / 0 skipped. U81 real selection check and all 43 subcases passed, including current-reader Start drift. The failures were the known PG down/re-up assertion plus the mutation parent and two new factory mutation children: symlinked factory modules resolved their imports to the original service. The harness now copies both factory entry modules and HTTP into its disposable tree; pnpm run test:loop-selection-mutations then exits 0 with 13/13 pass, expected=12 caught=12 restored=12 skips=0. The original five-file run is still a FAIL; no consolidated green is claimed. Unchanged P71 real-provider settings check separately passes 1/1. Final post-PG shared-memory preflight count is 2, matching its initial qualified count.

No new commit: staging the independent type/document checkpoint was refused at index.lock (exit 128), with no escalation/retry. Retained patch and all five new file contents are in ignored round-9 scratch. Code, attack and CI reviews, complete historical/rollback qualification, broad/production/next-door reruns and the lead-owned full host gate remain pending.

R9 additional next-door evidence: eight-file affected command exits 1 with 402 tests / 400 pass / 1 fail / 1 inherited skip. B2a dropped-before-admission and uncertain Stop retain separate replay keys fails because Stopped appears after the uncertain Stop reply. A targeted current-tree command also fails 0/1, zero skips; the identical targeted command in a git archive HEAD source/test tree at b671cccbdf91e0ab56fef039cba4c47e26455548 passes 1/1, zero skips. Root cause is unresolved; no pre-existing/flaky verdict or repair is claimed. This is an additional MEDIUM next-door failure alongside the HIGH exact-shape spec/code conflict. Both block completion. All commands returned and the retained draft is uncommitted after staging refusal.


## U81-B round 10 — D33/D34/D35 integrated candidate

The R9 ADD/DROP physical-column conflict is resolved by the new immutable admission table. The six source columns retain attnums 1..6. Shared PKs, restrictive admission→source FK and DEFERRABLE INITIALLY DEFERRED source→admission FK enforce exactly one pair at commit. Native backfill preserves signed rows. Down locks source/admission/commands and refuses retained B8 before DDL; 0317 down leaves pair FKs validated until 0316 down. D34 counts are application/native public 265/266 after up and 264/265 after down. Product/updater fresh/re-up digest equals `2d8114af1694cf47f6d49f4b9958198318a0a4ec0b666e746839c2fe94893ba9`; predecessor literals and both digest readers are unchanged.

Production grant sources mirror policy-source privacy: private web SELECT/INSERT only, generic production roles denied. Canonical private role SQL is reapplied after relation re-creation; P72 explicitly tests private web INSERT independently of the shape digest. Final ledger: 188 files, `sha256:28557da16b18acb1c4cb00ad62bc61f35a2e28718a43de106e3a3bf8f1e97a03`.

Deciding results (exact commands, elapsed times and all initial failures are in BUILD-B8-SELECTION-U81B-R10.md; raw logs in ignored `.test-tmp/r10-*.log`):

- Red storage: native PG17 old draft has a seventh source column; intended assertion fails. First sandbox-only attempt stopped at ipcs and is not red evidence.
- B2a replay regression: targeted old draft 0/1 FAIL; moving provenance into the original verified-lineage status transaction gives 1/1 PASS and full UI 52/52 PASS, zero skips. UI code/assertions unchanged.
- Final five constrained files in one command: exit 0, 145/145 PASS, zero skips; includes native 43 subcases plus parent, service/factory/mutation and native SQL/20-caller cases.
- Required eight affected files: exit 0, 406 pass / 407 tests; one inherited S3 native-PG skip. Not zero-skip qualification.
- Exact named P72 down/re-up: exit 0, 1/1 PASS; original predecessor/restored assertions and new INSERT-grant proof pass.
- Final focused P71/S4 native bridge: exit 0, 4/4 PASS, zero skips; generic-role denial, immutable source/admission pairs, pre-0310 normalized Confirm/Start with no manufactured provenance, old signed bytes preserved, B8 targets refuse all-versions-empty lineage, and S4 upgrade/replay remain positive.
- Desk TRUNCATE dependency repair: exit 0, 4/4 PASS. Include the new child while retaining the original target-trigger assertion. No CASCADE or weakened assertion.
- Mac grant regressions 23/23; explicit native selection 44/44; UI mutation 6/6; unchanged P71 real-provider settings 1/1; loader tests 42/42 PASS. Native SQL covers eight acknowledgement guard-offs and six side-table/pair guard-offs with restored guards and cleanup.
- check, check:demo, build, ledger verification, loader registration, lane coverage, mutation anchors, quarantine and diff checks PASS. No cache downloads.

Initial full PG run was 78/86 PASS with eight failures from missing new FK children or incomplete role reapplication; corrected targeted cases now pass. A full stable-tree PG rerun and production rerun remain in progress. The initial production run overlapped the final role/ledger correction; its migration_altered failure is not final-candidate evidence. Broad suite is 934 pass / 940, one B5 failure reproduced at unchanged base and five inherited skips. Boundary remains 2/11 PASS, nine lead-acknowledged pre-existing failures. Bridge/lineage mutation lanes cannot qualify the draft: they clone committed HEAD, sandbox-native baselines fail, and their hardcoded native ports differ from this job's range. Browser executables and Squawk cache are absent; offline hygiene is ENOTCACHED. Selection-browser registration/UI is U81-C.

All run admission changes remain uncommitted because staging returned index.lock Operation not permitted; no retry/escalation, identity change, push or PR operation. Full host, independent exact-head reviews, pinned Linux parity, real worker/device and paid-run qualification remain separate. B1a is the earlier completed slice; B1b/B2 implementation and the final reviewed table/grant correction are retained for the lead to commit. No SELECTION-TO-START-GREEN claim.


### Final R10 checkpoint

The final historical pre-journal key guard is verified in the expanded five-file command: 147/147 PASS, zero skips. Latest full PG suite: 84/86 with two mandatory shared-memory precheck failures, zero skips; earlier full PG86/86 and final SQL positives inside 147/147 remain separate checkpoints. Final affected eight: {'tests': 408, 'pass': 407, 'fail': 0, 'skipped': 1}, exit 0 with one inherited S3 skip. Final broad: {'tests': 941, 'pass': 935, 'fail': 1, 'skipped': 5}; sole B5 failure matches unchanged base. Stable production prefix 3/3; main {'tests': 118, 'pass': 86, 'fail': 32, 'skipped': 0}, no migration_altered. Actual build and check:demo pass. See the private R10 report's exact commands, times and logs.

Raw draft-key reuse cannot mint B8 provenance: a replayed save must resolve its existing kind before source/admission or waiver writes. Typed 503 leaves every historical row unchanged and dispatches zero times; its separate guard-off case is caught/restored. New PG tests use the allocated 60520 default when CI supplies only PG_BIN, verified by a positive unset-port run. No product/existing test default changes.

Remaining gates: explicit broad/boundary/production failures and inherited skips; missing cached Squawk/Chromium and offline hygiene; committed-HEAD mutation lanes need the lead's commit before exact candidate qualification. All three existing bridge/lineage/UI mutation scripts clone HEAD and do not qualify this uncommitted tree. U81's working-file mutations pass. No new unresolved builder findings, no independent CLEAN claim. Stage refused index.lock; no commit/push or identity configuration. Lead-owned full host/reviews/Linux parity and separately authorized worker/device proof remain pending. Owned foreground sessions returned and owned-cluster marker audit completed; shared-host IPC resources are not attributed or removed. No live install or real provider launched.
