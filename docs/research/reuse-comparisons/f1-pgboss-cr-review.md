# Independent review: pg-boss through actual CR adapters

2026-09-08. Read-only review of root's CR-worker/binding fixtures, updated PostgreSQL runner, fit report and success/failure receipts; checked actual bounded-database and native submission/worker contracts. No execution, installation/download, service or application change. Root retains driver/engine/security selection.

## Disposition

**No blocker to the four successful node-postgres variant observations at their stated scope.** Real CR transaction/submission/worker code crosses real PostgreSQL with synthetic delivery. The report appropriately does not call that canonical approval/hold persistence, native capacity release, production PG17 acceptance or a ready-made replacement driver. Generic Postgres.js failure is real evidence at its tested seam; private-driver settings and cold-reserve diagnosis remain separate source concerns.

## Actual success evidence checked

- The node-pg branch composes real Pool.connect/Client.query/release beneath actual `boundPrivateDatabase`; it does not replace the CR transaction/precommit wrapper with a look-alike transaction. Marker INSERT and enqueueInSession use the same acquired transaction lease. The intentional precommit error is required, and post-rollback queries observe neither marker nor queue job. This proves that bounded synthetic rollback case, not every lost-COMMIT outcome.
- Actual preparePgBossNativeTaskSubmission and startPgBossNativeTaskWorker are imported and used. The queue schema/profile is package-created and explicitly standard/nonpartitioned/retryLimit0/notifyfalse. Two references with canonical-format derived operational IDs commit and reach the actual worker wrapper; stored outputs exactly equal held/delivered fixture values. The delivery function itself is a synthetic callback and does not satisfy the production port's obligation to revalidate canonical authority/record hold. This is disclosed rather than used to bypass an application check.
- Re-enqueueing a fresh intent with the occupied operational ID rejects, and final observed callback list remains the two valid references. It is not duplicate canonical request replay acceptance or an exactly-once guarantee after recovery.
- Extra prompt field is rejected before the synthetic delivery callback. Source allows cancelled/failed as terminal negative states; actual receipt specifically records cancelled. Error array is actually empty in this run. The source filter permitting `native_task_delivery_unresolved` is broader than asserting zero errors, but current zero-error statement is backed by retained output, not inferred from that filter alone.
- Four outcome records and the two exact callback IDs are retained with exit0. The separately maintained node-postgres8.23.0 pin relies on previously acquired package provenance, not a fresh version/hash assertion inside this fixture. No new complete dependency audit is claimed.

## Failure fidelity and diagnosis

The initial import typo and zero-outcome safe submission failure are separately retained. The logging-only subclass calls super.send unchanged; its query wrapper forwards the same SQL/params and rethrows. Diagnostic evidence contains SQL22023 from json_to_recordset on a scalar after two metadata queries, not successful precommit rollback. This supports the source analysis of inferred JSON parameter serialization; no actual production-driver conclusion follows merely from generic createPostgresClient failing.

Both JSON/options receipts contain no emitted outcomes. The current binding fixture accumulates observations in memory and prints only after every branch, so empty output does not identify whether the first binding, shutdown or later reserve stalled, nor does it prove earlier branches did not execute. The fit report properly says **inconclusive** and does not promote those combinations to failures/passes. One precision limit: retained terminal records have code:null and do not retain execFile's killed/signal/timed-out metadata or elapsed60s. The runner enforces a60s timeout and root reports deadline termination, but this reviewer cannot independently recover exact timeout cause/duration from those normalized receipts alone. No unchanged rerun is requested for that evidence limitation.

Cold-reserve source inference remains appropriately distinct. The diagnostic correction separating binding/reserve and adding a reserve race does not establish which reserve configuration succeeded or failed because no intermediate result reached the receipt. prepare:false/fetch_types:false or warming are not accepted remedies here.

## Isolation, bounds and cleanup

Runner restricts paths to the known owned cohort, creates a fresh pg-run child and empty cwd, supplies a sterile child environment, disables TCP and confirms listen_addresses through actual pg. CR-worker fixture sets only explicit synthetic PG variables within that child for generic driver construction; no real profile/credential discovery is used. The node-pg branch uses explicit socket options regardless of those variables. Real schema SQL and the marker are limited to the fresh cluster; this is not a current full application schema/role test.

Three connections in each of two pools are within the cluster max12. Existing boundPrivateDatabase statement/transaction/close gates execute, but successful execution does not qualify nativePool.end as forced cancellation of active/queued leases. The report explicitly preserves that production blocker. Six-second polling is a loop bound, not an exact total bound on awaited SQL plus delay. Outer child limit and cluster teardown provide additional fixture containment, not proof of every production driver deadline.

Finally blocks release worker/submission/boss then close pools; if db.close rejects, the following pool.end is skipped, so future teardown-failure tests should use nested independent cleanup. All retained attempts show parent cluster stop/owned-child cleanup; this source-only review did not independently inspect live processes. Normal successful cleanup is sufficient for this narrow receipt, not forced-termination/recovery qualification.

## Fair action/removal boundary

The result supports testing a maintained pg driver at the existing application contract before replacing the queue engine for a binding problem. Supported Postgres.js typed binding remains a concrete unexecuted alternative. No ad hoc serializer, ORM installation or library fork is required by these results. Driver adoption still owes JSON/scalar/text/UUID/array/null equivalence, exact production session/config/role checks, active lease termination and uncertainty/recovery behavior. Retain IDs/profile checks/same-session precommit coupling/canonical authority; these four cases do not delete that infrastructure or settle the final engine choice.
