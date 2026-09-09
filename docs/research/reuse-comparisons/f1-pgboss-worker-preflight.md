# F1 pg-boss worker: source-only equivalent experiment preflight

2026-09-08. Inspected actual installed pg-boss12.30.0 `dist/index.{js,d.ts}`, types, manager, worker, db, contractor, attorney and construction plans; compared root's `f1-dbos-worker-fit.mjs`. No execution, installation/download, database, service, app or GitHub change. Exact installed pin is shared with prior F1 receipts. This is a proposed disposable experiment, not a worker result.

## What is and is not equivalent

Root's DBOS fixture uses actual `DBOS.recv` plus durable send/event/status/results, not a held in-memory Promise. A pg-boss work callback held on a synthetic Promise can demonstrate **capacity occupation only**: localConcurrency1 should leave B waiting while A is active;2 should let B proceed. It must not be labeled durable review waiting, checkpointed continuation or process recovery equivalent to DBOS.recv.

The honest second comparison is a **durable phase boundary**: A's first pg-boss job returns an explicit synthetic `{phase:'waiting_review'}` output and becomes completed at the queue-job level; B runs with capacity1; later an explicit synthetic release creates a separate continuation job referencing A's actual job ID. Read both stored outputs/state through public findJobs. That demonstrates persisted phase output, freed pickup capacity and an explicit later pickup—not an atomically recorded human approval, replay-safe continuation or completion of the entire logical A task. No custom scheduler/router or new application authority is needed for that research-only body. Keep both variants rather than presenting a held Promise as pg-boss's strongest architecture.

## Smallest preparation against the same isolated PostgreSQL

Reuse root's already-approved disposable PostgreSQL instance/Unix socket, never any configured real database. Assert exact owned socket path under its recorded pg-run root, empty child cwd, explicit port/user/database/password-empty and absence of ambient provider/profile inputs. Import pg-boss from the absolute reviewed package path while cwd remains empty; no config discovery is necessary for this package. Keep the sterile child environment and source/hash guard used by root's runner.

Prefer the public `db: IDatabase` option around a dedicated existing `pg.Pool` with explicit Unix socket `host`, port65433, pool max4, connection timeout3s and statement timeout5s, same test role as the DBOS fixture. `IDatabase` requires `executeSql(text,values)→{rows}`; `pool.query` supplies that actual database port. No fake SQL answers. The adapter owns pool shutdown, because pg-boss only automatically opens/closes its internal `_pgbdb` database. A custom pool is not passed as an undocumented `pool` option.

The built-in alternative is also possible: DatabaseOptions publicly exposes host/port/database/user/password/max and db.js constructs pg.Pool from config. A Unix socket host therefore uses actual node-postgres transport. The custom adapter makes statement-timeout/pool ownership explicit without relying on undeclared extra options; useListenNotify:false removes the need to implement its optional dedicated listener capability.

Use a new clearly owned schema, e.g. `comparison_pgboss_worker`, confirmed absent first. Public `getConstructionPlans(schema)` returns package DDL suitable for explicit setup through that disposable pool. Inspect/record the plan before executing; it creates package schema/types/tables/functions, not just rows. Then start the worker instance with **migrate:false, supervise:false, schedule:false, useListenNotify:false**. With migrate:false the contractor performs installed/schema-version checks; it does not initialize an empty schema. Do not claim that flag alone makes a fresh instance ready.

## Startup effects explicitly accounted

Defaults in attorney.js enable migrate, supervise and schedule. `index.js:121–145` can run installation/migration, manager timers, LISTEN, maintenance/navigation, cron timers, and background migration depending on options. Disable the four optional responsibilities above for this test. Even then start() queries server version, checks installed schema/version, fetches queues and starts manager queue-cache/work-in-progress intervals (`manager.js:477–486`). It is not an inert constructor/read-only execution.

Do not invoke schedule(), supervise(), background maintenance or native workers. `createQueue`, send, work and job completion perform intended writes confined to the disposable schema. The experiment is actual pickup against PostgreSQL, not provider work. Root retains schema/setup authority and decides if prepared plans can be applied.

## Public worker experiment

Use two separate synthetic queues, one for each capacity case. `work(name,{localConcurrency:1|2,batchSize:1,pollingIntervalSeconds:0.5}, handler)` is public. Minimum polling is500ms; the DBOS50ms polling parameter cannot be copied. Work handlers receive an **array** even at batchSize1; assert one and record its actual ID. Set retryLimit0 and a finite expireInSeconds sufficient for the bounded case. Observe errors explicitly; don't leave an unhandled error event.

For each hold case:

1. Send A, wait until its actual callback has started, then send independent B.
2. At capacity1, observe B not started for a bounded interval spanning multiple500ms polls, and confirm A active/B created via public findJobs. At2, require B callback/result within a bounded deadline.
3. Release A's synthetic Promise, await both public persisted completed states and exact outputs. Do not assert merely that in-memory callbacks returned: manager.js:402–443 waits for callback then calls actual complete().
4. Assert one execution per inserted job in this uninterrupted run, no hidden retry/errors. Do not call this exactly-once under crash.

After those two cases, add one capacity1 phase case described above. Preserve distinct initial-A versus continuation IDs and stored parent reference. This changes the semantic boundary deliberately and must be labeled, not mixed into the first comparison. Stored output/continuation is a useful primitive fit even without inventing a review approval table.

LocalConcurrency is per process, unlike the DBOS fixture's simultaneous global+worker limits. With only one process this is an honest1/2-capacity observation, not a demonstrated cross-node limit. Global group controls exist publicly but would add a separate coordination question; do not silently claim them tested here.

## Teardown and interpretation

Always release/abort fixture holds in finally, including assertion failures. Stop the instance even if start partially fails: current index.js deliberately makes partial initialization reachable by stop(). Use public stop({graceful:true,timeout:1000,close:false}) for the custom pool, then explicitly pool.end(). The stop timeout has a1000ms floor, applies to grace polling and is **not a hard total bound** over every subsystem shutdown/query. Keep outer process deadline, finite database query limits and recorded owned-process cleanup. Do not equate timeout rejection with proven socket cleanup. Root's PostgreSQL runner owns cluster cleanup.

This experiment can determine real worker pickup/capacity and durable phase output with existing pg-boss, complementing the actual DBOS.recv case. It cannot settle canonical review authorization, transactionally enqueueing an approved continuation, restart recovery, stale approval, cross-node capacity or target native effects. Those are named remaining integration responsibilities, not proof that pg-boss needs an invented durable workflow engine. No file/service has been changed or started by this preflight.
