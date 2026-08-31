# CR10A OPS-090 acceptance

**Disposition:** Accepted for the exact local synthetic, executable-but-disabled snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/runbooks.ts` — exact eight-runbook registry, authenticated resumable instances, bound synthetic evidence, safe guide, rehearsal, abort, cleanup, reconciliation, and terminal ambiguity
- `src/operations/v1/index.ts` — versioned public export
- `tests/operations-runbooks.test.ts` — focused acceptance and hostile matrix
- `package.json` — OPS-090 registered in the normal pretest and CR10A suites

## Acceptance facts

1. The registry contains exactly deploy, forward migration, one-host canary, application rollback, backup/WAL, isolated restore, incident isolation, and audit-anchor recovery in fixed order.
2. Each graph freezes exact ordered step IDs, kinds, evidence classes, boundaries, cleanup, and reconciliation; semantic re-signing and registry reordering fail closed.
3. Every effect-shaped step is a disabled slot with no native executor, target, command, automatic retry, approval, authorization, or execution authority.
4. Evidence is synthetic, fresh, digest-bound, and exact to one instance, operation, definition, step, and evidence class.
5. Step skipping, out-of-order evidence, cross-instance reuse, cross-operation reuse, cross-step reuse, and changed replay are rejected. Exact replay is inert.
6. Stale evidence is recorded distinctly and blocks before change; it cannot be relabelled as a valid result.
7. Owner gates are rehearsal-only evidence and cannot contain or grant owner approval.
8. Whole-state HMAC authenticates resumable instances. A new authenticator with the same exact identity and key can resume; the wrong key and an ordinarily re-signed forgery fail.
9. Closing an authenticator wipes its internal key and permanently prevents further use.
10. Shared, detached, shadowed, partial, subclassed, or otherwise hostile binary keys fail without invoking attacker getters.
11. Extras, accessors, wrapper Proxies, and option Proxies fail without invoking hostile traps.
12. Before change, failure, uncertainty, stale evidence, or abort blocks with no retry path.
13. At or after a change boundary, failure, uncertainty, or abort can proceed only through exact cleanup and reconciliation before terminal ambiguity.
14. Cleanup cannot be omitted and reconciliation cannot run early.
15. All eight fake rehearsals finish as evidence-only completion with zero effect attempts and no commands or authority.
16. Safe guides contain no controls, commands, credentials, hosts, or execution claims.
17. The protected implementation imports no filesystem, process, network, service, container, database, storage, provider, or deployment client.
18. No command, host, endpoint, credential, target, service, database, storage system, provider, network, deployment, migration, canary, rollback, restore, incident action, or external effect was touched.

## Residual boundaries

The accepted authenticator and evidence builders are test-only. Production persistence, rollback-resistant checkpoint custody, key custody, owner-decision verification, production values, target identity, qualified native adapters, native effect claims, service/database/storage/provider execution, independent receipts, and real cleanup/reconciliation evidence remain unimplemented and separately owner-controlled. A native executor cannot be added to this module; it requires a new security boundary and review.

## Validation

- focused OPS-090: 16/16 passed
- combined CR10A: 106/106 passed
- repository pretest: 455/455 passed
- main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- TypeScript type check: passed
- full lint: passed
- production build: passed
- server-rendered route tests: 2/2 passed
- migrations: 0026 applied, 96 PostgreSQL tables verified
- diff whitespace validation: passed
