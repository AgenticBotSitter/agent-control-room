# CR10A OPS-100 acceptance

**Disposition:** Accepted for the exact local policy, evidence, proposal-only, executor-disabled snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/privacy-retention.ts` — exact data registry, policy revisions, requests, holds/releases, evidence, assessments, proposals, disabled adapter, and safe projection
- `src/operations/v1/index.ts` — versioned public export
- `tests/operations-privacy-retention.test.ts` — focused acceptance and hostile matrix
- `package.json` — OPS-100 registered in the normal pretest and CR10A suites

## Acceptance facts

1. The data registry contains exactly fourteen ordered classes with canonical, re-derived semantics.
2. Audit/security truth is preserved indefinitely as a full append-only record.
3. Replay and idempotency truth can at most compact to a required digest tombstone after the maximum dependency horizon.
4. Private body classes can at most become owner-review deletion candidates; public/source-authoritative classes use source reconciliation.
5. Policies bind exact project scope and registry revision. Missing production durations fail closed as unconfigured.
6. Later policy revisions require a predecessor digest; revision one forbids one.
7. Retention rules contain no legal decision, automatic deletion, approval, or execution authority.
8. Requests carry only exact scope and digest references. Subject erasure requires a subject digest and forbids a raw subject.
9. Active legal holds win before every request type. Subject-specific holds conservatively block broader unresolved requests.
10. Release evidence is exact-hold-bound and evidence-only; it cannot delete or grant authority.
11. Unknown dependency horizons, active references, unconfigured policy, and early expiry all preserve data.
12. Assessments cannot cross policy, project, request, evidence, hold, or release scope.
13. Candidate proposals carry ten exact gates and keep owner decision, effect claim, marker, receipt, and independent absence evidence missing.
14. The disabled adapter accepts only an in-process repository-created proposal and always stops before execution.
15. Every delete or compaction candidate requires a tombstone. Audit full-record deletion has no candidate route.
16. Safe projections expose only bounded digest-based cards and no controls, commands, private content, or locators.
17. Extras, accessors, Proxies, deterministic identity drift, semantic re-signing, cross-scope holds, and copied proposals fail closed.
18. The implementation imports no filesystem, process, database, object-store, provider, or network effect client.

## Residual boundaries

Production retention values, jurisdiction-specific rules, authenticated legal authority and release custody, subject-identity resolution, bounded inventory adapters, active-reference indexing, dependency-horizon aggregation, durable policy and hold persistence, rollback-resistant audit custody, owner-decision verification, protected claims, pre-effect markers, native cleanup adapters, destination idempotency, independent terminal receipts, and ambiguity reconciliation remain unimplemented. No legal validity has been determined. No data has been read, moved, compacted, quarantined, or deleted.

## Validation

- focused OPS-100: 18/18 passed
- combined CR10A: 124/124 passed
- repository pretest: 473/473 passed
- main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- TypeScript type check: passed
- full lint: passed
- production build: passed
- server-rendered route tests: 2/2 passed
- migrations: 0026 applied, 96 PostgreSQL tables verified
- diff whitespace validation: passed
