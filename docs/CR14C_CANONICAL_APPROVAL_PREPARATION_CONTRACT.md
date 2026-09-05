# CR14C — canonical native approval preparation

Date: 2026-09-05. Repository-only coordinator integration based on PR #309.

The assignment coordinator now builds unsigned native approval material from its real saved plan and
canonical reservation rather than requiring a caller to supply plain job/attempt/lease records.
`prepareNativeApproval` is a trusted server-side operation; it is deliberately absent from `webOperation`
and is not mounted on a route or used by the deployment bootstrap.

The pure native schemas and task-binding builder live in the shared `src/harness/v1` contract layer.
The native adapter re-exports those same definitions for compatibility; the application imports only
the shared modules. Neither shared module imports the native adapter, transport or journal. The existing
application/native isolation test remains unchanged and must pass; this is not an adapter allowlist exception.

## Configuration and authority

The constructor accepts an optional explicit list of reviewed enrollments with their node classes.
The default is empty: existing assignment behavior is unchanged, and approval preparation fails until
configured. Parse/copy all entries, reject duplicate node IDs, cross-tenant entries and nodes outside
configured assignment routes. No browser/request field supplies profile, model, destination or node class.

Preparation requires a current authenticated human owner with `tasks.read` and `tasks.approve` for the
project, using existing session/grant locks and precommit checks. An earlier assignment does not grant
approval access after logout, session revocation or role change. This permission only prepares unsigned
material; it is not a signature, step-up ceremony or task execution authorization.

## Locked canonical sources

Use the same tenant/project/job/lease/attempt/node ordering as assignment and expiry. Hold the ordinary
project's lifecycle head and verify it remains active. Verify the saved execution plan and its canonical
records through the existing integrity-aware planner; require the expected saved input digest. Read the
existing assigned lease and attempt with their projection/transition receipt checks, not caller IDs.
Require the configured enrollment for that reserved node and matching route executor.

The current node must be active, with matching identity/state/version projection. Its exact identity key
must still be active and within validity. Pass the checked plan content, canonical reservation, configured
enrollment/node class and freshly sampled time to `prepareNativeTaskApproval`. That existing builder owns
payload, authority, one-attempt, lease lineage and stable run/session/claim binding validation.

Before commit, recheck session/grants and the current clock against both prepared work deadline and
identity-key expiry, including backwards time. Waiting for locks cannot return already-expired signing
material. No shortened payload is fabricated to fit a different authority. Node keys still must be
rechecked by execution policy later; preparation is not ongoing key availability or host qualification.

## Output and effects

Return copied enrollment, unsigned request/start/binding/body, preparation time and source/input digests.
The exact prompt and instructions are private task data for the authorized signer flow, not a public
status response. Existing web authentication may register its session; there are no new canonical
transitions, approvals, effect records, native runs or outbox commands. Repeated preparation cannot
dispatch, sign, claim additional capacity or change the reservation.

The transaction proves the snapshot at preparation, not that it remains valid afterward. Signed packet
intake, persistence and dispatch must recheck current reservation/authority at their own boundaries;
the node still requires its separate current policy, qualification, admission and pre-effect marker.

## Remaining

This closes canonical preparation provenance, not approved-packet storage or native job delivery.
Owner signing/custody, authenticated packet intake and canonical persistence, durable supervisor state,
signed dispatch and revisions remain. No real database, credential operation, native/provider call,
listener, deployment or merge is performed. Continue repository integration on Astra Medium.
