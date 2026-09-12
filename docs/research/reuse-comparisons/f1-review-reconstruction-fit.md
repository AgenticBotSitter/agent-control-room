# Canonical review reconstruction seam

2026-09-08. Command:
`node --import tsx --test --test-concurrency=1 research/reuse-comparisons/f1-review-reconstruction.test.ts`
Exit 0; one test passed in 2133 ms total (1686 ms test body).

Actual TaskQualityCoordinator and existing canonical fixture execute against one
disposable PGlite database. Native transport, identities, keys and owner review are
synthetic fixture data, not real agent/provider or owner actions. Fixture cleanup
is registered with the test runner. No download, socket, production or GitHub effect.

Observed: initial reconciliation records pending review and releases the lease;
new coordinator instances preserve the exact capacity receipt and unchanged
canonical state. Synthetic owner review then allows exact job/run completion;
another reconstructed coordinator returns the same completion receipt as replay.
Recorded native calls and effect count remain unchanged throughout reconstruction.

This is object reconstruction with a retained database, not process restart,
native cancellation, storage restore or queue evidence. It closes only the shared
canonical-review seam needed by the comparison. The earlier same-object replay
tests were not rerun wholesale. No task or review state was invented in a new table.

Next join actual candidate submission/worker to this existing service behavior on
the same native PostgreSQL database. Current helper hierarchy allocates PGlite
internally; do not attach a separate queue database and claim admission atomicity.
Reuse helper setup with an explicit disposable-database injection if needed, rather
than duplicate approvals/signing/review logic. DBOS's earlier PGlite migration
failure is not a reason to repeat that setup or reject the candidate.

Work-engine decision remains open, with pg-boss retained provisionally. Hatchet's
separate acknowledgement/dedup-expiry test remains outstanding. This receipt is
not a claim that all queue/recovery tests or independent review are complete.

## Native database injection preparation

Added test-only AsyncLocalStorage-scoped database factory and used it at the existing
nativeTaskFixture allocation point. No production database adapter or application
source changed. Default behavior still creates PGlite; supplied backends must
implement the existing DatabaseClient plus migration/close operations. The factory
does not read environment variables, choose endpoints or open connections.

One overlapping-context/error-cleanup test passes (exit 0, 85 ms). The actual
review-reconstruction regression passes after this change (exit 0, 2106 ms).
Native PostgreSQL execution is not yet demonstrated by these tests.
Full private pnpm check exits 2 with diagnostics in other research comparison
files; no diagnostic names the two new tests, injection helper or modified fixture.
This does not establish a clean private-wide type-check or prove those unrelated
diagnostics predate this work. No errors or tests were suppressed.
