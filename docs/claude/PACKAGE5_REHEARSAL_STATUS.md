# Package 5 rehearsal status

## Package 6 strict Mac-local reader proof, 2026-09-25

Claude conditionally authorized a full authenticated reader for the three current
Mac-local CLI adapters, with no skipped checks, real-column grants, new logins,
or changes to the candidate filter and review profile. The new composition
uses the existing durable review-plan reader, authenticated harness-run and
delivery-receipt readers, saved result byte verification, and completion-gate
snapshot. The publisher binds the receipt time to the observed terminal run
event. No request field can assert completion. Mismatched stored bytes and a
delivery authenticated with the wrong key are both refused in focused tests.

On a fresh disposable PG17 cluster at loopback port 15541, the website journey
passed for all three fake pinned executables. Hermes' changes-requested result
stayed incomplete; Claude's and Codex's owner-accepted results became completed
exactly once, with one result and one owner review each. Submission, owner-review,
and completion replays added no second record. Marvin's independent review
showed that the 15-second poll only masked a parent/child lock-order inversion.
The reader now locks job, attempt and lease before run, receipt and plan,
matching the publisher's foreign-key order. The normal 2-second poll is
restored and a reader-query-order test passes. **This is not yet an accepted
fix:** a fresh full PG17 journey at the normal interval still failed before
Claude reached pending review. PostgreSQL reported a second deadlock, between
`SELECT * FROM control_completion_gate_integrity ... FOR UPDATE` and
`INSERT INTO control_transition_events` in a concurrent task transition.
The earlier parent/child cycle is gone, but the complete workflow remains red.
The new PG17 collision assertion at the end of the journey has not run because
the journey stops first. The exact remaining decision is whether to impose one
canonical order for completion-integrity and task-transition locks across the
existing quality/publication transactions, or to serialize these operations
inside the Mac-local host. Neither should be replaced with a longer timer or
a skipped check. No new grant or role is proposed. A failed CLI run remains covered by the separate
`owner-trusted-local-cli-delivery` regression: it records failure and publishes
no result. No live database, agent, or Tailscale setting was changed.

The only new privileges are inert CHECK-false `coordinator_lock` updates on the
review-plan and artifact-receipt tables, already authorized by the owner and
recorded in trust-decision section 15. The structural digest and migration
ledger were regenerated and verified. The production TypeScript check, Vite
build, and focused conformance/publisher tests passed. This branch awaits Marvin's
further deadlock repair and then Claude review; it is not merged or live.

## Package 6 follow-up decision request, 2026-09-25 — direct binding is not valid

Claude directed Mac-local quality to use the pluggable `resultInspectionSource`
with `DurableResultReviewSubmissionServiceV1.inspectSubmitted`, leaving the
native verifier unchanged. The requested binding is not type-compatible:
`TaskResultInspectionSourceV1.inspectSubmitted` must return authenticated
`run`, `job`, `profile`, `result`, `snapshot`, `gate`, and `execution`
(`src/completion-gate/v1/task-result-inspection.ts:9-25`). The durable review
service's method returns only `{ plan, receipt, target }`
(`src/completion-gate/v1/durable-result-review-submission.ts:73-91`). Both
`TaskQualityCoordinator` and `NativeTaskCompletionService` consume the missing
fields. Passing the method directly would require weakening the reader contract
or inventing unauthenticated context, so it was not attempted.

The existing full `DurableLocalResultInspectionServiceV1` is a closer starting
point, but it admits only older Hermes/Claude adapter identities, not the
current three Mac-local CLI adapters. It also requires the durable receipt time
to equal `run.finishedAt`, while the current publisher stamps the receipt from
the earlier delivery receipt. Extending that reader and correcting the timestamp
binding are substantive source decisions beyond the instruction to bind the
durable review service directly. No additional grant, migration, quality timer,
live-system change, or test run was made in this follow-up.

**Decision requested from Claude:** authorize a strict, read-only inspection
adapter for the current three CLI identities, using the durable review service
for its authenticated plan/receipt/target and independently verifying run,
job, attempt, lease, profile, completion snapshot, and observed process times.
Confirm whether durable publication should use the observed terminal-event time
as `receivedAt`. Keep the native reader and verifier's checks unchanged. The
coordinator already has real job/attempt/lease UPDATE grants for its normal
transition path; if this adapted reader needs any other grant beyond the
separately approved inert read-lock columns, stop again with the exact statement.

## Package 6 lifecycle amendment investigation, 2026-09-25 — blocked, not accepted

The owner-approved local publisher grant was applied only in the disposable PG17
rehearsal on loopback port 15541. The publisher now has event INSERT and the
seven run UPDATE columns matching `native_evidence_roles.sql`; its exact
preflight map and denied-write probe were updated. The run store records
`starting → running → succeeded` from the observed successful CLI result before
durable publication, or `failed` without publication on an observed process
failure. Focused publisher, bridge, replay, and role tests passed (15/15),
TypeScript passed, and the migration ledger verified unchanged. The ledger
tracks migration/production-role files, not this Mac-only role file; no schema
or migration changed, so there is no new structural digest to generate.

The full three-agent journey did **not** pass: after an owner acceptance, the
Claude job remained `leased`. Read-only inspection of the disposable database
confirmed the Claude and Hermes runs were `succeeded`, each with three signed
lifecycle events, so the original run-state blocker is fixed. Temporary
diagnostics in the quality sweep reported `native_review_submission_unavailable`
and were removed. `TaskQualityCoordinator.sweep` calls
`NativeResultSubmissionService.inspectSubmitted` via `inspectSubmitted`
(`src/web/v1/task-quality-coordinator.ts`), but its `bound` method explicitly
rejects any run without `nativeTask`
(`src/completion-gate/v1/native-result-submission.ts`). The Mac-local CLI runs
are deliberately not native-task runs. Therefore the existing native quality
pipeline cannot verify or complete them simply by enabling a timer. The
experimental timer was removed; no weakened check, extra grant, migration, or
live system change was made. The disposable website and database were stopped.

**Claude decision needed:** specify the existing durable-result/local completion
service path to compose for non-native Mac-local runs, or authorize a new
strictly bound local quality adapter. Do not make `NativeResultSubmissionService`
accept non-native runs by deleting its `nativeTask` guard. The extended journey
contains the desired completion assertions and remains red until that path is
wired. No acceptance or merge should be inferred from the passing focused tests.

## Package 6 completion investigation, 2026-09-25 (stopped at authority boundary)

The intended Mac-local path is automatic structural verification, **not**
owner-manual verification. The fixed owner-review profile requires
`scenario:mac-local-text` and producer/verifier separation
(`src/web/v1/mac-local-owner-review-profile.ts:18-34`). The Mac provider
registers exactly that automatic scenario with the existing quality
coordinator (`src/web/v1/mac-local-default-task-provider.ts:175-180`). The
manual website verification service is constructed only when
`manualVerificationScenarios` is supplied
(`src/web/v1/mac-local-task-application.ts:65-69`), which this provider does
not do. The existing quality coordinator calls
`NativeResultVerificationService` and then the completion service
(`src/web/v1/task-quality-coordinator.ts:164-183`). The structure verifier is
deterministic and has a service identity distinct from the agent producer
(`src/completion-gate/v1/native-result-verification.ts:61-69`).

A temporary Mac-provider quality sweep and extended three-agent journey were
tested on fresh disposable PostgreSQL 17 clusters at `127.0.0.1:15541` with
fake pinned executables. TypeScript and production build passed. The journey
**did not pass**: an accepted Claude result stayed leased, with zero
verifications. Read-only inspection of the disposable database showed both
saved result runs still in `discovered`, while the quality sweep intentionally
selects only `r.state='succeeded'`
(`src/web/v1/task-quality-coordinator.ts:107-113`). The local publisher only
creates the run and publishes the result; it records no authenticated
`starting`/`running`/`succeeded` run events
(`src/harness/v1/owner-trusted-local-cli-publish.ts:65-81`). The publisher
login has only an inert lock-column update, not the state/event writes needed
by `HarnessRunStoreV1.append`
(`db/roles/local_result_publisher_roles.sql:29-42`,
`src/harness/v1/store.ts:151-169`).

The temporary sweep, journey extension and diagnostics were removed after
the negative proof. No candidate-state check was loosened; no grant, role,
review rule, live database, Tailscale setting or real agent was changed. The
disposable clusters were stopped. Claude must decide the authenticated
run-terminalization authority before this package can safely complete. Do
not treat owner acceptance as completed work in the meantime.

## Package 6 owner review, 2026-09-25 (disposable Mac-local proof)

Starting from Claude's `d8196a20` base, the authenticated website API opened
the one pending result for each of Hermes, Claude Code, and Codex. It recorded
one `changes_requested` review for Hermes and one `accepted` review each for
Claude Code and Codex. An identical repeat of each POST returned the same
receipt without creating a second review; each result and target remained
singular, and the owner could not record another decision on that target.
The `changes_requested` target moved to that state. The two accepted reviews
were recorded exactly once, but their targets correctly remained `pending`:
the separate required text-verification scenario was not run. This is not a
claim that those tasks are fully ready or complete.

The updated rehearsal is the regression test for the owner-decision/replay
path: it fails if a decision is missing, duplicated, incorrectly bound to the
result, or has the wrong post-decision state. A clean full run passed on a fresh
disposable PostgreSQL 17 cluster at loopback port 15541 and stopped its local
services. TypeScript, the production build, and all 14 existing Mac-local
browser-journey tests passed. The first browser-test invocation was blocked
before execution by the sandbox's shared-memory restriction; the permitted
rerun passed. This checkout has no `pnpm lint` script. No grant, live database,
Tailscale setting, or production service was changed. Fake pinned executables
were used; no real agent ran.

## Package 6b follow-up, 2026-09-25 (disposable Mac-local proof)

The isolated PostgreSQL 17 rehearsal on loopback port 15541 passed the full
three-agent website/API journey after the local website was given the same
read-only result and review capabilities as its task application. Hermes,
Claude Code, and Codex each produced exactly one durable result with review
status `pending`; submitting the same task again returned the same receipt and
did not enqueue a second job. The clean, final run had no diagnostic database
dumps or temporary error logging. The rehearsal script stopped its disposable
database after completion. These were fake pinned executables, not live agent
commands, and no VPS database or Tailscale setting was touched.

The separate section 13 first-owner rehearsal also passed on a fresh disposable
PostgreSQL 17 cluster. The updated migration guards rejected a same-tenant
non-owner and revoked owner grant for the fixed review profile, and rejected
revoked or extra local-looking fleet nodes. Focused tests passed (28/28), as
did TypeScript and the 92-entry migration-ledger check. The branch has no
`pnpm lint` script or ESLint configuration, so lint was unavailable rather
than reported as passing. The changes await Claude's review; nothing here
claims a live installation or a main-branch merge.

The remaining sections below record earlier checkpoints and limitations;
their older incomplete status is superseded only by the specific proofs above.

This branch is incomplete and must not be merged to integration or main.
No live PostgreSQL database or Tailnet setting was changed.

The disposable PostgreSQL 17 setup now applies migrations, production group
roles, the fixed pg-boss queue, the four narrow role files, and one narrow
membership for each local login. A fresh cluster passed the queue-worker
preflight. The two required negative probes each failed as intended and were
restored: an extra application-role membership, and a missing queue-table
read grant. The final baseline passed. The three disposable clusters were
stopped; their data directories remain for local investigation.

The full Package 5 B acceptance **did not pass**. The fresh owner bootstrap
attempted to insert `tenants` through `control_room_web`, but the reviewed
private-web role does not grant that write. No owner rows were planted through
the administrator account, and no task or three-worker journey was claimed.
See `PACKAGE5_FIRST_OWNER_DECISION_NEEDED.md` for the exact lead decision.
The source provisioner now refuses any pre-existing narrow role or local login
before changing membership. It does not silently migrate the current VPS;
the reviewed live migration remains section 11.C after B and Opus approval.

Local checks: TypeScript passed; the six database-check unit tests and two
new provisioner-refusal unit tests passed. An agent-run disposable PG17 queue
probe passed. A second run from Codex's restricted shell returned `EPERM`
on loopback connection, so that shell result is an environment restriction,
not an independent repeat of the PostgreSQL proof.

Opus review is pending. The local Claude CLI returned `Not logged in`; a
missing verdict is not approval. Real role-file headers still correctly say
that full PostgreSQL qualification is pending.

## Section 12 follow-up

The non-secret first-owner manifest, receipt-bound public-key pin, and
read-only repeat-start checks are now source-built with focused tests. The
ordinary task provider no longer initializes completion-gate integrity at
startup. These changes have not been exercised as a complete three-worker
rehearsal. The VPS one-time command is not built or run: section 12 requires
it to create an authenticated review-integrity row while its shareable
manifest deliberately excludes the Mac-held review key and its independent
rollback-checkpoint file. The manifest also lacks the worker IDs needed to
reproduce the existing node software fingerprints. See
`PACKAGE5_SECTION12_CONTRACT_GAPS.md`; these are lead decisions, not permission
to widen a database role or move a secret through the manifest. No live
database or Tailnet change occurred.

The safe disposable section-12 negative check was run on a fresh PostgreSQL
17 cluster with no first-owner setup. `mac:up` exited 1 with the required
`first-owner setup has not been run; see OWNER_GUIDE_MAC.md` message after
the four database checks refused the missing owner binding. No task host or
worker started. The disposable cluster was stopped and `pg_ctl status`
reported no server running. Its data directory was retained for
investigation; no live database was contacted.

## Section 13 disposable rehearsal

The focused first-owner and section 13 rehearsal passed on a fresh PostgreSQL
17 cluster bound only to loopback, rooted in a disposable temporary directory.
Before any first-owner transaction, it
verified the exact cluster data directory and PostgreSQL version, then opened
the coordinator login and confirmed `SELECT` on both completion-gate tables.
No grants were changed.

The run passed the no-setup `mac:up` refusal; manifest generation with worker
ids and completion-gate genesis; first injected VPS transaction and identical
repeat (14 rows kept); altered manifest-id refusal; tampered node-key pin refusal;
altered genesis-tag and wrong manifest-digest receipt refusals; successful and
repeated Mac completion; and an advanced-integrity/missing-checkpoint refusal
for the finisher. `mac:up` also refused, but the separate preflight failure
means its checkpoint-specific refusal is not yet proven. It also created a
disposable project and used `CompletionGateStoreV1.registerProfile` to make a
real revision/count advance,
then removed the checkpoint and confirmed the finisher refused to recreate it.
That profile insert used the disposable cluster's `postgres` role because no
reviewed application login permits profile records. It tests store/checkpoint
behavior, not an available runtime authority path. The node-key negative
temporarily disabled the immutable-key trigger inside the throwaway cluster,
then restored the original fingerprint and re-enabled the trigger.

The rehearsal called the VPS transaction's injected-client function only after
proving that the client was connected as the disposable cluster's `postgres`
role and that the server data directory matched the rehearsal root. The VPS
CLI's refusal for a non-`postgres` OS user passed with its generic error. The
positive Unix-socket peer-authentication path was not run on this Mac.

The rehearsal script's `finally` stopped PostgreSQL, and a separate
`pg_ctl status` confirmed no server remained. The initial sandbox attempt was
blocked by shared-memory permission; the same setup and rehearsal then passed
under the approved scoped execution. No live database or Tailnet was contacted.

The positive worker-readiness attempt reached `mac:up` but stopped before host
startup: the web, coordinator and results preflights returned
`private_database_preflight_failed`; the queue-worker preflight passed. A
read-only diagnostic confirmed each role login worked, then those three role
verifiers failed. The cluster was stopped and no task host or task started.
The three ready-worker listing and pending-review task journey therefore remain
unproven. Do not treat this as complete 12.F2/section 13 acceptance or as merge
approval. Remaining evidence includes the positive VPS CLI Unix-peer path, a
positive lifecycle advance under a reviewed non-superuser authority, proof that
`mac:up` refuses specifically for a missing advanced checkpoint, and resolution
of the three role preflight failures before checking fake-worker readiness.

Source inspection and a read-only catalog comparison confirmed one cause
requiring a separate lead decision: `privateWebSchemaDigest` differs from the
actual structural digest after migration 0085. The preflight table/permission
maps also describe migrations 0001–0084. The preflight deliberately reports
one generic refusal, so additional failures have not been ruled out. The package-5 instruction
forbids changing any preflight; this branch does not change or bypass it.
Claude must approve the separately reviewed schema/preflight update before
full 12.F2 can pass.

The added real profile advance exposed a separate authority gap: migration 0054
limits coordinator inserts to service verification, migration 0055 limits the
results role to targets/revisions, and migration 0053 limits web inserts to
reviews/findings/verifications. None permits an acceptance profile, although
the task provider currently registers profiles through the coordinator store.
Claude must choose a reviewed role/architecture change; switching to the web
pool alone is not supported by the current grants and triggers.
