# CR10A OPS-050/060 acceptance

**Disposition:** Accepted for the exact local fake-only snapshot
**Date:** 2026-08-29
**Native or external effects:** None attempted

## Accepted implementation

- `src/operations/v1/backup-dry-run.ts` — pure exact backup/WAL plan, retention/resource ceilings, factory-only fake adapter, manifest verification, and safe projection
- `src/operations/v1/backup-fake-runner.ts` — authenticated fake claim/marker/receipt orchestration, separated from the protected contract path
- `src/operations/v1/fake-lifecycle-ledger.ts` — private exact-schema SQLite fake ledger with whole-state HMAC, rollback-checkpoint port, restart reconciliation, and terminal ambiguity
- `src/operations/v1/fake-recovery.ts` — empty-target fixture, eleven-phase coordinator, one-use target claim, fake restore/WAL/validation evidence, cleanup, independent attestation, and RPO/RTO calculation
- `scripts/operations-backup-dry-run.ts` — no-command safe JSON rehearsal
- `tests/operations-backup-recovery-harness.test.ts` — focused acceptance and hostile matrix

## Acceptance facts

1. The protected backup contract and CLI contain no database, storage, filesystem, subprocess, or network client import.
2. Backup plans bind exact topology, release, database service, retention policy, estimates, and digest-only protected references.
3. The CLI contains no command lines or effect controls and cannot accept a target.
4. Fake manifests contain no database bytes, WAL bytes, object locator, or credential material.
5. Manifest verification rejects mutable, incomplete, byte-bearing, foreign-release, foreign-topology, and out-of-bound evidence.
6. Retention and resource estimates fail closed above their frozen ceilings.
7. Lifecycle claims are one-use, markers precede simulated effects, receipts are digest-bound, and HMAC/checkpoint verification detects forged stored state.
8. Reopening after an unsettled marker produces terminal ambiguity and never redispatches.
9. Recovery accepts only an empty disposable fake identity distinct from all production principals.
10. All eleven phases execute in exact order; only synthetic restore and WAL phases receive effect markers.
11. A used target cannot be claimed by a second recovery plan.
12. Missing audit anchor, attempted node-truth overwrite, self-validation, failed cleanup, and reordered phase requests fail closed.
13. Independent attestation binds all eleven receipts, backup, topology, release, health, journals, cleanup, identities, measured RPO, and measured RTO.
14. Recovery evidence grants no production readiness, cutover, approval, restore, or execution authority.
15. No real host, database, storage target, locator, credential, key, process, runtime, provider, network, backup, restore, or cutover was touched.

## Focused hostile evidence

The focused suite covers:

- locator and credential-shaped insertion;
- mutable manifest and missing WAL bound;
- database/WAL bytes presented as evidence;
- cross-release manifest;
- retention and resource ceiling overrun;
- post-marker restart and retry refusal;
- at-rest receipt forgery;
- production target and reused disposable target;
- wrong release and restore point outside the WAL window;
- reordered recovery phases;
- missing external audit anchor;
- refusal to overwrite node truth;
- refusal of self-validation;
- failed cleanup;
- uncertain restore outcome after the durable marker.

## Residual boundaries

This acceptance proves contract and state-machine behavior only. The lifecycle ledger is fake-harness infrastructure and its test checkpoint is in memory. Real backup, WAL archiving, protected-reference resolution, storage allocation, restore, clean-host qualification, independent native validation, cleanup, measured production RPO/RTO, and cutover remain separate owner-controlled future operations. None is inferred from this acceptance.

## Validation

- OPS-050/060 focused suite: 16/16 passed
- Combined CR10A OPS-000 through OPS-060 suite: 63/63 passed
- Repository pretest: 412/412 passed
- Existing main suite: 416 total, 414 passed, zero failed, two intentional platform skips
- Type checking and full lint: passed
- Production build and rendered HTML: passed; two rendered routes passed
- PostgreSQL migration verification: 96 tables passed
- Git diff whitespace validation: passed
