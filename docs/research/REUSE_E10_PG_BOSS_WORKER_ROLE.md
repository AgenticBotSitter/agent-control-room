# E10 — actual pg-boss worker privilege evaluation

2026-09-06. Local continuation after `c6736fe`; no downloads or native database.
Uses retained E01 pg-boss 12.30.0 and repository in-memory PGlite.

## Finding and implementation

The actual package can fetch and complete a standard job with SELECT/UPDATE on its
operational job tables. Recording a failure also requires DELETE/INSERT: upstream
`dist/plans.js::failJobsBody` deletes the active row and reinserts its terminal or
retry state. This applies even with `retry_limit=0`. A read/update-only production
worker would fail when trying to record an uncertain delivery.

Added `db/roles/native_queue_worker_roles.sql`, an **offline candidate setup script**.
It is not executed by runtime or production startup. It requires the pre-provisioned
fixed standard/non-partitioned queue with retries, notifications and dead-letter off.
It creates a fresh NOLOGIN role with no superuser, database/role creation, replication
or RLS bypass. Its explicit grants are:

| Object | Worker privilege |
|---|---|
| `control_room_queue` schema | USAGE only |
| Queue/version metadata | SELECT only |
| Operational `job` / `job_common` tables | SELECT, INSERT, UPDATE, DELETE |
| Canonical application evidence | None granted |

PUBLIC permissions on existing objects in this dedicated queue schema are revoked.
The script does not provision the schema/queue, create a login, change application
roles, or configure credentials. It is for a separately rehearsed fresh setup, not an
automatic brownfield upgrade. Future-object/default privileges and the final LOGIN's
effective memberships still need production preflight and real-PG validation.

Operational table access is not execution authority: a trusted worker can alter queue
rows, but canonical saved approval, project/attempt, node and signed packet checks
remain mandatory before delivery. Do not place provider credentials in this role or
grant it the coordinator's canonical database permissions. One fixed job queue was
tested; adding other queue classes/partitions requires renewed permission analysis.

## Tests actually executed

Three new actual-package cases in `scripts/research/pg-boss-worker-integration.test.mjs`:

1. Read/update grants permit pickup/completion; failure recording is denied and the
   row stays active after rollback. Adding INSERT/DELETE permits recording failure,
   with zero retry. Queue policy editing and schema creation remain denied.
2. Apply the exact candidate SQL in a fresh fixture and run E09's owned runtime under
   that role. One synthetic callback completes/holds, another fails without retry;
   shutdown closes cleanly. Attempts to edit queue retry policy, create a table or
   read/write a synthetic canonical-evidence table are denied. Role flags are checked.
3. Retry-enabled queue causes the script to reject before creating its role; rollback
   leaves the existing queue unchanged.

Every worker SQL operation runs inside a PGlite transaction with SET LOCAL ROLE, so
the synthetic role does not leak to the fixture's admin/producer operations. This is
real package execution and SQL permission behavior on PGlite, not native PostgreSQL
connection/login/pool acceptance. No cross-process role or deployment claim.

Final combined command:

```sh
CR_REUSE_EVAL_ROOT=/private/tmp/control-room-reuse-eval.4GX1mK node --import tsx --test --test-reporter=spec scripts/research/pg-boss-worker-integration.test.mjs scripts/research/pg-boss-submission-integration.test.mjs
```

**31 pass, zero failures/skips**, about 25 seconds. This includes the prior canonical
approval/replay/delivery tests; do not add their count again. Targeted ESLint and
`git diff --check` pass. No TypeScript runtime source changed, and no full build or
new independent review was run. The expected missing-grant rejection is retained
as a passing negative test, not concealed as successful failure handling.

## What remains

Production role acceptance is still open: final effective-permission preflight,
producer-role integration, real PostgreSQL rehearsal with actual canonical adapter,
schema/package version pin, scheduler/supervisor roles, and update/cutover/restore.
The private web application must remain excluded from operational queue mutation.
Existing E02 native authorization is spent; this test uses no new server authority.

All in-memory fixtures/processes closed. No credentials or production state used;
dependencies, lockfile and retained downloads unchanged.
