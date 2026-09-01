# CR13A-LIVE-020 independent security and integrity review packet

**Mode:** independent review, report only  
**Immutable base:** `737d9744c00129882af00094a84eae1f28a5a5a2`  
**Immutable target:** `456f4d1f715e583c18f6533075a9d83346a22b95`  
**Producer:** root Codex architect; reviewer must be different  
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact target safely adds durable protected Hermes enrollment persistence and independently
authenticated node-signal freshness without leaking location/identity or turning enrollment, recency, compatibility,
qualification, live-panel state, or execution authority into interchangeable claims.

## Scope

Review exactly `git diff 737d9744c00129882af00094a84eae1f28a5a5a2..456f4d1f715e583c18f6533075a9d83346a22b95`.
The principal paths are migration 0034, `src/connection-registry/v1`, `src/connection-center/v1`, protected endpoint and
local-pilot wiring, Connection Center UI, tests, ADR-149, build plan/status, and the CR13A-LIVE-020 acceptance record.
Compare changed paths to this packet before reading claims.

## Required attacks

1. Attempt cross-tenant, wrong-node, wrong-connection, missing-node, changed-replay, backwards-renewal, duplicate active
   route/profile, over-capacity, and concurrent-new-connection writes.
2. Attempt row payload/column/tag/digest/sequence/previous-digest/head mutation; newest, middle, and all-row deletion;
   head deletion; and wrong integrity-key reconstruction. Distinguish partial database tamper from a privileged complete
   database rollback, which this block does not claim to detect externally.
3. Attempt behavioral/Proxy/accessor values at the enrollment binding, registry read, freshness array/item, database-row,
   roster, and public projection boundaries. Record whether any trap executes.
4. Prove only authenticated persisted telemetry can produce `current`. Discovery, capability, benchmark, enrollment age,
   installed runtime, SSH configuration, and compatibility must not do so. Test missing, expired, future, excessive-lifetime,
   malformed, cross-node, and cross-tenant signals.
5. Prove `current` cannot change qualification, live-panel, approval, command, lease, or execution authority.
6. Use locator-shaped connection/node/enrollment identifiers and sensitive-looking route/profile/issuer/host-key digests.
   No source or tenant identity, locator, port, address, hostname, credential, path, or per-enrollment digest may reach the
   API/UI. Ordinal references must remain stable for one projection and must not claim durable identity.
7. Verify owner authentication precedes both roster and freshness reads, errors fail closed, the endpoint is GET-only, and
   an absent/unavailable protected source never falls back to fixtures or invented live state.
8. Check PostgreSQL/PGlite migration compatibility, append-only triggers, tenant/node foreign keys, transaction locking,
   restart behavior, exact replay, active capacity, expiry, deterministic roster order, and read/write race behavior.
9. Check browser imports for Node/database/private modules and UI wording for false online, healthy, available, qualified,
   or authorized claims.
10. Check documentation and test-count claims against the target; passing producer tests are evidence, not acceptance.

## Deterministic commands

Use the repository-installed dependencies without downloads or network fallback:

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx
node --import tsx --test tests/project-event-store.test.ts tests/project-event-reconciliation.test.ts tests/project-event-sse.test.ts tests/project-live-activity.test.tsx tests/idea-lab-local-pilot.test.ts tests/connection-center-contract.test.ts tests/connection-center-route.test.ts tests/connection-center-http-client.test.ts tests/connection-center-ui.test.tsx
node --import tsx scripts/verify-migrations.ts
npm run build
node --test tests/rendered-html.test.mjs
git diff --check 737d9744c00129882af00094a84eae1f28a5a5a2..456f4d1f715e583c18f6533075a9d83346a22b95
```

Reviewer-owned temporary tests may be created only outside the repository and must be removed. Do not run `npm install`,
contact GitHub, start a persistent server, access credentials, launch Hermes/SSH/native processes, contact a provider or
production PostgreSQL, deploy, or perform any external effect.

## Stop and report

Return one disposition for the exact target: `accepted` or `rejected`. List every finding by High/Medium/Low severity with
file/line evidence, reproduction, observed versus expected behavior, and whether it blocks acceptance. State which required
attacks and commands were actually run, their exact outcomes, cleanup/working-tree status, and all unobserved claims.
Do not repair. A useful negative report is a successful review outcome and must remain preserved.
