# Independent current-runtime ordering disposition review

2026-09-08; local source-only review at `0d3031d` plus current research changes.
No tests, downloads, native calls or application changes. Root retains protocol
selection. Reviewed the complete disposition and Python ordering source report,
`src/harness/codex-v1/isolated-runtime.ts`, and the actual scripted-runtime tests in
`tests/codex-harness-contract.test.ts:1227–1402`.

## Disposition

No blocking contradiction found. The disposition appropriately corrects a false
equivalence between **safe refusal** and **successful supported ordering**. Neither
the current qualification runtime nor the pinned synchronous SDK is established
as the complete production lifecycle solution by this packet.

## Confirmed against local source

- `isolated-runtime.ts:59–73` has one sequential request reader. It returns the
  matching response without independently consuming the next frame. At 203–206 the
  caller extracts and binds the turn before reading notifications. Thus this class
  does not itself have a separate reader/requester queue-registration race for
  response-first frames. This relies on the injected transport preserving unread
  frames; it is not proof of every process adapter or transport implementation.
- At 199–202 the early-notification callback ignores the notification contents and
  always throws. It cannot distinguish stale/unrelated events from a legitimate
  start, usage or completion for the eventual response's turn. A same-turn early
  event is therefore unsupported in this code, not recovered or reconciled.
- The catch path at 210–216 attempts ambiguous observer/ledger settlement and
  throws; finally closes the transport. There is no automatic second start in
  this path. Ambiguity is not evidence that the remote turn did not execute or
  that remote cancellation succeeded. Settlement persistence is also not proved
  merely by invoking the port: the observer's `disconnect` catches settlement
  failures for reconciliation (`isolated-jsonrpc.ts:200–205`).

## What the existing tests actually establish in source

`ScriptedAppServerTransport.write` synchronously queues response then start, usage
and completion (1250–1268). The test **“CR7B qualification runtime completes one
fake-transport turn and returns sanitized evidence”** asserts exact lifecycle and
usage events, sanitized thread binding, closed transport, replay-completed ledger
result and the exact outbound method sequence containing one turn/start
(1281–1306). This is an eager response-first baseline, not a delayed-after-binding
fixture and not a real native result.

The `stale` mode inserts `turn:stale` before a response for `turn:runtime:one`
(1257–1260). **“CR7B qualification runtime binds correlated turn identity and
reports failed or interrupted truth”** checks that case rejects with protocol
invalid (1346–1352). It does not supply a same-turn event before the response;
nor does this particular stale assertion check settlement/replay or closure.
Those must not be attributed to that assertion merely because related negative
tests check them.

The forbidden-request/missing-usage/disconnect test explicitly checks ambiguous
ledger replay and closed transport (1354–1373); the deadline/cancellation test
checks the corresponding ambiguity codes (1375–1402). All use in-memory broker
state and synthetic line transport. Their source does not qualify restart-durable
storage, current environment RPC compatibility, live cancellation or a complete
production connector. These tests were read, not rerun in this review.

## Python comparison and next experiment

The linked Python report expressly separates a source scheduling inference from
native reproduction. Response waiter delivery without requester registration
acknowledgment permits an independent reader to consume completion first; a
response-before-events wire convention alone does not exclude that local schedule.
The report also stops short of proving the entire server call graph has no other
ordering constraint. Its upstream files were fetched memory-only by root, not
retained or independently re-fetched here; this review checks the reasoning and
its stated scope, not a new independent upstream-source acquisition.

The proposed two-sided next fixture is justified: same-turn early events through
the actual current runtime, separately from stale events; response-first controlled
requester scheduling through the unchanged pinned Python client. Preserve exact
identities, bounded termination, real usage availability and no duplicate start.
Any claim of durable settlement/reconciliation needs the actual durable seam,
not just the existing in-memory fixture. A supported snapshot must not be relabeled
as the missing event/usage stream. Nothing in this review authorizes a bespoke
router, protocol change or production component removal.
