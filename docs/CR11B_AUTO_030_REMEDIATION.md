# CR11B-AUTO-030 Independent-Review Remediation

**Status:** fourth remediation implementation complete; another independent re-review required

**Rejected target:** `47e4000fb374eaefdfeb31e88db127505d3f11dc`

**Preserved review:** `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md`

**Preserved review SHA-256:** `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`

**Rejected first remediation:** `fd64e418882fb8ca8a044163b2c623f235e21976`

**Preserved first re-review:** `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REREVIEW.md`

**Preserved first re-review SHA-256:** `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652`

**Rejected second remediation:** `5b26a634516ca1a956edfeb67c7480343bf9104b`

**Preserved second-remediation re-review:** `docs/reviews/CR11B_AUTO_030_SECOND_REMEDIATION_REREVIEW.md`

**Preserved second-remediation re-review SHA-256:** `db6e7986b97a877db77cc235a8e9d83b9723ef7a5a4aacdc4fe12805cd2897b7`

**Rejected third remediation:** `9e43ea56471df1ee58dd8e94da04550ce6062063`

**Preserved third-remediation re-review:** `docs/reviews/CR11B_AUTO_030_THIRD_REMEDIATION_REREVIEW.md`

**Preserved third-remediation re-review SHA-256:** `10147ed33b7a95a300c36ac5a1d7d59124c037a8e88fa59323e816f97ffe0acc`

## Disposition

The first independent review rejected AUTO-030 with five reproduced findings. A separate transaction audit confirmed the generic-ready bypass, untrusted-time acceptance, shared-outbox exposure, stale replay truth, and missing simultaneous-concurrency evidence. A different-agent re-review then rejected the first remediation with three High authorization/time defects, one Medium operator-truth defect, and one Low evidence-wording defect. A third independent review rejected the second remediation with two High authorization/time defects, two Medium current-truth defects, and one Low concurrency-evidence defect. The next independent review rejected the third remediation with one High commit-boundary timing defect and one Medium replay-return timing defect. The fourth remediation preserves every negative report unchanged and does not reinterpret any negative result as acceptance.

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

## First re-review remediation binding

| Finding | Second remediation | Hostile evidence |
|---|---|---|
| `AUTO030-RR-001` caller-expanded canonical facts | Only the promotion service can mint an opaque exact-operation authorization. It binds the complete authenticated receipt, both full policy snapshots, materialization time, and clock. The canonical port compares every ceiling, resource, request, receipt, transition, reservation, and handoff fact to that hidden binding. | Seven direct-port attacks alter global/project ceilings, resource key/units/capacity, request/receipt digests, and handoff authority; all leave canonical promotion counts zero. |
| `AUTO030-RR-002` guard retirement before database completion | Canonical acquisition synchronously registers an in-flight use. Authorization retirement awaits every registered use, even if an intercepted caller fires the canonical promise and returns without awaiting it. Both policy callbacks therefore remain active until the database promise settles. | A deliberately delayed unawaited transaction cannot be overtaken by terminal revocation; revocation is rejected until the complete atomic result settles. |
| `AUTO030-RR-003` stale pre-queue clock | The service samples time only inside both acquired guards. The hidden authorization carries the clock into the canonical transaction, which enforces non-decreasing fresh time after the tenant lock and again before reservation and ready/handoff writes. | A queued request makes zero clock calls before guard acquisition and rejects after expiry; a transaction delayed across expiry rolls back request, transition, reservation, outbox, and handoff rows. |
| `AUTO030-RR-004` expired receipt projects pending | Receipt-only projection rejects observation before promotion or at/after reservation or handoff expiry. | Observation at exact handoff expiry fails closed instead of returning `ready_handoff_pending`. |
| `AUTO030-RR-005` whitespace evidence wording | Both review reports remain byte-for-byte unchanged. Current documentation distinguishes architect-owned working-tree validation from the two intentional Markdown hard-break lines in the immutable first report. | Review SHA-256 values remain exact; no clean exact-range claim is made for rejected `fd64e418`. |

## Second-remediation re-review binding

| Finding | Third remediation | Hostile evidence |
|---|---|---|
| `AUTO030-SRR-001` mutable canonical input after validation | The canonical promotion port accepts only the opaque one-use token. It acquires cloned hidden receipt and policy bindings synchronously, derives every tenant, job, request, ceiling, resource, transition, reservation, actor, and handoff write fact locally, and has no caller-supplied fact object to reuse after an `await`. | A legitimate call is intercepted with caller-controlled expanded ceilings, resource facts, digests, and positive handoff authority. The committed bundle still contains only the exact hidden policy/receipt values and negative authority. A forged token remains rejected with zero mutation. |
| `AUTO030-SRR-002` authorization expires during transition-to-commit window | The transaction resamples the non-decreasing trusted clock immediately after `transitionWith`, after the handoff insert, and after idempotency completion at the final callback boundary. Crossing any policy, materialization, reservation, handoff, or job-authority expiry throws inside the transaction. | A deterministic clock advances beyond policy expiry inside the ready transition. The request, transition, ready job, reservation, handoff, and outbox all roll back. |
| `AUTO030-SRR-003` replay crosses expiry after evidence reads | Replay resamples the same trusted clock after the final ready-job read and immediately before returning `replayed: true`. | A deterministic replay clock advances beyond policy expiry only after the handoff, transition, reservation, and job reads. Replay rejects and adds no mutation. |
| `AUTO030-SRR-004` receipt-only projection claims current pending state | Receipt-only projection is explicitly historical. It never reports a current ready job or pending handoff, including before nominal expiry, and rejects only observations that predate the authenticated promotion. | Current and post-expiry observations both report one historical promotion with zero current jobs and zero pending handoffs. A pre-promotion observation rejects. |
| `AUTO030-SRR-005` same-store Promise test does not reach canonical concurrency | Two independent evaluation, standing-policy, and ready-policy stores plus two service instances submit the same exact request to one shared canonical database. | Instrumentation proves at least two promotion transactions were pending at the canonical transaction boundary; they converge to one new result and one replay with exactly one job, reservation, transition, handoff, and request. Multi-process PostgreSQL behavior remains explicitly unproved. |

## Third-remediation re-review binding

| Finding | Fourth remediation | Hostile evidence |
|---|---|---|
| `AUTO030-TRR-001` authorization expires after callback but before commit | `DatabaseClient` now requires a transaction-owner `transactionWithPreCommitCheck` operation. Both PostgreSQL and PGlite adapters execute the trusted-time predicate after the complete application callback and immediately before returning control to their transaction manager for commit. | The exact report probe holds the underlying transaction after the canonical callback returns, advances time beyond policy expiry, and resumes. The adapter-owned check rejects and the request, transition, ready job, reservation, handoff, and outbox all roll back. |
| `AUTO030-TRR-002` replay expires after final callback check | The same adapter-owned predicate covers replay after every evidence read. Canonical promotion then resamples time after the transaction promise settles and before returning either a new or replay result. | A replay held after callback but before commit rejects in the pre-commit predicate. A replay held after transaction completion also rejects before `replayed: true` can return. A new result delayed after commit returns explicit canonical ambiguity rather than current success. |

## Current evidence

- AUTO-030 focused tests: 22/22 passed.
- Combined CR11B gate: 66/66 passed.
- Registered pretest lifecycle: 648/648 passed.
- Core suite: 414/416 passed, with two intentional platform skips and zero failures.
- Public post-test suite: 52/52 passed.
- Type checking and lint passed.
- Production build and 2/2 rendered-route tests passed.
- macOS stage-zero reported `ready_for_runtime_check`.
- Migration verification passed through `0027`, with 97 PostgreSQL tables.
- Architect-owned working-tree whitespace validation passed; the immutable initial report's two Markdown hard breaks remain documented exact-range exceptions.

The complete fourth-remediation repository gate is green. Another different-agent re-review of the exact immutable fourth-remediation commit is still required. The owner has already authorized all required independent reviews. No production policy, consumer, schedule, claim, lease, dispatch, provider/agent contact, GitHub mutation, deployment, or external effect is authorized.
