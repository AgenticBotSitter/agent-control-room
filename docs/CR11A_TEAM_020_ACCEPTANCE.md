# CR11A TEAM-020 acceptance

**Status:** Accepted for the exact authenticated local fake-persistence snapshot
**Date:** 2026-08-30

## Delivered

- Private owner-only SQLite ledger bound to one tenant, workspace, and project.
- Strict allowlisted schema with two tables, two query-driven indexes, and rejection of every unexpected trigger, view, table, index, column, or schema version.
- Append-only safe room events, monotonic owner read receipts, saved digest-bound draft handoffs, and revisioned preservation/legal-hold hooks.
- Exact inert replay and changed-replay rejection.
- Per-row HMAC, whole-ledger HMAC, and independent rollback-checkpoint comparison.
- Verify-before-use restart behavior and complete-database rollback detection.
- Digest-bound unread, needs-you, preservation, hold, and saved-draft projection.
- Read-only Owner Inbox integrated into every Project Agent Team view.
- No full-message retention, cleanup/delete executor, canonical work creation, dispatch, provider, Hermes, hosted-storage, or network path.

## Acceptance assertions

- A database cannot open under a different project scope, HMAC key, or checkpoint state.
- Row mutation, row deletion, schema mutation, sequence gaps, changed replay, and complete database rollback fail closed.
- Exact record replay is inert and does not advance the ledger or checkpoint.
- Room events remain inside the ten-message and three-round TEAM-010 ceiling.
- Read state is owner-only, monotonic, cannot pass observed room sequence, and never acknowledges action.
- A handoff draft persists only from its exact source mention and remains owner-review-only with no work item or dispatch.
- Retention remains `blocked_unconfigured`; legal-hold state is digest-linked and no deletion method exists.
- The durable projection matches exact scope, derives unread and needs-you counts, and denies every authority/effect field.
- Accessors, Proxies, unknown fields, unsafe values, and foreign scope fail without executing hostile traps.
- The rendered interface exposes authenticated/restart/preservation truth and no command, approval, dispatch, or form control.

## Verification

The focused CR11A gate passes 24/24 including eleven TEAM-020 persistence and hostile cases plus durable-projection tamper and cross-project UI checks. Registered pretest passes 545/545; the main suite reports 416 total with 414 passed, zero failed, and two intentional platform skips; public post-test passes 52/52. Type checking, full lint, production build, 2/2 rendered routes, migrations through 0026/96 tables, localhost project rendering, and diff whitespace validation pass.

## Explicit non-events

No raw prompt, full message, memory, native profile, provider session, usable private value, cleanup, deletion, schedule, work materialization, dispatch, approval, credential access, Hermes call, provider call, network request, D1/R2 binding, DNS operation, Cloudflare action, hosting, deployment, installation, Git commit, push, or pull request occurred.
