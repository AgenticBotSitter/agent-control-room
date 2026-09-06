# CR14C node execution and reporting runtime acceptance

## Delivered and reviewed

`createNativeNodeRuntime` owns supplied node resources for one exact queue/enrollment:
authenticated intake, explicit native start, observation, separately authorized recovery,
saved reporting, reconnect and bounded cleanup. Receipt alone never starts work. The
runtime opens no listener, journal, credential store or provider connection by itself.
See `CR14C_NODE_RUNTIME_CONTRACT.md`.

Independent static production review accepted `b5e3cf8` against `f38bdf0` with no
remaining actionable findings. Independent test review accepted `3e47542` with the
root-owned regression/registration at `f89ef48`. Production was unchanged during those
test corrections. Reviewers did not run native or central tests; execution below is
root-observed. The delegation-review workflow kept authorship, review and integration
separate.

## Executed evidence

- Stage zero returned `ready_for_runtime_check`, exit 0. No install or qualification.
- Final combined runtime integration, pins, denials, execution handoff, node bridge,
  recovery authority and test-inventory run: 78 passed, zero failed/cancelled/skipped.
- Four actual-journal journeys cover explicit start, completed bytes into pending
  review, disconnected reporting, retained-journal runtime replacement and separately
  permitted post-deadline stop/status without duplicate native start.
- Two focused regressions cover exact saved server-key pins before native preparation
  and two abort-ignoring raw requests retaining capacity until actual settlement.
  A third cannot enter transport; unsettled cleanup remains uncertain.
- Thirteen denial entries cover captured configuration/callbacks, malformed and
  wrong-pinned input, foreign queue on a handshaken connection, cancellation, queued
  transport ownership, reentrant enqueue and the bounded wire FIFO.
- Rebuilt private VPS artifact passed. Compiled managed-session tests plus updated
  root pins tests: five passed. TypeScript and full ESLint passed; TypeScript and
  changed-test lint passed again after the final test-only correction.
- All three new test files are in the standard package test lifecycle. No migration
  changed. This record does not claim a new full lifecycle or physical DB rehearsal.
- Prerequisite PR #342 at `f38bdf044283c09c4fd58a6b5584012d36a19797` was verified
  open/unmerged, with all nine checks successful in run `34019386115`.

## Retained failures and corrections

Production review found late saved-source pin verification, deferred callback capture
gaps, missing queued-transport cleanup ownership and underlying native promises omitted
from drain. `1716188` corrected these. Review then found possible accumulation of raw
abort-ignoring requests; `b5e3cf8` caps them at two, retains slots through actual settlement
and preserves uncertain bounded cleanup.

Initial type/fixture errors and the temporary usage interruption are recorded in
`CR14C_NODE_RUNTIME_WORKING_EVIDENCE.md`. Once usage was restored, ordinary approved
Git integration resumed; no rejection was bypassed. Worker source-only checkouts had
missing dependencies and performed no installation or runtime verification.

The first central denial run reported 13 entries, eight passing and five failing
(four causes plus a parent): mutable fixture resolver key, invalid fabricated dispatch
binding, mismatched replay journal and synchronous throw outside its assertion.
Author repair `68c071f` integrated as `6214b59` passed all 13. Independent test review
then caught a disconnected-runtime false-positive in the foreign-queue case. Author
`6161cf` integrated as `3e47542` uses the actual handshaken runtime and its transport
closure. Native-entry waits now surface premature operation settlement; the start gate
has cleanup release. Root `f89ef48` similarly strengthens the retained-slot test.
Final combined 78-pass evidence includes these corrections. A non-blocking test
robustness note remains: two fake transport-open entry waits can report cancellation
rather than a focused error if opening regresses before entry.

## Limits and next block

This is supplied-resource repository acceptance, not a deployed or live Hermes route.
Provider responses are synthetic; SQL/node journals are disposable. Close/cancellation
does not prove physical stop. Owner signing custody, persistent supervisor/profile
sources, credentials, host installation and real transport qualification remain separate.
Draft PR #329 is not adopted, retried or accepted here.

Next: production ownership of the signed-frame/result-byte transport handoff. The
current fixture still selects completed snapshots, reads exact saved bytes and passes
them to server input. Replace that application-aware test step with reusable bounded
node/server transport ports, preserving authenticated ordered delivery, exact result
binding, cancellation, reconnect and cleanup. Do not import the native adapter into the
web application, introduce another scheduler or implicitly start a task. Astra Medium
remains the root allocation; live effects still require scoped owner authority.
