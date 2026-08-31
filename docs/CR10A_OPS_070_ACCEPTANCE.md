# CR10A OPS-070 acceptance

**Disposition:** Accepted for the exact local synthetic, provider-disabled snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/monitoring.ts` — exact metric and alert policy, append-only fake time-series store, deterministic evaluator, correlated incident store, safe projection, synthetic fixtures, and disabled notification adapter
- `src/operations/v1/index.ts` — versioned public export
- `tests/operations-monitoring.test.ts` — focused acceptance and hostile matrix
- `package.json` — OPS-070 registered in the normal pretest and CR10A suites

## Acceptance facts

1. The policy freezes nine metric IDs, nine rule IDs, four queue classes, seven service roles, and exactly thirty expected series.
2. Arbitrary labels, dimensions, subjects, services, queues, rules, ordering, thresholds, and runbook links fail closed.
3. Samples are exact, scope-bound, digest-only, append-only, chronological, replay-safe, and limited to ninety-six per series.
4. Raw tenant/project IDs, secret-like values, locators, credentials, destinations, provider bodies, authority, and effect instructions cannot enter the contract.
5. The evaluator emits exactly one result per expected series and deterministically separates firing, unknown, clear-pending, and clear-candidate states.
6. Missing, stale, and explicitly unknown samples remain visible and never become healthy.
7. Incident clearance requires two consecutive current passing samples.
8. Incidents correlate by scope, rule, and series; exact replay does not open duplicate incidents or notification loops.
9. Open and escalation transitions create proposal-only notification evidence; updates, clears, and exact replay do not create delivery attempts.
10. A re-signed handcrafted clear batch is refused even when all ordinary digests are recomputed.
11. The disabled notification adapter refuses forged proposals and cannot approve, authorize, contact a provider, or deliver.
12. The operator projection is bounded, digest-only, fixed-runbook-linked, and control-free.
13. The implementation imports no telemetry, provider, notification, network, process, database, filesystem, or credential client.
14. No telemetry endpoint, provider, destination, token, account, credential, network, notification, host, process, service, deployment, rollback, or external effect was touched.

## Hostile evidence

The focused suite covers policy/cardinality/threshold/runbook drift, foreign scope, changed replay, raw labels, secret-shaped fields, arbitrary subjects, accessors and proxies, missing/stale/unknown data, insufficient clear evidence, incident loops, escalation, forged clears, notification-as-approval, forged notification proposals, unsafe projections, and accidental client imports.

## Residual boundaries

This acceptance proves only synthetic contract and state-machine behavior. The stores are bounded in-memory test implementations. Production telemetry collection, durable incident persistence, external rollback-resistant integrity, provider integration, destination enrollment, notification wording and delivery, real thresholds, on-call procedures, native observation, and live incident response remain unimplemented and separately owner-controlled. Monitoring evidence grants no operational authority.

## Validation

- OPS-070 focused suite: 11/11 passed
- Combined CR10A OPS-000 through OPS-070 suite: 74/74 passed
- Repository pretest: 423/423 passed
- Existing main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- Type checking and full lint: passed
- Production build and rendered HTML: passed; two rendered routes passed
- PostgreSQL migration verification: 96 tables passed
- Git diff whitespace validation: passed
