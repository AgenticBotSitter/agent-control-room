# CR13A-LIVE-070 private-loopback framing acceptance

**Status:** exact product `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587` frozen; independent review required
before integration
**Integration base:** `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`  
**Effect boundary:** repository code and local tests only; no socket bind, listener, SSH session, credential access,
Hermes/provider call, native process, production PostgreSQL/VPS contact, deployment, DNS, or other network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackFrameDecoderV1` is the first byte-framing seam in front of the accepted
CR13A-LIVE-060 transport admission. It decodes exactly one frame with a four-byte unsigned big-endian payload length and
one fatal UTF-8 JSON payload. It does not accept a stream, socket, iterator, callback, request object, remote address,
host, route, username, credential, authentication assertion, or caller-supplied time.

Configuration is exact and admits only:

- `transport: "ssh_tunnel"`;
- `listenerVisibility: "private_loopback"`;
- `addressFamily: "ipv4"` and the literal `bindAddress: "127.0.0.1"`;
- `framing: "uint32-be-utf8-single-frame/v1"`;
- a 4,096 through `NODE_PROTOCOL_MAX_FRAME_BYTES` payload ceiling; and
- a 1 through 4,096 chunk ceiling.

These values are a future listener contract, not proof that a physical listener exists or is private. This block does
not import a networking or process-launch module and does not open a port or SSH connection.

## Binary and message boundary

Every supplied chunk must be an exact host `Uint8Array` that owns its complete ordinary `ArrayBuffer`. Buffer objects,
subclasses, Proxies, detached/shared storage, partial views, accessors, symbols, aliases, empty chunks, and oversized
chunks fail closed. Caller bytes are never modified. The decoder bounds both the declared payload and the number of
chunks, rejects incomplete and trailing data, and makes success or failure terminal. Internal header and payload buffers
are wiped on success, failure, or close.

The decoder uses fatal UTF-8. It parses only enough JSON structure to prove the message declares
`connection.enrollment.deliver` and to extract its syntactically valid delivery ID as an explicitly untrusted routing
hint. It does not authenticate the frame, accept the claimed tenant/node/key/connection, validate chronology, or approve
the inner enrollment. Those independent proofs remain exclusively in LIVE-050 ingress and LIVE-030 intake.

The protected internal record binds the exact raw frame, UTF-8 byte count, routing hint, framing contract, and listener
policy in one digest. `toConnectionEnrollmentTransportAdmissionInputV1` reduces that record to the exact two-field input
accepted by LIVE-060. The raw frame is protected server-internal data and may not enter logs, operator receipts, or
review evidence.

## Authority and runtime truth

The protected handoff explicitly denies approval, network, command, lease, and execution authority. The local pilot
exposes only `DisabledConnectionEnrollmentPrivateLoopbackListenerV1`; its `start` method returns the bounded `disabled`
result. The existing disabled node-ingress and transport-admission defaults remain unchanged. No browser or HTTP write
route is added.

The framing boundary captures and verifies the selected JSON parser, UTF-8 decoder, byte-length operation, regex
execution, reflection, typed-array cleanup, and the accepted node-ingress runtime before processing bytes. Runtime drift
fails with a bounded local code before changed behavior is used.

## Deterministic evidence

Current local evidence before product freeze:

- macOS stage zero: pass (`ready_for_runtime_check`), with no native attempt;
- TypeScript: pass;
- focused framing plus transport-admission tests: 21/21 pass;
- complete connection slice: 63/63 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  314/314 posttests;
- production build: pass, including 4/4 rendered-page checks;
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables;
- TypeScript, full ESLint, and whitespace validation: pass.

The exact product is frozen at `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`. Independent review remains required.

## Review and next boundary

Because this code accepts future transport bytes and carries a protected raw frame, one independent reviewer must inspect
the immutable base-to-product diff, reproduce the deterministic gates, and attempt bounded malformed-prefix, chunk,
UTF-8, JSON, state, Proxy/accessor, runtime-drift, digest-drift, and disabled-default cases. A rejection or uncertainty
cannot be converted into acceptance; remediation requires a new immutable product and a different re-review.

The zero-repair packet is `docs/reviews/CR13A_LIVE_070_INDEPENDENT_REVIEW_PACKET.md`, SHA-256
`052f4b621e8606f807425a677e10e5211214563d2e05b1235dc803dac42fd2e6`.

Even after acceptance, a real listener remains a separate owner-controlled block. It must prove the actual bind address,
exclusive port ownership, tunnel peer and host-key custody, connection lifetime, backpressure, close/recovery behavior,
and exact composition into LIVE-060. This acceptance cannot authorize a socket, SSH, credential, provider, native,
production-database, deployment, DNS, or public-hosting effect.
