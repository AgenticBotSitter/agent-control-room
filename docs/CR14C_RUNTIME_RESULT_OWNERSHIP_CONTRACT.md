# Trusted runtime result ownership

Root-owned contract, 2026-09-05; base `8e3247ee24de4f1402b1cc47b29f6a196c3da844` (PR #336).

## Delivered connection

Optional trusted startup owns a third bounded pool against the same private PostgreSQL
primary. Its fixed `control_room_native_results` role is distinct from both existing
web and task-coordinator logins. All configured role/schema gates finish before mounting.
Without it, the existing two-pool behavior and runtime surface remain unchanged.

The returned internal `results.register` and `results.submit` commands take only exact
project/job/run IDs and an AbortSignal. Scope is captured tenant/workspace configuration;
callers cannot supply a profile, revision context, bytes, producer, authority or review.
No new HTTP/browser route or automatic callback/timer is introduced.

- Register: lock and verify the actual recorded native run and saved execution plan; use
  the existing planner's authenticated v1/v2 profile/context binding and submission service.
  A fresh binding requires an already recorded discovered run and unexpired native deadline.
  Project closure does not discard already authorized in-flight result evidence.
  Exact existing binding reconciliation is permitted after expiry without resurrecting work.
- Submit: verify the same saved execution plan/run, then re-read authenticated stored
  result metadata and actual bytes through the existing submission service. Create only the
  initial target or correctly linked revision/target. Return narrow receipt metadata, never
  the private execution plan, original prompt or prior result text.
- Preserve native-run/job lock order before Completion Gate locks. Capture all inputs and
  supplied keys/methods before asynchronous work. Guard every SQL await, final precommit and
  acknowledgement against cancellation, non-monotonic time and a ten-second operation limit.
  Nested checkpoint advances flush only at the outer transaction's final precommit boundary.
- Shared coordinator admission/drain bounds cover the optional writer. Health loss or close
  invalidates retained handles and in-flight sessions; every owned pool closes at most once.
  Lost acknowledgement is uncertainty; explicit exact replay can reconcile durable records.

## Database boundary

Root authors migration0055, offline role setup, exact privilege gate and schema fingerprint.
The new false-valued job lock column supplies row locking without granting canonical job
state updates. Existing web/coordinator role definitions and their write policies stay unchanged.
The result writer reads only execution/run/result/review identity and preflight dependencies;
it inserts native review plans, native-linked target/revision gate records and audit, and updates
only gate integrity, audit heads and inert lock columns. A role-specific insert guard rejects
profiles, reviews, findings, verifications, approvals and unlinked/native-producer mismatches.
No run/progress/artifact capture, job/attempt/lease transition, outbox write or provisioning grant.
Database privileges supplement, not replace, application HMAC, checkpoint and lineage verification.

## Evidence and authority

Root owns all production, role/schema changes and normative contracts. Separate agents add
bounded isolated persistence/role tests and startup/compiled tests after the product freeze;
a third independently reviews the exact boundary. Existing dependencies only, stage zero first.
Initial and revised producer cases must execute registration/submission using the actual restricted
writer. Fixture preparation and fake native transport remain explicitly labeled; a privileged
source generation is not evidence that a complete shared chain used the writer throughout.

No credential access, provider/native call, new listener, physical PostgreSQL, service start,
DNS, deployment or merge is authorized. Actual run/progress registration, physical result
transport, owner signing, supervisor activation and live end-to-end acceptance remain later work.
