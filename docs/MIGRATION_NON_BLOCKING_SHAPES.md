# Supported migration shapes: non-blocking indexes and NOT NULL on big tables

**Status:** design decision, documented 2026-10-01 on `cook/dbfix`. No applier
behaviour changed. See "Why nothing is implemented yet" at the end.

## The two shapes, and why they are a problem today

`deploy/postgres/apply-migrations.mjs:150` wraps every migration in one
transaction, together with the ledger row that records it. That is the right
default and it is not going to change: a migration either lands completely or not
at all, and the ledger never records a file whose SQL did not commit.

It has two consequences for schema changes that grow with table size.

### CREATE INDEX CONCURRENTLY is impossible

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so the applier
refuses it with PostgreSQL's own message:

```
migration_failed:db/migrations/0240_....sql:
  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

A plain `CREATE INDEX` applies, but takes a write lock for the whole build. That
lock grows with the table, and the production sessions set `lock_timeout: 2000`
(`src/web/v1/private-pg-options.ts:37`), so a large enough table turns a slow
migration into a refused one for every concurrent writer.

### Adding a NOT NULL column with real values locks writers proportionally

The only way to add a NOT NULL column whose value is computed is a full-table
UPDATE inside the migration. Measured on `control_jobs` with 30 concurrent
coordinator-login writers, each on the production 5 s statement / 2 s lock
timeouts:

| rows | apply time | writer blocked > 200 ms | worst single write |
|---|---|---|---|
| 4 000 | 1 382 ms | 1 104 ms | 1 104 ms |
| 40 000 | 2 600 ms | not measured at this size | - |

At 40 000 rows the apply alone exceeds the 2 s lock timeout, so a concurrent
writer is **refused**, not merely slowed. This is a latent upgrade failure on a
table size a real install reaches.

## The supported pattern

### Indexes: build them concurrently, outside the transaction

Use `CREATE INDEX CONCURRENTLY`, which means the file must not run inside the
applier's transaction. Until that is supported, the supported pattern is to ship
the index as its own migration applied through the operator's session, not
through `applyMigrations`:

```sql
-- db/migrations/0120_....sql   (the ledger-tracked half)
-- Records the intent, and is safe to re-run.
CREATE INDEX IF NOT EXISTS idx_...._safe ON ... ;
```

with the concurrent build run separately and verified before the ledger row is
trusted. **This is a documented pattern, not an endorsed workflow.** The reason is
in the next section.

### NOT NULL columns: three separate migrations, never one

```sql
-- Migration 1: add it nullable. Cheap, brief lock, no rewrite.
ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;

-- Migration 2: backfill in bounded batches, in SEPARATE commits.
-- The batch size is a migration parameter; each batch is short enough that a
-- writer never waits more than the 2 s lock timeout.

-- Migration 3: attach the constraint without scanning, then validate it.
ALTER TABLE t ADD CONSTRAINT t_c_nn CHECK (c IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT t_c_nn;   -- takes SHARE UPDATE EXCLUSIVE, not
                                             -- ACCESS EXCLUSIVE: writers continue.
ALTER TABLE t ALTER COLUMN c SET NOT NULL;
-- Then DROP CONSTRAINT t_c_nn: PostgreSQL knows the column is NOT NULL now, and
-- the temporary CHECK would otherwise be a second copy of the same rule.
```

This is the standard PostgreSQL pattern and every step is available on the pinned
PG 17 target. It is also more work than one statement, which is why it needs to
be written down rather than rediscovered under time pressure during an incident.

## Why nothing is implemented yet

Both shapes need the same applier change: a per-migration opt-out from the
transaction, with the ledger row recorded separately because a crash between
statements can no longer be rolled back. That opt-out has costs that are worth
naming before it is built:

- **A non-transactional migration can half-apply.** Every existing file is
  all-or-nothing, and code across this repository assumes that. A file using the
  opt-out must therefore be idempotent (`IF NOT EXISTS`, `IF EXISTS` on every
  drop) so that a re-run converges.
- **It must be refused where a half-applied migration is unrecoverable**, which
  includes the Mac/VPS upgrade path: the upgrade step exists to be
  stop-apply-verify, and a crash between statements there leaves the operator
  with a database whose ledger says nothing was applied and whose schema says
  something was.
- **It changes the failure semantics of a whole class of operations**, and this
  is the applier every install and every upgrade goes through.

That is a design decision with a blast radius wider than the two shapes above, so
this note records the pattern and the cost, and leaves the opt-out for a decision
rather than smuggling it in beside two bug fixes.

## What is checked today

Nothing enforces this. A migration written in the slow shape applies, and the
only signal is the writer blocked during the apply. That is recorded here as a
known gap rather than as a defect: the alternative (a lint rule over migration
SQL) is itself approximate, and a false positive on a migration file stops a
release.

## How to reproduce the measurements

Both tables above come from real PostgreSQL 17 through the repo's own applier, at
4 000 and 40 000 rows on `control_jobs`, with 30 concurrent writers on the
coordinator login using the production timeouts. Re-running them requires a
disposable cluster on a port outside the other lanes'; see
`tests/support/attack-kit/real-postgres.ts` for the harness the other migration
tests use.
