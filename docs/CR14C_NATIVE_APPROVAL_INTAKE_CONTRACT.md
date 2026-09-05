# CR14C — paired native task approval intake

Date: 2026-09-05. Repository-only component based on PR #308.

`createNativeApprovalIntake` receives a start approval and a separately signed recovery permission for
one trusted prepared reservation. It returns verified material for the existing controllers; it neither
signs approvals nor grants execution authority. No route, queue consumer or native transport is mounted.

## Exact prepared work

Construction parses/copies the enrollment, unsigned normalized request and native start, then verifies
their existing payload/operation/claim/run/session commitments. Already signed requests and changed
content cannot become a different intake transaction. Trusted coordinator code must obtain the prepared
material from the authenticated plan and canonical reservation. Plain supplied records are not provenance.

The strict packet contains only its versioned schema plus the existing signed start-attestation and
native recovery-permission schemas. Start approval must target the exact node, tenant, project, job,
attempt, operation and risk. Class-wide approvals are intentionally insufficient for this exact-node
intake. Its signature must be approved, issued no later than now and valid through the prepared deadline.
The intake never shortens a task to fit an earlier approval or changes the approved payload.

Cleanup permission binds the complete native run binding, permits only status/stop, is issued before
the work deadline and no later than now, and expires after work but no later than the enrollment or
five-minute cleanup allowance. Enrollment must leave room after the prepared deadline; this component
does not renew enrollment to create that room. Both owner signatures are mandatory. Missing cleanup,
wrong tasks, forged signatures, unknown keys and unsupported time bounds fail closed.

## Current owner trust and freshness

Resolve both signing keys through the existing separately pinned owner-public-key store for the exact
tenant/node/class. The caller must supply the same protected security repository used by that store.
Key lookups run together under the existing approval store's bounded unresolved reads/timeouts; this
module opens no resources and has no alternate key source. An AbortSignal is checked before and after
key resolution; it does not physically cancel an already pending store read or add a retry loop.

Capture verified committed server-trust revision before the awaits and recheck it afterward, alongside
approval-store lifetime/disposal and a monotonic per-instance clock. Return a synchronous freshness
check with copied packet material. It is not a durable approval ledger, replay-consumption marker,
restart rollback defense, owner presence proof or cryptographic guarantee about underlying key custody.

Intake can repeat validation without dispatching. The existing start controller still resolves current
owner ceiling, signed lease, qualification, pause, credential availability and effect capacity before
durable admission/claim marking and immediately before native bytes. Recovery still requires an exact
known native run and its outstanding durable claim. Intake success does not bypass either controller,
prove a reservation is still active, or authorize automatic retry after uncertainty.

## Remaining integration

Owner UI/signing custody, authenticated intake routing and canonical persistence, durable supervisor
configuration, signed job dispatch and revision submission remain unimplemented. Tests exercise generated
owner keys, real disposable trust/admission/claim/run stores and fake transport only. No owner credential,
provider call, listener, production database, deployment or merge occurs. Live C-WORK remains incomplete.
Continue repository integration on Astra Medium.
