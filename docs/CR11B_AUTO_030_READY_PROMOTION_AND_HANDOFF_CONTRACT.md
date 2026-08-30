# CR11B-AUTO-030 Ready Promotion and Internal Handoff Contract

**Status:** independently accepted for exact effect-free repository commit `adf0804a52a13d544192afc90506c3e989254ffd`

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

The promotion request binds the authenticated AUTO-020 materialization receipt, canonical job, standing policy, ready policy, request and promotion times, and exact reservation expiry. The service re-reads the authenticated frontier evaluation and both current policies. It verifies the complete source, evaluation, proposal, materialization, standing-policy, ready-policy, job-authority, route, platform, capability, risk, cost, project, and time lineage. A required injected trusted clock supplies the current canonical UTC instant. The clock is sampled only after both policy guards are acquired, repeatedly inside the canonical transaction, by the transaction owner after the application callback and before commit initiation, and again after transaction completion before the result returns. Promotion time cannot be in the future or more than five seconds old, and policy, materialization, authority, reservation, and handoff freshness are checked against the non-decreasing trusted time rather than caller history.

The service holds the current standing-policy guard and then the current ready-policy guard through the canonical database transaction. While both are live, the service privately mints one opaque exact-operation authorization. Only this module can mint it; the canonical store can acquire a registered use. The authorization binds the complete authenticated receipt, both full policy snapshots, exact materialization time, and the trusted clock. The canonical port accepts only that token, clones its hidden bindings, derives every request, receipt, transition, ceiling, resource, reservation, actor, and handoff write fact locally, and never accepts or reuses caller-owned persistence facts. An unawaited database promise remains registered, so policy callbacks cannot commit, retire the authorization, or admit suspension/revocation until the canonical use settles. Guard operations queue, reentrant synchronous policy mutation cannot roll back another operation's transaction, and capabilities retire on exit. A concurrent revision, suspension, or revocation must serialize entirely before or after promotion. A stale, superseded, suspended, revoked, narrowed, foreign, over-capacity, or changed input fails before a partial result can survive. No standalone persistence or authorization-minting function is exported.

The deterministic CR6 scheduler scores only the exact authenticated candidate. It does not discover or accept caller-selected alternatives. The scheduler decision, reservation, handoff packet, and final promotion receipt have stable digest-bound identities. Handoff packets and receipts are separately HMAC-authenticated. A tenant-scoped canonical idempotency record binds each promotion request ID to the exact request digest, receipt, job, reservation, and handoff; exact simultaneous replay converges and changed reuse fails before mutation.

## Atomic canonical result

One canonical transaction:

1. acquires the exact-operation authorization and locks the tenant scope and exact proposed job;
2. verifies the global and project active-ready ceilings;
3. locks the resource head, expires stale reservations, and verifies capacity;
4. inserts one active database reservation;
5. transitions the exact job from `proposed` version 0 to `ready` version 1; and
6. inserts one record into the dedicated `control_ready_frontier_handoffs` table with its only permitted state, `pending_internal_handoff`; and
7. completes the exact promotion-request idempotency record; and
8. resamples trusted time after the transition, handoff, and request-completion phases;
9. invokes the transaction adapter's mandatory trusted-time predicate after the complete application callback and before commit initiation; and
10. resamples time after transaction completion and before returning a new or replay result.

The handoff packet destination is `internal_scheduler_jobber_table` and its state is `pending_internal_handoff`. It is not stored in `control_outbox`, so generic delivery cannot claim it. Exact replay runs after the tenant lock, verifies the completed request identity, exact ready job, active reservation and resource-head capacity, transition, and pending handoff, and then resamples trusted time after its final evidence read, at the adapter-owned pre-commit boundary, and after transaction completion before returning the same authenticated receipt. A forced handoff collision or authorization expiry detected through the pre-commit boundary rolls back the idempotency record, job transition, reservation, transition evidence, ordinary domain-event outbox write, and internal handoff.

The process clock cannot prove the external database's physical commit timestamp. The adapter-owned pre-commit predicate is the last abort-capable boundary and contains no awaited application seam before commit initiation. If authorization ceases to be current only after a successful commit but before the canonical result returns, the caller receives explicit canonical ambiguity rather than a current-success claim; the durable request lineage supports later reconciliation. A replay crossing the same post-transaction window likewise cannot return `replayed: true`.

Two independent evaluation/policy stores and two promotion services can enter the same shared local canonical transaction boundary concurrently. The repository evidence converges an exact duplicate to one new result and one replay. This is local PGlite/PostgreSQL-compatible evidence only; independent multi-process PostgreSQL convergence remains unproved.

The transaction creates no attempt, approval, schedule, claim, lease, effect intent, provider request, agent message, GitHub item, or executor invocation. Generic transition cannot ready a frontier work order, generic delivery cannot see its handoff, and generic job claiming rejects frontier-ready jobs. No consumer for the dedicated internal handoff is part of AUTO-030.

## Operator projection

The portfolio and Project Workspace show repository ready-policy state, the absence of production enrollment, and whether historical ready/internal-handoff evidence exists. Receipt-only projection is explicitly historical and never claims a current ready job or pending handoff because it has no authenticated current canonical-state cut. Observation before the authenticated promotion fails; current and post-expiry observations retain only the historical count. The repository fixture currently shows no requested promotion. The views contain no form or control for promotion, approval, scheduling, claiming, leasing, messaging, dispatch, or execution.

The projection omits proposal objectives, intent identity, owner evidence, authentication tags, private locators, credentials, source evidence, and handoff payloads.

## Explicit stop boundary

AUTO-030 is repository simulation only. It has no real policy enrollment, timer, recurrence activation, outbox consumer, GitHub jobber creation, agent message, native read, provider client, credential access, claim, lease, dispatch, execution, filesystem or network effect, DNS, Cloudflare, hosting, deployment, or production action.

The initial independent review rejected the first candidate, and three successive different-agent reviews rejected the first, second, and third remediations. All four negative reports remain unchanged. A fresh different reviewer re-ran every recorded attack against exact fourth-remediation commit `adf0804a52a13d544192afc90506c3e989254ffd` and returned `ACCEPTED_EFFECT_FREE_REPOSITORY_SNAPSHOT`; that unchanged report has SHA-256 `18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2`. AUTO-040 remains a separate repository-only no-relay simulation and protected activation packet, and any real activation remains owner-gated.
