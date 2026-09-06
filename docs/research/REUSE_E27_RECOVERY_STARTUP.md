# E27 — explicit recovery startup configuration

2026-09-06. Local opt-in composition; no deployment activation.

Private startup now accepts nativeQueueRecovery:true only with nativeQueue:true. It
selects the exact E25 recovery database profile, requires a prepared recovery method,
captures that method and exposes only the owned server-side recovery/verification
commands. Without the flag, extra recovery methods supplied by a factory are not exposed.

When a worker is configured, startup passes the captured canonical verifier alongside
delivery. Startup abandonment aborts/fences both callbacks. The independently verified
worker bootstrap captures the verifier and retains its health checks before and after
verification; the worker database receives no canonical access.

## Evidence

55 combined actual-package checks and 54 startup/runtime regression checks pass.
TypeScript, targeted ESLint and whitespace checks pass.

Actual-package startup tests cover recovery enabled, recovery method missing, and the
existing success/failure/timeout paths. Enabled startup enqueues, then recovers/verifies
a synthetic failed job through the returned owned command. Missing method refuses
installation and closes the acquired producer/pools. Invalid recovery-without-queue
configuration refuses before database opening.

The restricted worker LOGIN/bootstrap test now also picks up a synthetically recovered
job and invokes its supplied verifier exactly once. That fixture's verifier is a spy;
E26 separately proves actual canonical verification and signed delivery to review.

The first startup recovery test failed because its administrative fetch inherited the
last coordinator identity on the single PGlite engine. The test now explicitly restores
the administrator only for synthetic pickup setup. No coordinator privileges were
expanded to make administrative pickup pass. This is not physical pool isolation proof.

## Remaining

Automatic recovery must trigger after successful signed reconciliation, not raw hello
or unauthenticated connection attachment. Add bounded assigned-node candidate discovery,
generation/abort checks and duplicate readiness handling. Expired/ineligible work must
not invalidate a healthy connection used for result intake. Then prove the automatic
offline-to-review path and whole-host/exact-role/full-schema acceptance, followed by
separately authorized real PostgreSQL and live-owner testing.

No native agent, credential access, listener, persistent service, database provisioning,
download or GitHub publication. Reused E01 package and closed in-memory fixtures only.
