# CR14B — private startup and database preparation

Date: 2026-09-04. **Design and scoped follow-on work, not an installed bootstrap or permission to execute it.**
The app remains unconfigured by default. Preserve the single private Hostinger PostgreSQL primary decision;
PGlite remains disposable development/testing and R2 remains artifacts/backups. No AWS RDS or public database.

## Startup ownership to implement next

One explicitly invoked Node bootstrap should own the following sequence. Importing it must have no effects.
No HTTP request can supply a database locator, trusted issuer, tenant, key source or startup configuration.

1. Validate one operator-supplied configuration: exact private HTTPS application origin and fixed Access
   issuer/audience, tenant/workspace scope, separately owned private database locator/credential and existing
   registry keys. Reject defaults, ambiguous multiple URLs and fixture fallback. Do not log values.
2. Acquire one bounded application pool to the approved local/private PostgreSQL primary. A private-looking
   hostname alone is not proof of private routing; host ingress/network evidence belongs to B-DB-PREP.
   No auto-migration, owner bootstrap, enrollment, provider authentication or installation during startup.
3. Before accepting traffic, check the deployed schema manifest, effective role/memberships, required
   permissions and enforced connection/query limits. Verify the pre-existing human binding and workspace.
   Missing prerequisites produce a sanitized setup failure and close the acquired pool exactly once.
4. Install the existing server-only `installPrivateWebProcess` once, with the one pool and existing private
   keys. The reviewed demand-driven Access key cache remains the only public-key loading path. Do not
   pre-qualify an agent, start a queue or inherit personal agent plugins from application startup.
5. Start the separately reviewed Node static/request adapter only after setup succeeds. Serve only built
   client assets; never server chunks, source/configuration or directory listings. The app listener is private
   to its approved reverse proxy. TLS/Access enforcement, direct-origin exclusion and MFA remain real-rehearsal
   evidence, not facts derived from source configuration.
6. Shutdown first removes readiness/stops new admission, then drains admitted handlers and transactions,
   and only then closes the pool. A forced-deadline exit must mark incomplete writes as uncertain and use
   stored command receipts on recovery; never repeat a write automatically. Browser snapshots can reconnect
   via fresh authorized GETs. Real rolling updates and fleet version negotiation remain CR14G.

### Proposed finite limits — not currently implemented

These are initial private-pilot design values, to be validated in the next repository block and real rehearsal.

| Boundary | Initial ceiling | Required behavior |
|---|---|---|
| Application pool | 8 connections, bounded pending admission | Reject excess work with fixed unavailable output; never unbounded wait queues |
| Connect / pool checkout | 5 seconds each | Fail setup/request; no alternate host or credential fallback |
| SQL lock wait | 2 seconds | Roll back; preserve original command key for explicit reconciliation |
| SQL statement | 5 seconds | Cancel through database/driver support, not merely abandon a JS promise |
| Whole transaction | 10 seconds | Database-enforced where supported; include pre-commit checks and rollback |
| Idle in transaction | 5 seconds | Release abandoned locks; no idle-open request transaction |
| Graceful app drain | 30 seconds | Stop admission first; no false successful shutdown if the drain expires |
| Pool close after settled drain | 5 seconds | Record fixed failure category; supervisor policy owns forced exit |

`createPostgresClient` currently sets pool/connect/idle/end options but not the complete query, admission or
transaction deadline policy above. `createPrivateWebProcess.close()` currently waits for admitted handlers;
it cannot itself guarantee a bounded drain if a database request never settles. Do not claim these targets
are implemented by the existing helpers. Inspect installed postgres 3.4.7 behavior before authoring its adapter.
The selected real PostgreSQL version must be pinned at rehearsal; current documentation is not evidence of
an installed service. PostgreSQL supports separate statement, lock, transaction and idle-transaction limits;
their interactions must be checked against that selected version. [PostgreSQL connection settings](https://www.postgresql.org/docs/18/runtime-config-client.html).

## Database role scope to implement and rehearse

The historical `db/roles/production_roles.sql` gives `control_room_application` broad table access. It is
**not the accepted least-privilege role for this mounted private app**. Do not apply it as private-beta setup.
Use a separate role profile, with no ownership, superuser/role creation/database creation/BYPASSRLS powers,
schema creation, broad role memberships or default grants to future tables. Migrations and owner identity/grant
provisioning are separate operator-owned operations, never ordinary web login capabilities.

| Mounted operation | Tables needed | Intended data authority |
|---|---|---|
| Identity/grant admission | `control_identities`, `control_role_grants` | Read and row-lock; no changing subject/provider/state/actions/scope/expiry or issuing grants |
| Session admission/logout | `control_web_sessions` | Insert exact session, read/lock, revoke existing assertion; no deleting tombstones or extending expiry |
| Ordinary project creation/lifecycle | `workspaces`, `adapter_registry`, `projects`, `control_manual_project_heads` | Read/lock the existing workspace; create manual adapter/project/head, update only existing manual lifecycle fields; no delete |
| Command replay and audit | `control_web_project_commands`, `audit_events`, `control_audit_chain_heads` | Append receipts/events and advance audit head; never edit immutable events/receipts |
| Idea project read | canonical `projects`, `control_project_lifecycle_events` | Read verified latest event/mirror only; no Idea decision or lifecycle write |
| Connection read | `control_connection_registry_heads`, `control_connection_enrollments`, `control_connection_authenticated_telemetry_receipts` | Read/verify existing enrollment and telemetry; no enrollment, renewal or signal publication |

This table is an implementation target, not executable grants. In particular, PostgreSQL row-locking SELECTs
require UPDATE permission on at least one column of each locked table. A SELECT-only role will not run the
current identity/grant/registry-head locks. Do not solve that by granting authority-bearing columns. The next
block must choose and review a narrow lock-support mechanism, prove it works with the current lock order,
and test that it cannot alter identity/grant authority or authenticated registry state. Any schema/trigger/helper
change must have an explicit migration and restricted ownership/search path; no unnoticed SECURITY DEFINER
or runtime-owner shortcut. [PostgreSQL SELECT privileges](https://www.postgresql.org/docs/18/sql-select.html).

Table/column grants alone also cannot express "manual projects only" or irreversible session revocation.
The application remains trusted for those transitions, as in the accepted threat model. If the new role profile
claims stronger database enforcement, it must implement and test that explicitly. Never describe broad SQL
permissions as tamper-proof. Inspect both direct and inherited effective privileges, append-only triggers and
PUBLIC/default privileges in rehearsal. [PostgreSQL privilege model](https://www.postgresql.org/docs/18/ddl-priv.html).

## Gates and handoff

**Repository-only next block (Astra Xhigh):** implement the bounded pool/startup composition using injected
dependencies, least-privilege role/migration support and reproducible disposable tests; independently review
the new authority boundaries. Prepare one exact local listener/real-PostgreSQL rehearsal packet with setup,
allowed commands/effects, cleanup and redacted evidence limits. No new permission needed to author/review it.

**B-DB-PREP, separately authorized:** identify the exact VPS/role/database/version and approved private route;
prepare host/DB and backup destination under a bounded owner packet. Retain credentials and addresses privately.

**B-DB-REHEARSE, separately authorized:** use a disposable real database/workspace; prove migration manifest,
effective privileges, read/write/revoke paths, independent-session locking, deadline behavior, restart/restore
and cleanup. PGlite cannot replace this cross-process/host evidence.

**B-PILOT, separately authorized:** owner configures IdP/MFA/private hostname/Access; rehearse actual sign-in,
remembered session, all protected routes, logout/revocation, non-public origin, static delivery and shutdown;
deploy only the accepted exact artifact. An employer-approved work alias remains separately gated. Nothing
here authorizes bypassing employer restrictions or treats a hidden subdomain as access control.
