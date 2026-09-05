# CR14C — native start authority and atomic capacity

Date: 2026-09-05. Repository composition only; no runtime activation.
Base: PR #300, `396c8a68b2b80bc8ce3f5ef2ebb133965a44b561`.

## Scope

`createNativeStartAuthority` connects an exact payload-bound, separately owner-signed request to the
existing local policy evaluator and durable admission, execution and effect stores. It supplies the
Hermes adapter's start/capabilities/live-observation authority and commits the real pre-effect marker.
It is not an approval signer, service installer, provider, transport, global scheduler or complete
recovery controller. Stop and post-deadline observation are denied until separately typed recovery
authority is composed. This restriction must remain visible, not presented as working cancellation.

Construction snapshots and verifies enrollment/request/start binding without I/O. Supplied SQLite
stores remain caller-owned; no journal/database/credential/listener is opened. `close` disables this
controller and aborts its pending checks, not the caller's stores or a remote agent.

## Trusted current evidence boundary

`readCurrent` must resolve an already verified owner ceiling, current signed lease provenance, exact
executor capability, key availability, current approval public-key trust, pause and unsettled effect
count. `assertProfileCurrent` must resolve current accepted profile/qualification/OS-isolation evidence
for the exact frozen enrollment. Neither callback can be browser/job/agent supplied. No default or
capability-report substitute exists. This block does not implement those platform resolvers or claim
that a plain object proves a signed ceiling/lease or host qualification.

Every allowed operation re-reads current policy and checks the profile, including the adapter's final
authorization call immediately before authenticated bytes. The actual existing evaluator verifies the
owner approval signature and ceiling/lease/request intersection. Input mutation cannot replace captured
request/configuration or supplied store methods. Resolver snapshots are copied before another await.
These are bounded current snapshots, not an atomic lock over independent external trust services.

Checks allow at most eight concurrent resolver operations, no queue, and at most five seconds each,
also bounded by task/enrollment expiry. Test limits may shorten, never extend this. Close/timeouts abort
the signal; late resolver completion cannot create admission or a marker. Abort does not prove an
uncooperative resolver physically stopped. The local clock must be finite/nonnegative and cannot go
backwards within a controller. Durable expired/cancelled/terminal execution state cannot be resurrected
for live observation by reconstructing a controller with an earlier wall clock.

The task deadline must not outlive the current local ceiling duration, authority duration/expiry,
lease, owner approval or enrollment. The committed absolute deadline remains unchanged. A narrower
new policy denies rather than silently editing the approved payload.

## Admission and pre-effect ordering

For the exact request, the controller records accepted local admission, creates one execution record,
transitions that local authority to executing, claims the effect, and commits the payload-bound marker.
Only a successful new marker acknowledgement enables its own adapter's subsequent start authorization.
No pre-existing execution/claim/marker is reused to submit again. The adapter's separate durable native
journal still owns native one-attempt/idempotency behavior; this authority port is not a generic HTTP
one-shot transport capability. Local authority `executing` is permission state, not observed provider work.

The durable steps use separate existing journals, not a distributed transaction. A partial prefix or
lost acknowledgement remains recorded for reconciliation; no rollback fiction or automatic native retry.
Uncertain marker acknowledgement, or failed start authorization after its own marker, quarantines the
controller and attempts the existing ambiguity transition for its claimed effect. Failure to save that
transition remains uncertain. Native transport/observation outcomes are not automatically settled as
confirmed effects, completed jobs, stopped processes or accepted results by this controller.

Status/events before the work deadline require the exact marker and still-live durable execution plus
fresh policy/profile checks. They can be read by a replacement controller without authorizing another
start. Separate stop/recovery policy is required after expiry; there is no implicit grace period.

## Atomic node capacity

`SqliteEffectClaimStore.claim` accepts an optional `maximumActiveEffects` (1–10,000). Native start always
supplies the lower current ceiling/lease limit. Inside the existing immediate SQLite transaction, before
inserting a new claim, it counts integrity-checked unsettled claims for this tenant/node. Claimed,
executing and ambiguous effects retain capacity; only settled terminal records stop counting. Exact
duplicate/tombstone replay remains independent of new admission capacity. Legacy callers without the
optional limit retain their existing behavior; this is not a retroactive migration of every executor.

`countActive` uses the same integrity-checked count. It scans at most 10,000 full records across the
owned journal and fails closed above that bound; explicit retention/compaction is required, not automatic
eviction. Checking all full rows avoids trusting a corrupt indexed tenant/node/state projection to hide
an active claim. This does not defend against a same-UID attacker rewriting the entire journal/history.

The current count includes this effect once durable. A live recheck subtracts only its exact verified
executing/ambiguous marker-bearing claim, not arbitrary capacity. New claims recheck capacity atomically,
so different task controllers with stale zero counts cannot oversubscribe the same owned node ledger.
All controllers on a node must share the authoritative local effect ledger; separate paths are not a
coordination strategy. PostgreSQL remains the sole global write authority; SQLite is node enforcement.

## Evidence and remaining work

Tests combine actual disposable canonical proposal/planning/assignment, synthetic Ed25519 owner approval,
the existing local evaluator and SQLite admission/execution/effect/native journals with the actual Hermes
adapter and an explicitly fake transport. Qualification and ceiling/lease provenance remain synthetic
trusted seams. Tests cover revocation before bytes, ambiguity, late resolver fencing, current counts,
same/different-task concurrency, two SQLite connections, corrupt count projections and no expiry resurrection.

No physical Hermes/provider operation, owner key access, native qualification, production SQL, service
or deployment is authorized. Next: separately typed exact-run stop/post-deadline recovery, real resolver
composition, owner signing/intake, signed dispatch and bounded revisions. Continue on Astra Medium.
