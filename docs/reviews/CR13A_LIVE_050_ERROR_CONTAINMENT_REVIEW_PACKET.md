# CR13A-LIVE-050 bounded error-handling independent review packet

**Mode:** independent correctness review, report only
**Original product:** `b86e60e5f8389029030deaaada890267e5f92f53`
**Superseded first remediation:** `7c79837cb60e497a7f49a203f20382afe133bd91`
**Immutable second-remediation target:** `bbd3bcbd659ab91461bb52117718a95098c7bb80`
**First rejected report SHA-256:** `ae40c366c16ac9d72cdc0be6db0393fd02904eef77b07b3e04bd8a07b7c6b255`
**Second rejected report SHA-256:** `67b8eaeffd6bbcc86eb81d061107beaf464b5dcb0f680317ad3d18cb89c85992`
**Producer:** root Codex architect; reviewer must differ from the producer and both completed prior reviewers
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact second remediation closes M-002 while keeping M-001 closed and preserving proof order,
replay and recovery, key separation, receipt shape, disabled defaults, and the repository-only effect boundary. Treat
the implementation, tests, documentation, and producer results as claims requiring independent confirmation.

## Exact scope

Review exactly:

```text
git diff 7c79837cb60e497a7f49a203f20382afe133bd91..bbd3bcbd659ab91461bb52117718a95098c7bb80
```

Principal paths:

- `src/security/host-value.ts`
- `src/connection-registry/v1/store.ts`
- `src/connection-registry/v1/intake.ts`
- `src/connection-registry/v1/node-delivery.ts`
- `src/connection-registry/v1/node-ingress.ts`
- `tests/connection-enrollment-node-ingress.test.ts`
- `docs/reviews/CR13A_LIVE_050_REMEDIATION_REREVIEW.md`
- `docs/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_ACCEPTANCE.md`
- ADR-154 in `docs/CR3_DECISION_LOG.md`

Use unchanged LIVE-030, accepted LIVE-040, and the first-remediation runtime checks only as needed to confirm there is no
regression.

## Required verification questions

1. Does `exactHostErrorCodeV1` reject a direct Proxy before reflection, require the exact immediate captured prototype,
   and read only an own string data descriptor without invoking accessors or walking a supplied prototype chain?
2. Can either a direct Proxy rejection or an ordinary rejection whose immediate prototype is a Proxy cause any Proxy
   or accessor behavior to run?
3. Have `instanceof` checks been removed from all caught-value classifications in the connection registry, intake,
   node-delivery adapter, and ingress coordinator?
4. Does each catch construct a fresh local error from an explicit allowlist, with every unknown value converted to a
   bounded local outcome and no raw value rethrown, serialized, or logged?
5. Do genuine exact local errors preserve the documented invalid-input, authentication, scope, replay, integrity, and
   source-unavailable mappings?
6. Do both new database-rejection regressions prove zero behavior execution, a fresh bounded ingress error, an unchanged
   preexisting replay baseline, and zero delivery, intake, or registry persistence?
7. Does M-001 remain closed: selected runtime checks still occur at entry, after every awaited proof seam, and before
   final receipt construction, with the 20-operation and post-intake-commit cases unchanged?
8. Are outer node-frame authentication and current database-key verification of the nested enrollment still independent
   and ordered, with routing bound to the protected delivery evidence?
9. Are all three HMAC key domains still distinct and are replay, response-loss recovery, and exact concurrent outcomes
   unchanged?
10. Does the public receipt still contain only the declared derived fields and false authority values, without protected
    identity, location, credential, signature, or transport details?
11. Is the local runtime still disabled with no application mutation route, listener, connector, native/provider call,
    credential access, production infrastructure contact, deployment, or network operation?
12. Did this remediation introduce any new High, Medium, or Low correctness, integrity, privacy, recovery, or
    availability defect?

## Required reproduction

Run from a disposable exact-target archive using already prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts tests/connection-enrollment-node-ingress.test.ts
npm run test:cr13a-connections
node --import tsx scripts/verify-migrations.ts
git diff --check 7c79837cb60e497a7f49a203f20382afe133bd91..bbd3bcbd659ab91461bb52117718a95098c7bb80
```

Expected deterministic counts are 24/24 focused intake/delivery/ingress tests and 39/39 complete connection tests.
Optional checks must be read-only, temporary, local, and removed with an absence check. Do not modify the shared
checkout. Do not use network access, GitHub writes, listeners, SSH, Hermes, providers, credentials, native
qualification, production infrastructure, deployment, MCP, or plugins.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_050_ERROR_CONTAINMENT_REVIEW.md`. Include:

- exact original, superseded, and second-remediation commits;
- reviewer independence statement;
- required command outcomes;
- explicit closure decisions for M-001 and M-002;
- explicit answers to all twelve verification questions;
- any new findings ordered High, Medium, Low with precise path/line evidence and required correction;
- repository cleanliness, disposable cleanup, and no-effect confirmation;
- one disposition: `accepted` only if M-001 and M-002 are closed and no High, Medium, or Low finding remains;
  otherwise `rejected`.

Both earlier rejected reports remain durable. Incomplete or uncertain review cannot become acceptance. This packet grants
no integration, listener, enrollment, connector, native, provider, production, deployment, or execution authority.
