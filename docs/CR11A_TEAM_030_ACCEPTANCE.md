# CR11A TEAM-030 acceptance

**Status:** Accepted for the exact local reviewed-materialization, no-dispatch snapshot
**Date:** 2026-08-30

## Delivered

- Exact accepted, rejected, and withdrawn owner decisions bound to one saved draft and its source-room lineage.
- Digest-only reviewer and owner-authentication evidence with no raw authentication value.
- Version-2 authenticated Agent Team ledger support for append-only owner reviews.
- Exact replay, restart verification, rollback detection, and changed/second-review rejection.
- Deterministic draft request, proposed workflow, proposed zero-effect job, and resolved Action Inbox record.
- One canonical transaction for all four records with full rollback on an Action Inbox conflict.
- Strict handoff job ceiling: one preparation operation, no credentials, filesystem, network, effects, concurrent effects, or cost authority.
- Open Action Inbox projection for accept, decline, and withdraw; resolved rejection, withdrawal, and materialized views.
- Project Team UI review state and choices with no form, command, approval, or dispatch control.

## Acceptance assertions

- A review cannot be recorded unless its exact proposal already exists in the authenticated ledger.
- Exact review replay is inert; another decision or changed lineage for the same proposal fails closed.
- Rejection and withdrawal are preserved as resolved truth and cannot create canonical work.
- Only an accepted review bound to the exact proposal can build a materialization receipt.
- A stale digest, different proposal, foreign scope, unsafe field, accessor, or Proxy fails closed without executing hostile behavior.
- Materialization creates exactly one draft request, proposed workflow, proposed job, and resolved attention item.
- Exact canonical replay is inert; changed identifier reuse fails closed.
- An Action Inbox collision rolls back every new request, workflow, and job record.
- Zero attempts, leases, approvals, effect intents, and outbox events exist after materialization.
- The UI truthfully states that the saved handoff awaits the owner and that the local preview cannot record or dispatch.

## Verification

The focused CR11A gate passes 29/29, including strict migration of an authenticated TEAM-020 ledger before the first review. Registered pretest passes 550/550. The main suite reports 416 total with 414 passed, zero failed, and two intentional platform skips. Public post-test passes 52/52. Type checking, full lint, production build, 2/2 rendered routes, migration verification through 0026/96 tables, stage-zero readiness, live localhost project rendering with all four review-state markers, and diff whitespace validation pass.

## Explicit non-events

No real owner decision, ready job, attempt, lease, dispatch, approval, effect intent, outbox event, command, schedule, full message, raw prompt, native profile, usable private value, Hermes Bot Mode call, provider contact, credential access, network request, hosted storage, D1/R2 binding, DNS operation, Cloudflare action, hosting, deployment, installation, GitHub write, Git commit, push, pull request, publication, or external effect occurred.
