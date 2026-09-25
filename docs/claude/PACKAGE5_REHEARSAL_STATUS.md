# Package 5 rehearsal status

This branch is incomplete and must not be merged to integration or main.
No live PostgreSQL database or Tailnet setting was changed.

The disposable PostgreSQL 17 setup now applies migrations, production group
roles, the fixed pg-boss queue, the four narrow role files, and one narrow
membership for each local login. A fresh cluster passed the queue-worker
preflight. The two required negative probes each failed as intended and were
restored: an extra application-role membership, and a missing queue-table
read grant. The final baseline passed. The three disposable clusters were
stopped; their data directories remain for local investigation.

The full Package 5 B acceptance **did not pass**. The fresh owner bootstrap
attempted to insert `tenants` through `control_room_web`, but the reviewed
private-web role does not grant that write. No owner rows were planted through
the administrator account, and no task or three-worker journey was claimed.
See `PACKAGE5_FIRST_OWNER_DECISION_NEEDED.md` for the exact lead decision.
The source provisioner now refuses any pre-existing narrow role or local login
before changing membership. It does not silently migrate the current VPS;
the reviewed live migration remains section 11.C after B and Opus approval.

Local checks: TypeScript passed; the six database-check unit tests and two
new provisioner-refusal unit tests passed. An agent-run disposable PG17 queue
probe passed. A second run from Codex's restricted shell returned `EPERM`
on loopback connection, so that shell result is an environment restriction,
not an independent repeat of the PostgreSQL proof.

Opus review is pending. The local Claude CLI returned `Not logged in`; a
missing verdict is not approval. Real role-file headers still correctly say
that full PostgreSQL qualification is pending.

## Section 12 follow-up

The non-secret first-owner manifest, receipt-bound public-key pin, and
read-only repeat-start checks are now source-built with focused tests. The
ordinary task provider no longer initializes completion-gate integrity at
startup. These changes have not been exercised as a complete three-worker
rehearsal. The VPS one-time command is not built or run: section 12 requires
it to create an authenticated review-integrity row while its shareable
manifest deliberately excludes the Mac-held review key and its independent
rollback-checkpoint file. The manifest also lacks the worker IDs needed to
reproduce the existing node software fingerprints. See
`PACKAGE5_SECTION12_CONTRACT_GAPS.md`; these are lead decisions, not permission
to widen a database role or move a secret through the manifest. No live
database or Tailnet change occurred.

The safe disposable section-12 negative check was run on a fresh PostgreSQL
17 cluster with no first-owner setup. `mac:up` exited 1 with the required
`first-owner setup has not been run; see OWNER_GUIDE_MAC.md` message after
the four database checks refused the missing owner binding. No task host or
worker started. The disposable cluster was stopped and `pg_ctl status`
reported no server running. Its data directory was retained for
investigation; no live database was contacted.

## Section 13 disposable rehearsal

The focused first-owner and section 13 rehearsal passed on a fresh PostgreSQL
17 cluster bound only to loopback, rooted in a disposable temporary directory.
Before any first-owner transaction, it
verified the exact cluster data directory and PostgreSQL version, then opened
the coordinator login and confirmed `SELECT` on both completion-gate tables.
No grants were changed.

The run passed the no-setup `mac:up` refusal; manifest generation with worker
ids and completion-gate genesis; first injected VPS transaction and identical
repeat (14 rows kept); altered manifest-id refusal; tampered node-key pin refusal;
altered genesis-tag and wrong manifest-digest receipt refusals; successful and
repeated Mac completion; and the advanced-integrity/missing-checkpoint refusal
for both completion and `mac:up`. The advanced-state case used explicit
revision fault injection after checkpoint creation and restored the disposable
state afterward; it did not advance the tenant through a real completion-gate
lifecycle operation. The node-key negative temporarily disabled the immutable-key
trigger inside the throwaway cluster, then restored the original fingerprint
and re-enabled the trigger.

The rehearsal called the VPS transaction's injected-client function only after
proving that the client was connected as the disposable cluster's `postgres`
role and that the server data directory matched the rehearsal root. The VPS
CLI's refusal for a non-`postgres` OS user passed with its generic error. The
positive Unix-socket peer-authentication path was not run on this Mac.

The rehearsal script's `finally` stopped PostgreSQL, and a separate
`pg_ctl status` confirmed no server remained. The initial sandbox attempt was
blocked by shared-memory permission; the same setup and rehearsal then passed
under the approved scoped execution. No live database or Tailnet was contacted.

The positive worker-readiness attempt reached `mac:up` but stopped before host
startup: the web, coordinator and results preflights returned
`private_database_preflight_failed`; the queue-worker preflight passed. A
read-only diagnostic confirmed each role login worked, then those three role
verifiers failed. The cluster was stopped and no task host or task started.
The three ready-worker listing and pending-review task journey therefore remain
unproven. Do not treat this as complete 12.F2/section 13 acceptance or as merge
approval. Remaining evidence includes the positive VPS CLI Unix-peer path, a
real lifecycle advance followed by missing-checkpoint refusals, and resolution
of the three role preflight failures before checking fake-worker readiness.

Source inspection and a read-only catalog comparison confirmed one cause
requiring a separate lead decision: `privateWebSchemaDigest` differs from the
actual structural digest after migration 0085. The preflight table/permission
maps also describe migrations 0001–0084. The preflight deliberately reports
one generic refusal, so additional failures have not been ruled out. The package-5 instruction
forbids changing any preflight; this branch does not change or bypass it.
Claude must approve the separately reviewed schema/preflight update before
full 12.F2 can pass.
