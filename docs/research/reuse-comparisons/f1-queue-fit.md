# F1 first comparison checkpoint — not a queue selection decision

2026-09-08. Existing pg-boss 12.30.0 baseline remains installed. This experiment
does not replace it, run workers or qualify an external effect. F1 remains open.

## DBOS actual source and package

Source discovery pin d8c4974cca6cc84b296f3b8edfbbb41627ddd47e contains
`src/client.ts::enqueueInTransaction` and portable counterpart: it passes caller
ClientBase into `systemDatabase.initWorkflowStatus`, returning a workflow handle.
`duplicationPolicy:return-existing` is explicitly refused in this transaction path.
Upstream `tests/client.test.ts` includes commit, rollback, same-ID replay and
deduplication checks. Those tests were inspected, not executed wholesale here.

Registry package 4.27.6 has different gitHead ef3534036901fa4f54d5eb6c4596e34fcf7d939f.
The actual installed `dist/src/client.js` also contains the caller-transaction method;
`system_database.js::ensureSystemDatabase` and actual migration runner were inspected.
Do not infer every main feature exists in the release. Root MIT license inspected;
resolved lock is saved, full transitive notices/security audit remains incomplete.

The actual application integration seam is
`src/persistence/database.ts::{DatabaseSession,transactionWithPreCommitCheck}` and
`src/persistence/pg-boss-native-task-submission.ts`. DBOS's query-client structural
bridge may preserve our caller-owned transaction without replacing the SQL driver.
This is a viable contender, not rejected on the old assumption of a mandatory
separate transaction. Its workflow storage/runtime must still be compared against
our existing canonical identities, queue ownership, native uncertainty and reviews.

## Actual prototype attempts

`research/reuse-comparisons/f1-dbos-fit.mjs` executes the pinned installed candidate,
not rewritten SQL. It proposes schema migration, marker+enqueue commit, canonical
precommit rollback, same-ID changed-input replay and unsupported policy refusal
through the existing database adapter. No candidate worker or agent starts.

1. Default PGlite attempt failed immediately: uuid-ossp extension not registered.
   No tests passed. Fixture setup was corrected by enabling the already installed
   PGlite contrib extension, not modifying DBOS or faking its UUID function.
2. With the actual extension, migration failed `XX000: tuple concurrently updated`.
   Again zero acceptance scenarios passed. No bypass/SQL patch applied. Both owned
   in-memory databases closed in finally; failure output was subsequently bounded.
3. A native PostgreSQL18.4 disposable runner was prepared. Its initdb failed on a
   missing packaged ICU symlink before any server started. Exact child fixture was
   removed. The package was installed with lifecycle scripts disabled as required.
   Complete hydration script and 17 package-local link pairs were read; separate
   authorization requested for that specific setup script. No script ran yet.

The loader/fixture failures are NOT evidence that DBOS cannot fit PostgreSQL.
Real PostgreSQL remains the next decisive experiment. PG18.4 is local comparison
tooling, not proof of the production PG17 configuration. Avoid repeated unchanged
PGlite attempts. No migration/transaction case is currently counted as passed.

## Hatchet narrow source inspection

Pin 4be0bdc7b96c33579f134d859960d4345035cd40. Actual TypeScript
`sdks/typescript/src/clients/admin/admin-client.ts::runWorkflow` serializes input,
applies namespace, maps worker labels and calls the gRPC `triggerWorkflow` method;
it returns a WorkflowRunRef. The inspected method does not accept a caller SQL
transaction. This creates a concrete integration question: whether another public
interface or an explicit outbox bridge can preserve our transactional admission.
It is not evidence that no such interface exists anywhere in Hatchet.

Matching admin-client tests use mocked channel/factory and synthetic config.
Root MIT license inspected. SDK manifest acquired; no package installed or actual
Hatchet service/client test run. Full source archive exceeded its bound on media;
targeted implementation files replace the failed acquisition. No candidate rejection
or E2 claim follows from archive size or gRPC architecture alone.

## Remaining discriminating work

- Run actual DBOS release with fresh PG and our transaction adapter; compare same
  cases with pg-boss (reuse existing equivalent evidence where valid).
- Inspect Hatchet current v1 enqueue/transaction/outbox and engine insertion paths,
  then exercise the strongest viable seam, not only its legacy admin facade.
- Extend contenders to concurrency, review waits, task eligibility, uncertain starts,
  recurring/DST work, drain/restart and narrow SQL/runtime permissions.
- Measure candidate-specific memory/latency under equivalent workloads, migration
  and code-removal cost. No score/winner before decisive fit evidence.

Production code changed/deleted: zero. Package/dependency changes are isolated to
the logged temporary root; application lockfile unchanged. Acquisition, failure and
cleanup details: [F1 ledger](f1-acquisitions.md).
