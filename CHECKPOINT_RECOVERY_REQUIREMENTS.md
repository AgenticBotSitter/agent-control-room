# Checkpoint recovery: unfinished production gate

The completion ledger lives in PostgreSQL. Its independent checkpoint detects
rollback or deletion; it is not a second copy of the ledger. The selected etcd
adapter does not make the two commits atomic.

## What the current implementation proves

`pnpm test:checkpoints` exercises exact-key conditional updates, bounded calls,
staging and the actual completion-store mismatch check. In the split test, a
scripted external peer advances while its acknowledgement is lost. PostgreSQL
rolls back. A new store refuses reads, writes and initialization on the mismatch.
This is intentional refusal, not completed recovery. The peer is not real etcd.

## What must not be used as a repair

- Do not overwrite the checkpoint with the current database digest.
- Do not bypass integrity checking or substitute an in-memory checkpoint.
- Do not initialize a missing/replaced key from an untrusted read response.
- Do not retry an uncertain mutation to find out whether it happened.
- Do not restore the database and anchor together and call them independent.

The checkpoint retains a state digest, authentication tag, revision and count—not
the lost ledger records. An advanced checkpoint alone cannot reconstruct a rolled
back SQL transaction. A matching authenticated recovery source must exist before
claiming a repair is possible. Re-signing the old database is not recovery evidence.

## Remaining implementation package

1. Specify the independently retained recovery evidence and ownership boundary.
   Reuse existing database backup/WAL facilities and retained authenticated records
   where they actually supply the missing data; demonstrate any gap before adding
   a recovery journal. A rolled-back SQL mutation is not assumed recoverable from
   an ordinary committed-state backup.
2. Bind a recovery operation to exact tenant, database state, independently pinned
   checkpoint generation and approved target state. Require current owner authority
   and exclusive maintenance ownership; ordinary web/worker credentials cannot
   repair, rotate pins or create a new checkpoint generation.
3. Build read-only diagnosis first, then an explicitly authorized recover/restore
   path. If no authenticated matching state is available, report that limitation
   instead of guessing. Preserve conflicting evidence before any destructive step.
4. Test both commit orders and lost acknowledgements against disposable real
   PostgreSQL and etcd: before write, after anchor write, after SQL commit, during
   recovery and after recovery restart. Verify exact ledger contents and restricted
   roles, not merely equal revision numbers or a successful health check.
5. Independently review the recovery implementation, placement and runbook before
   enabling production completion writes with this adapter.

No recovery command or production change is authorized by this document. Native
services, credentials, independent storage placement and restore operations need
their separately scoped operator approval. The six-batch goal remains incomplete.
