# CR11A TEAM-030 reviewed handoff contract

**Status:** Frozen and implemented for the local effect-free snapshot
**Date:** 2026-08-30

## Purpose

TEAM-030 provides the deliberate bridge from a saved Agent Team handoff draft to ordinary Control Room proposed work. It does not let a room, message, mention, read receipt, draft, or review dispatch an agent. A review is an authenticated owner decision about one exact draft; it is not an approval of an external operation.

## Exact owner decision

One review binds the tenant, workspace, project, room, source message, target agent, proposal identifier, proposal digest, proposal idempotency key, reviewer actor digest, owner-authentication evidence digest, safe reason, decision, and time. The allowed decisions are `accepted`, `rejected`, and `withdrawn`.

- A review is accepted by the durable ledger only after the exact proposal is already saved from its source mention.
- Exact review replay is inert.
- A changed decision, second review, stale digest, different idempotency key, different source message, different target, or foreign scope fails closed.
- Rejected and withdrawn drafts become resolved Action Inbox truth and cannot materialize.
- Authentication evidence is represented only by a digest. Raw sessions, credentials, prompts, profiles, and private values are forbidden.

The Agent Team ledger schema is version 2. It adds one append-only `handoff_review` record kind under the existing per-row HMAC, whole-ledger HMAC, and external rollback-checkpoint verification. An existing version-1 TEAM-020 database is admitted only after its exact old private schema is verified, then migrated transactionally without changing authenticated records or the external checkpoint. Restart verifies the complete ordered state before a review can be read or appended.

## Atomic materialization

Only an exact accepted review can build one deterministic materialization receipt. The receipt creates, in one canonical database transaction:

1. one request in `draft`;
2. one workflow in `proposed`;
3. one job in `proposed`;
4. one resolved Action Inbox item recording the reviewed result.

Identifiers derive from the proposal and accepted-review digests. Exact replay is inert. Changed reuse of any canonical identifier or the Action Inbox identifier fails closed. If any of the four writes conflicts, all new canonical writes roll back.

The job is structurally non-runnable at this boundary. It has the exact `agent-team-handoff/v1` specification, an `agent-handoff.*` type, an `agent.team.handoff.*` capability, the sole operation `prepare.agent-handoff`, zero credentials, zero filesystem roots, no network destinations, `networkPolicy: none`, `effectPolicy: none`, zero concurrent effects, and zero cost authority.

## Action Inbox and interface

Before review, the Action Inbox projection is open and offers three explicit owner choices: accept the exact handoff, decline it, or withdraw the draft. These are displayed choices, not executable controls in the synthetic Project Workspace. Rejection and withdrawal resolve without work. Successful materialization resolves the attention item and exposes only the canonical proposed request, workflow, and job identifiers.

The Project Agent Team view shows saved state, owner-review state, Action Inbox state, platform and route, and the no-dispatch/no-work truth. It contains no form, command, approval, or dispatch control.

## Explicit non-authority

TEAM-030 creates no attempt, lease, ready job, approval, effect intent, outbox event, schedule, command, provider session, credential access, network request, or external effect. A later transition out of `proposed` remains subject to the ordinary Control Room scheduler, authority, capability, approval, and execution contracts.

No Hermes Bot Mode call, provider contact, native profile read, full-message storage, installation, D1/R2 binding, DNS change, Cloudflare action, hosting, deployment, GitHub write, commit, push, or publication belongs in this block.
