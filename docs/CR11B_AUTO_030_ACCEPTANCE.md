# CR11B-AUTO-030 Acceptance Record

Status: initial candidate and first remediation rejected; second remediation implemented; acceptance blocked on another independent re-review

Date: 2026-08-30

## Candidate implementation target

AUTO-030 must prove that one exact authenticated proposed zero-effect job can become ready only while both its standing policy and separate ready-policy addendum remain current. The ready transition, bounded scheduler reservation, and internal jobber handoff must commit together or not at all, without creating approval, schedule, claim, lease, dispatch, execution, agent/provider contact, GitHub mutation, or an external effect.

## Initial independent review

The independent review of commit `47e4000fb374eaefdfeb31e88db127505d3f11dc` returned `REJECTED_FINDINGS_REQUIRE_REMEDIATION`. It reproduced five defects: generic ready transition bypass, stale exported persistence after revocation, conflicting request-ID reuse, stale replay truth, and invalid projection time. A separate transaction audit confirmed additional caller-time, shared-delivery, generic-claim, exact-concurrency, and evidence gaps. The negative report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REVIEW.md` with SHA-256 `5a5f2d884c28ae5397caaf27b4573aa14f3ae93fe8936687d8251d7e328ae825`.

The remediation removes the standalone persistence export, requires simultaneous unforgeable policy-guard capabilities at the canonical port, rejects generic ready and claim paths for frontier jobs, binds request identity in the canonical transaction, injects trusted service time, isolates the handoff in migration `0027`, makes replay state-aware after the tenant lock, queues same-process guards safely, and validates real canonical projection instants. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## First remediation re-review

The different-agent re-review of commit `fd64e418882fb8ca8a044163b2c623f235e21976` returned `REJECTED_REMEDIATION_FINDINGS`. It reproduced three High defects: legitimate live guards could carry caller-expanded ceilings/resource facts through the public canonical port; an unawaited database promise could commit after guard retirement and ready-policy revocation; and trusted time was sampled before queued guards rather than at the write boundary. It also found a Medium stale pending-handoff projection and a Low evidence wording defect. The report is preserved unchanged in `docs/reviews/CR11B_AUTO_030_INDEPENDENT_REREVIEW.md` with SHA-256 `8f0bd318bbbf69a516f737da5cdd4367e4bd00cc6afcb0130c7c433e9e042652`.

The second remediation privately mints one exact-operation authorization bound to the complete authenticated receipt, both full policy snapshots, materialization time, and trusted clock. Canonical use registration keeps that authorization and both enclosing policy operations alive through the actual database promise, while repeated in-transaction clock checks reject queue or transaction delay across expiry. Direct-port ceiling/resource/receipt/handoff substitutions fail before mutation, and receipt-only projection rejects expired pending truth. See `docs/CR11B_AUTO_030_REMEDIATION.md`.

## Focused remediated-candidate evidence

The combined AUTO-000/AUTO-010/AUTO-020/AUTO-030 gate passes 60/60 tests. Sixteen AUTO-030 hostile cases cover:

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
- direct-port substitution of global/project ceilings, resource key/units/capacity, request/receipt identity, and handoff authority;
- an unawaited database promise that cannot escape authorization lifetime or be overtaken by revocation;
- trusted time sampled after policy queues and repeatedly at the canonical write boundary; and
- rejection of expired historical receipt-only pending-handoff projection.

## Full repository gate

- registered pretest lifecycle: 642/642 passed;
- core suite: 414/416 passed with two intentional platform skips and zero failures;
- public post-test suite: 52/52 passed;
- combined CR11B focused gate: 60/60 passed;
- type checking and full lint passed;
- macOS stage-zero reported `ready_for_runtime_check`;
- production build and 2/2 rendered-route tests passed;
- all 27 PostgreSQL migrations verified 97 tables;
- localhost browser QA passed for the portfolio and Content Blooms Project Workspace, including the ready-policy/no-handoff truth and zero frontier action controls; and
- architect-owned working-tree whitespace validation passed; exact commit-range validation for the rejected `fd64e418` target intentionally retains two Markdown hard-break lines in the immutable first-review report and is not represented as clean.

The exact candidate creates no real policy enrollment, approval, schedule, claim, lease, dispatch, execution, agent/provider contact, GitHub work, or external effect.

## Required independent review

A different independent agent from both prior reviewers must inspect the exact second-remediated candidate commit, re-run every recorded attack, and explicitly determine whether:

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
