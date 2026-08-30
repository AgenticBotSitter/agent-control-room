# CR11B-AUTO-030 Acceptance Record

Status: initial candidate plus first, second, and third remediations rejected; fourth remediation implemented; acceptance blocked on another independent re-review

Date: 2026-08-30

## Candidate implementation target

AUTO-030 must prove that one exact authenticated proposed zero-effect job can become ready only while both its standing policy and separate ready-policy addendum remain current. The ready transition, bounded scheduler reservation, and internal jobber handoff must commit together or not at all, without creating approval, schedule, claim, lease, dispatch, execution, agent/provider contact, GitHub mutation, or an external effect.

## Initial independent review

The independent review of commit `47e4000fb374eaefdfeb31e88db127505d3f11dc` returned `REJECTED_FINDINGS_REQUIRE_REMEDIATION`. It reproduced five defects: generic ready transition bypass, stale exported persistence after revocation, conflicting request-ID reuse, stale replay truth, and invalid projection time. A separate transaction audit confirmed additional caller-time, shared-delivery, generic-claim, exact-concurrency, and evidence gaps. The negative report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md` with SHA-256 `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`.

The remediation removes the standalone persistence export, requires simultaneous unforgeable policy-guard capabilities at the canonical port, rejects generic ready and claim paths for frontier jobs, binds request identity in the canonical transaction, injects trusted service time, isolates the handoff in migration `0027`, makes replay state-aware after the tenant lock, queues same-process guards safely, and validates real canonical projection instants. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## First remediation re-review

The different-agent re-review of commit `fd64e418882fb8ca8a044163b2c623f235e21976` returned `REJECTED_REMEDIATION_FINDINGS`. It reproduced three High defects: legitimate live guards could carry caller-expanded ceilings/resource facts through the public canonical port; an unawaited database promise could commit after guard retirement and ready-policy revocation; and trusted time was sampled before queued guards rather than at the write boundary. It also found a Medium stale pending-handoff projection and a Low evidence wording defect. The report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REREVIEW.md` with SHA-256 `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652`.

The second remediation privately mints one exact-operation authorization bound to the complete authenticated receipt, both full policy snapshots, materialization time, and trusted clock. Canonical use registration keeps that authorization and both enclosing policy operations alive through the actual database promise, while repeated in-transaction clock checks reject queue or transaction delay across expiry. Direct-port ceiling/resource/receipt/handoff substitutions fail before mutation, and receipt-only projection rejects expired pending truth. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## Second remediation re-review

The next different-agent review of commit `5b26a634516ca1a956edfeb67c7480343bf9104b` returned `REJECTED_SECOND_REMEDIATION_FINDINGS`. It found that the canonical port reused mutable caller-owned facts after asynchronous boundaries and could therefore commit facts changed after authorization validation. It reproduced authorization expiry inside the transition-to-commit window, found the same end-time gap on replay, demonstrated that receipt-only projection could not observe early canonical release, and showed that the same-store Promise test serialized before the canonical transaction boundary. The report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_SECOND_REMEDIATION_REREVIEW.md` with SHA-256 `db6e7986b97a877db77cc235a8e9d83b9723ef7a5a4aacdc4fe12805cd2897b7`.

The third remediation removes every caller fact from the canonical port: it accepts only the opaque one-use token and derives all writes from hidden cloned authorization bindings. Trusted time is checked after the ready transition, after the handoff write, after request completion, and after replay's last evidence read. Receipt-only projection is labelled historical and never claims a current pending handoff. Two fully separate policy-store/service stacks now reach the shared local canonical transaction boundary concurrently and converge to one mutation. Multi-process PostgreSQL remains explicitly outside this repository proof. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## Third remediation re-review

The next different-agent review of commit `9e43ea56471df1ee58dd8e94da04550ce6062063` returned `REJECTED_THIRD_REMEDIATION_FINDINGS`. It reproduced one remaining High timing gap after the final application callback check but before the transaction manager committed, plus the equivalent Medium replay return gap. The token-only boundary, historical projection, separate-store concurrency, isolation, rollback, capacity, negative authority, and UI all held. The report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_THIRD_REMEDIATION_REREVIEW.md` with SHA-256 `10147ed33b7a95a300c36ac5a1d7d59124c037a8e88fa59323e816f97ffe0acc`.

The fourth remediation makes the database transaction owner run the trusted-time predicate after the complete application callback and before commit initiation. Both PostgreSQL and PGlite adapters implement the mandatory boundary. Canonical promotion also resamples time after transaction completion and before returning a new or replay result. Expiry in the pre-commit window rolls the complete attempted bundle back; expiry only after a successful commit produces explicit canonical ambiguity rather than a false current-success result. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## Focused remediated-candidate evidence

The final combined AUTO-000/AUTO-010/AUTO-020/AUTO-030 gate passes 66/66. Twenty-two AUTO-030 hostile cases cover:

- the exact authenticated repository-only ready-policy contract and negative authority;
- restart, suspension, terminal revocation, and complete database rollback detection;
- one exact atomic ready transition, resource reservation, internal handoff, authenticated receipt, replay, and tamper rejection;
- suspended, revoked, superseded, stale, narrowed, and parent-standing-policy drift rejection before mutation;
- competing promotions against one constrained resource, where only one job becomes ready;
- forced handoff collision with full rollback of job, reservation, transition, and outbox evidence;
- a bounded safe operator projection; and
- accessor and Proxy rejection plus structural absence of effect clients;
- generic ready-transition and retired-policy-guard bypass rejection;
- trusted-time rejection of historical and future requests;
- simultaneous exact-request convergence and conflicting request-ID rejection;
- generic delivery and job-claim isolation; and
- reentrant policy-write/close rejection without guard rollback;
- a token-only canonical port that derives global/project ceilings, resource key/units/capacity, request/receipt identity, and handoff authority solely from hidden authenticated bindings;
- an unawaited database promise that cannot escape authorization lifetime or be overtaken by revocation;
- trusted time sampled after policy queues, after transition and commit-sensitive writes, and after replay evidence reads;
- receipt-only projection that reports history but never current ready or pending state; and
- two independent policy-store/service stacks reaching the shared canonical transaction boundary concurrently and converging to one exact mutation;
- transaction-owner pre-commit rejection after the complete application callback, with full rollback; and
- post-transaction new/replay expiry returning explicit ambiguity or non-success rather than current success.

## Full repository gate

- registered pretest lifecycle: 648/648 passed;
- core suite: 414/416 passed with two intentional platform skips and zero failures;
- public post-test suite: 52/52 passed;
- combined CR11B focused gate: 66/66 passed;
- type checking and full lint passed;
- macOS stage-zero reported `ready_for_runtime_check`;
- production build and 2/2 rendered-route tests passed;
- all 27 PostgreSQL migrations verified 97 tables;
- localhost browser QA passed for the portfolio and Content Blooms Project Workspace, including the ready-policy/no-handoff truth and zero frontier action controls; and
- architect-owned working-tree whitespace validation passed; exact commit-range validation for the rejected `fd64e418` target intentionally retains two Markdown hard-break lines in the immutable first-review report and is not represented as clean.

The exact candidate creates no real policy enrollment, approval, schedule, claim, lease, dispatch, execution, agent/provider contact, GitHub work, or external effect.

## Required independent review

A different independent agent from every prior reviewer must inspect the exact fourth-remediated candidate commit, re-run every recorded attack, and explicitly determine whether:

- either policy can change between authorization and canonical commit;
- a duplicate or conflicting request can create multiple ready jobs, reservations, or handoffs;
- capacity, project, route, capability, risk, cost, expiry, or global/project ready ceilings can be bypassed;
- transaction failure or ambiguous replay can leave a ready job without its reservation and handoff, or vice versa;
- repository fixture evidence can be mistaken for production owner authentication or production independent review;
- the internal handoff grants claim, lease, dispatch, execution, agent-message, provider, GitHub, or effect authority; and
- the UI or safe projection exposes private evidence or an action control.

Until that re-review passes, AUTO-030 is not accepted and AUTO-040 does not begin.

## Residual boundary

The ready policy, integrity keys, rollback checkpoints, trusted test clock, scheduler decision, resource reservation, and dedicated internal handoff are repository/local database evidence. Protected production policy ingress and custody, an internal-handoff consumer, scheduler/jobber delivery, no-relay agent operation, real capacity, hosted persistence, multi-process PostgreSQL concurrency evidence, ambiguity reconciliation across services, and every external effect remain unimplemented and unauthorized.
