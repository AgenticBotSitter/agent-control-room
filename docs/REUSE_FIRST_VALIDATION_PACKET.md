# Reuse-first validation: source findings and proposed test packet

Date: 2026-09-06. Local application baseline: `7dc025d8b65324c5a3e3be651bb5b279fed00d87` plus assessment documents.
Parent: [replacement/completion plan](REUSE_FIRST_COMPLETION_PLAN.md).

## Source-stage baseline evidence, not acceptance

- Stock-Node stage-zero command passed with `ready_for_runtime_check`; local Node is 22.22.3. No setup was performed.
- Local package resolution: `pg-boss`, `@dbos-inc/dbos-sdk`, and `@hatchet-dev/typescript-sdk` are absent. Existing PGlite is 0.3.14; PostgreSQL client library is 3.4.7. These are not a running PostgreSQL server.
- `psql`, `postgres`, `initdb`, and `docker` were absent from PATH. A bounded executable-name search in standard Homebrew/application installation locations found no matching server tools. This does not assert that every possible location/remote host has been searched.
- `node --import tsx --test tests/native-task-queue.test.ts`: exit 0, 10 passed, 0 failed/skipped. Existing disposable tests cover atomic approval/queue/audit, rollback, lost commit acknowledgement, immutability and access restrictions. They did not execute a candidate package or a real PostgreSQL server.
- No provider calls, credential-store operations, listeners, installs, deployments or remote writes occurred.

**Later authorized evaluation:** The owner then explicitly approved needed downloads,
storage checks and a cleanup log. E01 acquired pg-boss 12.30.0 in an isolated directory
without changing application dependencies. [Actual-package results](research/REUSE_E01_PG_BOSS_RESULTS.md):
11 PGlite tests passed, and the existing baseline rerun passed 10. The download and first
transaction attempts encountered failures, retained in that report and the
[download ledger](REUSE_DOWNLOAD_LOG.md). Real PostgreSQL has not run; no engine is adopted.

**Subsequent E02:** The owner separately approved one disposable PostgreSQL cluster.
[E02 results](research/REUSE_E02_POSTGRES_RESULTS.md) now establish real concurrency,
transaction-marker atomicity, clean server restart, exact restricted-role correction,
57 existing migration scripts and actual capacity-reservation contention. Nine checks
passed across three commands; the first command's role failure remains recorded. Server
shutdown and exact data removal are verified. This supersedes the not-run/permission-pending
statements in the historical packet below for that single completed evaluation, not for
future server starts or deployment. Full canonical approval/queue integration remains open.

## Queue candidate selection is narrowed, not finalized

First evaluate pg-boss's queue/timer integration. DBOS is the comparative alternative for durable multi-step recovery; Hatchet remains a platform alternative if both library approaches fail a named requirement. Do not install all three reflexively.

[pg-boss release 12.30.0](https://github.com/timgit/pg-boss/releases/tag/12.30.0) reports schema version 40. Its tagged [database interface](https://github.com/timgit/pg-boss/blob/12.30.0/src/types.ts) accepts an `executeSql` adapter, with optional listener support and explicit migration/schema controls. This is a plausible seam for our transaction client, not proof of atomic integration. Release source/package integrity and exact transitive dependencies must still be recorded at acquisition. The current upstream development PGlite version is newer than ours; do not upgrade the application's lockfile merely to make a comparison pass.

[DBOS release v4.27](https://github.com/dbos-inc/dbos-transact-ts/releases/tag/v4.27) is the source comparison target. Its main package version is a build placeholder, not a usable install pin; resolve the actual published package/version/integrity before any approved installation. No Conductor purchase or service is part of the evaluation.

Avoid adopting a queue dashboard as a shortcut to the private product UI: pg-boss's separate dashboard release notes include a recent database-connection-string exposure fix. Core queue library selection does not clear every sibling package. [Dashboard release evidence](https://github.com/timgit/pg-boss/releases/tag/dashboard-1.7.0).

### Integration/retirement boundary

`src/persistence/database.ts` exposes caller-owned `DatabaseSession.query` transactions and a pre-commit check. The candidate adapter must use that exact session for an atomic enqueue, not open a second pool/transaction. `TaskAssignmentCoordinator.enqueueNativeTask` in `src/web/v1/task-assignment-coordinator.ts` calls `NativeApprovalPacketStore.enqueueInSession`, then appends audit evidence within the existing checked transaction.

`src/web/v1/native-task-queue.ts` currently records immutable authenticated delivery intent, not a mutable worker queue. Do not delete that history merely because a queue package exists. Candidate operational queue state may replace generic pickup/retry/schedule delivery, while the canonical record still answers what was authorized and queued. Prove consistent transaction/cutover semantics before deciding whether any evidence representation should change.

Retirement targets after successful selection: duplicated generic polling, backoff, scheduled occurrence delivery and failed-item operations for the selected job class. Keep project authorization, current approvals, assignment constraints, result/review lineage and uncertain-start reconciliation. Do not replace only timer callbacks and then claim the broader custom workflow recovery has been retired; record separately whether DBOS's broader replacement is worth its migration cost.

Concrete downstream targets from the independent local review:

- `src/persistence/delivery-store.ts`: `claimOutbox`, `markOutboxFailed`, `recoverStaleOutbox` supply generic mechanics; no production claim/recovery consumer was found. Reuse can avoid building a daemon, not merely replace one.
- `src/services/v1/recurrence.ts` and `occurrence-store.ts`: the calculator is pure; materialization/acknowledgement depends on `control_outbox` delivered state. A candidate cron timer must preserve or explicitly migrate that relationship and DST/occurrence identity.
- `src/web/v1/task-coordinator-lifecycle.ts`: existing quality sweep/reconcile is a representative non-native worker target.
- `src/persistence/canonical-store.ts` and `src/scheduler/v1/reservation-store.ts`: canonical attempt/lease/capacity relationships remain separate from generic engine slots.
- Migrations 0003, 0014, 0016 and 0046-0052 plus bounded database/preflight code need integration review. Current coordinator role restricts outbox topic writes; package tables or background workers cannot simply inherit broad privileges.

The first candidate test should extend the existing canonical approval fixture's transaction boundary: successful commit, forced rollback/precommit abort, and lost-acknowledgement replay. Do not invoke native dispatch to prove queue atomicity. Broader crash/concurrency/roles require real PG and remain separate evidence.

## Codex interface decision for the next adapter

Use App Server over local stdio as the leading interactive adapter interface; assess the TypeScript SDK for simpler noninteractive jobs. Keep the existing adapter's evidence but don't stretch its exact macOS-only pin into fleet support.

Official documentation distinguishes SDK automation from App Server custom-client integration. App Server supports thread/turn operations, streamed notifications and targeted interruption. Its network WebSocket transport is explicitly experimental/unsupported; a public Codex listener is not selected. Local stdio avoids introducing that network surface. Generated schemas must match the selected executable version. Sources: [App Server](https://learn.chatgpt.com/docs/app-server), [SDK](https://learn.chatgpt.com/docs/codex-sdk).

Local `src/harness/codex-v1/manifest.ts` pins 0.150.0-alpha.8, macOS only, with approval mode unsupported. A refreshed adapter must qualify exact executable/profile policy and map native approvals and identities into existing application services. It must not share Hermes authentication or treat conversational resume as replay of an uncertain side effect. No Codex process was started for this assessment.

## Service packaging: concrete reuse and missing work

The local packaging review found no `node-service.js` artifact although all service templates reference it. Root package scripts build the web app, not an installable node connector. Existing supplied-resource runtime/connector factories can be retained, but config/state loading, executable entrypoint, safe process lifecycle and immutable release packaging remain missing. Static substring checks are not evidence of an installed service.

- macOS: reuse launchd LaunchAgent; the existing plist has an Aqua context but no `RunAtLoad`/`KeepAlive`. Its throttle setting alone does not establish restart behavior. Owner-context credential behavior still needs attended proof.
- Linux: reuse systemd where actually available; the existing non-root hardened unit is a useful starting point, not an installed artifact. Detect unsupported non-systemd hosts rather than silently selecting another service model.
- Windows: existing wrapper-shaped XML names no selected wrapper. Compare a pinned maintained wrapper such as WinSW against a user-logon Task Scheduler route; source/license, profile loading and owned-process-tree termination must decide. Do not write a new Windows supervisor by default.

Exact local review targets: `packages/control-room-node-service/`, `src/node-service-packaging/v1/conformance.ts`, `src/node-service-packaging/v1/diagnostics.ts`, `src/node-bridge/native-connector.ts`, `src/harness/hermes-native-v1/node-runtime.ts`. Future acceptance must parse rendered platform configs, launch the real artifact in inert readiness, and separately prove start/stop/restart/update/rollback with preserved journals. Platform templates and package display flags are not proof of any of those behaviors.

## Proposed bounded package-evaluation authority

Status: **isolated package acquisition and initial PGlite evaluation authorized and executed**
on 2026-09-06. The following packet describes the scope used. Real PostgreSQL initialization/
startup remains separately gated; broad downloads do not authorize services or native agents.

Request one isolated evaluation area created with `mktemp -d`, no application dependency or lockfile changes. Allow retrieval of the selected published pg-boss package, its exact resolved dependencies, source/license metadata and integrity records. Disable package lifecycle scripts. Use the already-installed PGlite only through an explicitly documented test import; do not copy or relink the application's dependency tree. If its version is incompatible, report that result rather than silently upgrading it. Retain a small sanitized report/lockfile in the repository, not runtime state.

Initial actual-package cases: schema initialization in a new in-memory database; canonical row + queue submission commit/rollback; safe job pickup/completion; duplicate operation identity; stop/close resources. Include failing/ambiguous cases, not only success. This first leg may eliminate an incompatible candidate but cannot accept production locking, cross-process recovery or role behavior.

Real PostgreSQL is the second required leg. Its installation/startup method must be selected and explicitly authorized: disposable local-only cluster, throwaway data, bounded lifetime, no production credentials, no standing/autostart service, no VPS changes. Do not install Docker or a global PostgreSQL service as an implicit prerequisite. Evaluate DBOS against that same fixture only after its package pin is resolved and acquisition is within approved scope.

The complete comparison uses the parent's common finalist test card. Capture expected/observed results for concurrency, unknown starts, retry, review waits, recurrence, drain and restore. Never mark a skipped real-PG leg passed. If package acquisition, lifecycle scripts, a native toolchain, a listener or expanded host access exceeds the approved packet, stop that leg and report the needed scope.

Cleanup: close only evaluation-owned clients/processes, verify those handles terminated, then remove only the exact recorded temporary directory after validating ownership. Do not delete package-manager shared caches or existing databases. Keep sanitized test evidence; no tokens, connection strings or real task content in the report.

## Blocking dependency and safe continuation

Package acquisition permission is resolved; actual candidate execution is now evidenced by E01.
The subsequent one-cluster E02 authority was used and cleanup completed. Remaining source
integration/cutover design can proceed locally; later real-PG runs require their own bounded
authority. Neither E01 nor E02 establishes all crash, canonical approval, scheduler, review,
upgrade and restore cases in the complete finalist test card.

Independent docs-only review found no blocking corrections in this packet, the parent plan and status pointers. Review covered R01-R16, source-versus-runtime evidence, queue/role cutover, packaging gaps and ungranted setup boundaries. It did not accept an engine, migration, license clearance for a downloaded artifact or any live deployment. Local whitespace/heading/requirement-row checks also passed.
