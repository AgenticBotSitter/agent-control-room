# CR11B-AUTO-010 Acceptance Record

Status: accepted for the repository-only authenticated integration and UI

Date: 2026-08-30

## Accepted result

AUTO-010 now has four strict authenticated repository read lanes, one fail-closed source composer, a manually driven effect-free local cycle service, durable latest/history projections derived from the AUTO-000 ledger, a cross-project portfolio frontier, and Project Workspace proposed/blocked/review/deferred lanes.

The first repository fixture cycle produces the same three real-work proposals as AUTO-000. Later unchanged cycles and restarts suppress those proposal intents. Stale, failed, tampered, incomplete, non-canonical, wrong-key, and cross-project sources create no accepted cycle.

## Security and authority disposition

- read-channel payloads and complete envelopes are digest- and HMAC-bound;
- all channels must agree on tenant, scope, revision, and observation time;
- every candidate requires an exact attention overlay;
- exact data boundaries reject extra fields, secret-like content, accessors, and Proxies;
- durable projections are re-derived only after ledger and rollback-checkpoint verification;
- source objective, candidate identity, evidence, authentication tags, policy identity, private locators, and usable access data are absent from the UI projection;
- the manual request, result, projection, service, and UI all deny canonical work creation, approval, ready, claim, lease, dispatch, execution, provider access, and effects;
- no schedule, timer, native read, provider, credential, agent-message, GitHub-creation, network, deployment, or production client exists in the AUTO-010 path.

## Verification

The acceptance gate requires:

- all focused AUTO-000/AUTO-010 contract, recovery, integration, and view tests;
- the complete registered pretest lifecycle;
- the complete core suite;
- the complete public post-test suite;
- type checking and lint;
- macOS stage-zero readiness;
- production build and rendered-route verification;
- PostgreSQL migration verification;
- browser rendering of the portfolio and Content Blooms Project Workspace frontier;
- a clean whitespace and repository status check.

Final results:

- combined AUTO-000/AUTO-010 focused gate: 32/32 passed;
- registered pretest lifecycle: 614/614 passed;
- core suite: 414/416 passed with two intentional platform skips and zero failures;
- public post-test suite: 52/52 passed;
- type checking, full lint, and macOS stage-zero readiness passed;
- production build and 2/2 rendered-route verification passed;
- all 26 PostgreSQL migrations and 96-table schema verification passed;
- localhost browser QA passed for the portfolio and Content Blooms Project Workspace frontiers, including the absence of authority controls;
- whitespace validation passed.

## Residual boundary

This acceptance proves a repository-only local integration. The standing owner policy, protected policy enrollment, frontier materialization, automatic ready promotion, scheduler/jobber handoff, protected service ingress, production key/checkpoint custody, hosted persistence, no-relay agent run, and every real effect remain unimplemented and unauthorized.
