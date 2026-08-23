# CR-5A node protocol and device identity

**Status:** Complete 2026-08-22  
**Scope:** Public node protocol schemas, compatibility negotiation, single-use enrollment, device authentication, replay protection, and transport rate-limit contract.  
**Stop boundary:** No bridge daemon, live node, endpoint, tunnel, production key, executor, or project integration was created.

## Delivered contract

`control-room-node/v1` is project-, harness-, and operating-system-neutral. Its signed frame union covers:

- connection hello and negotiated acceptance;
- resource/policy heartbeat;
- immutable job offers containing authority and artifact references, never artifact bytes;
- offer accept/reject decisions with safe reason codes, followed by explicit lease grant and renewal frames;
- sequenced lifecycle/checkpoint/result events;
- cancellation request and acknowledgement;
- reconnect reconciliation request and report;
- safe protocol errors.

The authoritative Zod validators live in `src/node-protocol/v1/schemas.ts`. Generated draft 2020-12 JSON Schemas in `contracts/control-room-node-v1-*.schema.json` let non-TypeScript bridges use the same wire contract. `pnpm protocol:generate` regenerates them.

## Authentication order

`NodeProtocolAuthenticator` rejects a frame in this order:

1. byte ceiling before JSON parsing;
2. valid JSON and strict known schema;
3. known protocol version, direction, sender kind, and allowed message type;
4. expiry, future skew, and maximum lifetime;
5. a caller-supplied transport-identity rate limit that cannot be bypassed by changing unverified actor fields;
6. canonical body digest and secret-material guard;
7. exact tenant/actor/key lookup and active key/principal state;
8. key validity interval and Ed25519 signature over the canonical complete frame except `signature`;
9. durable message ID, nonce, connection ID, and monotonic sequence consumption.

Replay state is consumed only after the signature verifies, so an unauthenticated caller cannot poison a legitimate node's nonce or sequence. New node-to-server connections must begin with signed `connection.hello` sequence 1. A bridge reconnect uses a new connection ID and the reconciliation bodies; it does not reset durable message/nonce protection within the bounded replay window.

A `job.offer` is not execution authority. The node may reserve capacity and return `job.offer.decision`, but it starts only after Control Room atomically creates the canonical lease and sends a signed `job.lease.grant` with the exact epoch, expiry, and authority digest. A renewal is similarly explicit and epoch-bound.

The authenticator requires an explicit `ProtocolRateLimitGuard`. `FixedWindowProtocolRateLimiter` is the deterministic single-process implementation for the synthetic bridge. A later deployment may compose it with Cloudflare/ingress limits, but outer service authentication never replaces the enrolled node signature.

## Enrollment

1. An owner-authorized caller issues a random 256-bit, maximum-15-minute, node-class-scoped token.
2. The database stores only its SHA-256 digest; plaintext is returned once to the caller.
3. A correct token creates one maximum-five-minute challenge and verifies protocol compatibility.
4. The node signs the exact challenge, public key, immutable node ID, platform facts, class, and supported versions with its locally generated Ed25519 private key.
5. One transaction verifies the proof, consumes token and challenge, inserts the active canonical node and public key, and writes the transition and outbox event.
6. The accepted response returns the safe initial grant plus its digest and the configured Ed25519 server public trust keys, allowing the new node to verify future Control Room frames.
7. The private key is never accepted or stored. CR-5B/5C will provide the platform key-store boundary used by the bridge.

Key identity fields are immutable. A retired key cannot become active and a revoked key cannot be restored or rewritten. Rotation will insert a distinct key ID; it will not replace key bytes in place.

## Persistence

Migration `0008_cr5a_node_protocol_identity.sql` adds:

| Table | Purpose |
|---|---|
| `node_enrollment_tokens` | digested, scoped, expiring, single-use bootstrap tokens |
| `node_enrollment_challenges` | one bounded challenge per token |
| `control_node_keys` | tenant/node-bound public keys, validity, retirement, revocation |
| `node_protocol_connections` | direction-specific monotonic connection sequence |
| `node_protocol_replay` | durable message/nonce/sequence replay window |

Replay rows reject update and truncate. Expired rows may be pruned only through a separately privileged maintenance connection; the ordinary production application role has no delete permission. Connection sequence state remains, preventing an old sequence from becoming current after replay-row cleanup.

## Security and compatibility properties

- Unknown required versions fail closed; v1 is currently the only negotiated version.
- All objects are strict and bounded in length/count; arbitrary extension fields are rejected in v1.
- Ed25519 public keys use base64url-encoded DER SPKI and are fingerprinted with SHA-256.
- Canonical JSON binds header, routing, body digest, body, timestamps, nonce, and sequence to the signature.
- Revoked keys and quarantined/revoked/pending nodes cannot authenticate. Active, draining, and offline identities may authenticate; scheduling eligibility remains a separate core decision.
- Job frames carry only logical credential references. Runtime bodies are rechecked by the central secret guard before authentication succeeds.
- The database resolver intentionally resolves node keys only. A node bridge will verify Control Room frames against its separately provisioned local server-trust bundle in CR-5B/5C.

## Verification

The CR-5A suite proves:

- strict schema and direction ownership;
- mutual-version selection and closed failure;
- token digest-only persistence, expiry, class binding, unsupported-version rejection, invalid proof rejection, and irreversible consumption;
- canonical node/key/transition/outbox creation;
- valid signature and digest acceptance;
- forged signature, tampered digest, expired frame, wrong direction, unknown version, oversized frame, malformed JSON, rate overflow, sequence gap, message replay, and cross-connection nonce replay rejection;
- quarantined-node and revoked-key rejection plus revoked-key non-restoration;
- bounded replay cleanup.

CR-5B consumes these contracts to build the portable connection loop, heartbeat producer, reconnect reconciliation, backpressure, and local journal. It must not weaken the validators or bypass the authenticator.
