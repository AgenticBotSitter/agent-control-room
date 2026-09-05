# CR14C planned native result submission

Status: implemented for independent review; repository-only, not mounted or deployed.

## Product connection

The trusted planner saves the existing document acceptance profile's exact ID/digest before a native
run has any recorded observations. Authenticated delivery can then submit its verified file to that
profile automatically. The owner can review this exact target through the existing private task pages.
No manually manufactured target is needed in the positive integration test.

`NativeResultSubmissionService.register` is an internal control-plane capability, not a node/browser
authorization endpoint. Its caller must be the future accepted planner. It does not create profiles,
provision checkpoints, authorize work or dispatch anything. Runtime composition is deliberately absent.

## Durable binding and effect limits

Migration 0044 adds one immutable PostgreSQL plan per canonical job and run. The HMAC binds tenant,
project, job, attempt, node, native binding, input and authority digests, exact existing profile,
deterministic initial target ID and planning time. Registration locks run then job, verifies the profile
through the existing Completion Gate, rejects recorded progress and existing review targets, and permits
only an exact immutable replay thereafter. Another attempt cannot obtain a fresh initial review root.
The plan table is not an independently anchored rollback ledger; absent/corrupt plans fail closed.
Database administrators and the internal planner remain trusted. No private web role grants are added.

Submission rechecks the canonical run/job and plan, then reads the authenticated artifact receipt and
actual bounded bytes. It creates only a document target at revision zero, with the recorded node as
producer and canonical job as subject. It does not infer a distinct worker, model or harness identity.
Receipt time supplies the stable submission time. Existing Completion Gate uniqueness/checkpoint
validation prevents alternate initial targets and preserves exact replay without another checkpoint
advance. The audit and target share a SQL transaction; the external checkpoint is staged until the final
precommit check. A failure after checkpoint advancement remains uncertainty, not automatic repair.

Receiving or submitting a file grants no quality acceptance, verification, approval, job completion,
new attempt, execution authority or revision. Acceptance profile requirements still have to be met.

## Delivery failure and recovery

`NativeTaskResultService` accepts an optional, explicitly supplied submission dependency. Its default
behavior is unchanged. When configured, success requires capture and submission. Capture may already
have committed when submission fails: the caller receives rejection, not a false no-write promise.
The stored result stays available for explicit reconciliation; no task or provider is restarted.
Exact subsequent submission reads the original receipt and either registers once or returns the
existing target. Missing pre-run plans cannot be backfilled after progress. Partial/uncertain checkpoint
flush cannot be repaired by this service.

## Verification and remaining integration

Tests use disposable PGlite, synthetic authentication and in-memory artifact/checkpoint adapters.
They cover planned delivery through owner review, reconstruction/concurrent replay, missing plan,
profile/time conflicts, append-only behavior, unavailable bytes, SQL rollback and lost acknowledgement.
They are not PostgreSQL concurrency, physical transfer, browser-click or live-agent evidence.

The private startup schema fingerprint and preparation inventory advance to migrations 0001–0044 /
131 tables. PostgreSQL remains the sole production write authority; PGlite is development/test only.
No production database or account is accessed. No dependencies, Hermes code, network listener, native
credential stores, services, deployment or Sites configuration are changed.

Remaining: executable task planning/admission/dispatch, actual transport composition, and bounded
revision submissions. Cross-attempt/cross-job revision lineage must use the existing revision contract,
not a fresh initial target or an automatic execution retry. This block does not complete C-WORK.

Model for this implementation and next integration block: Astra Medium. Escalate effort only for a
specific unresolved decision or demonstrated difficulty, not merely because the task is integration.
