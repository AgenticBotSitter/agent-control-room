# CR13A-LIVE-060 Promise-containment remediation re-review packet

**Mode:** independent re-review, report only
**Immutable integration base:** `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`
**Rejected product:** `cee64a8197a011a91c06e6085d5f4d11e978ddbc`
**Immutable remediation target:** `45b4a67477fb39811d02ba1b1a67e8c78cf98ee9`
**Rejected report:** `docs/reviews/CR13A_LIVE_060_INDEPENDENT_REVIEW.md`, SHA-256
`d53bd172753ee77feb445bedaa0616080a8a74cf302ea12df1058de8454c7342`
**Reviewer:** must be different from the producer and the first CR13A-LIVE-060 reviewer
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact remediation `45b4a67477fb39811d02ba1b1a67e8c78cf98ee9` closes Medium M-001 without
assimilating or executing foreign behavior, correctly closes Low L-001's evidence totals, and introduces no new High,
Medium, or Low defect in the bounded transport-admission contract.

Review both:

```text
git diff cee64a8197a011a91c06e6085d5f4d11e978ddbc..45b4a67477fb39811d02ba1b1a67e8c78cf98ee9
git diff 5a94bfd7f28d336274f6b29ad50575eb5a90a9b1..45b4a67477fb39811d02ba1b1a67e8c78cf98ee9
```

Principal paths are `src/connection-registry/v1/transport-admission.ts`,
`tests/connection-enrollment-transport-admission.test.ts`, the first review and this packet, the LIVE-060 acceptance
record, BUILD_STATUS, build plan, and ADR-155. Treat remediation tests/documents as claims to attack.

## Mandatory closure questions

1. Does an already-rejected exact intrinsic Promise with an own non-constructor string data property create zero
   `unhandledRejection`/`uncaughtException` event, expose no raw value, and return only local `integrity_failed`?
2. Does the same remain true when the decoration is an unreadable accessor, with zero accessor execution?
3. Does the strict `--unhandled-rejections=strict` child probe genuinely exercise the product boundary and fail if the
   malformed Promise remains unobserved, rather than hiding the event with test-runner behavior or a global listener?
4. Is observation restricted to a real non-Proxy same-realm intrinsic Promise and performed through the captured native
   method without reading a supplied `then`? Do foreign thenables and Proxies still execute zero behavior?
5. Can an own `constructor` override, Promise subclass/cross-realm value, prototype constructor/then drift, constructor
   `Symbol.species` drift, species accessor, or hostile instrumentation cause behavior execution or an unsafe observer
   Promise? Are values outside the provably safe observation class untouched?
6. Do both inert settlement handlers prevent the observer Promise from carrying or assimilating the original fulfillment
   or rejection value, and can the observer itself become unhandled?
7. Do exact accepted native Promises, Node symbol metadata, ingress parsing, response-loss replay, and safe receipt
   stability remain unchanged?
8. Are corrected counts exactly 24/24 focused admission/ingress, 53/53 connections, and 304/304 posttests, with the first
   erroneous 50/50 claim and the independently observed 51/51 negative evidence preserved rather than rewritten?
9. Did the remediation change any request, receipt, proof, failure allowlist, protocol, schema, migration, persistence,
   local-runtime, listener, route, or external-effect contract?
10. Do all original packet questions not superseded by M-001/L-001 remain passing, and is there any new High, Medium, or
    Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-transport-admission
npm run test:cr13a-connections
node --import tsx scripts/verify-migrations.ts
git diff --check 5a94bfd7f28d336274f6b29ad50575eb5a90a9b1..45b4a67477fb39811d02ba1b1a67e8c78cf98ee9
```

Add private read-only probes outside the product tree for decorated rejected intrinsic Promises, own constructor/species
edge cases, foreign thenables, Proxies, subclasses, and raw process-event escape. Do not mutate the shared checkout,
start the app, bind a listener, open SSH, contact Hermes/provider/production PostgreSQL, read credentials, deploy, or
publish protected evidence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_060_REMEDIATION_REREVIEW.md`. Include exact
targets, independence, command outcomes, explicit closure of M-001 and L-001, findings ordered High/Medium/Low with
file/line evidence and required remediation, answers to all ten questions, product/effect/cleanup confirmation, and one
disposition. `accepted` requires no High, Medium, or Low finding. Any failure, uncertainty, or incomplete attack is
`rejected`. The report grants no integration, listener, connection, credential, native, provider, production, or
deployment authority.
