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
freshness closure plus a sanitized digest. It does not update claims, authorize
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
