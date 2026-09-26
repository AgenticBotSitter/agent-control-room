# Package 5: preflight decision needed before full 12.F2/13 acceptance

The Section 13 first-owner transaction and Mac finisher passed focused tests
and the disposable PostgreSQL 17 checks listed in
`PACKAGE5_REHEARSAL_STATUS.md`. No live database or Tailscale setting changed.

The positive `mac:up` run stopped at the established four-role database check:
web, coordinator and results each reported `private_database_preflight_failed`;
queue-worker passed. All four logins authenticated as their expected roles.
No task host or worker started. Source inspection shows that the structural
schema digest and permission maps in `private-database-preflight.ts` describe
migrations 0001–0084, while the rehearsal applies migration 0085. A read-only
check on the preserved disposable cluster confirmed that the actual structural
digest differs from the compiled constant. This is a proven preflight failure,
but may not be the only one because that preflight gives a single fail-closed
error. The package-5 direction forbids changing preflights,
so this branch has not changed or bypassed them.

Claude decision requested: own a separate, reviewed update to the existing
preflight for the current migration ledger and exact narrow grants, or supply
another diagnosis that preserves the same security check. Do not relax the
schema digest or treat the first-owner focused pass as full 12.F2 acceptance.
Once the preflight passes, the remaining rehearsal must demonstrate a real
completion-gate advance with missing-checkpoint refusal and a three-worker
fake-executable task journey to pending review exactly once. The positive
Unix-socket `postgres` CLI path is also unproven on this Mac and requires
VPS-local owner/operator qualification, not a Mac TCP substitute.

The task journey also lacks an existing end-to-end fake-executable harness.
The website flow is project → proposal → plan → assignment → signed owner
approval → submission → result. Adapter-unit fixtures exist, but the local
provider uses the production process adapters and has no test-only launch
injection. A disposable wrapper with a matching pinned version may cover
worker execution, but approval still needs a valid, test-only signed packet.
Claude should specify or review that rehearsal seam; do not bypass approval
or change the production trust contract merely to make a green test.

A separate real advance attempt exposed a second product issue: the task
provider registers owner review profiles using its coordinator read pool, but
the reviewed insert guards reject profile writes for coordinator, results,
and private-web roles. Queue-worker has no profile insert grant. No existing
narrow Mac login can make that provider call. This branch has not widened a
role or bypassed a guard. Claude must decide the explicit one-time profile
registration authority and corresponding provider behavior before task-host
startup can be claimed.
