# CR13A-LIVE-040 independent authenticated node-delivery security and integrity review packet

**Mode:** independent review, report only
**Immutable base:** `10605afd4a5e8d3baeafeab82ec883f6008e845b`
**Immutable product target:** `6493118f2b7272308d3c508b963f3ddd52cc9863`
**Producer:** root Codex architect; reviewer must be different from the producer and prior CR13A reviewers
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact target safely adds one authenticated node-protocol path into the protected enrollment source
without allowing outer transport authentication to replace inner enrollment authorization, weakening replay or active-key
rules, leaking protected identity, executing hostile input/database behavior, or enabling a listener or external effect.

## Exact scope

Review exactly:

```text
git diff 10605afd4a5e8d3baeafeab82ec883f6008e845b..6493118f2b7272308d3c508b963f3ddd52cc9863
```

Principal product paths:

- `src/node-protocol/v1/types.ts`
- `src/node-protocol/v1/schemas.ts`
- `contracts/control-room-node-v1-frame.schema.json`
- `src/connection-registry/v1/node-delivery.ts`
- `src/connection-registry/v1/intake.ts` as the unchanged downstream trust boundary
- `db/migrations/0036_cr13a_connection_enrollment_node_delivery.sql`
- `tests/node-protocol.test.ts`
- `tests/connection-enrollment-node-delivery.test.ts`
- `tests/connection-enrollment-intake.test.ts`
- `docs/CR13A_LIVE_040_AUTHENTICATED_NODE_DELIVERY_ACCEPTANCE.md`
- ADR-151 in `docs/CR3_DECISION_LOG.md`

Treat producer tests and documents as claims to attack, not acceptance evidence.

## Mandatory attack questions

1. Can a forged, expired, future-version, wrong-direction, revoked, quarantined, rate-limited, oversized, or malformed outer
   frame reach delivery persistence?
2. Are tenant, node, active key, connection, direction, sequence, nonce, message ID, contract, delivery ID, and exact
   envelope digest bound to the signed frame before replay consumption?
3. Can a valid outer frame with an invalid, drifted, cross-scope, expired, or attacker-key inner envelope create a
   connection registry record, or does CR13A-LIVE-030 still independently resolve the active database key and verify the
   inner Ed25519 signature?
4. Can exact replay, reused nonce, reused message ID, reused delivery ID, cross-node message-ID collision, sequence gap,
   or different-content replay create a second ledger/registry record or conceal conflict?
5. If protocol replay commits and the delivery-ledger append fails or the process stops, can the same exact frame recover
   safely without a new sequence/nonce, while changed content remains blocked?
6. Can concurrent writers, an absent head, row/head mutation, deletion, truncation, reordering, wrong integrity key,
   payload substitution, or inconsistent semantic fields bypass the authenticated delivery chain?
7. Can caller Proxies, accessors, sparse/hostile objects, behavioral database results, hostile transport identity, raw
   error text, or post-import ambient mutation execute behavior or escape protected values at the new boundary?
8. Do safe receipts omit tenant, node, connection, delivery, enrollment, key, host, route, profile, public-key,
   signature, credential, and transport identity while granting no approval, network, command, lease, or execution
   authority?
9. Does the generated JSON Schema exactly match the runtime validator, and is the new message direction/type set correct
   without broadening other protocol authority?
10. Is there any browser/HTTP write route, listener, connector, SSH/Hermes/native launch, credential access, provider call,
    production PostgreSQL/VPS contact, deployment, or network effect in the target?

## Required reproduction

Run from a clean checkout at the immutable target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/node-protocol.test.ts tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts
node --import tsx --test tests/project-event-store.test.ts tests/project-event-reconciliation.test.ts tests/project-event-sse.test.ts tests/project-live-activity.test.tsx tests/idea-lab-local-pilot.test.ts tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts
node --import tsx scripts/verify-migrations.ts
git diff --check 10605afd4a5e8d3baeafeab82ec883f6008e845b..6493118f2b7272308d3c508b963f3ddd52cc9863
```

The reviewer may add private read-only probes or temporary tests outside the product tree. Do not publish secrets, host
identity, locators, credentials, raw infrastructure data, or native/provider evidence.

## Required report

Write only `docs/reviews/CR13A_LIVE_040_INDEPENDENT_REVIEW.md` on a report-only branch. Include:

- exact base and product target;
- reviewer independence statement;
- reproduced commands and exact outcomes;
- findings ordered High, Medium, Low, each with file/line evidence, exploit/failure path, and required remediation;
- explicit answers to all ten mandatory attack questions;
- confirmation that no product file was changed and no external effect occurred;
- one disposition: `accepted` only if there are no High, Medium, or Low findings, otherwise `rejected`.

Negative evidence is durable. A failed command, incomplete review, or uncertainty cannot be converted into acceptance.
The report grants no integration, listener, enrollment, connector, native, provider, production, or deployment authority.
