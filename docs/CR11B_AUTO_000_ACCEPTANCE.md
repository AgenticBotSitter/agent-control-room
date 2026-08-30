# CR11B-AUTO-000 acceptance

**Status:** Accepted for the repository-only authenticated fake simulation
**Date:** 2026-08-30

## Delivered

- Exact digest-bound project, route, dependency, candidate, canonical-work, prior-proposal, and repository-policy-fixture contracts with explicit unverified-owner-policy truth.
- Deterministic hard-gate evaluation with explicit blocked, review, duplicate, policy-deferred, and capacity-deferred truth.
- Bounded fair-share scoring plus a starvation guard that cannot override safety gates.
- Per-global, project, outstanding, route, risk, cost, freshness, and cycle ceilings.
- Digest- and HMAC-bound proposal and evaluation identity.
- Automatic suppression of exact intents already in canonical work, the current source, or authenticated prior frontier history.
- A private authenticated SQLite fake ledger with external rollback checkpoint comparison.
- Exact replay, restart, row/schema/key/scope/rollback/capacity defenses.
- A safe operator projection with no source evidence, authentication tag, or authority-bearing control.
- A realistic ABS News, Content Blooms, and Wayfarer fixture.

## Acceptance assertions

- The first synthetic cycle proposes three useful real-work items and ranks the starved eligible item first.
- A later unchanged cycle proposes none of those exact intents again, including after restart.
- Dependencies, reviews, blockers, duplicate truth, route presence/freshness, platform, risk, cost, deadline, project, and capacity limits fail closed before selection.
- Starvation changes ordering only after every hard gate passes.
- Failed, cancelled, rejected, dismissed, or expired exact intent cannot silently become a retry.
- Proposal and evaluation substitution fail without the private integrity key.
- The durable store detects exact replay drift, wrong key, foreign scope, altered/deleted rows, metadata drift, added schema behavior, complete database rollback, and capacity overflow.
- The safe projection cannot approve, ready, claim, lease, dispatch, or execute work.

## Explicit non-events

No canonical request, workflow, job, attempt, lease, approval, effect intent, outbox event, dispatch, execution, provider call, agent message, GitHub issue/PR creation, schedule activation, credential access, native integration, network operation, DNS, Cloudflare, hosting, deployment, publication, or production effect occurred.

## Verification

- Focused controller and durable-store gate: 21/21 passed.
- Registered safety and integration pretest: 603/603 passed.
- Core repository suite: 416 tests, 414 passed and 2 intentional platform skips.
- Public-release posttest: 52/52 passed.
- TypeScript check: passed.
- ESLint: passed.
- macOS stage-zero dependency preparation: `ready_for_runtime_check`.
- Production build and rendered-route verification: passed, including 2/2 server-render checks.
- Database migration verification: all 26 migrations applied and 96 PostgreSQL tables verified.
- Git whitespace validation: passed.
