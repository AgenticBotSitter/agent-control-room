# Independent review — CR14B disposable fixture preparation

Date: 2026-09-05. Mode: independent-review. Reviewer: separate Codex agent `cr14b_fixture_review`.
The architect authored the implementation; the reviewer made no edits and did not self-integrate.

**Disposition: ACCEPT — repository fixture-preparation scope.**

- Base: `78a6a983b70ccec28f5f1d79787d1e175e345909`.
- Product: `fd8b2736a806735dc07ada577df31967c573a96b`.
- Tree: `a6cf590e7c4ff73b57409a700414a55177091c86`.
- Findings: High 0 / Medium 0 / Low 0.
- All eight changed paths matched the assigned scope: two source modules, three test/helper files,
  package/build registration and the fixture-preparation contract.

## Reviewer conclusions

The preparation gate validates the packet, distinct login coordinates, target binding and deadlines before
opening a pool. Database metadata, reviewed schema, ownership and all 127 public tables' emptiness precede
fixture generation and inserts. All store operations join the outer transaction through the adapter in
`private-rehearsal-fixture.ts` lines 67–73; no nested transaction independently commits. Table locks cover
empty checks and seed writes, with a schema recheck after acquiring locks.

Cancellation/deadlines fence later queries and the pre-commit check. The existing bounded driver closes
uncertain transactions without retry or rollback after an attempted commit. Material becomes available only
after acknowledged commit and successful client shutdown. Retrieval consumes the closure before checking
expiry, and failure paths expose no material.

Evidence distinguishes injected execution, client shutdown, unobserved physical connections, operator-owned
cleanup and unaccepted native PostgreSQL. Synthetic enrollment/telemetry do not acquire native execution
authority. The entry is separate from application routes and startup; imports/construction start no resources.

## Independently observed verification

- macOS stage zero: `ready_for_runtime_check`, exit 0.
- `node --import tsx --test tests/web-fixture-preparation.test.ts tests/web-database-rehearsal.test.ts`:
  28 passed, zero failed/skipped, exit 0.
- Exact candidate diff whitespace check: exit 0.

The reviewer used the delegation-review skill to preserve immutable scope and evidence distinctions.
No files changed, build, network, credentials, native DB, listener, provisioning or deployment occurred.
Compiled-artifact/full-suite results are the architect's separate evidence. Real host isolation, PostgreSQL
concurrency/ACLs and cleanup absence remain future operator verification. This review does not authorize
a native preparation/rehearsal, merge, deployment or claim of private-beta readiness.
