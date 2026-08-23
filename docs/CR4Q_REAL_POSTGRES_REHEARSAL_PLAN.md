# CR-4Q real PostgreSQL rehearsal plan

Run this plan on a disposable PostgreSQL deployment before any live node or project integration. Use synthetic tenants and credentials only.

## Environment

1. Create a fresh supported PostgreSQL instance with at least four independent client connections.
2. Apply migrations 0001–0007 as the migration owner.
3. Apply `db/roles/production_roles.sql`, then create separate temporary login roles inheriting migrator, application, reader, and backup groups.
4. Load only the repository’s synthetic fixture tenants.
5. Capture server version, isolation defaults, migration hashes, and test commit.

## Required drills

| Area | Drill | Required result |
|---|---|---|
| Roles | Attempt schema DDL as application; mutation as reader/backup; update/delete/truncate of audit, transitions, decisions, consumptions, and anchors | Every forbidden operation fails; application can perform only its reviewed DML |
| Tenant scope | Attempt cross-tenant projection, audit, command, worker, allocation, and canonical lineage writes | Composite foreign keys reject every write |
| Claims | Race at least four sessions for one ready job and one outbox batch | One active lease; monotonic epoch/attempt; disjoint outbox rows |
| Approval | Race approval revocation against effect authorization | Exactly one serial outcome; revoked/expired approval never consumes or authorizes |
| Audit | Concurrent first append to one tenant/month, sustained append, verification, and anchor | Contiguous sequence, correct head, no lost event, verified anchor |
| Inbox/idempotency | Race duplicate receive/process and duplicate idempotent operations | Handler/effect executes once per destination contract; replay returns durable result |
| Kill points | Terminate application before/after transition, outbox insert, handler work, processed marker, effect consumption, and audit-head update | Transaction rolls back or commits atomically; restart converges without duplicate consequential effect |
| Migration | Apply 0007 to a populated synthetic CR-4D snapshot, then restore the pre-migration backup | Migration succeeds without cross-tenant residue; restore returns the exact prior state |
| Backup | Base backup plus WAL/PITR restore to a second disposable instance | Restored invariants, chain verification, and synthetic reconciliation all pass |

Record commands, server logs, row counts, hashes, and pass/fail evidence in a dated rehearsal report. A failed row remains a release blocker; do not weaken a constraint to make the rehearsal pass without a reviewed finding and decision update.
