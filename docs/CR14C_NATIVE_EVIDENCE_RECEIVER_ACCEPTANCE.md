# CR14C native evidence receiver — verification in progress

## Scope and disposition

Implementation through `ff5d542` has independent static review with no remaining
actionable production findings. Integrated acceptance is **pending** startup,
compiled-path and corrected receiver replay evidence. This is not live fleet,
physical PostgreSQL, provider or deployment acceptance.

The receiver derives the run from authenticated stored delivery, records signed
progress, captures and reads back exact result bytes, then submits the saved result
for review. Optional four-role startup owns its resources without widening existing
web, coordinator or result permissions. See `CR14C_NATIVE_EVIDENCE_RECEIVER_CONTRACT.md`.

## Retained review and verification evidence

- Initial review identified arrival-time registration rejecting valid earlier node
  progress. `5c2b1e8` uses authenticated node `recordedAt`, bounded by the saved
  intent and receipt times. Independent review accepted the correction.
- `ff5d542` captures a separate delivery integrity key instead of incorrectly
  reusing the planning key. Independent follow-up review found no issues.
- Existing role, coordinator, startup and result tests: **91 passed**.
- Initial capture/lifecycle regression run: **28 passed, 2 failed**. Both failure
  injectors wrapped the old transaction API and never reached their intended
  failure after capture adopted the precommit API. Updating the injectors retains
  actual rollback and lost-acknowledgement assertions; all **13** capture tests
  then passed in the focused combined run.
- Initial restricted receiver run: **5 passed, 1 failed**. The full initial
  result capture/submission reached replay, but the fixture requested a new queued
  frame after its prior frame had already been acknowledged; no frame existed.
  Replay evidence remains pending a focused fixture correction.
- Types and scoped lint passed after integrating receiver tests and correcting
  the old failure injectors. Full lint passed before those test-only changes.
- Rebuilt private VPS artifact and all **30** existing compiled tests passed.
- Disposable migrations 0001–0056 passed, with **138 tables**. This is PGlite
  evidence, not a provisioned PostgreSQL service.
- Prerequisite PR #337 at `6dac246` has all nine GitHub checks successful in
  run `34013914346`; it remains open and unmerged.

No installs, native/provider calls, owner credential operations, listeners,
production database changes, deployment or merges were performed by this block.
