# Reuse-first integration progress

Updated 2026-09-06. Parent: [completion plan](REUSE_FIRST_COMPLETION_PLAN.md).
Owner now explicitly approves continuing the plan until sensible reusable pieces are
integrated. Local implementation is authorized; GitHub publication remains paused.
Native database/server/provider/credential operations retain their scoped boundaries.
The completed E02 database authorization is not reusable standing authority.

## Completed locally in this block

[E49 project receipts](research/REUSE_E49_PROJECT_RECEIPT_MATCHING.md) checks save responses
against the original request before clearing pending state. It reuses existing explicit
idempotent retry and current-state reads, with no new workflow engine or automatic write.

[E48 separate project tabs](research/REUSE_E48_PROJECT_TAB_AFFORDANCE.md) makes opening
multiple authorized project pages explicit using native browser links. It introduces
no tab-state infrastructure, project mutation or claim of a connected fleet.

[E47 compiled inspection](research/REUSE_E47_COMPILED_QUEUE_INSPECTION.md) packages the
existing schema inspector and verifies it with the compiled full-host task journeys.
The VPS handoff distinguishes compiled components from an installed service; real
database preparation, configuration, live agents and operational acceptance remain open.

[E46 approval editing](research/REUSE_E46_APPROVAL_EDITING.md) preserves matching local
review/file state without restoring old files into a replacement review or changing
server approval validation. Focused checks and compiled regressions pass. The duplicate
test-script keys are repaired; all 479 combined follow-up checks pass.

[E45 task workflow guidance](research/REUSE_E45_TASK_WORKFLOW_GUIDANCE.md) improves the
existing panel flow and confirmed-assignment refresh without new commands. Local UI
tests pass; browser interaction remains unproven while the Mac is locked.

[E44 delivery attention](research/REUSE_E44_DELIVERY_ATTENTION.md) connects verified
historical delivery records to task and inbox views. It distinguishes pending intent,
unconfirmed transmission and authenticated receipt/rejection without new grants or
retry behavior. Operational triage and real-service acceptance remain separate.

[E43 saved-plan readback](research/REUSE_E43_SAVED_PLAN_READBACK.md) reuses trusted plan
verification to restore task links and remove already-planned proposal inbox entries.
Separate authorized transactions avoid nested identity locks across pools; reads never
create work. Saved-plan availability is explicit for older/unconfigured compositions.

[E42 task attention](research/REUSE_E42_TASK_ATTENTION.md) adds saved task/review items
and direct task links to Needs Me using existing canonical records and verification.
It does not create another queue. Pagination, current owner/source access and incomplete
evidence remain explicit; task-specific queue-delivery uncertainty is still unfinished.

[E41 recovery attention](research/REUSE_E41_RECOVERY_ATTENTION.md) connects the first
owner-only Needs Me section to current runtime recovery observations. It reuses session
authorization, exposes no raw machine identities or command port, and passes source/
compiled full-host checks. Durable task-level inbox and interactive acceptance remain.

[E40 schema inspection](research/REUSE_E40_SCHEMA_INSPECTION.md) adds a read-only strict
wrapper around upstream schema detection, covering swallowed probe failures and
cancellation without granting operational roles more access. Physical PostgreSQL
rehearsal and caller integration remain separate, unaccepted work.

[E39 installed composition](research/REUSE_E39_INSTALLED_QUEUE_COMPOSITION.md) removes
test-only package constructor wiring from the complete host journeys. Compiled helper and
adapter plus installed pg-boss pass all three journeys; 35 compiled regressions pass.
Production dependencies remain required beside the build; startup is still explicit.

[E38 pnpm configuration](research/REUSE_E38_PNPM_WORKSPACE_CONFIGURATION.md) resolves
E37's local precheck mismatch without bypassing verification or reinstalling packages.
Normal pnpm execution passes all 66 queue checks; preparation and release-tooling checks pass.

[E37 pinned dependency](research/REUSE_E37_PINNED_APPLICATION_DEPENDENCY.md) removes the
temporary evaluation-folder requirement. All 66 queue integration checks pass against the
application's locked pg-boss installation. pnpm run precheck diagnosis remains separate;
direct Node test execution is verified. No production startup enabled.

[E36 client/host reconciliation](research/REUSE_E36_BROWSER_CLIENT_HOST_RECONCILIATION.md)
passes the actual browser client through the complete host for online, offline and lost
commit-response journeys. Real browser interaction remains untested because the Mac is locked.

[E35 full-host journey](research/REUSE_E35_FULL_HOST_TASK_JOURNEY.md) closes the local
fresh-task composition gap: protected HTTP to actual six-role host/queue to signed delivery
and exact result awaiting review, online and after reconnect. 65 package checks and both
compiled variants pass. Provider remains simulated and browser interaction remains open.

[E34 six-role actual startup](research/REUSE_E34_ACTUAL_SIX_ROLE_STARTUP.md) combines
real package/schema/worker registration with managed sessions and all restricted application
logins. Source and compiled variants pass; 27 prior startup checks pass. Queue is empty:
fresh delivery through this whole composition remains the next acceptance gap.

[E33 compiled acceptance](research/REUSE_E33_COMPILED_QUEUE_ACCEPTANCE.md) runs eight
actual-package scenarios against the built bootstrap and passes all 35 compiled app
regressions. Source adapter injection and PGlite limits remain explicit; no deployment.

[E32 status/build](research/REUSE_E32_DISPATCH_STATUS_AND_BUILD.md) replaces hardcoded
unconnected task projections with composition-derived configuration and adds overlapping
submission coverage. A real build failure from a local `require` binding is fixed without
changing policy. VPS build and three compiled checks pass; no live-system acceptance.

[E31 submission controls](research/REUSE_E31_SUBMISSION_READBACK_AND_CONTROLS.md) adds
read-only canonical receipt reconciliation and a bounded browser client that refuses
another send after uncertainty. The approval page exposes explicit queue/check controls.
Eight package startup and 17 browser/approval tests pass; no interactive browser acceptance yet.

[E30 HTTP submission](research/REUSE_E30_PROTECTED_HTTP_SUBMISSION.md) wires the narrow
coordinator operation through the protected private application. Eight focused startup
checks pass after correcting a test's packet-mismatch error expectation; the preceding
full package run passed the other 60 checks. 33 related checks plus the added no-queue
approval test pass. Browser controls and uncertain-response readback are next, not complete.

[E29 six-role coexistence](research/REUSE_E29_SIX_ROLE_COEXISTENCE.md) passes the real
database gates for all six application/worker identities on one actual-package PGlite
schema and rejects incompatible role memberships. 62 package checks pass. This is not
physical PostgreSQL pool or whole-host/browser acceptance; protected web submission is next.

[E28 automatic recovery](research/REUSE_E28_AUTOMATIC_READY_RECOVERY.md) now runs after
signed-ready reconciliation with bounded discovery and generation/deadline checks.
The actual package test reaches review from offline pickup without a manual recovery
call. Full-host/browser/live acceptance and attention-view integration remain open.

[E27 recovery startup](research/REUSE_E27_RECOVERY_STARTUP.md) selects the exact
permission profile and captured recovery/verification ports through explicit startup
configuration. 55 package and 54 startup/runtime checks pass. Signed-reconciliation
triggering is next; no production service has been enabled.

[E26](research/REUSE_E26_RECOVERED_PICKUP.md) connects lifecycle-owned recovery and
canonical audit verification to optional worker admission. The actual package test
now reaches pending review from an offline first pickup after explicit recovery on
reconnect. 53 package and 71 related checks pass. Automatic triggering is still open.

[E25 recovery permissions](research/REUSE_E25_RECOVERY_PERMISSIONS.md) verifies the
offline coordinator column-grant candidate and opt-in full database profile with actual
canonical recovery under a restricted LOGIN. 53 package and 39 startup checks pass.
No production grants or automatic recovery are enabled.

[E24](research/REUSE_E24_NEVER_STAGED_RECOVERY.md) implements the canonical never-staged
gate and opt-in upstream recovery port, with audit in the same transaction. 52 package
and 42 related checks pass. Recovery permission/profile, lifecycle command and
audit-bound reconnect/pickup integration remain unmounted, not silently waived.

[E23 recovery source-fit](research/REUSE_E23_OFFLINE_RECOVERY_PRIMITIVES.md) selects
the public retry/update transaction, not internal restore or a custom queue reset.
48 package checks pass. Never-staged canonical proof and reconnect wiring are not yet
implemented; the current worker deliberately continues rejecting recovered metadata.

[E22 host/worker composition](research/REUSE_E22_HOST_WORKER_STARTUP.md) now supplies
the real delivery callback and all five application logins to an explicitly injected
worker factory before joint installation. Production remains disabled. The offline
package test proves retained unsent work does not resume on reconnect; recovery is an
open product gap, not a passed journey. 45 package checks pass.

Latest: [E21 connected queue-to-review test](research/REUSE_E21_QUEUE_TO_REVIEW.md)
passes with all 44 actual-package checks. One signed dispatch reaches a pending review
with exact stored result bytes through simulated native execution. This closes the
separate-fixture integration gap, not browser, host startup or live-agent acceptance.

| Area | Actual change | Evidence and remaining limits |
|---|---|---|
| Approved-task queue submission | Thin pg-boss adapter and optional trusted coordinator composition. Fresh immutable intent, queue INSERT and audit share one checked transaction. Canonical replay never re-enqueues, including after operational history pruning. | 13 actual-package/PGlite integration tests passed. 131 related tests passed. Not wired to app startup, no consuming worker/native dispatch, no app dependency adoption or production schema change. |
| ABS duplicate-event selection | Adapted MIT Control Center title/event helpers now run in existing digest selection. Near-duplicate headlines from distinct clusters defer lower-ranked entries, without merging canonical records. | All 61 ABS tests passed; four comparisons against the exact upstream file passed. No feed fetch, LLM ranking, score rewrite, identity migration or publishing. |
| Continuous queue pickup | Thin adapter to pg-boss public worker API: library polling/concurrency, single-item callbacks, zero automatic retry, group drain and coarse dispositions. | [E05](research/REUSE_E05_PG_BOSS_WORKER.md): 26 combined actual-package checks pass, including seven canonical delivery-path cases and six worker cases; 16 new unit checks pass. Source opt-in only, no startup/production worker or genuine provider run. |

## Queue adapter design and cutover

Files: `src/persistence/native-task-submission.ts`, `pg-boss-native-task-submission.ts`,
and `TaskAssignmentCoordinator.enqueueNativeTask`. The constructor accepts an optional
trusted server-side submission port; ordinary existing compositions still do not submit
operational work. No browser-controlled queue name, database client or provider input.

- Package remains pinned in the **isolated E01 evaluation** at pg-boss 12.30.0. The adapter
  receives its constructor through composition; it does not dynamically install/load a
  package, open a connection or contain its own queue implementation.
- AsyncLocalStorage binds **all** library database calls to the exact caller transaction,
  including a cold-cache metadata read. Each concurrent caller has an isolated context;
  continuations that outlive submission cannot reuse that transaction. No live fetch is
  used as metadata priming. This replaces the E01 test-only workaround.
- Preparation requires an already-created `control_room_queue` schema and standard
  `native-task-delivery` queue on `job_common`, retryLimit 0, no dead letter, no notify.
  Schema creation/migration, scheduler, supervisor and notifications are disabled.
  The library's ordinary metadata/WIP housekeeping intervals may exist until close;
  no claim is made that preparation starts zero timers.
- Submission locks the queue metadata row `FOR SHARE`, rechecks those settings and
  explicitly disables retries on the submitted job. Default cache refreshes never
  replace the canonical record or operation identity.
- Queued data contains only canonical locators/digests, no prompt, signed packet,
  credentials or execution authority. Workers must re-read and revalidate canonical
  authority before any native effect. A queue claim cannot approve an operation.
- Fresh-ID collision fails and rolls back instead of silently adopting an orphan queue
  row. No fallback queue is used when the engine fails. Submission failure, audit
  failure, abort, expiry and revocation all roll back intent and operational INSERT.
- Old canonical intents are **not automatically backfilled** when this adapter is
  introduced. A deliberate migration/reconciliation policy must classify old work and
  uncertain starts. Preserve all signed/history records when retiring generic queue code.

Restricted-role delta observed on PGlite: the coordinator needs schema USAGE, version/
queue SELECT, SELECT/INSERT on `job` and `job_common`, and **UPDATE(name) on queue** for
PostgreSQL's row-lock privilege requirement. This last grant was not in E02; it needs
real-PG confirmation with the final adapter. It is a test-only grant here, not an edited
production role script. Worker, supervisor, scheduler and per-queue partition privileges
must be reviewed separately. Private web remains excluded.

Custom-code justification: pg-boss provides queue mechanics, not Control Room's signed
approval checks or permanent canonical replay policy. The thin adapter uses its public
API and Node's standard transaction-context mechanism. DBOS/Hatchet would not remove
those domain-specific obligations and have not shown a gap requiring another engine.
No custom polling, retry, scheduling or worker-supervision engine was added.

## ABS adoption decision

Source revision, hashes, full license and changes: [Control Center notice](../third_party/control-center/NOTICE.md).
Downloaded original is recorded in [E03 ledger](REUSE_DOWNLOAD_LOG.md). The adapted subset
has no runtime dependencies and is imported directly by the existing digest selector.

Reuse: Unicode/headline normalization, publisher suffix handling, significant title
tokens and event-overlap comparison. Changes are deliberately narrow: precomputed token
sets, no hash-derived new identities, protect distinct numeric model/version/date tokens,
and avoid suppressing sparse headlines on different/unknown direct URLs.

Observed reasons not to adopt the whole upstream pipeline:

- Its source-diversity second pass can exceed maxPerSource to fill spare slots. An exact
  upstream comparison selected two same-source items with maxPerSource 1. ABS retains
  its existing hard cap rather than creating a second ranker or weakening that contract.
- Its URL normalizer accepts `http://localhost/...` and semantic query parameters. It is
  not a replacement for our public-HTTPS destination validator; source normalization
  never grants network authority.
- Its routine-path exclusion removed a synthetic privacy-news URL `/privacy`. This
  initially confounded the soft-cap comparison; the test was corrected to a non-utility
  path. The broad routine-page filter and scoring heuristics are not adopted here.
- The initial local event integration failed four old short-headline tests because
  removing one-letter tokens erased real distinctions. The sparse-title exemption was
  broadened; all original tests then passed along with new near-duplicate/version tests.

These are concrete compatibility reasons, not preference for custom implementation.
Existing score order, strict caps, verified/archive/freshness filters, story/cluster IDs
and authenticated evidence remain unchanged. Deferred stories remain available; none
are deleted or merged by digest selection.

## Verification commands and disposition

- `node --import tsx --test` over nine queue/approval/assignment/delivery suites: **131 pass**.
- `CR_REUSE_EVAL_ROOT=<E01 root> node --import tsx --test scripts/research/pg-boss-submission-integration.test.mjs`: **13 pass**.
- All eleven `tests/abs-news*.test.*` files: **61 pass**.
- `CR_REUSE_ABS_ROOT=<E03 root> node --import tsx --test scripts/research/control-center-events-comparison.test.mjs`: **4 pass** after the documented comparison-fixture correction.
- `tsc --noEmit`, targeted ESLint and `git diff --check`: passed.
- `node --import tsx scripts/verify-migrations.ts`: 57 migrations, 138 public tables verified on **PGlite**, not another native database attempt.
- New queue unit tests and existing/extended digest tests are registered in the default
  repository test command. Opt-in downloaded-package comparisons remain separate.

No full repository test/build suite or new independent agent review is claimed for this
block. New source has local tests/review only; do not relabel it deployed/live accepted.

## Next useful work

[E20 managed routing](research/REUSE_E20_MANAGED_QUEUE_ROUTING.md) connects the approved
node locator to one current managed-session generation and exposes a server-only
queueDelivery callback under the configured lifecycle. 49 related checks pass. Missing
receipt stays unresolved while later receipt intake remains available. Next: whole-host
composition and exact-role/full-path tests, not claims of a live fleet.

[E19 approval-bound server delivery](research/REUSE_E19_SERVER_DELIVERY_AUTHORITY.md)
implements ADR-251's separate server entry points. Background delivery no longer needs
a fabricated browser identity; exact canonical/signature/current-owner checks still run.
The path remains opt-in and unmounted pending session routing and acceptance.

[E18 joint lifecycle](research/REUSE_E18_JOINT_LIFECYCLE_AND_DELIVERY_GAP.md) orders worker
drain before application close and gates requests immediately. 36 related checks pass.
Inspection found the canonical delivery entry still depends on a browser identity;
settle a separate approval-bound server delivery entry before production mounting.
Synthetic identity fixtures are not unattended-dispatch acceptance.

[E17 worker startup](research/REUSE_E17_WORKER_STARTUP.md) composes the identity check
and existing runtime with topology validation, one attempt, bounded cleanup and late
SQL fencing. 45 unit and 42 package checks pass. Production mounting still requires
current-authority delivery and joint application/worker shutdown, not an arbitrary callback.

[E16 worker identity](research/REUSE_E16_WORKER_DATABASE_IDENTITY.md) verifies a dedicated
worker LOGIN, database, session limits and fixed role membership using the existing
application gate. 42 package and 78 role/startup regression checks pass. This is still
PGlite with its documented TEMP exception, not real pool isolation or production startup.

[E15 version/drift evaluation](research/REUSE_E15_QUEUE_VERSION_AND_DRIFT.md) proves
upstream startup version rejection through both adapters. Reuse it; no new custom
version checker needed. Drift diagnostics can skip failed probes, so an ok report is
not full schema acceptance. 41 combined package checks pass. Worker identity/bootstrap,
complete schema validation and real PostgreSQL acceptance remain next.

[E14 producer startup](research/REUSE_E14_PRODUCER_STARTUP.md) now permits explicit
queue-enabled composition only with approvals and a trusted supplied producer factory.
Database checks precede preparation; drain/stop/pool cleanup and late preparation are
tested. 38 package and 28 lifecycle/startup checks pass. There is no production default
factory, worker startup activation or browser submission endpoint yet.

[E13 queue coexistence](research/REUSE_E13_APPLICATION_QUEUE_ROLES.md) adds the offline
producer grant script and explicit combined database-preflight option. Default gates
remain queue-free; opt-in requires producer-only coordinator privileges and no queue
access for web/other application roles. 32 package and 25 database/startup checks pass.
Actual startup selection and real PostgreSQL qualification remain unfinished.

[E12 coordinator submission](research/REUSE_E12_COORDINATOR_SUBMISSION.md) wires the
prepared port through owned admission/transaction/drain checks. Default actual-package
submission tests now use that lifecycle (20 pass); lifecycle/startup suites pass 28.
The private app factory exposes this server-side operation without mounting an HTTP
route. Production startup configuration and permission/schema composition remain open.

[E11 permission preflight](research/REUSE_E11_PG_BOSS_PERMISSION_PREFLIGHT.md) now
rejects missing/excess effective worker privileges before package startup. 43 unit
and 32 package checks pass. This closes the component permission-check gap, not the
real-PG/login/bootstrap or cutover acceptance gaps below.

Latest continuation: [E09 owned runtime](research/REUSE_E09_PG_BOSS_RUNTIME.md) connects
the pg-boss worker to bounded lifecycle/error handling and dedicated worker SQL-port
ownership. The canonical delivery tests now use this composition. 42 unit and 28
actual-package checks pass; production role/bootstrap/cutover evidence remains open.
Do not repeat the E05 lifecycle gap as entirely unimplemented or call it deployed.

[E10 worker-role evidence](research/REUSE_E10_PG_BOSS_WORKER_ROLE.md) adds an offline
candidate role script tested under the actual package on PGlite. Failure needs
DELETE/INSERT as well as read/update. 31 combined package checks pass; effective
production privileges, actual login/pools and native PostgreSQL remain unqualified.

1. [E04](research/REUSE_E04_HERMES_PRESENTATION.md) now identifies Desktop's active-session
   strip as the focused project-tab presentation candidate. Full sidebar/onboarding
   modules are not drop-ins: Electron/cache/credential callbacks need our actual
   application services. No E04 source copied. Keep close-view separate from cancel;
   prioritize protected dispatch and runnable host packaging before cosmetic screens.
2. Queue acceptance still needs this **actual adapter** through real-PG canonical approval
   transactions/role locks, then schedule/review/crash/restore cases and explicit cutover.
   E02 marker/concurrency evidence cannot stand in for those tests. Consolidate any new
   native runtime authority request; continue source/UI reuse work meanwhile.
3. Supported native Hermes/Codex interface integration and OS service packaging remain
   the routes to live agents; monitoring/backup tools are adopted as operations services
   only when deployment is authorized, not reimplemented as bespoke infrastructure.

The broader owner goal remains active and incomplete. No completion percentage or claim
that all reusable pieces have been integrated is made.
