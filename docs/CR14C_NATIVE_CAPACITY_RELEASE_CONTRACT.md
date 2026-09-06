# Verified native capacity release before quality acceptance

Root contract, 2026-09-05. Base `ef2a2ff985897b36fb2194ca878bca7bc0c5a5d8`, PR #334.
This supersedes only the rule that native quality completion must itself release an active
lease. It does not change quality requirements, canonical job/attempt success, native
execution authority, source-scheduled ownership, or excluded draft PR #329.

## Separate execution occupancy from quality outcome

An authenticated completed native run with its exact saved bytes and submitted review
target may release its own current canonical lease before quality acceptance. Neither a
successor plan nor a replacement result is required: both would unnecessarily couple
capacity to a later step. This permits ordinary reviewed work and revisions on bounded
nodes. The source job and attempt stay byte-for-byte unchanged, retaining their existing
leased/running/waiting projections until quality completion. Their historical assignment
must explicitly show the released lease; those job states alone are never new admission.
No new state vocabulary, schema, role grant or automatic native retry is introduced.

Use the same exact native-result inspection, indexed/payload identity checks, latest
lease epoch and authenticated terminal-event/deadline proof as canonical completion.
Unknown, failed, revoked, expired, replaced or already-cancelled execution cannot release
capacity through this operation. Recording may happen after the timestamp deadline only
if native completion happened before it and the canonical lease is still active; recorded
expiry wins. Current time cannot precede any involved state/evidence timestamp.

Release only the lease, using a legal versioned transition, normal outbox and sanitized
audit in one transaction. Persist a separately HMAC-authenticated, exact-request receipt
under a deterministic native-capacity namespace. It names producer, lease/epoch/version,
native completion time, release time, and unchanged job/attempt versions and full-record
digests (including state), with explicit
false quality/approval/execution-authority flags. Current-operation fences apply before
commit and after acknowledgement. Missing or tampered release proof is never repaired.

## Later quality completion and replay

Initial release and exact replay require unchanged non-terminal job/attempt state and
versions. A completed job uses the existing completion receipt, not an early-release retry.
Later quality completion still requires the exact ready target and every existing review,
verification, native, lineage and timestamp check. It accepts an already released lease
only with its exact authenticated native-capacity receipt and unchanged recorded
job/attempt versions. It transitions job/attempt to success without rewriting the lease;
the completion receipt retains that lease's actual version. Completion replay validates
both release and completion evidence, preserving their distinct recorded timestamps.
An optional authenticated capacity-release digest in the completion receipt pins that
prerequisite even when both timestamps coincide; legacy receipts omit it unchanged.
Legacy active-lease completion remains byte-compatible. Arbitrarily released leases cannot
be adopted. Neither superseded nor changes-requested output becomes successful.

## Mounting and proof

The existing optional quality coordinator releases capacity after inspection/verification
for non-ready results, returning explicit capacity-release evidence with its existing
truthful quality disposition. Ready results retain normal completion. Bounded sweep uses
the same path; no timer, native writer, listener or runtime is activated. Earlier evidence
commits can survive later interruptions; exact replay is required instead of retries of
native work. Existing web role remains read-only for these canonical transitions.

Root owns production and integration. Isolated agents test the frozen implementation;
independent review checks the altered completion/lease boundary. Prove pending, failed
check, requested-change and superseded cases, later fresh approval/completion, distinct
timestamps, exact replay, missing/tampered receipt, wrong lineage/epoch, expiry/currentness
races, rollback and lost acknowledgement. Prove original capacity is actually released
before a child assignment at the same configured limit, with source quality history
unchanged and no repeated native start. PGlite/fake transport is not live fleet evidence.
