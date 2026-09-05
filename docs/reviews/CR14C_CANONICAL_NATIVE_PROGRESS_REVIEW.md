# CR14C canonical native progress — independent review

Disposition: **REJECTED**; preserve this original finding set. Corrections require a separate re-review.

- Reviewer: independent agent `cr14c_native_progress_review`; no implementation or file edits.
- Candidate: `342079280b56e99ba0c35a41c360d2ff8271f89b`.
- Tree: `cf90a1f9a0b0264fd63e3eceb69c4f4e852d2a61`.
- Base: `fc199dd4abb80f7e6aa938067a41b746ae7148fd`.
- Mode: bounded read-only independent acceptance review, synthetic/disposable tests only.

## Findings at the candidate

1. **Medium — uncommitted earlier snapshot can be overtaken.** `src/node-bridge/bridge.ts:221`
   sends newer snapshots without the older durable acknowledgement; authentication can consume an
   earlier delivery whose business transaction fails. If a newer observation commits, the old version
   cannot later pass the central progress/terminal guard and can remain unacknowledged.
2. **Medium — healthy-connection lost ACK has no recovery opportunity.** `bridge.ts:216` only
   flushes pending bodies; staged observations only expire during reconciliation. A silently lost ACK
   can therefore strand evidence indefinitely without a disconnect.
3. **Low — correlation ID overflows for valid long attempts.** `bridge.ts:222` prefixes a possibly
   160-character attempt ID with `correlation:` even though the envelope's correlation bound is 160.
4. **Low — cancellation can invent a start observation.** `src/harness/v1/store.ts:218` treats
   first observations of stopping/cancelled/interrupted as execution-bearing, although those states
   can follow queued without observed execution.

Root also identified a registration invariant to strengthen: only one native run may register for an
exact canonical attempt; serialize that check on the attempt. This was not an additional independent
finding and is recorded separately from the reviewer's four findings.

## Evidence

Reviewer ran stage zero (ready), the six-file focused suite below (48 passed, zero failed/skipped),
TypeScript (`--noEmit`, exit 0), and exact candidate diff whitespace check (exit 0):

```sh
node --import tsx --test tests/native-task-observation.test.ts tests/native-task-store.test.ts tests/native-task-bridge.test.ts tests/hermes-native-journal.test.ts tests/node-bridge.test.ts tests/harness-run-store.test.ts
```

The review found that evidence/authority separation otherwise held in scope: no canonical job,
attempt, lease, effect, artifact or review decision was mutated by snapshots. Native authority and
runtime activation remained unwired. Passing tests did not cover the newly identified recovery gaps.
No install, network, credentials, services, native agent, build, deployment or merge was performed by
the reviewer. These are code-path conclusions and disposable test evidence, not real-host qualification.
