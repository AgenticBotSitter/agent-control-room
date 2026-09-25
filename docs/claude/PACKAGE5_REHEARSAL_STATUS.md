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
