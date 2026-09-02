# CR13A-LIVE-050 independent provider-disabled ingress security and integrity review packet

**Mode:** independent review, report only
**Immutable base:** `34379984d3c4793f2c2d464ffb3545ab98717ba5`
**Immutable product target:** `b86e60e5f8389029030deaaada890267e5f92f53`
**Producer:** root Codex architect; reviewer must be different from the producer and prior CR13A reviewers
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact target safely composes the independently authenticated node-delivery and enrollment-intake
boundaries without letting an untrusted routing label, one proof boundary, mutable host behavior, replay, recovery, or
receipt construction replace the other proof boundary, disclose protected identity, or create a listener or external
effect.

## Exact scope

Review exactly:

```text
git diff 34379984d3c4793f2c2d464ffb3545ab98717ba5..b86e60e5f8389029030deaaada890267e5f92f53
```

Principal product paths:

- `src/connection-registry/v1/node-ingress.ts`
- `src/connection-registry/v1/node-delivery.ts` as the accepted outer-authentication boundary
- `src/connection-registry/v1/intake.ts`, including the newly exported protected-delivery parser
- `src/connection-registry/v1/index.ts`
- `src/local-pilot/v1/runtime.ts`
- `tests/connection-enrollment-node-ingress.test.ts`
- `tests/connection-enrollment-node-delivery.test.ts`
- `tests/connection-enrollment-intake.test.ts`
- `package.json`
- `docs/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_ACCEPTANCE.md`
- ADR-152 in `docs/CR3_DECISION_LOG.md`

Treat producer tests and documents as claims to attack, not acceptance evidence.

## Mandatory attack questions

1. Can an invalid routing hint reach node replay or delivery persistence, or can a valid mismatched hint select or feed a
   different delivery into intake?
2. Is the delivery receipt bound to the exact authenticated protected-delivery evidence before intake, including its
   canonical durable receive time and evidence digest, without trusting caller labels?
3. Does the composition preserve two independent proofs: outer node-frame authentication and current active database-key
   verification of the nested Hermes enrollment signature? Can either proof be skipped, substituted, or reused as the
   other?
4. Can a forged outer frame, valid outer frame with invalid inner envelope, cross-scope data, inactive key, expired
   envelope, changed content, duplicate key domain, or malformed result create a registry record or misleading receipt?
5. If delivery commits before intake fails, or either successful response is lost, can exact retry recover one stable
   result without duplicate delivery, audit, or registry rows? Does changed-content retry remain blocked?
6. Do exact concurrent retries serialize to one stable receipt, and can interleaving, stale chronology, later replay, or
   a changed routing label cause receipt drift or split outcomes?
7. Are delivery, registry, and intake-audit HMAC key domains provably distinct? Are temporary key copies wiped while
   caller-owned keys remain untouched and usable after construction?
8. Can Proxy/accessor input, behavioral database setup/results, mutable built-ins after import, malformed dependency
   return values, raw downstream errors, or rejected promises execute behavior, bypass checks, or disclose protected
   values?
9. Is the generic coordinator unexported and therefore unavailable for production proof substitution? Does the public
   database composition construct the accepted concrete delivery and intake boundaries without caller-injected proof
   ports?
10. Does the safe receipt omit tenant, node, connection, delivery, enrollment, key, host, route, profile, public-key,
    signature, credential, transport identity, and raw timestamps except the allowed canonical receive time? Does it
    grant no approval, acknowledgement, network, command, lease, or execution authority?
11. Did exporting the protected-delivery parser change the accepted LIVE-030 parsing semantics, validation ordering,
    behavioral-input defense, or error surface?
12. Is the local runtime default genuinely disabled, with no public ingress port, browser/HTTP write route, listener,
    connector, SSH/Hermes/native launch, credential access, provider call, production PostgreSQL/VPS contact, deployment,
    or network effect?

## Required reproduction

Run from a clean checkout at the immutable product target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts tests/connection-enrollment-node-ingress.test.ts
npm run test:cr13a-connections
node --import tsx scripts/verify-migrations.ts
git diff --check 34379984d3c4793f2c2d464ffb3545ab98717ba5..b86e60e5f8389029030deaaada890267e5f92f53
```

The reviewer may add private read-only probes or temporary tests outside the product tree. The reviewer must not edit the
shared checkout. Do not publish secrets, host identity, locators, credentials, raw infrastructure data, or
native/provider evidence.

## Required report

Return report text for architect placement at
`docs/reviews/CR13A_LIVE_050_INDEPENDENT_REVIEW.md`. Include:

- exact base and product target;
- reviewer independence statement;
- reproduced commands and exact outcomes;
- findings ordered High, Medium, Low, each with file/line evidence, exploit/failure path, and required remediation;
- explicit answers to all twelve mandatory attack questions;
- confirmation that no product file was changed and no external effect occurred;
- one disposition: `accepted` only if there are no High, Medium, or Low findings, otherwise `rejected`.

Negative evidence is durable. A failed command, incomplete review, or uncertainty cannot be converted into acceptance.
The report grants no integration, listener, enrollment, connector, native, provider, production, or deployment authority.
