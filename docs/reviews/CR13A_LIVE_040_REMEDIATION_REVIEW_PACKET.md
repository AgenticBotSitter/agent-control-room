# CR13A-LIVE-040 remediation independent review packet

**Mode:** independent verification and report only
**Immutable base:** `10605afd4a5e8d3baeafeab82ec883f6008e845b`
**Superseded rejected target:** `6493118f2b7272308d3c508b963f3ddd52cc9863`
**Immutable remediation target:** `67c16c5c11d06d3752b434fd8e3641c1c1482e8b`
**Producer:** root Codex architect
**Reviewer:** must be different from the producer and the reviewer who issued the first CR13A-LIVE-040 report
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact remediation target closes H-001, M-001, M-002, and L-001 from
`CR13A_LIVE_040_INDEPENDENT_REVIEW.md` without weakening the accepted outer-frame authenticator, the independent inner
enrollment authorization, durable replay, authenticated delivery evidence, safe output, or the disabled runtime
boundary.

## Exact scope

Review exactly:

```text
git diff 10605afd4a5e8d3baeafeab82ec883f6008e845b..67c16c5c11d06d3752b434fd8e3641c1c1482e8b
```

Principal paths:

- `src/node-protocol/v1/types.ts`
- `src/node-protocol/v1/schemas.ts`
- `contracts/control-room-node-v1-frame.schema.json`
- `src/connection-registry/v1/node-delivery.ts`
- `src/connection-registry/v1/intake.ts`
- `db/migrations/0036_cr13a_connection_enrollment_node_delivery.sql`
- `tests/node-protocol.test.ts`
- `tests/connection-enrollment-node-delivery.test.ts`
- `tests/connection-enrollment-intake.test.ts`
- `docs/CR13A_LIVE_040_AUTHENTICATED_NODE_DELIVERY_ACCEPTANCE.md`
- ADR-151 and its remediation amendment in `docs/CR3_DECISION_LOG.md`

Treat producer tests and documents as claims requiring independent confirmation.

## Required verification questions

1. **H-001 host-operation integrity:** After importing the delivery module, can replacement of any selected host
   operation influence ledger validation or execution? Confirm that the runtime selection is checked at every public
   entry and after each awaited database boundary, replacement functions are not invoked, a wrong integrity key still
   fails, and a changed or invalid authentication tag cannot be accepted.
2. **M-001 wire-schema parity:** Does the generated schema require the one-way `node_to_server`/`node` delivery variant,
   shared delivery-ID bounds, structural enrollment identity fields, and strict Ed25519 attestation? Does the shared
   rejection corpus pass against both the generated schema and runtime validator? Are computed digest and cross-field
   equality checks accurately documented as runtime-only and enforced before replay consumption?
3. **M-002 canonical replay chronology:** Does a later retry of an already committed delivery return the byte-for-byte
   equivalent safe receipt built from the original durable replay time and initial disposition? If replay committed but
   the ledger append did not, does a later exact retry use the original replay time, create exactly one ledger record,
   and remain stable on subsequent retries? Is the initial disposition covered by the ledger authentication tag?
4. **L-001 delivery-ID contract:** Is one 3–160 character ASCII contract enforced by protocol runtime, generated schema,
   delivery adapter, protected intake, and migration? Do lengths 2 and 161 fail before replay state changes while lengths
   3 and 160 pass when otherwise valid?
5. Do outer node-frame authentication and inner enrollment signature/active-database-key authorization remain separate,
   with neither one substituting for the other?
6. Do exact replay, changed-content reuse, recovery, concurrency, ledger row/head verification, and tenant serialization
   remain safe and deterministic?
7. Do all error paths and receipts avoid protected identity, key, signature, host, route, profile, credential, and raw
   database details while granting no approval, command, lease, execution, or network authority?
8. Does the target add no browser/HTTP mutation, listener, connector, SSH/Hermes/native launch, credential access,
   provider call, production PostgreSQL/VPS contact, deployment, or other external effect?

## Required reproduction

Run from a clean checkout at the immutable remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/node-protocol.test.ts tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts
node --import tsx --test tests/project-event-store.test.ts tests/project-event-reconciliation.test.ts tests/project-event-sse.test.ts tests/project-live-activity.test.tsx tests/idea-lab-local-pilot.test.ts tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts
node --import tsx scripts/verify-migrations.ts
git diff --check 10605afd4a5e8d3baeafeab82ec883f6008e845b..67c16c5c11d06d3752b434fd8e3641c1c1482e8b
```

The reviewer may use temporary read-only probes outside the product tree. Do not access or publish secrets, credentials,
host identity, private infrastructure, native/provider evidence, or network services.

## Required report

Return report text for `docs/reviews/CR13A_LIVE_040_REMEDIATION_REVIEW.md` containing:

- exact base, superseded target, and remediation target;
- reviewer-independence statement;
- reproduced commands and exact outcomes;
- a closure decision for each original finding H-001, M-001, M-002, and L-001;
- any new findings ordered High, Medium, Low, with file/line evidence, failure path, and required remediation;
- explicit answers to all eight questions above;
- confirmation that no product file changed and no external effect occurred;
- one disposition: `accepted` only when all four original findings are closed and there are no new High, Medium, or Low
  findings; otherwise `rejected`.

Negative evidence is durable. A failed command, incomplete review, or uncertainty cannot become acceptance. The report
grants no integration, listener, enrollment, connector, native, provider, production, or deployment authority.
