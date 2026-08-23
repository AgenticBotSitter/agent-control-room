# CR-4A canonical domain contract and state machines

**Status:** Implemented

**Contract:** `control-room-domain/v1`

**Boundary:** Types, validators, JSON Schema, transition tables, authority-containment rules, and contract tests only. No database or live integration is authorized here.

## Canonical records

| Record | Purpose | Primary lifecycle |
|---|---|---|
| Request | One-off or ongoing owner intent | draft → submitted → accepted → fulfilled |
| Workflow | Versioned graph compiled from a project pack or proposal | proposed → active → paused/succeeded/failed |
| Job | Immutable schedulable specification and authority envelope | proposed → ready → leased → running → outcome |
| Attempt | One placement/execution history for a job | offered → leased → running/waiting → outcome |
| Lease | Time-bounded, epoch-protected ownership of one attempt | active → expired/released/revoked |
| Checkpoint | Ordered resumability evidence from an attempt | declared → stored → verified/rejected |
| Effect intent | Durable record of a consequential external operation | proposed → authorized → executing → confirmed/failed/ambiguous |
| Approval | Decision bound to one operation digest, scope, actor class, and expiry | pending → approved/denied/expired; approved → revoked |
| Service | Continuously desired state and current operational condition | active/degraded/paused/failed → retired |
| Schedule | Recurrence definition that creates finite work or checks | active ↔ paused; either → disabled |
| Incident | Evidence-backed operational/security exception | open → acknowledged/mitigating → resolved → closed |
| Artifact manifest | Lineage and immutable metadata for bytes stored elsewhere | declared → uploaded → verified/quarantined/rejected/deleted |
| Node | Enrolled machine identity and administrative lifecycle | pending → active/draining/offline/quarantined → revoked |
| Message envelope | Authenticated, expiring cross-boundary message | Not persisted as a domain lifecycle |

## Universal transition rules

Every mutation in CR-4B and later must:

1. name the expected record version and current state;
2. select an edge present in the CR-4A transition table;
3. satisfy the edge guards below;
4. increment the version once in the same transaction;
5. write its outbox/audit event in that transaction;
6. return an idempotent receipt for a repeated mutation key;
7. reject rather than infer an unrecognized state or transition.

Terminal records do not reopen unless an explicit edge exists. A retry creates or re-readies work only through the documented job edges; it never rewrites a succeeded attempt.

## Job edge guards

| Edge | Required evidence |
|---|---|
| proposed → ready | Specification validates; dependency graph is acyclic; authority is current; policy accepts the job |
| proposed → rejected | Stable safe reason code |
| ready → leased | Eligible node atomically accepts a new attempt and monotonic lease epoch |
| leased → running | Matching node, attempt, unexpired lease, and epoch |
| leased → ready | Lease expired/released before execution; retry policy permits |
| running → waiting_approval | Exact effect operation digest exists and no valid approval is bound |
| waiting_approval → running | Unexpired approval matches operation digest, scope, actor requirement, and policy |
| running → succeeded | Output verification passes; required effects are confirmed; attempt owns current epoch |
| running/waiting → orphaned | Heartbeat/lease evidence is lost; no terminal result accepted |
| failed/orphaned → ready | Attempts remain below limit; failure is retryable; ambiguous effects are reconciled or placed in attention |
| any cancellable state → cancelled | Actor/policy is authorized; node cancellation is requested when applicable |

## Cross-record invariants for CR-4B

These invariants are part of the contract even though PostgreSQL enforcement arrives in CR-4B:

- `(job_id, attempt_number)` is unique and attempt numbers increase monotonically.
- At most one active lease exists for a job; lease epochs only increase.
- A lifecycle event from an old lease epoch cannot complete the current job.
- `(attempt_id, checkpoint_sequence)` is unique and sequences never decrease.
- Effect idempotency keys are unique within their destination/operation scope.
- An ambiguous effect blocks blind retry until destination reconciliation or explicit attention resolution.
- Approval applies only to its exact operation digest and cannot broaden the job authority envelope.
- Child authority must be a strict subset of or equal to its parent and must cite the parent digest.
- Artifact lineage must resolve to its producing project/job/attempt and a verified content hash.
- Signed URLs and credential material are not valid artifact locators.
- Revoked nodes and disabled schedules cannot be reactivated by an ordinary transition.
- Optimistic record version mismatch fails without a partial state, audit, or outbox write.

## Authority ordering

Delegated authority may reduce operations, credentials, duration, cost, network destinations, effect authority, and expiry. Network access is either absent or an explicit destination-reference allowlist; child destinations must be a subset. It may not change projects or executors, add credentials/operations, extend expiry, remove a parent cost ceiling, or replace an approval requirement with preauthorization. An omitted parent cost ceiling means no paid authority, not unlimited spending. The child cites the exact parent digest so comparison cannot silently use a newer envelope.

All `sha256:` fields are lowercase SHA-256 over the contract-defined payload serialized with RFC 8785 JSON Canonicalization Scheme. A record's own digest field, mutable lifecycle state, database version, timestamps, receipts, and signatures are excluded unless the particular digest contract explicitly includes them. CR-4B/CR-4C must verify rather than trust caller-supplied digests at their boundaries.

## Contract sources

- TypeScript types: `src/domain/v1/types.ts`
- Runtime validators: `src/domain/v1/validators.ts`
- Transition tables: `src/domain/v1/state-machines.ts`
- Authority comparison: `src/domain/v1/authority.ts`
- Generated JSON Schema: `contracts/control-room-domain-v1.schema.json`
- Contract tests: `tests/domain-contract.test.ts`

The generated JSON Schema supports external adapters. Zod validators and transition/authority functions remain the executable in-process contract. Cross-record transactional invariants are tested against PostgreSQL in CR-4B.
