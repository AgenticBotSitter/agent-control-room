# CR13A-LIVE-040 authenticated node-protocol enrollment delivery acceptance

**Status:** independently accepted remediation `67c16c5c11d06d3752b434fd8e3641c1c1482e8b`; integrated through owner-approved
PR #233 as `34379984d3c4793f2c2d464ffb3545ab98717ba5`
**Effect boundary:** repository code, generated JSON Schema, PostgreSQL-compatible migration, and PGlite tests only; no
listener, HTTP mutation, live connector, SSH, Hermes/provider call, credential access, production database, or deployment

## Delivered boundary

CR13A-LIVE-040 adds one node-to-server message, `connection.enrollment.deliver`, to
`control-room-node/v1`. Its body binds a globally unique delivery ID, the declared enrollment contract, a digest of the
exact inner envelope, and the envelope. The signed outer frame binds that body to the enrolled tenant, node, active key,
connection, monotonic sequence, nonce, send/expiry window, and protocol version. The runtime and generated JSON Schema
structurally require the node-to-server/node-signed variant, the shared delivery-ID bounds, envelope body identity fields,
and a strict Ed25519 attestation. The runtime additionally rejects computed envelope-digest and cross-field
contract/tenant/node/connection/key drift before replay state is consumed. Those relational checks are explicitly
runtime-only because standard JSON Schema cannot express equality or recompute a cryptographic digest.

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
- Every delivery uses the original replay row's durable receive time; a committed duplicate returns the original safe
  receipt even when the retry is observed later.
- Delivery-ID or protocol-message reuse with different authenticated content is a terminal replay conflict.
- If replay persistence succeeds but the delivery-ledger transaction fails, retrying the exact frame reuses the protocol
  replay proof and its original chronology to complete the missing ledger append. No new nonce or sequence is invented.
- Delivery IDs use one 3–160 character ASCII contract in protocol runtime, generated schema, adapter, protected intake,
  and migration, and invalid bounds fail before replay consumption.
- The delivery ledger is append-only, tenant-serialized, digest-chained, HMAC-authenticated, payload-digested, bounded to
  10,000 records per tenant, and protected against row/head deletion and truncation.
- Damaged, deleted, reordered, behavior-bearing, wrong-key, or semantically inconsistent evidence fails closed.

## Safe output and negative authority

The delivery receipt exposes only derived references, digests, the canonical receive time, the original successful
protocol/ledger disposition, and explicit false values for approval, network, command, lease, and execution authority.
It exposes no tenant, node, connection, delivery, enrollment, key, host, route, profile, public-key, signature,
credential, or transport identity.
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
safe receipts, generated-schema structural parity, shared validator rejection cases, delivery-ID bounds, later-time
response-loss/recovery replay, post-import ambient mutation, and absence of browser/HTTP mutation.

The exact product is `6493118f2b7272308d3c508b963f3ddd52cc9863`. Stage zero, TypeScript, full lint, 23/23
focused protocol/intake/delivery tests, 42/42 combined CR13A tests, the complete 769/769 pretest plus 418/420 core with
two intentional platform skips plus 277/277 posttest lifecycle, production build, 4/4 rendered routes, all 36 migrations
with 119 PostgreSQL tables, and `git diff --check` pass. The zero-repair independent review packet has SHA-256
`e62d0edee24c1a0060ccf5511e842f68f62afc0e9862d716799fe58bbb7162b4`.

The independent report rejected that target with one High, two Medium, and one Low finding: post-import ambient mutation
could bypass ledger HMAC checks; the generated JSON Schema was weaker than runtime validation; exact replay did not use
the original durable receive time; and the delivery-ID bounds disagreed across protocol and intake. The negative evidence
is preserved in `docs/reviews/CR13A_LIVE_040_INDEPENDENT_REVIEW.md` and cannot authorize integration.

The remediation candidate freezes and verifies host-operation selection, structurally strengthens the one-way generated
schema while documenting runtime-only relational checks, derives delivery chronology from the durable replay row,
protects the initial disposition so exact duplicates return the original receipt, and shares one delivery-ID contract
across every boundary. Hostile regressions replace ten ambient operations after import and prove that none execute;
wrong-key evidence still fails. A new exact product and a different independent re-review are required.

The remediation product is frozen at `67c16c5c11d06d3752b434fd8e3641c1c1482e8b`. It passes stage zero, TypeScript,
full lint, 26/26 focused protocol/intake/delivery tests, 28/28 connection-slice tests, all 36 migrations with 119
PostgreSQL tables, the complete 769/769 pretest plus 419/421 core with two intentional platform skips plus 279/279
posttest lifecycle, the production build, 4/4 rendered routes, and `git diff --check`. The zero-repair remediation review
packet has SHA-256 `f3c9b605b3646d2f518000f144163d09973fa9174dc9488d1ddc29e84aa96733`. No listener, network,
credential, provider, native, production-database, or deployment effect ran.

A fresh reviewer, different from both the producer and the reviewer who rejected the first target, reproduced every
required gate and ran independent signed-frame, PGlite ledger, concurrency, recovery, wrong-key, changed-tag, and
28-operation post-import mutation probes. All four original findings are closed and no new High, Medium, or Low finding
remains. The accepted report is `docs/reviews/CR13A_LIVE_040_REMEDIATION_REVIEW.md` with SHA-256
`217dd95aca1f314038b9730183e86bbb644464fa75a5be407c2d899c7135b516`.

## Required review and next boundary

The accepted product was published and integrated after owner approval. Passing review and integration do not authorize
a listener, enrollment attempt, connector, native/provider action, production database, deployment, or live use.

PR #233 CI run `33590140698` passed in 8m36s before the owner-approved merge. Integration changed no product semantics
and grants no live-effect authority.

After accepted review and owner-approved integration, CR13A-LIVE-050 may add a provider-disabled server ingress
composition or a bounded enrolled-connector rehearsal packet. Any actual listener, machine connection, SSH/Hermes/native
effect, credential use, provider call, production PostgreSQL/VPS contact, or deployment remains separately gated.
