# CR13A-LIVE-070 private-loopback framing acceptance

**Status:** accepted for immutable product `8e4c20da7166d48cb22c06fd38dfe87ee0016a02` after a different independent
re-review closed all two Medium and two Low findings with no new defect; integration remains owner-controlled
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

Every supplied chunk must be an exact host `Uint8Array` that covers its complete ordinary `ArrayBuffer`. Buffer objects,
subclasses, Proxies, detached/shared storage, partial views, accessors, symbols, empty chunks, and oversized chunks fail
closed. JavaScript cannot prove that another full view of an ordinary buffer does not exist, so the decoder makes no
exclusive-ownership claim. It synchronously copies accepted bytes into private storage and retains no caller buffer;
later mutation through any ordinary alias cannot change the decoded result. The decoder bounds both the declared payload
and the number of chunks, rejects incomplete and trailing data, and makes success or failure terminal. Internal header
and payload buffers are wiped on success, failure, or close.

The decoder uses fatal UTF-8. It parses only enough JSON structure to prove the message declares
`connection.enrollment.deliver` and to extract its syntactically valid delivery ID as an explicitly untrusted routing
hint. It does not authenticate the frame, accept the claimed tenant/node/key/connection, validate chronology, or approve
the inner enrollment. Those independent proofs remain exclusively in LIVE-050 ingress and LIVE-030 intake.

Before object extraction, an iterative bounded JSON preflight rejects duplicate members at every nesting level,
including escape-equivalent keys. The protected internal record is minted only by the decoder and carries module-private
unforgeable in-process provenance. It also binds the exact raw frame, UTF-8 byte count, routing hint, framing contract,
and listener policy in one digest. Parsing and reduction re-extract the delivery ID from the raw frame and require exact
agreement. `toConnectionEnrollmentTransportAdmissionInputV1` reduces the verified record to the exact two-field input
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

Current remediation evidence before product freeze:

- macOS stage zero: pass (`ready_for_runtime_check`), with no native attempt;
- TypeScript: pass;
- focused framing plus transport-admission tests: 23/23 pass;
- complete connection slice: 65/65 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  316/316 posttests;
- production build: pass, including 4/4 rendered-page checks;
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables;
- TypeScript, full ESLint, and whitespace validation: pass.

The rejected exact product remains frozen at `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`. The remediation product is frozen
at `8e4c20da7166d48cb22c06fd38dfe87ee0016a02` and was accepted by a different independent reviewer.

## Review and next boundary

Because this code accepts future transport bytes and carries a protected raw frame, one independent reviewer must inspect
the immutable base-to-product diff, reproduce the deterministic gates, and attempt bounded malformed-prefix, chunk,
UTF-8, JSON, state, Proxy/accessor, runtime-drift, digest-drift, and disabled-default cases. A rejection or uncertainty
cannot be converted into acceptance; remediation requires a new immutable product and a different re-review.

The zero-repair packet is `docs/reviews/CR13A_LIVE_070_INDEPENDENT_REVIEW_PACKET.md`, SHA-256
`052f4b621e8606f807425a677e10e5211214563d2e05b1235dc803dac42fd2e6`.

The independent report rejects the product with Medium M-001 and M-002 plus Low L-001 and L-002. An unkeyed digest
cannot prove that a protected handoff came from this decoder; a caller can manufacture or change the record and recompute
the digest. Native JSON parsing collapses duplicate members before exact object validation and therefore permits
last-member routing syntax. The code accepts a second full view of one ordinary backing store, contradicting an
unenforceable absolute alias-rejection claim even though synchronous copy and no-retention prevent an observed mutation
race. Finally, the immutable product's acceptance heading had two trailing-whitespace lines and failed the required
exact diff gate.

The negative report is preserved at `docs/reviews/CR13A_LIVE_070_INDEPENDENT_REVIEW.md`, SHA-256
`91f9e00c41d7b3a47efab3619d6ac33dee5236c34f6c151c6ca94d42a9487ae6`. No integration is permitted. Remediation must
add module-private decoder provenance, re-extract and compare delivery identity, reject duplicate JSON members before
object extraction, state the enforceable full-backing-store synchronous-copy rule, prove post-push caller mutation cannot
change the result, remove whitespace drift, and receive a different zero-repair re-review.

Those four remediations are frozen at `8e4c20da7166d48cb22c06fd38dfe87ee0016a02`. The different-reviewer packet is
`docs/reviews/CR13A_LIVE_070_REMEDIATION_REREVIEW_PACKET.md`, SHA-256
`5bf992f81c136b0e4f32e4095dd5eaa16a86bb29cbfda8f42cdf14215928c9dd`.

The different reviewer reproduced all deterministic gates plus eight independent hostile-probe groups, closed M-001,
M-002, L-001, and L-002, and found no new High, Medium, or Low defect. The accepted report is
`docs/reviews/CR13A_LIVE_070_REMEDIATION_REREVIEW.md`, SHA-256
`7ac1a5fa117b70556e2d73da80e729ebb0703161e747db6d2ce58ea12fe2a0c0`. Acceptance permits ordinary owner-controlled
integration review only and grants no listener or external-effect authority.

Even after acceptance, a real listener remains a separate owner-controlled block. It must prove the actual bind address,
exclusive port ownership, tunnel peer and host-key custody, connection lifetime, backpressure, close/recovery behavior,
and exact composition into LIVE-060. This acceptance cannot authorize a socket, SSH, credential, provider, native,
production-database, deployment, DNS, or public-hosting effect.
