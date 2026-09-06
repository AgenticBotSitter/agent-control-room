# CR14C native evidence receiver — local acceptance

## Scope and disposition

Implementation through `ff5d542` has independent static review with no remaining
actionable production findings. Initial owned receiver, startup and compiled-path
verification passed, including corrected replay and cancellation evidence.
This is not live fleet,
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
  The correction uses the actual completed body in a fresh signed journal frame,
  without another native start/poll. All **7** receiver tests then passed, including
  cancellation during actual storage put: progress and bytes persist but no readback,
  metadata, submission or acknowledgement follows. Independent review accepted it.
- Types and scoped lint passed after integrating receiver tests and correcting
  the old failure injectors. Full lint passed before those test-only changes.
- Rebuilt private VPS artifact and all **30** existing compiled tests passed.
- New startup and compiled receiver tests: **15 passed**, including seven startup
  failure subcases, four restricted-role preflights, captured configuration,
  bounded admission/drain and exact completed-byte submission. The first typecheck
  caught a fixture inferring concrete in-memory storage instead of its interface;
  the isolated typing correction passed types and full lint without assertion changes.
- Both new source files and the compiled file are registered in standard test
  commands; all **8** CI inventory checks passed.
- The complete earlier capture/lifecycle regression rerun passed **30** tests.
  An additional metadata-precommit invalidation test then passed in the expanded
  **14-test** capture file. It proves metadata rollback with retained stored bytes;
  independent review accepted this test. Its query wrapper needed an explicit generic
  type annotation; runtime assertions were unchanged.
- The receiver test's concrete fixture storage inference also required widening to
  the constructor contract, without changing runtime assertions.
- Disposable migrations 0001–0056 passed, with **138 tables**. This is PGlite
  evidence, not a provisioned PostgreSQL service.
- Prerequisite PR #337 at `6dac246` has all nine GitHub checks successful in
  run `34013914346`; it remains open and unmerged.

No installs, native/provider calls, owner credential operations, listeners,
production database changes, deployment or merges were performed by this block.

## Remaining integration

The new compiled owned path proves initial-job delivery. Revised-result semantics
remain covered by the earlier result writer tests, not a new owned-receiver revised
job run in this block. Physical concurrency, session authentication resource ownership,
transport routing/recovery, owner signing and real deployment remain unconfigured.
Current-head GitHub CI and dependency-order integration remain required before merge.

## Retained CI isolation correction

PR #338 at `1dcbd95` failed the existing native-adapter isolation check in main-2
of run `34015087088`: the receiver imported the pure registration converter from
the adapter directory. Earlier static review verified purity but missed this stricter
directory boundary. The converter is moved unchanged into the neutral harness/v1
contract layer, with a compatible re-export at its old location and no change to the
isolation test. Independent review accepted the correction. The unchanged isolation,
observation and receiver tests passed **11** on the dependent integration checkout.
The corrected PR head still requires its own full CI; this failure is not erased.
