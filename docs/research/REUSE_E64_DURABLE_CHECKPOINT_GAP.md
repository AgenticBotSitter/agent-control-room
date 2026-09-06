# E64 — durable checkpoint gap and focused reuse evaluation

2026-09-06. Repository audit and public source/documentation research only.

## Verified missing implementation

`src/security/rollback-checkpoint.ts` defines synchronous read/initialize/compare-and-swap
operations and explicitly requires storage outside the database it protects. The only
concrete implementation found is `InMemoryRollbackCheckpointStoreV1`, explicitly
test-only. Other stores consume the interface or buffer updates; they do not supply a
durable external implementation. Completion Gate, result review and planning depend on
this port. `stageCompletionCheckpoint` buffers CAS operations and flushes them at the
SQL boundary; it is not durable storage.

Therefore complete production configuration is not merely filling in passwords and
hostnames. A durable independent checkpoint implementation, provisioning and recovery
policy are missing. An ordinary table in the protected PostgreSQL database or an
in-memory startup reconstruction would contradict the current contract.

CR14A/ADR-202 removes the old LIVE product chain from the default critical path; do not
restart that entire program. It does not turn this current runtime dependency into a
production implementation. Preserve one PostgreSQL job/write authority and R2's
artifact/backup role. A potential anchor service stores only integrity checkpoints,
never job claims, business records or a second scheduler.

## Source-level shortlist, not adoption

| Candidate | Existing primitive | What must be proven |
|---|---|---|
| etcd, Apache-2.0 | Atomic comparisons on key value/version/revision followed by conditional writes | Exact-scope roles, durable CAS, delete/recreate detection, ambiguous reply handling and restore independence |
| OpenBao KV v2, MPL-2.0 | Versioned secret storage with check-and-set | Mandatory CAS, metadata/version binding, deny delete/destroy/reset for runtime principals, consistent reads and operational fit |

Sources: [etcd transactions](https://etcd.io/docs/v3.6/learning/api/#transaction),
[etcd access control](https://etcd.io/docs/v3.6/op-guide/authentication/rbac/),
[etcd license](https://github.com/etcd-io/etcd/blob/main/LICENSE),
[OpenBao KV v2](https://openbao.org/docs/secrets/kv/kv-v2/),
[OpenBao license](https://github.com/openbao/openbao/blob/main/LICENSE).
These are current upstream documentation/root-license observations, not immutable
download pins or a transitive-license clearance. No code was imported or installed.

Neither ordinary CAS nor a product's version counter automatically proves our rollback
threat model. Both services have administrative restore/deletion capabilities. Putting
the anchor inside the same restored VPS snapshot as PostgreSQL cannot demonstrate
independent rollback detection. Define and test the storage/restore failure boundary
before selecting a deployment location. Key-value write access alone must not be
mistaken for an enforced monotonic-only API.

## Next actions and acceptance

1. Prefer a narrow etcd CAS evaluation first; retain OpenBao as the alternative if
   its independently justified secret-management role reduces total setup. Do not
   install two services or write a bespoke consensus/storage engine.
2. Map current checkpoint consumers and plan asynchronous port integration. Both
   candidates use network APIs; blocking the web process with subprocess calls or
   silently returning Promises from today's synchronous `advance(): void` is invalid.
3. Pin the selected package/source and license closure, check space and record any
   authorized acquisition. Running a real service remains a separate scoped operation.
4. Use identical tests: initialize exactly once; competing CAS has one winner; wrong
   scope/revision refuses; dropped response stays uncertain; restart retains state;
   PostgreSQL-only rollback is detected; unavailable anchor blocks protected writes;
   delete/recreate or anchor restore cannot silently certify old data.
5. Reconcile split commit outcomes (anchor advanced, SQL did not commit) explicitly;
   never reset the anchor or retry a changed request to turn uncertainty into success.

No candidate is accepted and no production contract was weakened. Existing compiled
host evidence stands, but does not prove this missing storage dependency. No download,
service, credential access, test run, GitHub write or deployment occurred in this audit.
