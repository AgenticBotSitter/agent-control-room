# Work-batch intake migration

Migration `0093_work_batch_intake.sql` adds only the proposal head and its
append-only revisions. It creates no task, assignment, delivery, queue, effect,
approval, runner, or execution record. The later owner-approval slice owns item
materialisation and the canonical job binding.

The machine boundary is a separate loopback-only service, not a browser route.
It binds `127.0.0.1`, accepts one fixed-length bearer secret from the protected
installation store, and exposes only these encoded project routes:

- `POST /v1/projects/{projectId}/work-batches`
- `GET /v1/projects/{projectId}/work-batches/{batchId}`
- `GET /v1/projects/{projectId}/work-batches`

The service authenticates the credential and project before reading a POST
body, applies the bounded-body limit, and supplies its own clock. Credentials
and timestamps are never accepted in a path, query, body, or CLI argument. The
`work:intake` source command reads exact JSON from standard input and reads its
origin and bearer from `config/work-intake.json` in the fixed protected root.
That single owner-only record also contains the server port, integrity key,
agent principal, queue-depth bound and the dedicated database login. The
existing Mac-local host loads and validates the record before opening a
connection, prepares the intake child inertly, then explicitly starts and
closes both listeners in one process lifecycle. No second daemon is installed.

Database privileges remain on the `control_room_work_intake` NOLOGIN group.
The running service uses the `control_room_work_intake_agent` LOGIN principal,
which inherits that group; the backup group retains read-only history access.
The insert trigger independently locks and checks an active agent identity and
one exact proposal-only, low-risk project grant. The protected service still
owns the bearer-to-identity binding: the shared database login enforces the
proposal semantics but cannot distinguish one bearer identity from another.
Per-agent database logins would be a separate authority design and are not part
of this slice.

The migration is forward-only in normal operation. If an operator prepares a
database recovery that removes this source-only slice, the reviewed recovery
SQL must lock both new tables and refuse while any batch exists. The executable,
tested form is `db/down/0093_work_batch_intake.sql`; it also removes the four
triggers and two slice-owned functions when both tables are empty:

```sql
BEGIN;
LOCK TABLE work_batches, work_batch_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batches) THEN
    RAISE EXCEPTION 'work batch intake down migration refused: batches exist';
  END IF;
END $$;
-- See db/down/0093_work_batch_intake.sql for the complete dependency order.
COMMIT;
```

This is a refusal contract, not a steady-state rollback command. Production
recovery remains subject to the existing reviewed upgrade and restore tools.
