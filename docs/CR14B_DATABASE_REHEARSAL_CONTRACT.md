# CR14B private PostgreSQL rehearsal tooling

Date: 2026-09-05. Architect: Codex, Astra Xhigh. Repository implementation, not permission to run.

## Purpose and boundary

`src/web/v1/private-database-rehearsal.ts` adds a fixed, single-use operator workload. The VPS build exports
it separately as `dist-vps/server/rehearsal.js`. Importing the entry and constructing its runner opens no
database, listener, credential store or agent connection. Nothing mounts it in the web application or queue.
Only an explicitly authorized operator may call the native runner's `run(input)` on a prepared disposable DB.
There is no environment loader, shell command, password argument, provisioner, migration runner, repair or retry.

The operator owns the actual compiled artifact/host identity check and approval. The structured packet is a
binding/checklist, **not a signed approval capability or independent attestation**. Exact commit/tree/artifact,
preparation, owner approval, cleanup plan and PostgreSQL package digests must be present. The expected PG17
patch number must match the database and both probes. The private configuration is fixed to same-host
`127.0.0.1`, a `cr14b_rehearsal_`-prefixed database and the separately prepared restricted LOGIN. No RDS.
Credentials and real locators remain in the operator's private memory/configuration, never command-line
arguments, logs, GitHub or returned evidence. Review the actual target, not merely its disposable-looking name.

Setup remains separately authorized. Apply migrations 0001–0041 and the reviewed fresh web/database role
profiles as the administrator/migrator, not the web login. Provide one synthetic owner, workspace, Idea project
and enrollment/signal with matching synthetic integrity material. The fixed synthetic fixture IDs and `.invalid`
origins are exported as `rehearsalScope`; the fixture assertion must be for `test-owner` and remain valid for
the entire approved window. No real Access/agent authentication or real enrollment is appropriate here.
Startup verifies the unmodified production role/schema contract before the workload; the runner never injects
TEMP permission results. It additionally requires an otherwise empty mounted project/session/command fixture.
Unrelated tables not readable by the web role are the separate preparation operator's isolation responsibility.

## Workload and bounds

The packet permits at most 15 minutes, two sequential web pools (eight connections each, never overlapping)
and two independently reserved validation sessions. The last ten seconds are reserved for stopping owned
work/connections. Cancellation and deadline fence later stages. A runner object consumes its single attempt
even for incomplete setup; create no second runner after uncertainty without a new owner decision.

1. Read-only production preflight, then rejection of a deliberately absent owner scope on the same database.
   This is an unsuitable-scope check, not evidence of every possible bad role/schema/host configuration.
2. Verify the fixed synthetic fixture and exact PG17 patch before application writes. Create one ordinary
   project, replay its create key, pause it, read its current view and require exactly two command/audit effects.
3. Read the shared Idea/ordinary catalog and synthetic enrollment projection. Require one current signal,
   zero missing/stale signals and no claim of a live panel.
4. In rollback-only probe transactions, fixed no-row updates to identity state, grant expiry, enrollment digest
   and session expiry must report PostgreSQL insufficient privilege. Unexpected success/error stops the run.
5. Two original reserved sessions lock the same synthetic identity. Read-only `pg_stat_activity` observation
   must see the second waiting on a lock before releasing the first. Then observe the 2s lock and 5s statement
   limits. Three separate 4s statements expose the 10s transaction-session limit; the final probe observes
   the original backend still idle/open at 4.5s, then absent after at least 5s. The check is named
   `idle_session_absence`: the driver does not expose the idle close cause, so SQLSTATE 25P03 remains
   unverified. An unrelated disconnect in that interval cannot be distinguished. Closed probes cannot
   reserve replacement connections.
6. Hold eight bounded pool transactions behind a local latch, require the ninth operation to reject without
   queuing or damaging the pool, then release all eight. This is SQL-pool admission, not a claim about eight
   simultaneous HTTP writes or a stress/load test.
7. Drain an admitted, bounded application render; reject new requests and close the first pool once. Open
   the second pool once, rerun real preflight, reconcile persisted command counts/project version and read
   the project. This proves a **planned pool reopen**, not an OS-process restart or crash recovery.
8. Revoke the synthetic session, reject subsequent project/connection reads, verify its tombstone and unchanged
   command/audit counts, then close. No mutation is replayed after uncertainty or during reconciliation.

PostgreSQL distinguishes statement cancellation, lock timeout, transaction-session timeout and idle-session
termination. The first three are checked by their specific SQLSTATE and elapsed time; idle disappearance
is explicitly not an exact timeout-cause claim. Timing tolerances are fixed, bounded
and may produce negative evidence on an overloaded host. Primary references:
[PG17 connection defaults](https://www.postgresql.org/docs/17/runtime-config-client.html),
[PG17 activity statistics](https://www.postgresql.org/docs/17/monitoring-stats.html),
[PG17 error codes](https://www.postgresql.org/docs/17/errcodes-appendix.html).
The installed postgres.js 3.4.7 reservation/close behavior was inspected. It is still unqualified on a real host.

## Cleanup and honest evidence

The runner closes only its own pools/probes, once per resource, including failure paths. No DB, role, service,
data directory, backup or enrollment is deleted. The separately approved operator owns exact disposable
database/role cleanup and final host/session absence verification. `poolsClosed`/`probesClosed` mean the owned
client shutdown completed, **not independent observation of all server-side session absence**. Created counts
are owned client wrappers, not observed physical connection attempts. The installed driver's initial target-session
selection can revisit an unsuitable endpoint before reservation. `physicalConnectionAttempts` remains
`not_observed`; no command retry is added by the runner. Only the idle
probe's backend absence is explicitly observed by this workload. Cleanup uncertainty prevents completion.

Evidence contains fixed dispositions, check names, digests and resource counts, never row values, request
contents, protected identifiers or raw errors. `checks_completed` is not review acceptance:
`realPostgresAccepted` and `privateBetaAccepted` stay false even after a native run. Independent review and
the operator cleanup evidence remain necessary. The injectable test composition always labels itself
`injected_test` and cannot report native evidence.

Physical listener/static/browser testing, actual OS-process restart, injected lost-ack behavior, backup/restore,
IdP/MFA/ingress and deployment are not silently included. The evidence explicitly marks their absence or
separate deterministic evidence. Existing startup/pool tests cover uncertain commit handling; this workload
does not manufacture a network interruption on a database. B-PILOT and CR14G remain incomplete.

## Changes from the earlier draft

`CR14B_SETUP_REHEARSAL_PACKET.md` remains the parent execution specification. This implements its SQL/application
portion with clearer evidence labels. Listener and backup/process-restart portions are separate follow-up
operator compositions; neither may be improvised or inferred as passed. Setup/fixture preparation and exact
cleanup remain distinct from workload-produced evidence, avoiding the earlier self-prerequisite loop.

Local tests use PGlite for application/receipt persistence plus recorded, injected driver timing and session
metadata. PGlite has one in-process SQL session and cannot establish real multi-connection or database TEMP
permission evidence. No simulator check qualifies the native PostgreSQL adapter or authorizes a live run.
