# Native signed delivery and receipt protocol

Add two strict node/v1 message types: server-to-node `harness.native.dispatch` and node-to-server
`harness.native.dispatch.receipt`. The shared authenticator retains signed identity/direction, tenant,
connection, time, key state, body digest, secret scanning, frame size and replay checks. Regenerate the
committed structural JSON schema; runtime relational checks and cryptographic checks remain additional.

The dispatch contains exact queue/input/enrollment/binding/packet digests, bounded start material, the
unsigned normalized request and separately owner-signed start/recovery packet. It never supplies a local
enrollment configuration or private key. IDs and operation scope must agree; the queue ID is deterministic
for tenant/job/attempt, and inputDigest must hash the exact prompt/instructions object. The frame cannot outlive the task deadline or predate the owner approval. The
native body is capped at64KiB in addition to existing protocol and start-field limits.

After authenticating a message, the receiver must resolve its own trusted local enrollment and use
`prepareNativeTaskDispatchIntake` to recompute the complete binding, then existing paired owner-signature
intake and current node policy/admission. A valid server signature never substitutes for owner approval,
qualification, local pause/ceiling, lease provenance or the durable claim/pre-effect marker.

Receipts bind exact queue, dispatch message/body digest, node, tenant/project/job/attempt, approval packet
and binding digest. The frame actor must equal the receipt node and its causation must name the dispatch.
`recorded` means durable intake only, not starting or completion; rejected receipts carry a fixed reason.
The matching helper must be called after authenticating the node frame and loading the trusted expected
dispatch. It is not a standalone authenticator or delivery-persistence service.

Feature `harness.native.dispatch.v1` is reserved for explicit mutual capability negotiation before any
sender/receiver activation. Existing nodes will reject unknown message types; do not down-convert native
work into generic job messages or send without verified feature agreement. This block registers schemas
and validators, not a connection feature advertisement, bridge handler, sender, durable receipt store or
native execution path. Those runtime integrations remain incomplete and must preserve current authority
and uncertain-delivery reconciliation. Tests use synthetic keys and disposable canonical records only.
