# CR13A-LIVE-040 authenticated node-protocol enrollment delivery acceptance

**Status:** implementation candidate; exact product freeze and independent security/integrity review required
**Effect boundary:** repository code, generated JSON Schema, PostgreSQL-compatible migration, and PGlite tests only; no
listener, HTTP mutation, live connector, SSH, Hermes/provider call, credential access, production database, or deployment

## Delivered boundary

CR13A-LIVE-040 adds one node-to-server message, `connection.enrollment.deliver`, to
`control-room-node/v1`. Its body binds a globally unique delivery ID, the declared enrollment contract, a digest of the
exact inner envelope, and the envelope. The signed outer frame binds that body to the enrolled tenant, node, active key,
connection, monotonic sequence, nonce, send/expiry window, and protocol version. The runtime and generated JSON Schema
reject envelope contract, tenant, node, connection, key, or digest drift before replay state is consumed.

`DatabaseConnectionEnrollmentNodeDeliveryAdapterV1` accepts only a raw string frame plus server-held receive time and
transport identity. It uses a database-backed active-key resolver, protocol rate limit, Ed25519 verification, and durable
exact replay. The adapter then applies the exact Hermes 0.21 enrollment parser, repeats every outer/inner identity
binding, constructs the existing protected delivery contract, and appends it to migration 0036's tenant-serialized,
HMAC-authenticated digest chain. Protected database rows are exact-captured before semantic access; behavioral rows are
rejected without executing their traps.

The adapter also implements the server-held `ConnectionEnrollmentProtectedDeliverySourceV1`. The existing
`ConnectionEnrollmentIntakeServiceV1` reads the durable delivery and still independently resolves the current active
database key, verifies the inner enrollment signature and chronology, and atomically commits registry plus intake audit.
Outer protocol authentication therefore cannot substitute for inner enrollment authorization.

## Failure and replay rules

- Oversize, malformed, future-version, wrong-direction, expired, rate-limited, forged, revoked, or quarantined frames fail
  through the existing node-protocol authenticator.
- Contract, envelope digest, tenant, node, connection, and key identity are signed outer-frame bindings.
- Exact protocol replay is accepted only when message, nonce, connection, sequence, and complete frame digest agree.
- Delivery-ID or protocol-message reuse with different authenticated content is a terminal replay conflict.
- If replay persistence succeeds but the delivery-ledger transaction fails, retrying the exact frame reuses the protocol
  replay proof and completes the missing ledger append. No new nonce or sequence is invented.
- The delivery ledger is append-only, tenant-serialized, digest-chained, HMAC-authenticated, payload-digested, bounded to
  10,000 records per tenant, and protected against row/head deletion and truncation.
- Damaged, deleted, reordered, behavior-bearing, wrong-key, or semantically inconsistent evidence fails closed.

## Safe output and negative authority

The delivery receipt exposes only derived references, digests, receive time, protocol/ledger duplicate status, and
explicit false values for approval, network, command, lease, and execution authority. It exposes no tenant, node,
connection, delivery, enrollment, key, host, route, profile, public-key, signature, credential, or transport identity.
The complete envelope remains only in the protected database so the intake can independently verify it.

No browser or HTTP mutation was added. The local pilot still uses the disabled delivery source. This implementation does
not open a port, connect to a machine, start Hermes, create an SSH tunnel, retrieve a credential, call a provider, attach
production PostgreSQL, deploy, host, or authorize native qualification or live Idea Lab work.

## Deterministic evidence

- `node --import tsx --test tests/node-protocol.test.ts tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts`
- `node --import tsx --test tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts`
- `./node_modules/.bin/tsc --noEmit`
- `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next`
- `node --import tsx scripts/verify-migrations.ts`
- complete repository lifecycle and production route build before product freeze

The focused implementation gate covers valid delivery-to-intake flow, outer forgery, independent inner-signature
failure, exact replay, post-authentication ledger recovery, conflicting reuse, ledger mutation, behavioral database rows,
safe receipts, generated-schema parity, and absence of browser/HTTP mutation.

## Required review and next boundary

A different independent reviewer must attack the exact frozen product and publish a report without repairs. Review must
trace schema generation, outer and inner signature independence, database key/node state, replay and recovery ordering,
tenant serialization, ledger integrity, safe error/output behavior, and the disabled runtime boundary. Passing producer
tests alone cannot authorize integration or live use.

After accepted review and owner-approved integration, CR13A-LIVE-050 may add a provider-disabled server ingress
composition or a bounded enrolled-connector rehearsal packet. Any actual listener, machine connection, SSH/Hermes/native
effect, credential use, provider call, production PostgreSQL/VPS contact, or deployment remains separately gated.
