# CR14C — supplied-resource coordinator lifecycle acceptance

Date: 2026-09-05. Accepted product: `3a8274f00228653e0f67a883e7e088897aae627c`.
Tree: `fbfa2c0ffe0d141a700ffce89a1e3984d47c17f9`.
Base: `ecedfcaf2b6ff132181adf6bedfb25193372a5ed` (PR #296).

## Delivered

- Owned planning/assignment services with scoped operations, at most eight active requests and no
  pending admission queue. Templates, routes and key material remain internal snapshots.
- Readiness drops before shutdown. Admitted work drains; deadline expiry invalidates later SQL and
  precommit checks, closes the supplied pool once and preserves uncertain-save reconciliation.
- Combined private task application with distinct web/control-plane resources, bounded cleanup on
  both normal shutdown and failed construction, and actual restricted web-role assignment tests.
- Inert private Node `taskApplication.js` factory and compiled protected API/cleanup integration.
  It is not installed into the existing production bootstrap or compiled-page singleton.

## Verification

Independent final review accepted with 45 passes and no remaining findings. Two P2 shutdown ordering
bugs were reproduced in failing regression tests and fixed: late committed acknowledgement during
forced cleanup, and an obsolete drain timer firing during healthy pool cleanup. See
`reviews/CR14C_TASK_COORDINATOR_LIFECYCLE_REVIEW.md` for immutable heads and initial results.
An initial TypeScript test-fixture optional-key mismatch was corrected with an explicit assertion;
no runtime key generation, fallback or dependency change was introduced.

Final root checks, all exit 0:

| Check | Result |
| --- | --- |
| Effect-free stage zero | ready_for_runtime_check; native readiness not run |
| TypeScript, ESLint, whitespace | Passed |
| Lifecycle tests | 14 passed |
| Registered focused CR14C | 237 passed |
| Registered pretest | 769 passed |
| Registered main | 816 total: 814 passed, 2 existing Windows-only skips |
| Registered posttest | 392 passed |
| Private production build / compiled artifact tests | Passed / 14 passed |
| Sites production build / rendered route tests | Passed / 4 passed |
| Disposable migration verification | 0001–0045; 132 PostgreSQL tables; schema unchanged |

Tests cover normal drain, refused excess admission, late callbacks, precommit rollback, already-committed
lost replies and exact reconstruction, failed/stalled close, failed construction cleanup, revocation and
the real restricted web role. Mocked timers cover timer ordering; injected resource termination and
PGlite are not evidence of real PostgreSQL socket cancellation/concurrency or OS process cleanup.
Installed dependencies were used directly through Node. Sites guidance preserved both build profiles;
no hosting, preview server or browser interaction was performed.

## Remaining and next block

The supplied resources must still be verified and owned by a trusted production bootstrap. Distinct
client object references are not proof of distinct physical pools, nor does an isAvailable callback
attest to database permissions. Implement the coordinator role/schema gate and mount both resources
through the actual shared startup/page-handler path next, on **Astra Medium**.

Then complete signed execution approval, local admission, dispatch, physical result transfer and
bounded revisions. Existing production startup remains unconfigured for planning/assignment.
No live database, credential-store access, native/provider call, listener, deployment or merge occurred.
