# E75 — checkpoint deployment boundary and next acceptance

2026-09-06. Source/documentation audit and offline limitation diagnostic. No provisioning.

## Decision

Keep etcd as a conditional candidate, not an accepted production dependency. Stop
expanding the protocol mapper until independent custody and restore behavior are
qualified. Do not introduce an additional custom proxy, consensus engine or secret
vault merely to make the current candidate seem complete.

The governing requirement is CR8B_COMPLETION_GATE_CONTRACT.md, Persistence and
integrity: an owner-controlled checkpoint outside the protected PostgreSQL
deletion/rollback domain, with explicit one-time provisioning and owner recovery for
split commits. CR14A's same-OS-identity/admin exclusion remains unchanged; it does not
permit untrusted worker code in the trusted controller process. Node owner ceilings
and independent approvals continue to contain a compromised server as specified.

## What etcd does and does not supply

The upstream [RBAC guide](https://etcd.io/docs/v3.6/op-guide/authentication/rbac/)
documents read/write permissions on exact keys or ranges, not an application-level
rule that checkpoint revisions may only increase. Consequently, restrict credentials
to the exact key, but do not call this a monotonic-only credential. A compromised
holder must not be assumed to obey our client wrapper. Whether stronger custody is
required must be decided against the threat boundary, not hidden inside a test.

The [restore guide](https://etcd.io/docs/v3.6/op-guide/recovery/) documents new cluster
identity on supported snapshot restore and optional revision bumps. Those mechanisms
are not proof against rolling back an entire old disk image with its old identity.

The new offline limitation test demonstrates the distinction: an old anchor disagrees
with a newer database digest, but restored old database and old anchor agree. Static
cluster/key identity does not fix that. Ten record/access tests and targeted lint pass;
the limitation test is negative product evidence, not passing recovery acceptance.

## Proposed placement, not authorization

- PostgreSQL remains the sole global business/job write authority on the private VPS.
- The anchor stores only integrity checkpoint records, not jobs, queues or artifacts.
- Prefer an independently managed, always-on owner-controlled location outside the
  VPS snapshot/restore domain. A separate container or directory in the same full-VPS
  snapshot is insufficient for that failure case.
- A home Mac/PC could be evaluated only if its availability is acceptable: unavailable
  anchor blocks protected operations. Do not quietly switch to a local substitute.
- No additional machine, paid service or deployment location is selected by this note.

## One consolidated setup/rehearsal packet

Before requesting a live run, prepare these exact items together:

1. Selected independent host/storage location, separation from database backups and
   explicit maximum resource/time budget. Identify restore authority and availability.
2. Pinned server/client versions and complete applicable license notices; E69's client
   lock is retained, but is not server acquisition or full license clearance.
3. Private endpoint, server identity verification and per-service client identity;
   no public listener, shared admin credential or worker access. Restrict the key range
   and separately protect maintenance/metrics surfaces. Never print credentials.
4. A disposable scope and one-time creation command whose key must be absent, initial
   application revision must be one, and failed comparison performs no writes.
5. Owner-controlled capture of cluster/key generation and initial checkpoint digest
   outside the protected restore domain. Runtime receives validated setup; it does not
   discover a missing pin from the record it is supposed to verify.
6. Single agreed evidence/cleanup directory and process handles; no production data.

Acceptance must exercise real transport and real service behavior, not just mocks:

| Scenario | Required observation |
|---|---|
| Concurrent updates to the same prior record | Exactly one accepted conditional update |
| Lost response / deadline / cancellation | No automatic reissue; uncertain result retained |
| Service/client restart | Same persisted record, not memory reconstruction |
| PostgreSQL-only rollback or deletion | Protected operation refused |
| Supported anchor restore / key recreation | Identity/generation change refused until reviewed recovery |
| Both disks restored with unchanged identities | Explicit failure-boundary evidence; never claim static pins detect it |
| Anchor unavailable | Protected operation refused, no fallback initialization |
| Anchor advances but SQL rolls back | Mismatch retained; no reset or blind replay to manufacture success |

## Recovery and remaining product work

On mismatch, stop protected writes for the affected scope, retain sanitized evidence,
and require owner-reviewed reconciliation. Do not reset the anchor or automatically
initialize a replacement. A detailed recovery algorithm is still required before daily
use; a read-only diagnosis procedure does not itself authorize destructive repair.

Safe work can continue on initial-create request/receipt evaluation, license provenance,
and the owner-signing/host setup path. Running the above service rehearsal needs a
fresh consolidated authorization and an actual independent-placement decision. Do not
declare all Control Room work blocked while those local integration tasks remain.
