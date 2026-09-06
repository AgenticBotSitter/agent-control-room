# CR14C node runtime — working evidence, not acceptance

Historical working evidence below preserves the interrupted build and its corrections.
Final scoped local acceptance is recorded separately in `CR14C_NODE_RUNTIME_ACCEPTANCE.md`.

## Implemented locally

Branch `codex/cr14c-node-execution-runtime` has production checkpoints `f0776f1` and
`1716188`, a disposable shared fixture at `bbca858` and journey tests integrated at
`039db23`. The retained-raw-request cap and focused regressions are committed at `b5e3cf8`.
`CR14C_NODE_RUNTIME_CONTRACT.md` describes the exact supplied-resource boundary.

The runtime joins authenticated intake, explicit start, saved progress/result reporting,
same-journal reconnect/replacement and separately permitted recovery status/stop. It does
not open a listener, provider, credential store or journal, and does not schedule or
implicitly start tasks. Supplied journals remain host-owned.

## Evidence already executed

- Stage zero: ready; no install or native qualification.
- Initial disposable smoke: queued run, exactly capabilities/start fake calls, one
  authenticated progress event.
- Four actual-journal journey tests passed: initial result into pending review, no
  duplicate start, disconnected reporting/reconnect, runtime replacement with retained
  journals, post-deadline stop once with separate status permission.
- Saved-source pin test plus retained-raw-slot bound test: two passed. The latter uses
  a fake clock and abort-ignoring promises; no third raw status call is entered and
  unsettled close remains uncertain until the fixture settles those promises.
- Prior combined source-pin/handoff regression:20 passed. Types and scoped lint passed
  after the raw-slot correction.
- Final broader local run:65 passed, zero failed/skipped, covering the two new files,
  execution handoff, node bridge, recovery authority and lifecycle test inventory.
  Full ESLint and the private VPS build also passed. These are repository/disposable
  results, not live native or physical database evidence.

## Review and retained findings

Independent review found saved-delivery pins checked too late, raw native promises not
tracked through cleanup, queued transports not owned before installation, and deferred
callback-capture gaps. `1716188` corrected these and static re-review considered them
sound. The reviewer then found unbounded accumulation of abort-ignoring raw requests.
Independent static re-review accepted `b5e3cf8` against `f38bdf0` with no remaining
actionable production findings. Actual raw promises retain slots until settlement;
abort wrappers cannot manufacture successful cleanup.

The initial typecheck caught a nonexistent derived binding property and an invalid
fixture queue lookup; corrected using the existing binding verifier and canonical queue
receipt. Scoped lint caught a single-assignment timer declaration; it is corrected.
The helper now supplies a valid stopping response instead of falsely interpreting its
old running-status response as a successful stop.

## Usage-limited integration handoff

The failure-test agent committed only `tests/native-node-runtime-denials.test.ts` at
`afb5e1b831e74fdee262d94c6412a387335d8a57`, branch `codex/cr14c-node-runtime-denials`.
That commit was preserved in its isolated source-only checkout while usage was exhausted.
Stage zero reported missing dependencies; no setup was performed.

The root cherry-pick request was rejected because the automatic approval-review service
reported a Codex usage limit. No alternate route, file copy, indirect integration,
publication or retry was used to bypass that rejection. The test agent also reported
a usage-limit failure. Preserve its existing commit; do not restart the packet from scratch.

After the owner restored usage, fresh account and GitHub checks succeeded and the ordinary
approved cherry-pick integrated the preserved test commit at `0c8fb09`. Initial central
execution reported 13 entries, eight passing and five failing (four causes plus parent):
the helper's mutable key resolver broke handshake, a fabricated foreign queue failed
schema validation before the target, replacement replay journals disagreed, and a
synchronous throw occurred before its rejection assertion. Author repair `68c071f`,
integrated at `6214b59`, corrected these fixtures. All 13 then passed; the combined
runtime/handoff/bridge/recovery/inventory run passed 78. Types, full lint and private
build passed; compiled managed-session plus updated pins checks passed five.

Independent test review then identified a foreign-queue false-positive: its fresh runtime
was disconnected, so rejection alone did not prove the queue guard. A separate focused
author correction `6161cf` was integrated at `3e47542` and independently accepted after
the final combined run passed78. Root `f89ef48` registers all new tests and races the retained
status entry against premature operation settlement. Complete the reviewed test correction
before publishing a stacked PR targeting `codex/cr14c-managed-native-input` (PR #342).
That prerequisite was freshly verified open/unmerged with all nine checks successful.
Do not mark this working record as acceptance.
PR #329 and all live/owner-signing/deployment gates remain separate.
