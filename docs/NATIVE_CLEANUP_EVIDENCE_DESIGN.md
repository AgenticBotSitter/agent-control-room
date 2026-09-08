# Native task cleanup evidence

Architect-authored, local implementation direction, 2026-09-08. This is a missing
dependency of consecutive pickup, not permission to qualify a host or settle claims.

Reuse the existing owner-public pin store, artifact signature verification, native
run journal and local effect-claim store. Custom code is limited to binding their
evidence: generic queue and SQLite libraries cannot establish that one particular
native task and its descendants are quiescent.

An owner-accepted **cleanup producer** is distinct from a profile acceptance. The
existing profile guarantees do not attest to per-task descendant checks. Its new
domain-separated acceptance must bind the exact enrollment and producer, bounded
lifetime, qualification evidence, node class and approval key, and explicitly accept
exact-run isolation, descendant-stop verification, native-request drainage and
durable revision tracking. Only separately reviewed host evidence can justify a
real owner signature. There is no signer or automatic upgrade of old acceptance.

The producer's protected synchronous snapshot must match the exact enrollment,
native binding, upstream run ID, native snapshot digest and local marker. It must
report quiescence with zero remaining descendants and pending native requests,
after the retained successful completion and claim marker, with a monotonic
revision and a validity window of no more than thirty seconds. Producer state is
not a browser payload, native capabilities response or hash of `close()`.

The consumer verifies owner acceptance and exact retained run/claim identity,
checks freshness on both sides of key resolution, and returns a synchronous
freshness closure plus a sanitized digest. It also computes one fixed confirmation
event and a guard for precisely its before/after claim digests. The guard normalizes
only that exact transition while checking unchanged run, producer proof, trust and
time; it cannot bless a caller-selected replacement event. It does not update claims, authorize
execution, claim server result acceptance, or free capacity. Runtime ownership,
canonical result/lease evidence and atomic/idempotent local settlement must still
be joined by the lifecycle owner before another task can start.

Only successful, current, exact native completion is supported initially. Failed,
cancelled, interrupted or ambiguous native snapshots, and missing, expired or
conflicting cleanup evidence remain held. A retained ambiguous effect claim may be
matched to a later successful exact run, but this read-only consumer does not
resolve its ambiguity or release its hold. In-memory revision tracking is not
restart protection: the accepted producer
must preserve monotonic revision and current state durably. A verifier cannot prove
its producer's physical observations independently. Synthetic tests validate the
consumer only; no real Hermes cleanup producer is presently installed or qualified.

## Transactional settlement seam

The existing local effect store now offers `applyChecked`: an exact-current-snapshot
comparison and synchronous checks before and after the proposed event, under its
existing SQLite write transaction. Failed checks roll back both event history and
capacity changes. Another connection sees the previous committed snapshot until
commit. Replays also require the expected current snapshot and fresh checks; an old
pre-transition digest cannot authorize a replay against a changed record.

This is a trusted internal persistence seam, not a cleanup verifier. The callback
must return exactly `true` synchronously and must not write stores or perform
external effects. Returned promises are refused and their rejections observed.
The existing unguarded event API retains its existing trusted-writer contract.

The lifecycle integration still must derive a fixed confirmation event from verified
cleanup evidence, validate all unchanged non-claim evidence across this one exact
transition, finish execution-state recording before freeing the effect claim, and
reconcile canonical result/lease acceptance before fresh pickup. Separate SQLite
files do not provide a shared transaction. Any crash between execution completion
and effect confirmation must retain the active effect hold and reconcile exact
recorded events, not invent a new native attempt or clear history.

## Local successful-task settlement

`createNativeTaskSettlement` now joins runtime drainage, this cleanup consumer,
execution state and the guarded effect store. `closeForSettlement` binds the actual
runtime to its previously verified dispatch binding, awaits its existing bounded
close, and checks that no local native requests or owned pending work remain.
It explicitly does **not** attest to descendant termination. Both that local closure
and the separately accepted producer proof are mandatory.

The settlement owner checks exact execution identity, admission, authority and
deadline; records completion at the retained native observation time using a stable
event; then confirms the effect under pre/post-write freshness checks. The overall
operation has a monotonic deadline and uses the existing bounded unary-call helper
for runtime close. Cancellation, bad closure evidence, async assertions and late
verification failures refuse settlement. The instance closes permanently after an
attempt. Reconstructing it after an execution-only commit replays the exact execution
event rather than running native work again. No transaction across the separate
execution/effect files is claimed.

The real runtime integration test now reaches retained result bytes and pending
quality review, closes its actual per-task runtime, and settles local execution/
effect records using synthetic producer evidence. It preserves canonical records
and adds no native calls. This does not qualify a physical cleanup producer or turn
on a continuous worker. Canonical result acknowledgement and lease release remain
separate existing operations. Historical receipt recovery after effect confirmation
already committed is described below; dynamic next-runtime selection and the complete
two-independent-task journey remain unfinished. A fresh consumer refuses an already confirmed effect
instead of asserting fresh cleanup from historical evidence.

## Historical committed settlement recognition

`readNativeSettlementHistory` recognizes an already committed local success from
existing protected effect, execution and native journals. It needs no cleanup
producer, owner pins, runtime, provider call or new table. The effect store returns
its exact last confirmed event after validating the full event chain, including
event-ID and timestamp lookup mirrors. The reader matches exact task/native snapshot,
execution completion event, identity, admission, authority and deadline, and returns
only sanitized evidence digests and an explicit historical classification.

This trusts protected-store integrity. Event-name prefixes and hashes are not
authentication of a physical producer, and historical recognition is not new cleanup
qualification. The result explicitly grants no execution, verifies no current cleanup,
releases no capacity, and claims neither canonical lease release nor quality acceptance.
Compacted, missing, changed or contradictory records are refused. Two matching reads
detect observed cross-store changes; they are not an atomic snapshot across separate
SQLite files. A deadline and cancellation are checked after reads as well as before.
The effect history lookup takes the existing SQLite writer lock but changes no rows.

The integrated source test recognizes committed settlement after closing the synthetic
owner pins and advancing beyond cleanup-proof expiry, with no additional native calls.
A separate real-file effect-store test closes/reopens SQLite and rejects corrupt event
lookup mirrors. These are local historical/reconstruction tests, not a physical fleet
restart or continuous two-task acceptance.
