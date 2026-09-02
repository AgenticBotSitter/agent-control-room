# CR13A-LIVE-050 receipt-integrity remediation independent re-review packet

**Mode:** independent review, report only
**Superseded product:** `b86e60e5f8389029030deaaada890267e5f92f53`
**Immutable remediation target:** `7c79837cb60e497a7f49a203f20382afe133bd91`
**Rejected report SHA-256:** `ae40c366c16ac9d72cdc0be6db0393fd02904eef77b07b3e04bd8a07b7c6b255`
**Producer:** root Codex architect; reviewer must differ from the producer and the completed first reviewer
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Verify whether the exact remediation closes M-001 without changing the accepted delivery/intake proof boundaries,
replay and recovery behavior, key ownership, safe receipt, disabled runtime, or no-effect scope. Treat implementation,
tests, acceptance text, and the producer's passing results as claims that require independent confirmation.

## Exact scope

Review exactly:

```text
git diff b86e60e5f8389029030deaaada890267e5f92f53..7c79837cb60e497a7f49a203f20382afe133bd91
```

Principal paths:

- `src/connection-registry/v1/node-ingress.ts`
- `tests/connection-enrollment-node-ingress.test.ts`
- `docs/reviews/CR13A_LIVE_050_INDEPENDENT_REVIEW.md`
- `docs/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_ACCEPTANCE.md`
- ADR-153 in `docs/CR3_DECISION_LOG.md`

Use the unchanged LIVE-030 and accepted LIVE-040 code only as necessary to confirm composition has not drifted.

## Required verification questions

1. Does direct ingress-receipt parsing compare the exact selected runtime before any changed canonicalization or hash
   operation can execute?
2. Does the selected boundary cover global object identity, property inspection, object keys/freezing, array
   classification/mapping/sorting/joining, numeric checks, JSON encoding, chronology, string slicing, regex execution,
   reflection, typed-array cleanup, and native hash update/digest methods actually used by this module or shared digest?
3. Are checks performed at receive entry, immediately after delivery, protected-read, and intake awaits, and before
   final receipt construction? Can a change introduced while any awaited dependency settles reach parsing or hashing?
4. Do the 20-operation regression cases restore every changed descriptor and show zero replacement executions?
5. Does the intake-commit seam case prove that a successful durable commit followed by runtime drift returns only the
   bounded integrity error, then recovers one stable receipt after restoration without another registry revision?
6. Do malformed input/result handling and downstream error mapping remain bounded, with no raw error or protected value
   in the final result?
7. Are outer node-frame authentication and current database-key verification of the nested enrollment still independent,
   in the same order, with no injectable public proof coordinator?
8. Are delivery, registry, and intake-audit key domains still distinct, caller-owned keys unchanged, and only temporary
   copies wiped with the captured typed-array operation?
9. Is exact and concurrent replay still stable, changed-content reuse still blocked, and routing-hint/evidence binding
   unchanged?
10. Does the receipt schema still contain only the declared derived values and false authority fields, without identity,
    locator, credential, signature, or transport data?
11. Is the local runtime still disabled, with no new application write route, listener, connector, native/provider call,
    credential access, production infrastructure contact, deployment, or network operation?
12. Did the remediation introduce any new High, Medium, or Low correctness, integrity, privacy, recovery, or availability
    defect?

## Required reproduction

Run from a disposable exact-target archive using already prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-enrollment-intake.test.ts tests/connection-enrollment-node-delivery.test.ts tests/connection-enrollment-node-ingress.test.ts
npm run test:cr13a-connections
node --import tsx scripts/verify-migrations.ts
git diff --check b86e60e5f8389029030deaaada890267e5f92f53..7c79837cb60e497a7f49a203f20382afe133bd91
```

Optional checks must be read-only, temporary, local, and removed with an absence check. Do not modify the shared
checkout. Do not use network access, GitHub writes, listeners, SSH, Hermes, providers, credentials, native
qualification, production infrastructure, deployment, MCP, or plugins.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_050_REMEDIATION_REREVIEW.md`. Include:

- exact superseded product and remediation target;
- reviewer independence statement;
- required command outcomes;
- explicit closure decision for M-001;
- explicit answers to all twelve verification questions;
- any new findings ordered High, Medium, Low with precise path/line evidence and required correction;
- repository cleanliness, disposable cleanup, and no-effect confirmation;
- one disposition: `accepted` only if M-001 is closed and no High, Medium, or Low finding remains; otherwise `rejected`.

The original rejection remains durable. Incomplete or uncertain review cannot become acceptance. This packet grants no
integration, listener, enrollment, connector, native, provider, production, deployment, or execution authority.
