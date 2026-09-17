# Hermes Bot Mode bridge (IDEA-005)

The bridge in `src/harness/hermes-bot-mode-v1/` maps Hermes Bot Mode room
discussions into canonical project work. Room messages are evidence and
proposals only — Control Room remains the authority, structurally: no
approve, dispatch, or publish surface exists anywhere in this package.

## Files

- `room-observations.ts` — injected room snapshots: selected participants,
  bounded rounds with message limits, and the id-keyed event stream.
- `reconcile.ts` — id-keyed merge with a consume cursor.
- `room-proposals.ts` — room results proposed as decision/task envelopes.

## What the bridge preserves

Selected participants, rounds, limits, and source contribution identities
pass through reconciliation untouched into every view and proposal.
Missing/failed participants and disagreements are carried visibly — never
dropped, never resolved here. A proposal from a contested room is allowed
but marked `contested` with the disagreement digests attached.

## Reconnects without repeat work

A reconnect replays the stream. Events already seen drop as duplicates,
late gap-fills (new ids below the cursor) merge without moving the cursor,
and sequence gaps are listed in `missingSequences` and carried forward
across batches via `nextCursor` until filled. Nothing is reprocessed.

## Fail-closed gates

Unsupported Bot Mode versions (`bot_mode_version_unsupported`) and
capabilities (`bot_mode_capability_unsupported` — tools must be disabled,
provider calls zero, discussion-only) are refused before any reconciliation
or proposal work. Unknown result ids (`bot_mode_result_unknown`) and rooms
with no selected participants refuse at proposal time.

## What the bridge never does

No Hermes call, no room creation, no credential, no deployment. Observations
are injected and disposable (recorded transports in tests). A room result
can propose a decision or task; it cannot approve, dispatch, or publish it —
the proposal envelope's grants are literal `false` and the type has no
execution fields to set otherwise.
