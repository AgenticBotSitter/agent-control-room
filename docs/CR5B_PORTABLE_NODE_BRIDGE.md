# CR-5B portable node bridge core

**Status:** Complete 2026-08-22  
**Scope:** Platform-neutral connection state machine, inbound loop, heartbeat scheduling, acknowledgements, reconnect/reconciliation, backpressure, and durable local SQLite journal.  
**Stop boundary:** No platform private-key store, local authority ceiling, harness, executor, live WebSocket, service installation, credential broker, or project integration was created.

## Portable boundary

The bridge core depends on four injected seams:

- `BridgeTransport` / `BridgeIncomingTransport` for an outbound-created message stream;
- `BridgeFrameSigner` for signatures without access to private-key storage details;
- `NodeProtocolAuthenticator` for the locally trusted Control Room public keys;
- heartbeat resource snapshots supplied by the platform host.

The core has no Hermes, Codex, Claude, project, VPN, Cloudflare, macOS, Windows, or Linux-specific logic. CR-6 will package the same core under native service supervisors; CR-7 adapters will sit behind the command queue rather than changing this protocol.

## Connection lifecycle

```text
stopped/backing_off
  -> connecting
  -> authenticating (signed connection.hello sent)
  -> reconciling (signed connection.accepted verified)
  -> online (reconciliation report sent)
  -> backing_off on transport loss
```

The incoming loop accepts only signed server frames bound to the active connection ID. Negotiated protocol, maximum frame size, feature subset, and heartbeat interval are checked before the bridge becomes schedulable. Reconnect delay is deterministic exponential backoff capped at 60 seconds; the platform host owns sleeping and process supervision.

`tick()` makes heartbeat scheduling deterministic and testable. It produces a snapshot only when the negotiated interval is due, so an expensive platform probe is not run on every host tick.

## Acknowledgement and retry semantics

CR-5B adds `protocol.ack` and a frame digest to durable replay records.

- A first valid signed frame is `accepted` and may be processed once.
- An exact retry with the same message ID, nonce, connection, sequence, signature, and complete-frame digest is `duplicate`; it is acknowledged but never processed again.
- Reuse of either message ID or nonce with different signed content remains a replay conflict and fails closed.
- Acknowledgement frames do not themselves require acknowledgement, preventing acknowledgement loops. They are journaled and locally retired after successful send.

This preserves the security replay boundary while supporting at-least-once delivery when a frame arrived but its acknowledgement was lost.

## Local SQLite journal

`SqliteBridgeJournal` uses the Node 22 built-in SQLite runtime in WAL mode. It durably stores:

- per-connection inbound and outbound sequence heads, plus received-versus-processed inbox state;
- signed outbound frames and send/ack/expiry state;
- authenticated inbound replay identity;
- queued server commands;
- unresolved attempt, lease epoch, event sequence, and checkpoint summaries.

Bodies pass the central secret-material guard before persistence. The journal never stores private keys or resolved credentials. One supervised bridge process owns one journal; multi-process writes are not a supported topology.

On restart, unacknowledged durable lifecycle frames remain available. After a new handshake and reconciliation, obsolete old-connection `connection.hello`, heartbeat, and acknowledgement frames are retired, while unexpired job lifecycle frames are resent exactly. Attempt summaries populate the signed reconciliation report.

Authentication receipt and handler completion are separate durable states. If the process dies after signature/replay verification but before command queueing, the exact retry remains eligible for handling. Only a `processed` inbox row may take the duplicate-only acknowledgement path.

## Backpressure

The journal has a configured pending-frame ceiling.

- When an unsent nonessential heartbeat is already retained, a newer heartbeat may be coalesced before sequence commitment; signed sequenced frames are never deleted or renumbered.
- Sent/unacknowledged frames are never silently removed.
- Nonessential work fails closed at the ceiling.
- A bounded 64-frame reserve lets essential acknowledgements/reconciliation continue instead of deadlocking behind telemetry.
- Expired frames are retired before reconnect replay.

CR-5C decides whether an offered command is locally authorized. CR-5B only verifies and queues it; queueing is not permission to execute.

## Verification

The bridge tests prove:

- signed hello, negotiated acceptance, reconciliation, command queueing, duplicate acknowledgement, and heartbeat timing;
- SQLite close/reopen recovery of unacknowledged frames and unresolved attempts;
- heartbeat coalescing, essential reserve, and fail-closed overflow;
- atomic sequence/outbox commitment with no gap on signing or backpressure failure;
- transport failure durability and bounded reconnect backoff;
- retirement of obsolete control frames with resend of durable lifecycle frames;
- inbound stream termination transitions to reconnect state;
- exact retry classification versus conflicting message/nonce rejection;
- recovery of an authenticated-but-not-yet-processed frame before acknowledgement.

CR-5C is the next security boundary: platform key-store implementations, immutable local authority ceilings, command/effect validation, and denial receipts.
