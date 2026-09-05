# CR14C native execution handoff evidence

Date: 2026-09-05. Accepted product: `34bfeff0d3c3954999ed53a4edf921570af3b342`.
Tree: `9742d11534f3fa27083d69f33b01d5657408ae24`.
Base: `fa9cba64d392058ea660785e5e128747b66d210b` (PR #323).

Independent re-review accepted the corrected product without remaining findings. Command:

```sh
node --import tsx --test tests/native-execution-handoff.test.ts tests/native-start-authority.test.ts tests/node-native-intake.test.ts
```

Exit zero: 51 passed, zero failures/skips. Actual canonical assignment, signed approval storage,
transmission and node intake feed the existing local admission/effect/run controllers. Synthetic
transport completes capabilities/start/status. Reopening the recorded run does not repeat its start.
Preparation itself performs no native calls and reserves no run. Tests cover current owner/server
revocation, cancellation, expiry/rollback, local pause/profile rejection, forged provenance, missing
source, bounded stalled key lookup and ambiguity immediately before start bytes.

Negative evidence retained: the initial fixture mistakenly compared independently generated task
bindings; 12 tests failed before exercising the handoff. Sharing the canonical assignment fixture
corrected setup without weakening the binding assertion. Initial product `6a4eabf` passed 50 focused
checks, but independent review M001 found the clock watermark advanced only after the expiry guard.
The correction records validated monotonic time before temporal rejection; a regression proves expired
observation followed by rollback cannot reserve a run or invoke transport. Broad checks started before
this correction are not final frozen-product evidence.

See `CR14C_NATIVE_EXECUTION_HANDOFF_CONTRACT.md` for private storage, lifetime and recovery limits.
All data, keys and transports are synthetic; stores are disposable. No real agent/provider call,
credential operation, physical listener, production database, deployment or merge was performed.
This is in-process integration, not acceptance of the live project-task workflow.

Final corrected-product verification exited zero: CR14C 543, preparation 769, main 1,127 with two
existing platform skips, post-suite 392. Both builds, private compiled 18, rendered 4, migrations0052/138
tables, TypeScript, full ESLint and diff whitespace checks passed. Current-head GitHub CI remains
required before dependency-order integration; these local checks do not imply a merge.
Published as [PR #324](https://github.com/MarvinAi5/control-room/pull/324), stacked on #323.
