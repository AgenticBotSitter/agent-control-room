# pg-boss actual worker and separate review phase

2026-09-08. Installed pg-boss12.30.0, actual PostgreSQL18.4 in a new owned
Unix-socket-only cluster. First attempt exited0, with seven synthetic callback
executions and persisted outputs. No setup or test repair. Exact terminal result
is retained in `f1-pgboss-worker-evidence.json`.

## What changed our comparison

| Actual case | Observation |
| --- | --- |
| One worker, A holds callback | B stayed created during1.5s; both completed after A release |
| Two workers, A holds callback | B completed before A release; both persisted outputs matched |
| One worker, A returns waiting_review phase | That queue job completed with stored waiting_review output; B completed next; a separate continuation then completed with A's actual job ID as parent |

The hold uses an in-memory Promise, **not DBOS.recv or durable waiting**. Both engines
occupy callback/workflow capacity when the running body waits, within the bounded
single-process observations. DBOS additionally supplies actual persisted receive/send;
the pg-boss hold does not establish an equivalent feature.

The phase case is an intentionally different integration shape: complete a bounded
queue job while the logical task is waiting for review. It positively demonstrates
that the existing queue can persist phase output and free its only worker, then
run a separately submitted continuation. It does not implement canonical approval,
transactional continuation, duplicate continuation refusal or crash recovery.
`completed` here is a queue-job state, not permission to mark the logical task done.

## Provisional integration direction

Prefer testing the existing canonical review-phase/outbox integration before
replacing pg-boss merely for the promise of continuous pickup. This result removes
the assumption that uninterrupted use requires adding DBOS. DBOS remains a viable
alternative for a specifically needed durable workflow/receive/replay responsibility.
No final engine choice is declared until canonical admission, uncertainty/recovery
and remaining occurrence cases/costs discriminate the contenders.

The engine options must be compared at equivalent application semantics. DBOS's
global+worker concurrency1/2 and pg-boss's localConcurrency1/2 were exercised in one
process only; this is not cross-node capacity evidence. DBOS could also use shorter
phases. Neither experiment demonstrates exactly-once external effects.

## Setup and cleanup

Root read the preflight and actual public constructor/start/stop/db/worker/source
interfaces and construction-plan composition. The actual package's public
getConstructionPlans produced fresh-schema DDL; no hand-written queue migration.
The plan SHA256 is retained in the receipt. An absent schema was asserted first.
The test rejects database/role/extension creation and ALTER SYSTEM; that lexical
check is an additional guard, not a general SQL-security proof.

The explicit four-connection pool used only the owned socket with connection and
statement timeouts. `db.executeSql` delegated actual SQL to pool.query, not canned
responses. After schema setup, migrate/supervise/schedule/useListenNotify were false.
Manager timers and actual queue read/write/completion operations still ran. Each
job had retryLimit0 and20s expiration; observations had5s limits. No app entrypoint,
provider, real approval, native agent or existing database was used.

The runner supplied sterile environment/empty cwd and a60s subprocess deadline.
Finally released holds, stopped the actual queue and closed the pool; the parent
stopped the owned PostgreSQL cluster, verified pid/socket absence and removed its
exact child. Root separately found no remaining pg-run children. Candidate package
cohorts remain for later comparisons; nothing was pushed or deployed.

Independent review in `f1-pgboss-worker-review.md` finds no blocker to the narrow
successful evidence; root accepts it. The5s observation loop is not a hard total
bound when an awaited query itself takes time. For future failure-path experiments,
pool close should have its own finally if queue stop throws. Neither is a failure
observed in this run, and no fresh full-package integrity audit is claimed.
Preserve this evidence rather than rerunning the
same callback cases for more counts. Next work is the actual existing application
boundary, not building an entire production review engine as a prerequisite to
choosing its queue.
