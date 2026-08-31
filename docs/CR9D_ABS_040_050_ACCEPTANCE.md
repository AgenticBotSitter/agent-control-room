# CR9D-ABS-040/050 acceptance

**Status:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29
**Depends on:** CR9D-ABS-010/020/030, ADR-058, ADR-059

## Delivered

- Exact owner review records bound to the proposal, story, action catalog, reviewer digest, decision, reason, and trusted time. Review acceptance is explicitly not approval, dispatch authority, or execution authority.
- An exact materialization receipt that binds one accepted review to one deterministic canonical request, workflow, and job.
- An atomic canonical-store operation that creates only a draft request, proposed workflow, and proposed job. Exact replay is inert and changed reuse of any canonical identifier fails closed.
- A zero-effect job authority ceiling: no credentials, filesystem roots, network destinations, external effects, concurrent effects, attempt, lease, dispatch, or outbox message.
- Action Inbox projections for proposals awaiting owner review and resolved accepted or rejected proposals.
- A separate private SQLite control ledger with an external HMAC integrity key, exact scope, strict schema identity, authenticated full-state metadata, append-only review/materialization/run evidence, restart recovery, and deletion/tamper detection.
- Disabled-by-default collector and monitor declarations using canonical schedule records. Every declaration requires later owner authority and creates no background process.
- Synthetic-only run evidence with bounded item/runtime/attempt ceilings, explicit retryable safe codes, deterministic occurrence/attempt identity, and terminal ambiguity after an unsettled restart.
- Schedule and Action Inbox projections that keep disabled state visible and surface failed or ambiguous run evidence without retrying or activating anything.

## Acceptance assertions

- A rejected, changed, detached, cross-scope, stale-catalog, or stale-story review cannot materialize work.
- Materialization cannot create a ready job, attempt, lease, approval, dispatch, outbox message, credential reference, network destination, filesystem authority, or effect permission.
- Request/workflow/job creation is one transaction. A crash cannot persist a partial canonical bundle.
- Restart-safe replay returns the exact existing bundle. Reusing an identifier for changed content fails closed.
- A live-configured collector cannot enter the synthetic run boundary.
- A schedule declaration is always disabled and cannot activate itself.
- A running synthetic record found after restart becomes terminally ambiguous and is never automatically retried.
- Only a definite, allowlisted safe failure before the configured attempt ceiling may create the next synthetic attempt. The retry is a new append-only run identity.
- Control-ledger deletion, row drift, schema drift, wrong key, wrong scope, review conflict, and occurrence/attempt identity conflict fail closed.

## Verification

- Focused CR9D gate: 32/32 passed.
- New CR9D-ABS-040/050 integration and adversarial tests: 6/6 passed.
- Repository pretest: 234/234 passed.
- Main suite: 416 total, 414 passed, zero failed, two intentional platform skips.
- Type checking, full lint, production build, two rendered-route tests, migrations through 0026/96 PostgreSQL tables, and diff whitespace validation pass.

## Explicit non-events

No live feed, search, newsletter, Gmail, source account, credential, endpoint, network request, provider call, model spend, background process, timer, active schedule, monitor, agent attempt, lease, dispatch, publication, website mutation, deployment, or external effect occurred. No GitHub commit or push occurred.

## Next boundary

CR9D-ABS-060 uses Sol/xhigh. It may freeze the exact owner-authorized live-read rehearsal packet, source allowlist, privacy/cost ceilings, credential custody, cleanup, and evidence requirements. It must not perform a live read until the owner separately authorizes the frozen source set and exact rehearsal.
