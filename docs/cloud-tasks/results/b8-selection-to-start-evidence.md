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

Status: BLOCKED: index lock refused; exact build, offline hygiene, browser and committed-HEAD gates incomplete
