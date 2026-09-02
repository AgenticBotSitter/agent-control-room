# CR13A-LIVE-040 remediation independent security and integrity re-review

**Disposition:** `accepted`

## Review identity and scope

- Immutable base: `10605afd4a5e8d3baeafeab82ec883f6008e845b`
- Superseded rejected target: `6493118f2b7272308d3c508b963f3ddd52cc9863`
- Immutable remediation target: `67c16c5c11d06d3752b434fd8e3641c1c1482e8b`
- Remediation tree: `4e260c4df6652002f9c76e1046561920918563cb`
- This was a fresh independent reviewer, different from both the product producer and the reviewer who issued the first
  CR13A-LIVE-040 report.
- Review was defensive, report-only, and zero-repair. Producer tests and documents were treated as untrusted claims.
- Review used a disposable `git archive` extraction pinned to the exact remediation target with the repository's
  already-prepared dependencies. The shared checkout was not modified.

## Deterministic reproduction

Host runtime was Node `v22.22.3`, satisfying the repository minimum.

All packet-required commands passed on their first invocation:

- `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
  - Exit `0`
  - Status `ready_for_runtime_check`
- `./node_modules/.bin/tsc --noEmit`
  - Exit `0`
  - No diagnostics
- `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next`
  - Exit `0`
  - No diagnostics
- `node --import tsx --test tests/node-protocol.test.ts tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts`
  - Exit `0`
  - `26/26` tests passed; no failures or skips
- `node --import tsx --test tests/project-event-store.test.ts tests/project-event-reconciliation.test.ts tests/project-event-sse.test.ts tests/project-live-activity.test.tsx tests/idea-lab-local-pilot.test.ts tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts`
  - Exit `0`
  - `44/44` tests passed; no failures or skips
- `node --import tsx scripts/verify-migrations.ts`
  - Exit `0`
  - Migrations `0001` through `0036` applied
  - `119 PostgreSQL tables` verified
- `git diff --check 10605afd4a5e8d3baeafeab82ec883f6008e845b..67c16c5c11d06d3752b434fd8e3641c1c1482e8b`
  - Exit `0`
  - No output

Independent protocol probing used correctly recomputed body digests and outer Ed25519 signatures rather than mutating an
already-signed producer fixture:

```json
[
  {"deliveryIdLength":2,"outcome":"malformed_frame","replayCalls":0},
  {"deliveryIdLength":3,"outcome":"accepted","replayCalls":1},
  {"deliveryIdLength":160,"outcome":"accepted","replayCalls":1},
  {"deliveryIdLength":161,"outcome":"malformed_frame","replayCalls":0},
  {"deliveryIdLength":20,"envelopeTenant":"tenant:other","outcome":"malformed_frame","replayCalls":0}
]
```

An independent PGlite ledger probe produced:

```json
{
  "firstReceiptStable":true,
  "firstReceivedAt":"2026-09-01T18:00:10.000Z",
  "firstInitialProtocolDisposition":"accepted",
  "wrongKeyOutcome":"integrity_failed",
  "forgedTagOutcome":"integrity_failed",
  "changedDispositionOutcome":"integrity_failed",
  "selectedMutationTargets":28,
  "replacementCalls":0,
  "failedAppendOutcome":"integrity_failed",
  "recovery":{
    "protocolDisposition":"duplicate",
    "ledgerDisposition":"accepted",
    "receivedAt":"2026-09-01T18:00:20.000Z",
    "stable":true,
    "rows":1,
    "initialProtocolDisposition":"duplicate"
  }
}
```

The probe also ran two concurrent later retries of an already committed delivery; both serialized to byte-identical JSON
receipts matching the first receipt.

Reviewer-probe setup evidence was preserved:

- The first optional ledger-probe invocation exited `1` before target execution because an external `/private/tmp`
  script could not resolve PGlite relative to itself.
- A second invocation exited `1` with `forbidden` because the reviewer probe omitted `expectedDirection`; the target
  failed closed.
- A third invocation exited `1` with `integrity_failed` because the reviewer probe temporarily failed to restore its own
  `Object.defineProperty` mutation; the target again failed closed.
- Correcting only the disposable reviewer probe, without changing the target, produced the successful result above.
- An optional Python Draft 2020-12 library check was unavailable because local Python did not contain `jsonschema`.
  Nothing was installed or downloaded. The exact generated branch was instead inspected directly, the committed
  artifact/generator equality test passed, and the shared generated/runtime corpus passed.

These were reviewer-probe construction errors or an unavailable optional library, not failures of any packet-required
target verification.

## Original finding closure decisions

### H-001 — Closed

The remediation captures the relevant host constructors, methods, prototypes, Buffer operations, regex execution,
chronology, JSON, reflection, collection, freezing, numeric, and string operations at module initialization in
`src/connection-registry/v1/node-delivery.ts:43-92`.

`assertCanonicalRuntimeV1()` verifies the complete selected runtime plus digest and HMAC sentinels at
`src/connection-registry/v1/node-delivery.ts:109-147`. It runs:

- at receipt parsing and before receipt return;
- at adapter construction;
- at `deliver()` and `read()` public entry;
- after rate-limit, key-resolution, replay, transaction, and individual database-query awaits;
- before semantic use of database results.

Tag comparison uses captured `Buffer.from` and imported `timingSafeEqual` at
`src/connection-registry/v1/node-delivery.ts:213-215`. Regex, dates, serialization, reflection, and receipt construction
use captured operations.

The independent probe replaced all 28 captured method selections one at a time after import. Every call failed as
`integrity_failed`, and no replacement executed. A wrong ledger key, a forged same-shape row authentication tag, and
mutation of the protected initial disposition all failed as `integrity_failed`.

H-001 is closed.

### M-001 — Closed

The generated delivery branch at `contracts/control-room-node-v1-frame.schema.json:342-559` structurally requires:

- `direction: "node_to_server"`;
- `senderKind: "node"`;
- `type: "connection.enrollment.deliver"`;
- delivery-ID length `3` through `160` with the ASCII identifier pattern;
- an object envelope containing required `body` identity fields;
- a required strict attestation object;
- `algorithm: "ed25519"`;
- required key ID, public-key SPKI, and signature fields;
- no additional envelope or attestation properties.

Runtime structure is defined at `src/node-protocol/v1/schemas.ts:105-128` and the one-way frame branch at
`src/node-protocol/v1/schemas.ts:336-350`. Runtime-only envelope-digest recomputation and cross-field
contract/tenant/node/connection/key equality are enforced at `src/node-protocol/v1/schemas.ts:124-128` and
`src/node-protocol/v1/schemas.ts:365-391`.

These runtime-only relations execute during `signedNodeFrameSchema.safeParse()` before rate limiting, key resolution,
signature verification, or replay consumption. The independently re-digested and re-signed cross-scope probe failed as
`malformed_frame` with zero replay calls.

The committed schema matched the generated artifact, and the shared structural rejection corpus passed both the
generated structural evaluator and runtime validator. Acceptance and ADR text accurately describe cryptographic digest
recomputation and equality relations as runtime-only.

M-001 is closed.

### M-002 — Closed

After authentication, the adapter re-reads and exact-validates the durable replay row, including nonce, message,
connection, sequence, frame digest, and original `received_at`, at
`src/connection-registry/v1/node-delivery.ts:614-630`.

Both new and existing ledger paths derive the protected delivery from that canonical replay time. Existing exact
delivery returns the stored delivery and protected initial protocol disposition at
`src/connection-registry/v1/node-delivery.ts:645-655`. New rows store the canonical time and
`initial_protocol_disposition` at `src/connection-registry/v1/node-delivery.ts:657-666`.

The initial disposition participates in record material at `src/connection-registry/v1/node-delivery.ts:250-259` and
therefore in both the record digest and HMAC tag at `src/connection-registry/v1/node-delivery.ts:472-480`.

Independent probing confirmed:

- later retries of a committed delivery return byte-identical safe receipts with the original time;
- two concurrent exact retries remain byte-identical and create no second row;
- after replay commit plus injected ledger failure, a later retry uses the original replay time and creates exactly one
  ledger row;
- subsequent recovery retries remain byte-identical;
- changing the initial disposition without recomputing its unavailable keyed tag fails closed.

M-002 is closed.

### L-001 — Closed

The shared contract is defined once at `src/node-protocol/v1/types.ts:9-20`: 3–160 ASCII characters matching the
identifier pattern.

It is applied by:

- runtime protocol schema: `src/node-protocol/v1/schemas.ts:10-11`;
- generated schema: `contracts/control-room-node-v1-frame.schema.json:436-440`;
- stored payload, ledger-row verification, and public adapter reads:
  `src/connection-registry/v1/node-delivery.ts:300-309`, `src/connection-registry/v1/node-delivery.ts:499-529`, and
  `src/connection-registry/v1/node-delivery.ts:719-723`;
- protected intake construction, capture, and audit verification: `src/connection-registry/v1/intake.ts:186-190`,
  `src/connection-registry/v1/intake.ts:214-242`, and `src/connection-registry/v1/intake.ts:353-378`;
- migration constraint: `db/migrations/0036_cr13a_connection_enrollment_node_delivery.sql:15-18`.

Correctly re-digested and re-signed lengths 2 and 161 failed before replay, while lengths 3 and 160 passed and reached
replay.

L-001 is closed.

## New findings

No new High, Medium, or Low findings.

## Required verification questions

1. **Host-operation integrity:** Yes. Runtime selection is verified at every public delivery entry and after every awaited
   database seam before result semantics are consumed. Captured replacements were not invoked. Wrong-key, forged-tag,
   and changed protected-disposition evidence all failed closed.

2. **Wire-schema parity:** Yes. The generated delivery variant is one-way node-to-server/node-signed, applies the shared
   delivery-ID bounds, structurally requires enrollment identity fields, and requires strict Ed25519 attestation. The
   shared structural corpus passes both paths. Digest recomputation and identity equality are accurately documented as
   runtime-only and execute before replay.

3. **Canonical replay chronology:** Yes. Committed duplicates reconstruct the original byte-equivalent receipt from
   durable replay time and protected initial disposition. Missing-ledger recovery creates exactly one row with the
   original replay time and remains stable. Initial disposition is included in digest and HMAC material.

4. **Delivery-ID contract:** Yes. Protocol runtime, generated schema, adapter, protected intake, and migration consistently
   apply 3–160 ASCII characters. Correctly signed lengths 2 and 161 fail with zero replay calls; lengths 3 and 160 pass.

5. **Outer versus inner authorization:** They remain separate. `deliver()` requires the outer node-protocol frame and
   stores protected delivery evidence. Intake separately resolves the current active database key at
   `src/connection-registry/v1/intake.ts:410-421` and independently verifies the inner signed enrollment at
   `src/connection-registry/v1/intake.ts:476-495` before registry persistence. The focused suite confirms a valid outer
   frame carrying an invalid inner signature creates a delivery record but no registry enrollment.

6. **Replay, recovery, concurrency, and ledger safety:** Exact replay is inert; content or identity reuse conflicts at
   `src/connection-registry/v1/node-delivery.ts:645-653`. Tenant-row locking, replay-row locking, delivery head/row locks,
   unique constraints, chain traversal, row/head digest checks, and HMAC verification preserve serialization.
   Independent concurrent duplicate and recovery probes created one stable record. Deletion, truncation, wrong-key,
   malformed-row, and chain/head damage remain fail-closed through full-stream verification and migration guards.

7. **Safe output and negative authority:** Errors expose only the bounded safe codes in
   `src/connection-registry/v1/node-delivery.ts:312-316`. Receipts contain derived references, digests, canonical time,
   dispositions, and explicit false authority fields at `src/connection-registry/v1/node-delivery.ts:153-167` and
   `src/connection-registry/v1/node-delivery.ts:701-716`. They expose no protected identity, key, signature, host, route,
   profile, credential, transport, or raw database detail and grant no approval, command, network, lease, or execution
   authority.

8. **External-effect boundary:** The target adds no browser or HTTP mutation, listener, connector, SSH/Hermes/native
   launch, credential access, provider call, production PostgreSQL/VPS contact, deployment, or external effect. Changed
   executable paths are protocol validation, server-held database adapter/intake code, exports, migration, and tests.
   The shipped application runtime does not compose the adapter, and the existing connection route remains read-only.

## Repository and effect confirmation

- No tracked or product file changed.
- TypeScript created an ignored `tsconfig.tsbuildinfo` in the disposable extraction; it was removed. A comparison against
  a second fresh archive then reported no differences, and the regular-file aggregate digest returned to its initial
  value:
  - Before verification: `3c9d051e4528a3deb5ea30bd42109e83b150fb703b1ee83c1baa175889c67aee`
  - After verification and artifact removal: `3c9d051e4528a3deb5ea30bd42109e83b150fb703b1ee83c1baa175889c67aee`
- The shared checkout remained clean.
- All disposable extractions and reviewer probes were removed with absence checks.
- No network access, GitHub operation, SSH, Hermes, MCP server, plugin, listener, credential, native/provider call,
  production database, deployment, or external service was used.

## Final disposition

`accepted`

All four original findings are closed, and no new High, Medium, or Low finding remains. This report authorizes no
integration by itself and grants no listener, enrollment, connector, native, provider, production, database, deployment,
approval, command, lease, network, or execution authority.
