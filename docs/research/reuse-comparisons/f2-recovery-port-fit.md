# Exact-ID recovery: current integration boundary

2026-09-08. Effect-free executed comparison; no native session/provider call.
Official documentation checked through OpenAI Docs:
https://learn.chatgpt.com/docs/app-server . It distinguishes stored thread/read
from resume/subscription and from turn/start generation. Pinned upstream source
and snapshot/usage limits remain in `f2-async-recovery-source.md`; refreshed docs
are not evidence that the pinned implementation changed.

## Actual finding, not another SDK wrapper test

Five assertions in `research/reuse-comparisons/f2-recovery-port-fit.ts` pass against
unchanged Control Room code. Receipt `f2-recovery-port-evidence.json` includes hashes.

- The initialized JSONL session and controller both refuse thread/read: the method
  is absent from CODEX_ISOLATED_CLIENT_METHODS_V1.
- Existing resume planning addresses the exact supplied thread but sets
  excludeTurns:true. It does not retrieve a historical turn snapshot.
- Missing identity fails. A refused read leaves no pending request; close is final.

The launcher supplied here is only the planner's minimal inert accessed data,
not a full accepted topology/launcher or credential attestation. No dispatch ledger
operation is allowed by the fixture. The test does not exercise an upstream SDK,
actual read response, known-ID usage recovery or production reconnection.

Source inspection of isolated-runtime.ts additionally shows that an authorized
resume request proceeds from thread/resume into planning/sending turn/start.
That operation means continuing a conversation with new input, not merely finding
the outcome of a disconnected old attempt. Do not reuse it as automatic recovery.
The current qualification implementation need not be defective for its original
bounded purpose; it is simply not the complete production reconciliation port.

## Effect on candidate cost and next experiment

Existing direct transport is not a zero-change incumbent for read recovery.
It needs a distinct reviewed read-only operation/method scope and exact persisted
thread/turn binding. The official SDK exposes thread/read already, but still needs
the same Control Room result/identity/usage reconciliation; its asynchronous facade
does not fix the previously observed event registration behavior. Neither option
earns a whole-client selection from these five assertions.

Do not broaden the qualification method allowlist just to make research pass.
Next compare the actual pinned SDK read method through a synthetic peer and a
separate explicitly research-only current-port adaptation. Validate absent/wrong
thread, absent/duplicate/wrong turn, incomplete item views, active/failed/completed
states. Record a snapshot as observation, never a manufactured native event or
settlement. Missing attributed usage remains unknown; no new turn/start is allowed
in this recovery comparison. Separately evaluate known-ID registered resume only
as an effectful subscription with exact matching usage, not arbitrary historical
usage retrieval. Prior unknown-ID start uncertainty remains unrepairable by guessing.

Implementation packet must distinguish three operations visibly: inspect retained
state, reconnect/subscription, and start a new turn. Preserve budgets, attempt IDs,
uncertainty and existing pending approval. This is required glue whichever supported
client is selected, not a justification for a second custom native protocol.
