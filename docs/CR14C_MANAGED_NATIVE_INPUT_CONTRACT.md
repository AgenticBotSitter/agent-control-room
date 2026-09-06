# CR14C managed native input

## Purpose and scope

The runtime owns the ordered stream supplied by a trusted transport host. This removes
the manual frame classification and recovery step from the retained-journal test driver.
It does not open a listener, activate an agent, issue an approval or implicitly send work.

`connections.attachInput(nodeId, transport, configuration)` returns a frozen facade with
`receive`, `stage`, `transmit`, `close`, node identity and a false execution-authority flag.
The existing raw `attach` API remains available for separately composed callers.

## Ordering and ownership

- Capture one strict configuration: initial or recovery mode and an exact project, job,
  attempt and input digest. The authenticated frames cannot retarget it.
- A single FIFO includes hello, protocol acknowledgements, reconciliation reports,
  dispatch receipts, snapshots and explicit owner stage/transmit commands.
- Initial reconciliation enables explicit staging and transmission only. A recorded
  receipt must match the configured attempt; its durable run and review registration
  finish before queued progress is processed.
- Recovery reconciliation restores only the exact already-recorded run before the next
  queued snapshot or trailing acknowledgement. It cannot stage, transmit, register a
  fresh run, renew a lease or restart a native run.
- Parsed frame types are routing hints, not authentication. Existing signed protocol,
  replay, scope and session-generation checks remain authoritative.
- Result registration and submission check source-session currentness inside their
  separate database transactions, including final precommit. A later outer rejection
  is not an adequate substitute for that fence.

## Bounds and failure

At most 16 pending operations, including the active operation, and 1 MiB captured input
are accepted. Frames are at most 128 KiB, snapshots 16 KiB and accompanying result bytes
64 KiB. Commands are strict, bounded copies charged at their serialized size. Waiting
counts against the ten-second operation deadline; dequeuing does not renew that deadline.

Malformed input, overflow, cancellation, expiry, processing failure or unavailable
ownership closes the stream. A failed frame is never dropped while its queued suffix
continues. Closing aborts pending input operations and delegates exact-once transport
cleanup to the existing bounded session owner. Uncertain cleanup remains uncertain.

Transport `send` may enqueue an incoming callback, but must not await completion of a
callback that depends on the sending FIFO operation. Hosts must preserve wire order.
The input owner cannot repair an upstream host that discards or reorders messages.

## Acceptance

Require actual signed protocol and retained-journal integration for initial receipt /
progress and reconnect snapshot / acknowledgement bursts, plus bounded fake-handle
tests for queue failure and cancellation. Verify no extra native calls or dispatch on
recovery, private facade shape, and source invalidation at result precommit. Preserve
failed tests and corrections. No live fleet, physical PostgreSQL or deployment claim
follows from these disposable tests.
