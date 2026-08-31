# CR10A OPS-050/060 backup and recovery harness

**Status:** Complete for the exact local fake-only boundary
**Scope:** Backup/WAL planning, authenticated fake lifecycle evidence, and disposable isolated recovery orchestration
**Not in scope:** A database connection, backup bytes, WAL bytes, storage location, key, credential, provider, native process, restore tool, host, container, cutover, or production action

## Backup and WAL dry-run

`src/operations/v1/backup-dry-run.ts` is the protected contract path. It imports no database, storage, network, filesystem, or subprocess client. It defines:

- an exact topology-, release-, and database-service-bound backup job identity;
- three distinct digest-only protected references for object location, encryption key, and manifest signer;
- continuous WAL plus daily base-backup scheduling semantics;
- ceilings of 35 retained base backups, 168 WAL hours, 90 manifest days, 16 TiB estimated encrypted bytes, 4 TiB estimated WAL bytes, and six estimated hours;
- immutable encrypted manifest requirements with explicit bounded WAL and external audit-anchor evidence;
- stable operation and idempotency digests;
- structural negative authority and explicit absence of commands, clients, locators, credentials, and bytes.

The in-memory adapter creates synthetic digests and metadata only. The manifest verifier re-parses the existing OPS-000 immutable manifest, checks topology, release, database, protected references, restore bounds, estimated bytes, and estimated duration, and returns only `contract_valid_reference_candidate`. External signature verification remains explicitly required.

`scripts/operations-backup-dry-run.ts` renders the plan as safe JSON. Its `commandLines` collection is always empty. It accepts only `--json`; it cannot accept a target or command and cannot resolve protected references.

## Authenticated fake lifecycle ledger

`src/operations/v1/fake-lifecycle-ledger.ts` is deliberately separate from the protected backup contract. It is a test-only local SQLite state machine, not a backup or production database client. It provides:

1. exact non-authorizing operation authorization;
2. one transition from `authorized` to `claimed`;
3. an authenticated pre-effect marker when the operation class requires one;
4. one digest-bound terminal receipt;
5. terminal `ambiguous` recovery when a ledger is reopened after a marker but before a receipt;
6. terminal `failed_before_marker` recovery when it is reopened after a claim but before a marker;
7. no redispatch from any terminal state;
8. HMAC-authenticated whole-ledger state plus an external rollback-checkpoint port;
9. private-file, exact-schema, monotonic-clock, row-shape, receipt-digest, and checkpoint verification.

The acceptance tests use the repository's in-memory rollback checkpoint because this is a fake harness. That checkpoint is not production rollback-resistant storage and grants no runtime authority.

## Disposable recovery coordinator

`src/operations/v1/fake-recovery.ts` consumes the exact OPS-000 recovery plan and runs only repository-created in-memory adapters against an empty disposable fake target. The coordinator:

- consumes each target identity once;
- pre-authorizes and enforces the exact eleven OPS-000 phases in order;
- records pre-effect markers before synthetic base restore and bounded WAL replay;
- binds every phase receipt to the plan and phase digest;
- refuses a production principal as the target through the OPS-000 plan parser;
- verifies topology, release, backup, restore window, external audit anchor, preserved node-journal truth, and independent health evidence;
- keeps the owner cutover gate closed during the eleventh phase;
- records mandatory cleanup and refuses attestation after failed cleanup;
- calculates measured RPO from the incident time and requested restore point;
- calculates measured RTO from coordinator start and completion;
- requires a validator identity distinct from the fake recovery worker and all seven production principals;
- produces only `recovery_candidate_only` evidence.

The final attestation explicitly establishes no production readiness, opens no owner window, attempts no cutover or native action, and grants no approval, restore, cutover, production-readiness, or execution authority.

## State outcomes

| Last durable fact | Restart or next disposition | Automatic retry |
|---|---|---|
| Authorized only | Eligible for one claim | No implicit retry |
| Claimed, no marker | `failed_before_marker` on reopen | No |
| Marker, no receipt | `ambiguous` on reopen | No |
| Authenticated success receipt | Terminal success | No redispatch |
| Authenticated failure receipt | Terminal failure | No |
| Failed cleanup | Recovery failed; no attestation | No |

## Deliberately absent

- PostgreSQL, S3/R2, provider, telemetry, or secret-store clients
- child processes, shell commands, network calls, native tools, host inspection, and containers
- paths, buckets, URLs, accounts, zones, keys, tokens, passwords, or credential values
- database or WAL bytes in Control Room evidence
- production targets, overwrites, migration, service control, canary, rollback, or cutover APIs
- automatic retry after a marker, restart, timeout, unknown outcome, or cleanup failure
