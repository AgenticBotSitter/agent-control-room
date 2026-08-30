# CR11A TEAM-020 authenticated local Agent Team ledger contract

**Status:** Complete for the exact local fake-persistence boundary
**Decision date:** 2026-08-30
**Scope:** Private project-scoped War Room events, owner read receipts, room retention/legal-hold hooks, saved draft handoffs, restart verification, and safe owner projections
**Authority:** ADR-090, ADR-091, `CR11A_AGENT_TEAM_AND_WAR_ROOM_CONTRACT.md`, and the existing security, audit, rollback-checkpoint, and privacy-retention contracts

## Outcome

CR11A-TEAM-020 turns the summary-only Team workspace into restart-safe local product truth without turning it into a chat archive or dispatch system. One private SQLite database binds exactly one tenant, workspace, and project. Its append-only records contain only bounded safe room summaries, monotonic owner read receipts, exact owner-review draft handoffs, and revisioned preservation/hold policy events.

The ledger does not store prompts, full messages, memory, native profiles, provider sessions, credentials, paths, usable private locators, raw host identity, unrestricted labels, or provider output. It has no delete, cleanup, job-materialization, scheduling, approval, command, lease, dispatch, provider, Hermes, network, or deployment client.

## 1. Private storage and exact schema

The database path must be absolute, owner-controlled, non-symlinked, single-linked, and inaccessible to group or other users. The parent directory must have the same owner and no group/other permissions. The database permits exactly two application tables and two query-driven indexes. Any unexpected table, index, view, trigger, column, constraint, schema version, or scope value fails before use.

The schema is local Node SQLite, not the hosted site store and not a canonical production migration. `.openai/hosting.json` remains unchanged with no D1 or R2 binding. A hosted or multi-user store requires a later authenticated service design and migration review.

## 2. Append-only record identity

Four immutable record kinds share one gap-free ledger sequence:

- `room_event`: exact room/message identity and one bounded safe summary;
- `read_receipt`: owner-only, monotonic read-through sequence that acknowledges reading but not action;
- `handoff_draft`: the exact digest-bound TEAM-010 proposal; and
- `room_policy`: a revisioned preservation and legal-hold hook.

Reusing an identity with the exact same digest is an inert replay. Reusing it with changed meaning fails as replay drift. Room policy binds the exact two-to-six-member roster; event authors, mentions, and draft targets must belong to it. Room messages must remain gap-free and inside the existing ten-message/three-round ceiling. Read state cannot move backward or beyond observed room truth. A draft can be saved only when its exact source event mentions the exact target agent.

## 3. Authentication, rollback, and restart

Each row is HMAC-authenticated with key material that remains outside the database. A whole-ledger digest and HMAC bind scope, revision, record count, ordered identities, row digests, and row tags. An independent compare-and-swap checkpoint must exactly match that state. Row mutation, deletion, insertion, changed key, foreign scope, unexpected schema, sequence gaps, and whole-database rollback fail closed.

Every open and every read or append verifies the complete authenticated state and external checkpoint before returning data. Restart never assumes prior success. Exact replay is inert; changed replay is rejected. The repository supplies only the existing test-only in-memory checkpoint implementation, so production rollback-resistant checkpoint custody remains unimplemented.

## 4. Minimization, retention, and holds

Only the already-approved bounded safe summaries cross into the ledger. Full message retention is structurally false in records and projections. Room policy revision one starts at `blocked_unconfigured`; Control Room invents no production retention duration and exposes no cleanup executor. Revision changes must bind the exact predecessor digest.

An active legal-hold hook requires an externally supplied evidence digest. The hook preserves data and grants no legal conclusion, approval, deletion, or effect authority. Releasing or changing a hold requires a later digest-linked policy event; it never mutates prior ledger history. Actual policy values and any disposition boundary remain owner-controlled future work under CR10A.

## 5. Owner projection

The safe project projection exposes per-room latest/read-through sequence, unread count, unread owner-needs, preservation state, legal-hold state, and saved-draft count. It also exposes authenticated-local, checkpoint-matched, and verify-before-use status. The projection is strict, descriptor-safe, Proxy-rejecting, digest-bound, and exact-scope-bound to the TEAM-010 view.

The Project interface now shows a read-only Owner Inbox, room attention cards, restart/integrity state, preservation state, and saved-local handoffs. It contains no form, button, job, approval, schedule, dispatch, or provider control.

## 6. Explicit effect ceiling

TEAM-020 performs local fake persistence and tests only. It does not call Hermes Bot Mode, contact a provider, read native Codex or Hermes state, create a schedule, materialize canonical work, dispatch an agent, bind DNS, configure Cloudflare, deploy, install, commit, push, or publish.

CR11A-TEAM-030 may consume an exact owner-reviewed saved draft into existing canonical proposed-work and Action Inbox contracts. It may not dispatch work or treat a saved draft, read receipt, room message, or legal-hold event as approval or execution authority.
