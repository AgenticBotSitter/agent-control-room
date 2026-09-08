# Actual etcd service independent source review

2026-09-08. Reviewed acquisition/service harnesses, fit report, corrected receipt and
preserved initial failure. No service rerun, download, credential access or application
change. This reviewer did not independently observe process cleanup or retained files.
Root retains security/selection authority.

## Disposition

No blocking contradiction for the eight bounded E2 observations. They are actual
service primitives, not a completed CR checkpoint adapter or custody comparison.

- CAS uses two real simultaneous HTTP transaction requests with identical expected
  bytes, distinct next values and empty failure branches. Exactly one success and
  subsequent stale refusal are asserted. Requests are concurrent from the client;
  no claim of internal simultaneous server execution or broad contention load follows.
- Restart compares the complete returned KV object, not just a counter. It occurs
  **before auth setup**, so authenticated restart/token persistence is not established.
  Cluster/member identity across restore is not established by KV equality.
- After enabling auth, actual runtime identity reads its key, receives recorded403
  for neighbor and administration attempts, and deletes its own key with deleted=1
  followed by empty read. This decisively corroborates the WRITE/delete limitation.
  Initial CAS runs unauthenticated during owner setup; it is not scoped-token CAS
  coverage. Root setup/runtime share an in-memory random test password but authenticate
  as distinct usernames; this is not production credential separation qualification.
- Payload is plainly a synthetic object rather than RollbackCheckpointV1. No digest,
  scope/generation, next-revision or staged-SQL policy is borrowed from these successes.

The denial assertions accept any non200 or error body. The saved actual403 responses
support the reported run; a future reusable policy test should assert permission-denied
specifically rather than count unrelated server errors as authorization evidence.
That weakness does not erase the two recorded403 outcomes or own-key positive controls.

## Failure and lifecycle fidelity

The initial zero-exit expectation failure is retained and not counted as a passing
workload. The single repair accepts requested SIGTERM as observed terminal state, not
graceful shutdown. Both corrected stops record SIGTERM, no watchdog failure, and state
removal. This supports the restart test and owned-process termination, not application
drain guarantees, descendant-tree containment or durable snapshot restoration.

Explicit loopback URLs, sterile child environment, hash-checked executable, request/
startup/lifetime/output bounds and sampled RSS limit are present. The Go memory target
and sampled kill threshold are not hard OS limits; response size is checked only after
buffering. Report correctly discloses both. Port discovery releases sockets before
launch, so it does not reserve them atomically. Readiness is endpoint health plus child
liveness, not cryptographic proof of endpoint ownership; treat this as an isolated
disposable fixture assumption, not a hostile-local-host transport qualification.

## Acquisition and retention scope

Acquisition checks expected compressed size and checksum while streaming, extracts to
new candidate directories, records file hashes and measures allocation. Those hashes
give release provenance, not independent signer trust or full license clearance.
Archive path validation rejects absolute/parent traversal names; entry type and extracted
size checks occur **after extraction**, so do not call it a general untrusted-archive
sandbox or a streaming extracted-size cap. Only the specifically pinned official
archives are the demonstrated scope.

Service state cleanup waits on the owned child's terminal event and removes only its
new directory. Distributions remain intentionally retained, with their target in the
acquisition ledger; `stateRemoved` is not whole-cohort cleanup. Author records successful
cleanup, not this reviewer. No service-registration or public ingress step exists here.

Remaining CR payload/adapter, dropped-write response, missing/replaced anchor, scoped
CAS, supported restore and split SQL/anchor commit tests are genuine unclosed work.
OpenBao remains the strongest operation-capability alternative. No winner, production
policy or deletion is justified by this packet alone.
