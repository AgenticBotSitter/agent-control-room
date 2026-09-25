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
