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

The database separates tenants for the intake login. Migration 0093 adds
`work_intake_tenant_binding`, a one-row table owned by the schema owner. The
owner bootstrap (`bootstrapMacLocalOwnerV1` on the Mac, `first-owner-vps.mjs` on
the VPS) writes it when it registers the intake agents, and refuses to run if
the row already names a different tenant. The intake group and the roles that
read the shared ledgers may only SELECT it. Only the schema owner and the
owner bootstrap can write it.

Every intake scope policy is RESTRICTIVE and keyed on `is_work_intake_session()`.
For an intake session it additionally requires the row's `tenant_id` to equal
the bound tenant. This covers `work_batches`, `work_batch_revisions`,
`control_idempotency` and `audit_events`. As a result the intake login:

- sees and may insert only its bound tenant's proposals, revisions, intake
  idempotency receipts and intake audit events;
- within that tenant, sees and may insert proposals only from agents the owner
  registered for work intake (`auth_provider = 'work-intake'`);
- sees and writes nothing at all while no binding row exists (fail closed).

The intake group still has no UPDATE or DELETE on either proposal table. Every
other role keeps its existing row access: the backup group still reads all
rows, and the application, reader, owner-web and coordinator groups still have
no access to the proposal tables. Because PostgreSQL permission-checks a policy's
subquery for every role that reads the table, each role that evaluates these
policies also holds read-only SELECT on the one-row binding.

What the database does not separate, and why:

- **Identities within the bound tenant.** All registered agents share one
  database login, so the database cannot tell registered agent X from
  registered agent Y in the same tenant. That separation stays with the
  service's bearer-to-identity binding and its tenant- and identity-scoped
  queries. Per-agent database logins would be a separate authority design.
- **Authorization metadata.** The intake group reads `control_identities`,
  `control_role_grants` and `projects` across tenants. The authorization query
  must resolve the caller before it applies project scope. This read grants no
  proposal, task, assignment or execution authority outside the validated
  project.
- **Audit chain heads.** The intake group reads `control_audit_chain_heads`
  without row security, because it must extend its own chain. That exposes each
  partition's name, head hash and event count for every tenant and subsystem,
  but no event content. Every intake head write must still match an intake
  audit event the login can see, and the binding limits those to its own tenant.

The migration is forward-only in normal operation. If an operator prepares a
database recovery that removes this source-only slice, the reviewed recovery
SQL must lock both new tables and refuse while any batch exists. The executable,
tested form is `db/down/0093_work_batch_intake.sql`; it also removes the
slice's triggers, policies, functions and the anchor and binding tables when
both proposal tables are empty:

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
