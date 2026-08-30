# CR11B-AUTO-030 Ready Promotion and Internal Handoff Contract

**Status:** remediated implementation candidate for repository-only simulation; acceptance requires independent re-review

## Purpose

AUTO-030 proves that one exact canonical proposed job may become ready under an unchanged standing policy and a separate, narrower ready-policy addendum. The same database transaction reserves bounded scheduler capacity and records one internal scheduler/jobber handoff. It does not approve, schedule, claim, lease, dispatch, execute, contact an agent or provider, mutate GitHub, or create an external effect.

## Separate ready-policy lifecycle

The standing policy from AUTO-020 deliberately denies ready and scheduling authority. AUTO-030 therefore adds a separate append-only ready-policy lifecycle rather than widening that policy in place. Each ready-policy revision binds:

- tenant, workspace, policy identity, monotonic revision, predecessor digest, lifecycle action, and state;
- the exact parent standing-policy identity, revision, and digest;
- digest-only ready-review and owner-authentication evidence;
- effective, expiry, and maximum-materialization-age limits;
- global and per-project active-ready ceilings;
- exact project, route, platform, capability, risk, and cost ceilings;
- one resource key, requested units, capacity, and reservation lifetime per project; and
- repository-simulation-only permission for a ready transition, database reservation, and canonical internal handoff.

The fixture states that production owner authentication and production independent review are both unverified. It denies automatic approval, schedule creation, claim or lease, dispatch or execution, provider contact, agent messages, GitHub mutation, and external effects.

The private owner-mode SQLite ledger authenticates every row and complete ordered state with HMAC and compares it with an external rollback checkpoint. Revision, restart, tamper, deletion, complete-database rollback, scope, schema, file-identity, and terminal-revocation rules match the standing-policy boundary. Suspension and revocation preserve the preceding ceiling, and revocation is terminal.

## Exact promotion lineage

The promotion request binds the authenticated AUTO-020 materialization receipt, canonical job, standing policy, ready policy, request and promotion times, and exact reservation expiry. The service re-reads the authenticated frontier evaluation and both current policies. It verifies the complete source, evaluation, proposal, materialization, standing-policy, ready-policy, job-authority, route, platform, capability, risk, cost, project, and time lineage. A required injected trusted clock supplies the current canonical UTC instant; promotion time cannot be in the future or more than five seconds old, and policy, materialization, authority, and reservation freshness are checked against trusted time rather than caller history.

The service holds the current standing-policy guard and then the current ready-policy guard through the canonical database transaction. Each guard has an unforgeable in-memory capability bound to the exact policy identity, revision, and digest; the canonical promotion port requires both capabilities to remain live. Guard operations queue, reentrant synchronous policy mutation cannot roll back another operation's transaction, and capabilities retire on exit. A concurrent revision, suspension, or revocation must serialize entirely before or after promotion. A stale, superseded, suspended, revoked, narrowed, foreign, over-capacity, or changed input fails before a partial result can survive. No standalone persistence function is exported.

The deterministic CR6 scheduler scores only the exact authenticated candidate. It does not discover or accept caller-selected alternatives. The scheduler decision, reservation, handoff packet, and final promotion receipt have stable digest-bound identities. Handoff packets and receipts are separately HMAC-authenticated. A tenant-scoped canonical idempotency record binds each promotion request ID to the exact request digest, receipt, job, reservation, and handoff; exact simultaneous replay converges and changed reuse fails before mutation.

## Atomic canonical result

One canonical transaction:

1. locks the tenant scope and exact proposed job;
2. verifies the global and project active-ready ceilings;
3. locks the resource head, expires stale reservations, and verifies capacity;
4. inserts one active database reservation;
5. transitions the exact job from `proposed` version 0 to `ready` version 1; and
6. inserts one record into the dedicated `control_ready_frontier_handoffs` table with its only permitted state, `pending_internal_handoff`; and
7. completes the exact promotion-request idempotency record.

The handoff packet destination is `internal_scheduler_jobber_table` and its state is `pending_internal_handoff`. It is not stored in `control_outbox`, so generic delivery cannot claim it. Exact replay runs after the tenant lock and verifies the completed request identity, exact ready job, active reservation and resource-head capacity, transition, and pending handoff before returning the same authenticated receipt. A forced handoff collision rolls back the idempotency record, job transition, reservation, transition evidence, ordinary domain-event outbox write, and internal handoff.

The transaction creates no attempt, approval, schedule, claim, lease, effect intent, provider request, agent message, GitHub item, or executor invocation. Generic transition cannot ready a frontier work order, generic delivery cannot see its handoff, and generic job claiming rejects frontier-ready jobs. No consumer for the dedicated internal handoff is part of AUTO-030.

## Operator projection

The portfolio and Project Workspace show repository ready-policy state, the absence of production enrollment, and whether a ready/internal-handoff result exists. The repository fixture currently shows no requested promotion. The views contain no form or control for promotion, approval, scheduling, claiming, leasing, messaging, dispatch, or execution.

The projection omits proposal objectives, intent identity, owner evidence, authentication tags, private locators, credentials, source evidence, and handoff payloads.

## Explicit stop boundary

AUTO-030 is repository simulation only. It has no real policy enrollment, timer, recurrence activation, outbox consumer, GitHub jobber creation, agent message, native read, provider client, credential access, claim, lease, dispatch, execution, filesystem or network effect, DNS, Cloudflare, hosting, deployment, or production action.

The initial independent review rejected the first candidate. A different independent agent must re-review the exact remediated commit and every recorded attack before AUTO-030 may be accepted. AUTO-040 remains the separately owner-gated end-to-end no-relay simulation and protected activation packet.
