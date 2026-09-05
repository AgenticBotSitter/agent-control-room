# CR14C — verified two-pool task startup

Date: 2026-09-05. Scope: inert repository startup and disposable/in-process evidence only.
Base: PR #298, `f84f22b251ac3f1e0a29588e342191386f1edf66`.

## One explicit startup, two fixed roles

The private Node build exports `taskBootstrap.js` in the same server graph as the page handler and
runtime. Import is inert. Trusted server code explicitly calls `startPrivateTaskApplication` once;
it validates and snapshots configuration before acquiring resources, opens and verifies the restricted
web pool, then opens and verifies the task-coordinator pool. Both retain their existing fixed privilege
profiles and the migration 0001–0046 schema gate. This adds no SQL permissions or migrations.

Both configurations must name the same literal-loopback PG17 host, port and database with distinct
login names. Each actual session must independently satisfy its exact login/role/database/primary,
timeouts, schema and active-owner checks. There is one authoritative primary, not a second database.
The injectable opener is trusted test/composition code, not an HTTP override or a preflight bypass.
Production uses the existing bounded PostgreSQL opener. Same resource or same client objects are
refused. Wrapper identity alone is not proof of physically independent connections.

The template, keys and configured machine routes are copied before any pool opens. Checkpoint access
is read-only. No planner, signing key, SQL client or mutable configuration is returned to the supervisor.
The returned handle exposes only readiness and close. Existing public-key loading remains demand-driven.
There is no environment lookup, credential loading, migration, provisioning, listener, provider call,
native run or deployment. The original web-only startup remains available and rejects coordinator
operation overrides. Operators choose one profile; they cannot replace an installed app in-process.

## Shared application and cleanup

Only after both preflights succeed and both resources are available does the combined application
mount into the existing shared runtime slot. Actual compiled pages and API routes therefore see the
same planning/assignment services and the same session revocation. Web reads/writes continue using
the restricted web pool; coordinator operations use the separately verified coordinator pool.

The bootstrap memoizes each pool close before transferring ownership. If opening the second pool,
either preflight, construction, readiness or installation fails, every acquired pool is cleaned once.
Cleanup starts for both pools even if one fails. Each underlying close is awaited for at most five
seconds. A failed/stalled close is fixed `private_task_startup_cleanup_uncertain`, not success or proof
that a physical connection terminated. Other failures are sanitized prerequisite/configuration codes.
There is no automatic repair, restart or retry after an attempt, successful or otherwise.

The composed application retains the reviewed simultaneous web/coordinator admission stop, 30-second
drain ceiling and bounded pool termination. Readiness requires both pools and drops before close.
Successful, failed and uncertain saves retain their existing reconciliation rules; assignment only
records a reservation and never grants execution authority or dispatches a native command.

## Evidence and limits

The startup fixture uses one disposable PGlite backend with serialized transactions, each using an
actual restricted LOGIN session identity. Both unmodified production preflights run; only the known
PGlite database TEMP metadata limitation is injected. This exercises real grants, triggers, planning,
assignment, task reads and session revocation, not real PostgreSQL connections, concurrency or ACL setup.
The earlier raw-metadata negative tests remain. No production override was introduced.

Required checks include invalid configuration before opening, both role failures, second-open and
installer failure, unavailable/shared resources, immutable configuration snapshots, one-attempt and
exact-once cleanup, stalled/failed close, compiled proposal/planning/assignment/page/logout and browser
asset isolation. The existing lifecycle tests cover draining, lost commit acknowledgement and late SQL.

Next: signed owner approval, local admission and dispatch, followed by bounded revision submission.
Real database setup, pilot/native qualification and deployment remain separately gated. Astra Medium
continues to suit the remaining repository integration; no model change is required for this block.
