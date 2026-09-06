# Reuse-first integration progress

Updated 2026-09-06. Parent: [completion plan](REUSE_FIRST_COMPLETION_PLAN.md).
Owner now explicitly approves continuing the plan until sensible reusable pieces are
integrated. Local implementation is authorized; GitHub publication remains paused.
Native database/server/provider/credential operations retain their scoped boundaries.
The completed E02 database authorization is not reusable standing authority.

## Completed locally in this block

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
