# CR14C canonical native progress — integration component acceptance

**Date:** 2026-09-05. **Disposition:** independently accepted, runtime activation unwired.
**Accepted product:** `f7d0c1115e0b3a321b3c9c9b6ee6efced83122eb`.
**Tree:** `ef934336fddc50f190092fa60712efcf9dcde2ab`.
**Base:** `fc199dd4abb80f7e6aa938067a41b746ae7148fd` (PR #288 handoff).
Branch: `codex/cr14c-canonical-native-task-integration`. Private publication is tracked in `BUILD_STATUS.md`.
This does not authorize a merge, runtime activation or live effect.

## Delivered

- Exact canonical attempt/lease registration and a shared bounded native observation schema/state graph.
  One admitted attempt can register only one native run; a replay never resets its progress.
- Native adapter snapshots project into content-free evidence: hashed handles/results, fixed state/reason
  categories and nullable upstream usage. Unknown start time, cost and cancellation cessation stay unknown.
- Durable node outbox, negotiated signed protocol delivery and current authenticated central intake.
  Per-run ordering, acknowledgement loss, reconnect and uncertain SQL acknowledgement preserve evidence
  without ever retrying a native task or provider request.
- Existing integrity-protected harness-run history records observations after durable SQL commit. It does
  not update canonical job/attempt/lease/effect/artifact/review authority or mark the owner workflow finished.
- An adapter-to-bridge-to-authenticated-SQL disposable fixture verifies the complete new evidence path.
  Existing legacy ingestion remains separate. No migration, dependency or live runtime enablement changed.

See `CR14C_CANONICAL_NATIVE_PROGRESS_CONTRACT.md` for exact limits and semantics. Node evidence capacity is
2,048 retained bodies; central native history is 1,024 observations per run. Capacity fails visibly, with no
automatic evidence eviction. Production retention and long-running capacity rehearsal remain required.

## Independent review and final checks

Initial candidate `3420792` was rejected for two Medium recovery defects and two Low ID/timestamp defects.
Corrections and three additional focused tests closed all four. Both reports remain in `docs/reviews/`;
the independent re-review accepted the exact product above with no remaining findings and **51 tests passed**.

All root checks used installed dependencies and returned exit 0:

| Check | Result |
|---|---|
| Stage zero | Ready; no installation |
| Focused registered `test:cr14c` | 74 passed |
| Registered pretest | 769 passed |
| Registered main test | 653 tests: 651 passed, two existing Windows-only skips |
| Registered posttest | 392 passed |
| TypeScript / full ESLint / whitespace | Passed |
| Private Node build / artifact checks | Passed / 9 passed |
| Preserved Sites build / render checks | Passed / 4 passed |
| Disposable migrations | 0001–0040 / 127 tables passed before correction; SQL inputs unchanged |

Both builds and all listed type/lint/pre/main/post/focused/artifact checks were rerun after correction.
There is no browser interface change in this block. Disposable SQLite/PGlite and injected transports are
not physical PostgreSQL, host-restart, network or live Hermes evidence.

## Remaining C-WORK delivery

Private project task/result pages, canonical draft creation, admission/effect/native dispatch composition,
verified final artifact transfer and owner review/revision remain. The accepted observation path is not an
active agent connection or complete useful-task journey. Real host qualification, dedicated profile/isolation,
private HTTPS topology and native cost/deadline limits retain their separate gates.

No listener, real database, credential store, actual agent/provider, deployment or merge occurred.
Continue the next authorized repository integration block on **Astra Xhigh**.
