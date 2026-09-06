# Native signed-frame and saved-result wire handoff

Status: implementation contract, not accepted or live. Local-only owner instruction applies.

## Purpose

Replace the application-aware fixture step that identifies completed native snapshots,
reads result bytes and supplies them to server input. Preserve existing signed protocol,
native runtime and managed server input authority. No second scheduler, implicit start,
owner signer, provider, physical transport or listener is introduced.

## Boundary

A versioned transport packet carries one unchanged signed raw JSON frame and optional
canonical base64 result bytes. This outer packet is not new authority: the receiving
existing runtime/input must still verify signature, identity, connection, replay and
canonical task binding. Bytes must match the completed snapshot's exact size and SHA-256
claim. They are forbidden on any other frame or on the server-to-node direction.
Parsing/encoding must preserve the raw signed frame, not silently normalize its contents.
The packet is limited before JSON parsing; raw frames retain the existing 128KiB ceiling,
native snapshots 16KiB, and result bytes 64KiB. Transport endpoints must enforce packet
limits while collecting physical input too; a bounded decoder alone does not bound a
future HTTP body's buffering.

Node output uses only the exact saved result reader, never a provider call or caller's
arbitrary bytes. Server input decodes once and delegates to the existing bounded ordered
managed input. Node inbound packets delegate to the existing pinned runtime receiver.
The application must not import the Hermes adapter implementation.

## Lifecycle

Adapters capture supplied callbacks before use and delegate lifecycle to the existing
owners. Every accepted transport has one cleanup owner; malformed input closes its
connection and surfaces a fixed error, never raw packet/result text. Queue admission,
timeouts, late completion and uncertain close retain existing runtime behavior.
Physical send completion means bounded transport acceptance, not canonical result
acceptance. Supplied send ports must not wait for application processing or its reply;
that would create a cyclic wait through the existing protocol send queues.

Reconnect creates a new transport generation over retained journals. Re-emitted completed
snapshots retrieve matching saved bytes, never regenerate results or restart execution.
Unsupported/missing packet versions, wrong direction, missing/extra/tampered result
bytes and malformed/oversized content fail closed. No raw diagnostics enter evidence.

## Required evidence

- Real disposable journals and existing signed node/server owners, fake provider and
  opaque packet transport: explicit start, completed artifact into exact pending review.
- Reconnect/replacement retains saved result bytes and canonical evidence without a new
  native start or dispatch. The fixture may shuttle packets, but may not parse their
  types, choose application operations or call the saved result reader itself.
- Negative codec/ownership cases, mutable input capture and cancellation/cleanup.
- Existing runtime/input and compiled application regressions; adapter isolation.

Repository tests are not live HTTPS, host installation, owner-signing or production DB
evidence. Those effects and GitHub publication remain outside this block's authority.
