# CR13A-LIVE-050 protocol-code allowlist independent re-review packet

**Mode:** independent correctness review, report only
**Superseded target:** `bbd3bcbd659ab91461bb52117718a95098c7bb80`
**Immutable remediation target:** `ffcdb586022ff67494cb2e404df7749b3a093b22`
**Rejected report SHA-256:** `61c934aca63942f043b613e5137b1ba2824f5f2139534031ba62ad65e732a86b`
**Producer:** root Codex architect; reviewer must differ from the producer and all three completed prior reviewers
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact narrow remediation closes L-001 while M-001 and M-002 remain closed. Confirm the change
does not alter proof order, replay/recovery, persistence, key separation, receipt shape, disabled defaults, or the
repository-only effect boundary. Treat producer results as claims requiring independent confirmation.

## Exact scope

Review exactly:

```text
git diff bbd3bcbd659ab91461bb52117718a95098c7bb80..ffcdb586022ff67494cb2e404df7749b3a093b22
```

Principal paths:

- `src/connection-registry/v1/node-delivery.ts`
- `tests/connection-enrollment-node-delivery.test.ts`
- `tests/connection-enrollment-node-ingress.test.ts`
- `docs/reviews/CR13A_LIVE_050_ERROR_CONTAINMENT_REVIEW.md`
- `docs/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_ACCEPTANCE.md`
- ADR-154 in `docs/CR3_DECISION_LOG.md`

## Required verification questions

1. Is a captured protocol code accepted only when it equals one of the seven declared `ProtocolAuthenticationCode`
   literals?
2. Does every other string become a fresh bounded `ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed")`?
3. Do both new regressions use an ordinary exact-prototype own-data value with an unknown string code and prove its
   accessor is never invoked?
4. Do the adapter and composed ingress both return conservative integrity failure without exposing the rejected value?
5. Do the tests prove the preexisting replay baseline is unchanged and delivery, intake, and registry persistence stays
   empty?
6. Do genuine protocol errors still map to `authentication_failed` and retain the accepted LIVE-040 behavior?
7. Do M-001 runtime checks and M-002 behavior-free exact-prototype/own-data classification remain unchanged and closed?
8. Are proof ordering, routing-evidence binding, three HMAC domains, exact replay, and response-loss recovery unchanged?
9. Are receipt fields, five false authority values, disabled local runtime, and absence of an application ingress route
   unchanged?
10. Did this remediation introduce any new High, Medium, or Low correctness, integrity, privacy, recovery, or
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
git diff --check bbd3bcbd659ab91461bb52117718a95098c7bb80..ffcdb586022ff67494cb2e404df7749b3a093b22
```

Expected deterministic counts are 26/26 focused tests and 41/41 complete connection tests. Optional checks must be
read-only, temporary, local, and removed with an absence check. Do not modify the shared checkout. Do not use network
access, GitHub writes, listeners, SSH, Hermes, providers, credentials, native qualification, production infrastructure,
deployment, MCP, or plugins.

## Required report

Return report text for architect placement at
`docs/reviews/CR13A_LIVE_050_ALLOWLIST_REMEDIATION_REREVIEW.md`. Include exact commits, reviewer independence, command
outcomes, explicit M-001/M-002/L-001 closure decisions, explicit answers to all ten questions, any new findings ordered
High/Medium/Low, repository cleanliness, disposable cleanup, no-effect confirmation, and one disposition. Use
`accepted` only if every finding is closed and no new High, Medium, or Low finding remains; otherwise use `rejected`.

All three earlier rejected reports remain durable. Incomplete or uncertain review cannot become acceptance. This packet
grants no integration, listener, enrollment, connector, native, provider, production, deployment, or execution authority.
