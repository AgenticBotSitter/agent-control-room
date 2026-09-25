# Package 5: preflight decision needed before full 12.F2/13 acceptance

The Section 13 first-owner transaction and Mac finisher passed focused tests
and the disposable PostgreSQL 17 checks listed in
`PACKAGE5_REHEARSAL_STATUS.md`. No live database or Tailscale setting changed.

The positive `mac:up` run stopped at the established four-role database check:
web, coordinator and results each reported `private_database_preflight_failed`;
queue-worker passed. All four logins authenticated as their expected roles.
No task host or worker started. Source inspection shows that the structural
schema digest and permission maps in `private-database-preflight.ts` describe
migrations 0001–0084, while the rehearsal applies migration 0085. This is a
probable cause, not proven to be the only one because that preflight gives a
single fail-closed error. The package-5 direction forbids changing preflights,
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
