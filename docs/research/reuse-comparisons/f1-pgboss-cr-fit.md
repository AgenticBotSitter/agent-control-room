# Actual Control Room queue adapters: driver comparison

2026-09-08. Local synthetic PostgreSQL18.4 only. No application change, provider,
native agent, real approval, full canonical task journey or production qualification.

## Result

The actual pg-boss12.30.0 package, unchanged Control Room submission/worker adapters,
and existing boundPrivateDatabase wrapper pass four scenarios with maintained
node-postgres8.23.0 underneath:

1. Marker plus actual queue submission roll back when the precommit check rejects;
   neither marker nor operational job remains.
2. Real submission IDs reach the actual CR worker wrapper at concurrency1. Synthetic
   held and delivered outcomes are persisted by pg-boss; both exact outputs match.
3. Repeating a fresh intent with an existing operational ID is refused; no extra
   delivery callback occurs. This is not canonical replay acceptance.
4. A queued locator with an extra field is cancelled before delivery. Only the two
   valid callback IDs were observed; no engine errors were emitted.

Receipt: `f1-pgboss-cr-nodepg-evidence.json`, first node-postgres variant exit0.
The research driver port uses actual Pool.connect/Client.query/release under existing
CR transaction/precommit/deadline handling. SQL and values are not rewritten.
This is a representative actual application adapter seam, not a standalone send demo.

The delivery port deliberately returns synthetic dispositions; it does not read
canonical approval or persist a canonical hold. Queue output is not review state.
The complete task-quality coordinator and native capacity release are not executed.
The node-postgres port's pool.end is normal cleanup, **not validated forced termination
of active leases**. Production adoption must satisfy the existing terminate contract;
the research port is not a ready-to-copy production driver.

## Preserved failures and diagnostics

- Initial fixture import typo referenced nonexistent src/security.ts. Zero scenarios
  executed. Root corrected only the import to actual security/index.ts and preserved
  `f1-pgboss-cr-setup-failure.json`.
- The generic createPostgresClient variant then failed before the intended precommit
  rejection with native_task_submission_unavailable. Zero complete scenario passes.
  Exact completion is in `f1-pgboss-cr-initial-evidence.json`.
- One logging-only subclass/query wrapper, forwarding actual behavior unchanged,
  exposed SQL22023: cannot call json_to_recordset on a scalar. Two metadata queries
  returned one row, then actual boss.send failed. Exact evidence is in
  `f1-database-diagnostic-evidence.json`. No application check was weakened.
- A separate JSON/options diagnostic reached the outer60s deadline without emitting
  intermediate outcomes. One correction separated cold reserve from direct binding
  and added a reserve deadline; that run also reached the outer deadline without
  outcomes. Both are inconclusive about individual option combinations. Do not label
  prepare:false, fetch_types:false, warm reserve or production startup as tested
  failures/passes from these missing observations. No further unchanged run planned.

Independent source analysis in `f1-database-driver-source-review.md` explains the
generic JSON failure: pg-boss supplies pre-serialized JSON; Postgres.js describes the
JSON parameter and applies JSON.stringify again. Production private-postgres.ts has
different settings/reserve behavior. Source supports a concern there, not a completed
production reproduction. The diagnostic also exposed a source-level cold-reserve
concern; two timeouts alone do not identify the stage where either process stalled.

## Effect on reuse selection

Do not replace pg-boss to fix a driver binding mismatch. Maintained node-postgres
is already installed through the evaluated packages and now crosses actual CR queue
boundaries. Postgres.js public typed text binding is another concrete alternative
for already-serialized parameters, but requires actual bind/lifecycle comparison;
do not create an ad hoc JSON serializer or install an ORM merely for conversion.

Next finite driver decision: typed text bind versus node-postgres across JSON/object/
scalar/text/UUID/array/null inputs and the actual private query/lifecycle boundary,
including cancellation/active-lease termination. The full current PG17 restore/profile
fixture needs a proper PG17 toolchain, identified separately in the restore preflight.
No driver winner or whole-engine readiness is declared from four cases.

All attempts used separately owned clusters with disabled TCP, private0700 Unix
sockets, sterile child environment and empty cwd. Every parent reported stopped
cluster plus removed exact child; root subsequently found no pg-run children.
No downloads were required. Existing package/source provenance is reused, not a
fresh complete byte-level dependency audit. Independent result review in
`f1-pgboss-cr-review.md` finds no blocker to the four narrow node-postgres cases;
root accepts that disposition. The earlier runner receipts omit killed/signal and
elapsed metadata: the60s deadline attribution above uses the configured runner and
root observation, not a fully reconstructible termination-cause receipt. No stage
inside either options diagnostic is established. The runner now retains killed/
signal/bounded partial stdout on future failures; no diagnostic rerun was made.
