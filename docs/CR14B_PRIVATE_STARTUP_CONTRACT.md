# CR14B private startup, bounded pool and database role

Date: 2026-09-04. Scope: repository implementation and disposable/injected tests. Not deployed.
This implements the startup/pool/role portion of `CR14B_BOOTSTRAP_DATABASE_PREPARATION.md`.

## Explicit startup

The VPS build exports `dist-vps/server/bootstrap.js` alongside its existing handler/runtime entries in one
shared server graph. Import is inert. `startPrivateWebApplication` is an explicit one-attempt lifecycle:
validate configuration, construct one owned pool, verify prerequisites, then install the shared private
application. It never starts a listener, loads environment files, migrates, creates identities, qualifies an
agent, invokes a provider, or supplies fixture fallback. HTTP cannot configure it.

Supply the exact HTTPS origin, Access issuer/audience, tenant/workspace, existing owner identity ID, session
ceiling, trusted public-key loader and optional existing 32-byte registry keys through trusted server code.
Keys are copied. Public keys remain demand-loaded by the existing bounded cache; startup does not call it.
No account credentials or real settings are included in an artifact or evidence.

The first supported database topology is **PG17, same-VPS TCP literal loopback only**. App and private primary
are co-located; port, database name, login and password must all be explicit. No URL, DNS, multi-host selection,
empty credential, or inherited PG*/OS-user locator fallback. TLS is disabled only on this same-host link;
this profile is not permission for unencrypted remote database access. Host ingress and authentication still
need real verification. PG17 is a compatibility target, not an assertion that a service is installed. Pin the
exact current PG17 patch/artifact under the later preparation packet; other majors need their own evidence.

## Bounds and outcome semantics

| Boundary | Implemented ceiling |
|---|---|
| Active HTTP handlers | 64; excess gets unavailable, no app wait queue |
| Pool admission | 8 active operations, zero pending admission queue |
| Connect / checkout | 5 seconds |
| Lock / statement | 2 / 5 seconds, supplied as per-connection PostgreSQL settings |
| Transaction / idle transaction | 10 / 5 seconds, supplied as per-connection PostgreSQL settings |
| Application drain / pool termination | 30 / 5 seconds |

The transaction deadline includes checkout and the callback. Standalone queries have a total 5-second
ceiling. Each reserved session allows one statement at a time. Every query and precommit boundary checks
that the operation remains active; escaped/late callbacks cannot issue more queries. A known callback or
failed precommit rolls back before release. Any fast driver uncertainty, failed rollback, failed COMMIT
acknowledgement or deadline quarantines the **whole pool**, rejects
admission, invalidates active operations, and calls postgres 3.4.7 `end({timeout:0})` once to terminate
connections/queued work. It does not merely race a promise and keep the driver working. There is no retry
or alternate host. Prepared statement caching is disabled to avoid the installed driver's automatic plan-cache
retry; statements still use parameterized extended protocol. A commit already sent may have committed: retain its command key and reconcile its
existing receipt explicitly. No ROLLBACK is issued after COMMIT is attempted. Uncertain operations await the
shared bounded termination outcome before reporting, so cleanup can add up to 5 seconds to the work deadline.
These are trusted application sessions, not a SQL sandbox for untrusted code.

Readiness drops before shutdown. Admitted requests can drain; deadline expiry returns unavailable to remaining
requests, closes key loading, terminates the pool and rejects shutdown as uncertain. A failed/stalled close also
stays uncertain. The future listener/supervisor must stop admission and use these readiness/close outcomes;
no signal handlers, forced process exit, listener or rolling-deployment machinery is installed here.

Server timeout semantics follow [PostgreSQL connection settings](https://www.postgresql.org/docs/17/runtime-config-client.html).
Installed-driver inspection and fake tests do not prove real socket cancellation, cross-session locks or OS cleanup.

## Restricted role and startup gate

Migration 0040 adds a constant-false `web_lock` column to identities, grants, workspaces and connection heads.
The dedicated NOLOGIN `control_room_private_web` role gets UPDATE on that harmless column only, allowing
existing row-locking SELECTs without permission to modify authorization or authenticated enrollment fields.
The CHECK constraint forbids true/null. A separate, privately provisioned LOGIN inherits **only** this role,
without ADMIN option or object ownership. The old broad `control_room_application` profile is not used.
[PostgreSQL locking SELECT privileges](https://www.postgresql.org/docs/17/sql-select.html).

`db/roles/private_web_roles.sql` is a fresh-role, explicit operator setup script. It grants only the mounted
table reads/inserts and named lifecycle/audit/session update columns. There are no deletes, table creation,
credential/grant issuance, registry writes, grant options, or public function execution rights. A separate
`private_web_database.sql` removes PUBLIC CREATE/TEMP on the **dedicated** database. Scripts change permissions
for that dedicated database and must not be applied to a shared production database by inference.

The session trigger additionally enforces immutable assertion binding/expiry and irreversible first revocation.
It is invoker-security, with a fixed search path. Existing audit/receipt immutability remains in force. Column
grants do not make a compromised app harmless: permitted project/audit writes are still trusted application
authority and not row-scoped to manual projects or one tenant by the DB. No stronger isolation is claimed.

Before installation, read-only preflight checks connection/database identity, PG17/primary, limits/search path,
session role, direct/inherited memberships, privilege flags, ownership, effective table/column/sequence/function
rights, PUBLIC/default privileges, and the existing active owner/workspace binding. It compares a repository
fingerprint of all public table columns, constraints, indexes, triggers and functions, including trigger enablement.
The current fingerprint is derived from migrations 0001–0045, not a mutable database version marker. CR14C
adds read access to canonical task/attempt/harness evidence and insert-only, trigger-constrained task
proposals/receipts, then read-only artifact receipts/manifests and verified review history. Migration 0043 adds
guarded human quality-review/finding inserts, immutable private feedback receipts and the required integrity/
lock columns. It grants no profile/target/verification/revision/approval inserts, task transitions, attempts,
leases, dispatch, effects or artifact writes. Migration 0044 adds trusted native review plans without
granting the private web role any privileges on that table. Migration 0045 adds owner-authorized execution
plan lineage, also without private-web grants; it requires separate trusted control-plane composition.
Extra/missing
permissions and schema drift fail closed. Migrators/DB administrators remain trusted; this is a startup snapshot,
not continuous monitoring of administrator changes. New schema/role versions require reviewed compatibility.

Failures use fixed codes, close acquired resources once and do not repair or retry. `isReady()` becomes false
when the pool is quarantined. The injectable factory is for trusted composition/tests, not a request-controlled
way to bypass preflight.

## Evidence boundary

Tests use disposable PGlite plus injected drivers and short deadlines. PGlite 0.3.14 exposes `template1` but
cannot revoke that database's ACL (`XX000`, tuple concurrently deleted). Role/table/column/trigger tests use
actual restricted SQL. Only the database TEMP privilege metadata is injected in the startup fixture; the
unmodified production preflight demonstrably rejects that PGlite connection. Neither the DB ACL script nor
real PostgreSQL cancellation/concurrency is claimed rehearsed. This limitation is not a production override.

Compiled tests verify the bootstrap and handler share one installation and the restricted fixture can create
a project through the actual built API. Browser assets exclude the database bootstrap. These are in-process
artifact checks, not browser clicks or a listening service. Existing Sites preview stays separate and unchanged.

Next: implement the private Node request/static adapter and its effect-free tests; complete an executable
disposable real-PG rehearsal harness against the exact reviewed artifact. See `CR14B_SETUP_REHEARSAL_PACKET.md`.
