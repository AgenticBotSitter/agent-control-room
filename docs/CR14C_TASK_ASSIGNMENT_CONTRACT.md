# CR14C — canonical task assignment and expiry

Status: independently accepted repository integration; production unconfigured. Base: PR #295.
Evidence: `CR14C_TASK_ASSIGNMENT_ACCEPTANCE.md`.

## Scope

`TaskAssignmentCoordinator` is an internal trusted SQL composition for the existing one-attempt,
approval-required native task class. It receives an existing execution planner and a bounded list of
server-owned node routes. It does not import the native adapter, own credentials, open a pool,
sign a lease/frame/approval, register a run or send a dispatch command.

An optional scope-labelled operation connects it to the protected private task page/API. GET returns
configured candidate labels/platforms and a stored reservation, not a promise of current availability.
POST accepts only assign plus node/input digest, or expire plus input digest. Machine availability and
owner authority are checked again inside the writer. The browser holds one exact uncertain change;
reads/focus/reconnect cannot allocate, expire or retry. Failed reads hide reservation data and actions.
Confirmed identity and known expiry survive out-of-order successful replies. Retained page-local
receipt memory is not authorization and remains hidden without a current successful read.
The ordinary web SQL pool remains restricted. Production startup explicitly rejects assignment
configuration until separately implemented coordinator resource ownership is available.

Owner-only `tasks.assign`, `tasks.read`, current session/grants, ordinary active project, immutable
plan/input, initial child request/workflow/job and no existing attempt are required for a new assignment.
It submits/accepts the child request, activates its workflow, promotes its job and uses the existing
canonical claim operation for one attempt and lease. The source proposal remains inert and unchanged.
These transitions and the audit share one transaction; failure cannot leave a partially ready job.

## Node selection and bounds

A configured route fixes node, executor, capability probe, scratch requirement, concurrency ceiling
(1–8) and lease duration (1–300 seconds). Assignment checks the current active canonical node and
identity key, stored authenticated fleet telemetry and matching passing capability report, scratch,
usable network/thermal state and existing active leases. Missing/stale/failed signals refuse assignment.
The lease ends at the earliest route/job duration, authority expiry, telemetry/capability expiry or key
expiry, with a final precommit deadline check after SQL work. Grant/session freshness also applies.

Fleet reports are allocation evidence only, **not verified native qualification or execution authority**.
The existing schema correctly forbids node self-reporting of verified trust; this block does not change
that rule. Actual node ceilings, typed capability, qualified profile/enrollment, signed lease,
owner approval attestation, pause state and durable pre-effect claim must still pass at local admission.

Tenant locking serializes these allocation decisions; node locking serializes fleet updates and capacity
checks against existing canonical claims. All still-active leases count, including elapsed leases that
have not been reconciled. Routes must be consistent in the eventual trusted coordinator configuration.
Database administration remains trusted. No external rollback anchor or real-PostgreSQL concurrency
rehearsal is claimed from the disposable tests.

## Reconciliation and expiry

Deterministic assignment IDs and the saved canonical claim event reconcile exactly one node/attempt/lease
after lost replies or service reconstruction. Different target nodes conflict. Existing assignments can
be read through exact reconciliation after route removal, closure or elapsed deadlines without extending
authority. Receipts show current lease state and clock freshness; `startsWork` and
`grantsExecutionAuthority` are always false for these coordinator operations.

Explicit owner-authorized `expire` uses canonical expiry plus an atomic audit. It refuses a live lease,
releases an elapsed reservation and marks the attempt orphaned according to existing canonical rules.
It does not prove native cancellation or stop, dispatch new work, or retry the original one-attempt job.
Even if canonical expiry returns the job to ready, this coordinator reconciles its original assignment
instead of claiming another attempt. Node-local capacity and pre-effect checks remain necessary before
any subsequent execution. No automatic sweep/timer is installed by this component.

## Acceptance

Require deterministic plan→assignment→private task view tests, scheduling/role/expiry refusal matrices,
atomic failure and lost acknowledgement tests, capacity serialization, mirror validation and expiry
reconciliation. The synthetic result-delivery chain must label the injected native admission/start/output
gap explicitly. Require independent review, existing regression suites, both builds and unchanged schema
verification. No host/native/provider, database service, listener, deployment or merge is part of this block.

Remaining: production coordinator resource ownership, actual signed
approval/admission/dispatch and bounded revision submission. Continue on Astra Medium; live setup stays gated.
