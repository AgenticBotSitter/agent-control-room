# b8-selection-to-start evidence (PLAN)

Phase: PLAN. No product code was changed or run. Product tests were not required in PLAN and were NOT RUN.

## Environment and setup (scheduled worker)

| Command | Exit | Note |
|---|---|---|
| `npm ci` | 1 | `EUSAGE`: the repository has no `package-lock.json`; its own lockfile is `pnpm-lock.yaml` (`packageManager: pnpm@11.19.0`) |
| `pnpm install --frozen-lockfile` | 0 | install from the repository lockfile |
| `apt-get update` | 0 | distribution archives only |
| `apt-get install -y postgresql-17` | 100 | `Unable to locate package postgresql-17` |
| fetch PGDG signing key over HTTPS | 22 | egress proxy 403 |
| `apt-get update` with the PGDG source added | 0 | PGDG `InRelease` refused by the proxy (403); source removed afterwards (exit 0) |
| `apt-get install -y postgresql-17` (PGDG) | 100 | package still unavailable |
| official source tarball listing over HTTPS / HTTP | 56 / 6 | proxy 403; host not resolvable over HTTP |
| fallback | — | newest local PostgreSQL is 16.15 (Ubuntu package); PG17 checks were **NOT run** |
| `useradd builder` | — | already existed |
| `chown -R builder <checkout>` | 0 | git used with a command-scoped `safe.directory` |

Node `v22.23.4`. PostgreSQL 17: NOT obtained (apt and source routes blocked by the egress policy). No database checks were run in PLAN; all DB checks in spec section 9.2 are **PG17-later** for this machine.

## Base verification

| Command | Result |
|---|---|
| `git rev-parse HEAD` / `origin/cloud-base/b8-selection-to-start` | `fa673cc8f81ce1dac457ce383b47b2f3ac31f026` (both) |
| `git rev-parse origin/cook/b7-providers` | `412d0c149fe8e272c491900d7a9164f80ecb612a` |
| `git merge-base --is-ancestor 412d0c1… HEAD` | exit 0 |
| `git rev-list --count 412d0c1..HEAD` | 1 |
| `git diff --stat 412d0c1 HEAD` | only `docs/cloud-tasks/b8-selection-to-start.md` and `docs/cloud-tasks/playbook/CLOUD-LEAD.md` |
| `git status --short` before writing | clean (exit 0) |

## Cited path and interface lookups

`test -f` returned OK for every cited existing path: loop-policy compose/service/http, loop adapter/service, `schemas.ts`, desk `service.ts`, `improve-control-room-http.ts`, `mac-local-web-process.ts`, `private-process.ts`, `loop-roster-columns.ts`, `loop-provider-service.ts`, the four improvement UI files, migrations 0302/0306/0307, `db/down/0306…`, migration ledger JSON + SQL, `desired-grants.json`, `private-database-preflight.ts`, `run-tests-with-quarantine.mjs`, `check-private-names.mjs`, the B5 helper and both loop browser specs.

`grep -rlF` file counts under `src db`: `composeLoopSettingsV1` 2, `LoopPolicyServiceV1` 5, `parseLoopSettingsV1` 3, `checkSettings?(text: string)` 2, `admissionExpectation` 1, `decisionProjection` 1, `qualifiedOperations` 1, `paidExecutionReady` 1, `saveLoopDraft` 2, `reviseLoopDraft` 2, `authorizeLoopStart` 2, `loopBridgeTransaction` 2, `recordInputSources` 2, `copyInputSources` 2, `control_loop_improvement_commands_check1` 4.

Absence check: `grep -rn "R296|acceptSameFamilyRisk|familyRiskAcceptance|selectionProjection" src db tests private-app` → 0 lines (all such names are NEW). No `cr.py` in the repository. `R296|same-family|review_only` matches only unrelated news code.

Script names verified in `package.json`: `test:improve-control-room` (skip pattern `^P71 real settings check$`), `test:loop-policy:real`, `test:improve-control-room-postgres`, `test:postgres-production`, `test:private-postgres-production-boundary`, `check`, `check:demo`, `build`, `test:improve-control-room-loop-browser`, `test:improve-control-room-loop-providers-browser`, `test:improve-control-room-loop-ui-mutations`, `test:improve-control-room-loop-bridge-mutations`, `test:improve-control-room-loop-lineage-mutations`, `check:test-loaders`, `test:test-loaders`. `test:loop-selection:real` does not exist (NEW).

## Privacy

`node scripts/check-private-names.mjs`: SKIPPED — no `CONTROL_ROOM_PRIVATE_NAMES`/`_FILE` denylist is configured in this environment. Separate bounded public-text scan of the five results is recorded below. The lead retains full privacy qualification.

## Historical r1 helper review (r2 dispositions superseded below)

Claude plan-review helper (read-only, general-purpose), reviewed spec r1 at working tree on `fa673cc8…`: verdict NEEDS-FIX — HIGH 2, MEDIUM 11, LOW 8 (counts from its report; no edits by the helper). Cited facts were confirmed accurate apart from LOW notes.

| Severity | Finding | Disposition (spec r2) |
|---|---|---|
| HIGH | Intake acceptance had no checker path; settings would become authority | Fixed: pre-stamped bound record evaluated by `checkWith` context (4.3) |
| HIGH | Checker never saw the signed record (`accepted_at` stamped in claim tx) | Fixed: preflight stamping + freshness/≤ predicates (4.3, 4.4) |
| MEDIUM | Product reasons altered checker eligibility | Fixed: separate `blockers` (3) |
| MEDIUM | Intake B8 input not strictly decoded | Fixed: `decodeSelectionEditsV1` on intake, R1 (2.2) |
| MEDIUM | No roster/availability drift fence | Fixed: `lineupDigest` expectation context + tools compare (5, 6.3) |
| MEDIUM | GET selection spawned checker | Fixed: lineage-only GET (7) |
| MEDIUM | SQL weaker than possible | Fixed: row predicates (a)–(d) (4.4) |
| MEDIUM | Approve/answer/recovery lacked record | Fixed: record copied to approve/answer; recovery digest covers start binding (4.3) |
| MEDIUM | Item 7 cases missing (duplicates, Trial/class/unwired, override matrix, dispatch drift) | Fixed: T5, T7, T9 |
| MEDIUM | Missing NEW mutation/browser commands and transport lane | Fixed: 9.2 NEW scripts, T13 |
| MEDIUM | Red-first claimed via missing modules / positive flow | Fixed: R1–R4 through existing entry points; T6/R5 marked regression guards |
| MEDIUM | `improvement-run-panel.tsx` missing | Fixed: added (7, 8) |
| MEDIUM | Item 6 policy core only intake/confirm/start | Fixed: product half in 4.3, engine half 6.4 |
| LOW | Effort enum not exported; "review-only" absence scope; pnpm vs npm; wrong unavailable error code; Start Confirm lookup; Confirm flag UX; preview authority shape; status files missing | Fixed in r2 (2.1, 1, 9, 5, 4.3, 7, 3) / status files added |

Spec r2 was not re-reviewed by a helper in the original cloud run. The subsequent specification gate found S1–S7; r3 replaces conflicting r2 dispositions. No independent CLEAN is claimed.

## Document checks

- `git diff --cached --check` over the six result files: exit 0, no output.
- Staged paths: exactly the five allowed results plus `b8-selection-to-start-status.md.progress`.
- Bounded public-text scan (workstation paths, account/email fragments, session URLs, key/token patterns, private-key headers) over the result files: one line matched, the spec's "Absent" row (a benign word match); no secret, workstation path or private name found.
- Status document last line verified: `Status: PLAN-READY`.
- Direct inspection: all five results re-read after r2; required spec sections 0–10, decisions format (Choice/Options/Why/Affected spec item) and owner-questions `None` present.

## Local specification revision r3 (2026-11-04)

Starting result: 43f09d589fcea359653a9d500f706bc61c999db3; source: origin/cook/b7-providers 412d0c149fe8e272c491900d7a9164f80ecb612a. Local plan branch; no push. This section describes the current revision; earlier setup/results are historical cloud evidence, not commands rerun locally. No dependency install, DB/model/provider/worker/browser/listener execution in this revision.

The independent gate reported HIGH 2 / MEDIUM 5 / LOW 0: S1 exact candidate/context/capsule; S2 SQL copied/delayed timing; S3 normalized/reload/Start UI; S4 shared codec/reset; S5 shared authority; S6 real snapshot prerequisite; S7 continuations/migration/lane integration. All have explicit r3 contract changes and future deciding probes; re-review remains pending. Tools/snapshot implementation is not claimed present.

Verified current source anchors: policy.assertSnapshot covers only defaults/layers/text; commandId/run currently allocated at claim; binding has no requestId; normalized Confirm increments saved version; result repeats claim binding with a later created_at. Roster DB state has version/export metadata, but no atomic availability reader. Fixture/application count is 263 and native public count 264 on this base (no PG execution); U81 constraint-only migration adds zero tables. Candidate and desk rollback chains already include 0309→0301 and need the new pair before that chain.

Deciding documentation audit and cleanup results are recorded below after completion. Full private-name denylist gate is NOT RUN (none supplied); bounded public-text scan is a separate limited check. Product/unit/PG17/tools/native/browser/device/Linux checks remain NOT RUN, as this is specification-only work.

### r3 completed documentation checks

- `git fetch origin` → `RESULT fetch exit=0`; disposable local plan branch created from the exact cloud result head (worktree creation exit 0). The first fetch needed a metadata permission retry; no push or other task network operation.
- `python3 .test-tmp/b8-fix1-doc-audit.py` (from the parent clone) → `PATHS=96 SCRIPTS=24 SYMBOLS=70 UNRESOLVED=0`, `RESULT documentation-audit exit=0`. Existing source paths/symbols/script names and line bounds checked against origin/cook/b7-providers; absent planned files/scripts classified NEW/deferred. Initial audit-harness path/prose/generic-method matching false positives were corrected before this passing result; no product behavior was changed.
- Independent contract arithmetic → reserve=6000000, actual=7500000, excess=1500000. Timing model: +1-second fresh-intent claim checks freshness; identical +8-second result and omitted-intent copied claim do not. These are contract calculations, not executed product/PG tests.
- Source subtree comparison against the pinned base reports no implementation difference. Allowed-write audit finds exactly this ID's five result Markdown documents. Both status final lines are exactly `Status: PLAN-READY`; P1–P4/S1–S7 have explicit r3 Revision history dispositions; balanced fences and bounded public-text privacy checks pass. The denylist-dependent privacy gate is still NOT RUN.
- `git diff --check` passed before this evidence update; final whitespace/allowed-path check is repeated for the handoff. Current independent spec re-review is pending; no product green gate or reviewer CLEAN is claimed.

Commit identity handoff: effective configured identity differs from the brief's required worker identity. No Git identity configuration was changed. No response authorizing command-scoped identity overrides was received before handoff. The verified worktree is retained for the lead to commit; no new commit exists. No wrong-identity commit is claimed.

Final handoff: both plan branches retain exactly five changed result Markdown files. Staging and staged whitespace checks completed with exit 0; final repeat follows the last documentation update. Worktrees are retained because commit identity authorization is unresolved; they are not removed with uncommitted work. No owned process remains.
