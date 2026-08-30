# CR10A OPS-080 acceptance

**Disposition:** Accepted for the exact local planner-only, effect-free snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/canary-rollback-planner.ts` — exact planner, four intent contracts, authenticated restart-safe ledger, external checkpoint binding, portable snapshot, reconciliation, safe projection, and disabled executor
- `src/operations/v1/index.ts` — versioned public export
- `tests/operations-canary-rollback-planner.test.ts` — focused acceptance and hostile matrix
- `package.json` — OPS-080 registered in the normal pretest and CR10A suites

## Acceptance facts

1. The planner consumes one exact deployment plan, all eighteen exact current readiness gates, and one exactly bound application rollback plan.
2. The source owner window, deployment plan, rollback plan, and planner must all remain current for the complete planner lifetime.
3. The planner freezes eight ordered steps, three owner questions, and four distinct proposal-only effect intents.
4. Every step and question is non-operative, and every intent contains no command, target, credential, client, approval, or authority.
5. Automatic promotion, automatic rollback, down migration, database restoration, automatic post-change retry, canary bypass, and mixed promotion/rollback branches are structurally refused.
6. Database restore cannot be relabelled as application rollback; it remains in the separate recovery path.
7. Canary requires independently verified forward-migration evidence. Promotion requires independently verified pass evidence. Application rollback requires independently verified failure evidence.
8. Claims and markers are evidence-only records and do not dispatch an action.
9. A complete post-marker receipt needs both an effect receipt digest and independent verification digest; partial or changed replay fails closed.
10. Restart before a marker records definite pre-change failure. Restart after a marker records terminal ambiguity. Neither can retry.
11. Whole-state HMAC, a monotonic high-water mark, and an external checkpoint detect wrong keys and older authenticated snapshots.
12. Integrity keys reject shared, shadowed, partial, subclassed, detached, and otherwise hostile binary views without executing getters.
13. Checkpoint Proxies, caller-created planners, forged intents, extras, accessors, and Proxies are refused without executing their traps.
14. The operator projection is bounded, digest-only, control-free, and explicitly distinguishes ambiguity.
15. The disabled executor has no execution mechanism and always stops before credential resolution, target selection, or effect.
16. The implementation imports no filesystem, process, network, service, container, database, storage, provider, or deployment client.
17. No command, host, endpoint, credential, target, service, database, provider, network, migration, canary, promotion, rollback, restore, or external effect was touched.

## Residual boundaries

The accepted ledger proves authenticated restart semantics through a test-only memory port and portable snapshot. Production persistence, rollback-resistant checkpoint custody, owner-decision verification, native effect claims, qualified executors, actual target identity, real canary observation, service control, database migration, promotion, rollback, and restore remain unimplemented and separately owner-controlled. The disabled executor cannot be upgraded in place; a native boundary requires a new review.

## Validation

- focused OPS-080: 16/16 passed
- combined CR10A after OPS-080: 90/90 passed
- repository pretest after OPS-080: 439/439 passed
- main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- TypeScript type check, full lint, production build, 2/2 server-rendered route tests, 96-table migration verification, and diff whitespace validation: passed
