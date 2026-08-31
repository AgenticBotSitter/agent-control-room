# CR11B-AUTO-020 Standing Policy and Materialization Contract

**Status:** implemented for repository-only simulation; real owner enrollment and protected activation remain unavailable

## Purpose

AUTO-020 connects one authenticated ready-frontier proposal to canonical Control Room proposed work without turning the frontier, its policy, or its UI into an approval, scheduler, dispatcher, or executor.

The boundary has two separate parts:

1. an append-only standing owner-policy lifecycle used only by repository simulation; and
2. an atomic materialization transaction that creates one draft request, one proposed workflow, one proposed zero-effect job, and one resolved Action Inbox record.

## Standing policy lifecycle

The exact v1 policy binds:

- tenant, workspace, policy identity, monotonic revision, prior-policy digest, lifecycle action, and state;
- digest-only owner actor and authentication-evidence references;
- recorded, effective, and expiry times plus a maximum proposal age;
- exact project, route, platform, capability, risk, and cost ceilings;
- repository-simulation activation only and explicit absence of production owner-authentication proof; and
- negative approval, ready, schedule, claim, lease, dispatch, provider, agent-message, GitHub, and external-effect authority.

Revision 1 is an active enrollment. Later records may revise, suspend, or revoke the policy. Suspension and revocation cannot alter the prior ceiling, and revocation is terminal. Exact replay is inert; changed revision reuse, a broken previous digest, skipped revision, time rollback, ceiling drift during suspension/revocation, or continuation after revocation fails closed.

The private SQLite ledger authenticates every policy and row with HMAC, authenticates the complete ordered state, and compares it with an external rollback checkpoint before use. File ownership, mode, link count, schema identity, row order, scope, restart, deletion, and complete database rollback are verified. The integrity key and rollback checkpoint are repository-test fixtures, not production custody.

The materialization service holds an immediate policy-ledger guard from the final current-revision check through the canonical commit. A concurrent revision, suspension, or revocation must serialize before or after that boundary; it cannot land between authorization and write.

## Exact materialization lineage

One request binds the authenticated evaluation, cycle, proposal, proposal digest, source digest, original frontier policy digest, standing-policy identity/revision/digest, request time, materialization time, and short zero-effect authority expiry.

The service reads the evaluation from the authenticated AUTO-000 ledger and the exact current policy from the standing-policy ledger. It rejects missing, expired, stale, superseded, suspended, revoked, cross-scope, wrong-route, wrong-platform, wrong-capability, over-risk, and over-cost truth. Proposal and evaluation authentication are rechecked before building the receipt.

The receipt is digest- and HMAC-bound. Its stable canonical identifiers derive from the exact proposal identity, so a later policy revision cannot create a second canonical bundle for the same proposal. Changed lineage conflicts with the existing canonical records rather than creating duplicates.

## Atomic canonical result

The dedicated canonical-store transaction writes all four records or none:

1. a request in `draft`;
2. a workflow in `proposed`;
3. a job in `proposed`; and
4. a resolved Action Inbox item containing only digest evidence for the proposal, evaluation, and standing policy.

The job is `ready-frontier-work-order/v1` with one `prepare.repository-work` operation. It has zero credentials, filesystem roots, network destinations, effects, concurrent effects, and cost authority. It creates no attempt, lease, approval, schedule, effect intent, or outbox message. A forced Action Inbox collision proves the request, workflow, and job roll back together.

Exact replay returns the existing bundle. A changed request, workflow, job, attention record, standing-policy lineage, or receipt authentication tag fails closed.

## Operator projection

The portfolio and Project Workspace show:

- repository standing-policy state;
- the truthful absence of production policy enrollment;
- per-proposal repository-simulation eligibility or denial; and
- whether canonical materialization is unrequested or recorded as proposed work.

The projection omits proposal objective, intent identity, owner identity/evidence digests, policy and proposal authentication tags, private locators, credentials, and source evidence. The page contains no policy-enrollment, materialization, approval, ready, schedule, claim, lease, dispatch, or execution control.

## Explicit stop boundary

AUTO-020 contains no timer, recurrence activation, scheduler handoff, jobber claim, ready promotion, lease, dispatch, provider client, Hermes/Codex message, GitHub mutation, credential access, native read, network client, DNS, hosting, deployment, or production effect.

Real standing-policy enrollment needs protected authenticated ingress and owner action. Automatic ready promotion and scheduler/jobber handoff require AUTO-030 plus an independent security review. End-to-end no-relay operation and protected activation remain AUTO-040 owner gates.
