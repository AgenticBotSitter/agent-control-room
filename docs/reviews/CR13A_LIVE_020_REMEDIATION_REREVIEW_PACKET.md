# CR13A-LIVE-020 remediation independent re-review packet

**Mode:** independent re-review, report only
**Immutable base:** `737d9744c00129882af00094a84eae1f28a5a5a2`
**Rejected target:** `456f4d1f715e583c18f6533075a9d83346a22b95`
**Remediation target:** `d858d8e7eb0f385d1b5867f8f70424e9c602cbff`
**Prior report:** `docs/reviews/CR13A_LIVE_020_INDEPENDENT_REVIEW.md`
**Reviewer rule:** must be different from the first reviewer and the producer
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact remediation target closes every finding from the rejected review without introducing a new
security, integrity, availability, privacy, chronology, or authority defect. Passing producer evidence is not acceptance.

## Required finding closure

1. Reproduce the original High attack by inserting valid-looking telemetry directly into
   `control_node_fleet_current`, with no authenticated receipt. Connection Center must report `missing`, never
   `authenticated_telemetry/current`.
2. Insert or mutate an authenticated-telemetry receipt without the server key. It must fail closed. Prove a real signed
   `node.fleet.signal` frame processed by `NodeFleetSignalIngress` creates a valid receipt and can produce `current`.
   Verify the receipt is written only after protocol authentication and fleet persistence; an intermediate crash/failure
   may cause a safe false negative but must not produce false authenticated freshness.
3. Re-run Proxy/accessor probes at database result/row, protected roster result, freshness source input/item/array, read
   scope, projection builder, and public projection parser boundaries. Application data traps must not execute.
4. Run the exact rejected-target whitespace command against the remediation target and confirm it passes.

## Required adversarial coverage

1. Attempt receipt tag, tenant, node, sequence, signal digest, message/key/connection digest, observed/expiry/authenticated
   time mutation; wrong-key read; cross-node/cross-tenant copy; deletion; same-sequence drift; backwards sequence/time;
   excessive lifetime; future and expired receipts; and forged current/history fleet rows.
2. Confirm exact receipt replay is inert, the next authenticated telemetry sequence advances once, and a receipt failure
   prevents acknowledgement. Deletion may reduce truth to `missing`; it must never create a positive claim. Complete
   database rollback detection remains outside this block's claim.
3. Re-run registry cross-tenant, wrong-node, wrong-connection, missing-node, changed-replay, backwards-renewal,
   evaluation-time mismatch/regression, duplicate active route/profile, over-capacity, concurrency, read/write race,
   wrong-key, row/chain/head mutation, and partial-deletion attacks.
4. Confirm registry timestamps are primitive canonical data before semantic use and malicious database adapters cannot
   execute row/result behavior.
5. Confirm current freshness cannot promote qualification, live-panel, approval, network, command, lease, or execution
   authority and cannot reveal tenant, connection, enrollment, node, route, profile, issuer, host-key, message, key, or
   connection-protocol identities in the API/UI.
6. Confirm authentication still precedes roster and freshness reads; the endpoint remains GET-only; unavailable sources
   fail closed without fixture fallback; browser code imports no Node/database/private registry module; UI copy does not
   claim online, healthy, available, qualified, or authorized state.
7. Check PostgreSQL/PGlite migration compatibility, foreign keys, receipt uniqueness, registry append-only guards,
   restart reconstruction, deterministic roster order, active capacity, and expiry behavior. Record that real PostgreSQL
   locking and process-crash behavior remain unobserved if only PGlite is used.

## Deterministic commands

Use installed dependencies without downloads or network fallback:

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx
node --import tsx --test tests/project-event-store.test.ts tests/project-event-reconciliation.test.ts tests/project-event-sse.test.ts tests/project-live-activity.test.tsx tests/idea-lab-local-pilot.test.ts tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx
node --import tsx --test tests/node-job-event-service.test.ts
node --import tsx scripts/verify-migrations.ts
npm run build
node --test tests/rendered-html.test.mjs
git diff --check 737d9744c00129882af00094a84eae1f28a5a5a2..d858d8e7eb0f385d1b5867f8f70424e9c602cbff
```

Reviewer-owned probes may be created only outside the repository and must be removed. Do not run installs, contact
GitHub, start a persistent server, access credentials, launch Hermes/SSH/native processes, contact a provider or
production PostgreSQL, deploy, or perform any external effect.

## Stop and report

Return `accepted` only if all three prior findings are closed and no new blocking finding exists; otherwise return
`rejected`. List each finding with severity, exact file/line evidence, reproduction, observed versus expected behavior,
and acceptance impact. State every required attack and command actually run, exact outcomes, unobserved claims, cleanup,
and working-tree status. Do not repair. Preserve negative evidence exactly if the target remains unsafe.
