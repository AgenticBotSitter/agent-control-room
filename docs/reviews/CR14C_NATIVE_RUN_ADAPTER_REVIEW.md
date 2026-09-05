# CR14C native-run adapter — initial independent review

**Disposition:** rejected; two P2/Medium correctness findings. No other findings.
**Product:** `32a62387973bc14bd8e12f82c8659b33898b481e`.
**Tree:** `31f3275c4bfe54fcf84579c93368abe33ae76ad6`.
**Base:** `dfc1f3609271ace0adc504ec0c9ebbf2e7005ea7`.
**Reviewer:** independent `cr14c_native_adapter_review` agent; no authorship, edits or self-approval.

1. `adapter.ts` original lines 125–145: observation holds the exclusive run operation through SSE and
   status, so a normal concurrent cancellation fails with `native_run_busy`. Provide cancellation-priority
   interruption/handoff for the owned observation while preserving one-use stream and stop semantics.
2. `adapter.ts` original lines 150–156 / `run-journal.ts` line 121: another adapter can advance the journal
   during a pending stop request. The acknowledged response and fallback then both save with a stale
   version. This discards the acknowledgement while preserving stop intent. Reconcile against current
   durable state, preserving terminal results or the acknowledgement without repeating the native stop.

Both were source-inspection findings; the initial tests did not cover those normal interleavings.
The authenticated start response supplies native-ID provenance. Another ownership handshake was not
required solely against a hypothetical dishonest authenticated server. Snapshotting private wire aliases
was considered worthwhile hardening, not a demonstrated blocking caller-boundary issue.

Independently ran the five registered `test:cr14c` files using installed Node/tsx: 43 passed, no failures or
skips, exit 0. Reviewed all 13 changed files, the delegation skill, active status and integration direction.
No network, credentials, native invocation, install, deployment, file edit or build was performed. Upstream
facts were taken from the architect's pinned source contract; broader checks remain root-owned evidence.
This report covers the initial product only. Corrections and re-review are separate; the rejection is retained.
