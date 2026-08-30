# CR11B-AUTO-030 Independent-Review Remediation

**Status:** implementation complete; independent re-review required

**Rejected target:** `47e4000fb374eaefdfeb31e88db127505d3f11dc`

**Preserved review:** `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md`

**Preserved review SHA-256:** `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`

## Disposition

The first independent review rejected AUTO-030 with five reproduced findings. A separate transaction audit confirmed the generic-ready bypass, untrusted-time acceptance, shared-outbox exposure, stale replay truth, and missing simultaneous-concurrency evidence. The remediated candidate does not reinterpret either negative result as acceptance.

## Remediation binding

| Finding | Remediation | Hostile evidence |
|---|---|---|
| `AUTO030-REV-001` generic proposed-to-ready bypass | Generic canonical transition rejects `ready-frontier-work-order/v1`; the dedicated mutation also requires simultaneous unforgeable standing- and ready-policy guard capabilities. | Direct generic transition leaves the job proposed with zero transition, reservation, handoff, or outbox rows. Retired guards cannot call the internal canonical port. |
| `AUTO030-REV-002` stale exported persistence seam | The standalone persistence function is removed. Persistence is private to the guarded service, and the canonical port verifies both live policy-guard capabilities against exact policy identity, revision, and digest. | A receipt built before terminal ready-policy revocation cannot be persisted with captured retired guards. |
| `AUTO030-REV-003` reused request identity | The canonical transaction locks the tenant, writes `control_idempotency` under scope `ready-frontier-promotion`, and binds request digest, receipt, job, reservation, and handoff. | Simultaneous exact requests converge to one result; the same request ID with a different job is rejected before mutation. |
| `AUTO030-REV-004` stale replay truth | Replay is checked only after the tenant lock and requires the exact completed request record, ready job, active reservation, resource-head capacity, canonical transition, and pending dedicated handoff. | Expired reservation replay fails; simultaneous exact retry converges rather than colliding. |
| `AUTO030-REV-005` invalid projection time | The shared canonical-time schema now proves a real round-tripping UTC instant before projection. | Non-instants, offset form, impossible dates, pre-effective time, exact expiry, and post-expiry cannot produce an active policy label. |
| Shared delivery and claim exposure | Migration `0027` moves the packet out of `control_outbox` into `control_ready_frontier_handoffs`, whose only state is `pending_internal_handoff`. Generic delivery cannot see it, and generic claim rejects frontier-ready jobs. | Delivery claims only the ordinary domain-transition event; direct job claim fails before node or lease creation. |
| Caller-controlled time | The service requires an injected trusted clock, checks canonical time, rejects future promotion time and more than five seconds of skew, and evaluates policy/materialization/reservation freshness at trusted time. | Historical and future envelopes leave canonical state unchanged. |
| Same-instance policy rollback race | Both policy stores queue async guards, reject synchronous policy writes and close while a guard is pending/active, roll back only transactions they began, and retire guard capabilities on exit. | A forced reentrant suspension and close cannot roll back the active guard; the guard commits and the store remains valid. |

## Current evidence

- AUTO-030 focused tests: 13/13 passed.
- Combined CR11B gate: 57/57 passed.
- Registered pretest lifecycle: 639/639 passed.
- Core suite: 414/416 passed, with two intentional platform skips and zero failures.
- Public post-test suite: 52/52 passed.
- Type checking and lint passed.
- Production build and 2/2 rendered-route tests passed.
- macOS stage-zero reported `ready_for_runtime_check`.
- Migration verification passed through `0027`, with 97 PostgreSQL tables.
- Whitespace validation passed.

The complete repository gate is green. An independent re-review of the exact remediated commit is still required. No production policy, consumer, schedule, claim, lease, dispatch, provider/agent contact, GitHub mutation, deployment, or external effect is authorized.
