# E67 — asynchronous Completion Gate checkpoint path

2026-09-06. Local-only implementation and disposable-data tests. No downloads,
credentials, real providers, listeners, external databases or deployment.

## Connected

- Added a separately named awaitable checkpoint port. The original synchronous
  interface and exact in-memory bindings used by historical simulations are intact.
- Completion Gate now awaits checkpoint read, initialization and advancement. The
  active task planning, review, verification and native result configuration accepts
  that port; existing synchronous fixtures remain compatible.
- Result submission, owner review/verification and automated verification use an
  asynchronous stage. It reuses the existing stage's exact scope, CAS, revision and
  batch validation instead of adding another storage algorithm. Its first external
  read is lazy, after the caller holds the integrity lock; merely constructing it
  performs no I/O. Staged writes flush sequentially at the awaited pre-commit boundary.
- A flush cannot certify an unawaited read/advance as an empty successful operation.
  Failure closes the stage; partial external advancement is not undone or retried.
- Owner and automated-verification guards run before and after external writes,
  including between a batch's advances. Expiry after a successful external advance
  refuses SQL commit and prevents the next advance.

This is Control Room-specific transaction/authority glue around the existing CAS
contract, not a new persistence engine. No candidate storage dependency was added.

## Evidence

New tests cover lazy single-read staging, exact multi-step CAS, partial failure,
wrong scope, unused-stage inactivity and refusal to flush an unawaited read.
Actual PGlite-backed Completion Gate tests cover delayed initialization and rollback
on initialization rejection. The owner-review test uses asynchronous supplied
storage and verifies that reads occur after the integrity lock, saves wait for the
reply, storage refusal rolls back, and expiry during a two-write review stops after
the first advance. In the latter case SQL is rolled back, the advanced checkpoint
is retained, and subsequent integrity validation refuses the mismatch. That is
unresolved split state, not a repaired or successful save.

The first typecheck after adding tests caught an unnecessarily widened inferred
return type in the new stage. `satisfies` now checks the port while retaining the
actual Promise-returning method types. No runtime assertion was relaxed.
Final verification: 49 new/Completion Gate/owner-review checks plus 194 adjacent
result, verification, planning, revision and quality regressions passed (243 total,
zero failures/cancellations/skips). TypeScript, full lint and the VPS build passed.
All 41 compiled regressions and four compiled queue/schema journeys passed. This
block did not rerun the entire default lifecycle; E66's full-phase evidence is earlier.

Generated sanitized logs, removable when no longer needed:
`/private/tmp/cr-e67-initial.log`, `/private/tmp/cr-e67-async.log`,
`/private/tmp/cr-e67-regression.log`, `/private/tmp/cr-e67-final-focused.log`,
`/private/tmp/cr-e67-final-regression.log`, `/private/tmp/cr-e67-build.log`,
`/private/tmp/cr-e67-final-build.log`, `/private/tmp/cr-e67-compiled.log` and
`/private/tmp/cr-e67-queue.log`. These are test outputs, not downloaded dependencies.

## Still required before a real external store

This does not implement etcd/OpenBao, prove restart durability or finish production
configuration. The selected adapter still needs bounded authenticated transport,
exact trusted scope/generation configuration, restore separation, ambiguous-reply
handling and licensing/source pins. SQL timeout prevents late COMMIT; it does not
cancel an external request already sent. Shared transaction cancellation/deadline
propagation into external storage and prevention of additional writes after driver
invalidation must be qualified with that adapter. Do not infer those properties
from the awaitable interface or fake storage tests.

Historical stores not on the active Completion Gate path were not migrated. No
global memory fallback, second job authority, checkpoint reset or native execution
was introduced. E64/E65 candidate acceptance remains outstanding; production must
not be marked ready based on this block.
