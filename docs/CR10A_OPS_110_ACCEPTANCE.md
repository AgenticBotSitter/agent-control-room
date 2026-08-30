# CR10A OPS-110 acceptance

**Disposition:** Accepted for the exact local synthetic dry-run, authenticated lifecycle, and executor-disabled snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/retention-cleanup-dry-run.ts` — exact plan, fake inventory, report, HMAC/checkpoint lifecycle, safe projection, and disabled executor
- `scripts/operations-retention-cleanup-dry-run.ts` — deterministic no-target JSON dry-run projection
- `src/operations/v1/index.ts` — versioned public export
- `tests/operations-retention-cleanup-dry-run.test.ts` — focused acceptance and hostile matrix
- `package.json` — CLI and OPS-110 registered in the normal pretest and CR10A suites

## Acceptance facts

1. A plan is created only after re-deriving the exact OPS-100 primary evidence, assessment, and proposal.
2. Twelve ordered steps preserve policy, inventory, hold, horizon, reference, owner, claim, marker, receipt, audit, and reconciliation boundaries.
3. Delete, compaction, source reconciliation, and quarantine remain four distinct lanes.
4. Delete and compaction require action-specific digest-tombstone evidence.
5. Source reconciliation and quarantine require their own distinct independent evidence.
6. Plans are bounded to fifteen minutes, 100,000 records, and 1 TiB of declared inventory.
7. The current adapter is repository-created fake-only and reads no body or locator.
8. Fresh holds, active references, inventory drift, already-absent targets, and existing terminal evidence block or reconcile.
9. A clean dry run creates only an external-authority review candidate and grants no cleanup authority.
10. Exact plan identity produces one stable operation and idempotency key.
11. HMAC authenticates complete lifecycle state and an independent checkpoint rejects rollback.
12. Exact lifecycle replay is inert; changed replay and a duplicate start fail.
13. Restart after claim but before marker records definite pre-marker failure without retry.
14. Restart after marker without receipt records terminal ambiguity and rejects late success.
15. Restart after a complete receipt can resume only reconciliation.
16. Definite failure is reconciled separately and cannot become synthetic success.
17. The projection authenticates current state and exposes no action controls.
18. The executor always stops before client, credential, locator, or effect.
19. Extras, accessors, Proxies, shared/hostile keys, wrong keys, forgery, rollback, aliases, and cross-evidence substitution fail closed.
20. The module and CLI import no filesystem, process launcher, database, storage, provider, or network client.
21. The no-target CLI emits a deterministic safe JSON projection with zero authority.

## Residual boundaries

Production retention values, legal authority custody, real inventory/reference/horizon adapters, subject resolution, durable policy/hold/lifecycle stores, protected key custody, rollback-resistant checkpoint infrastructure, owner-decision verification, actual tombstone construction, native claims/markers, storage-specific idempotency, cleanup adapters, independent native receipts, absence verification, audit append custody, and ambiguity reconciliation remain unimplemented. No data has been read, moved, compacted, quarantined, reconciled at a source, or deleted.

## Validation

- focused OPS-110: 21/21 passed
- no-target JSON dry-run CLI: passed
- combined CR10A: 145/145 passed
- repository pretest: 494/494 passed
- main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- TypeScript type check: passed
- full lint: passed
- production build: passed
- server-rendered route tests: 2/2 passed
- migrations: 0026 applied, 96 PostgreSQL tables verified
- diff whitespace validation: passed
