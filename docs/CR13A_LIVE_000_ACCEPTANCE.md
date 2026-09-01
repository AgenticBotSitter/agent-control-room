# CR13A-LIVE-000 acceptance record

**Status:** implementation candidate complete; independent security/integrity review required  
**Date:** 2026-09-01  
**Scope:** authenticated, resumable, read-only project activity

## Delivered result

Control Room now has the first production-shaped live Project Workspace data path. Migration `0033` adds one append-only
project event chain and authenticated stream head per tenant/project. Each event is bound to its tenant, workspace,
project, source identity, source replay key, subject, safe presentation fields, chronology, prior event, and negative
authority flags. Concurrent appenders serialize on the stream head; exact source replay is inert and changed replay fails.

The protected `GET /api/v1/projects/:projectId/events` endpoint authenticates the existing owner project scope before any
read. It accepts only a bounded cursor and returns a bounded Server-Sent Events replay. The response then closes; the
browser reconnects with `Last-Event-ID`, which drains additional pages or waits for later events without keeping an
indefinite server request open. Invalid, stale, foreign-project, or ahead cursors reset to a bounded current snapshot
instead of silently skipping truth.

The Project Workspace Activity tab now shows connection state and up to 100 authenticated events. The shipped browser
surface has no event write endpoint. Events and stream pages explicitly carry `presentationOnly=true` and approval,
command, and execution authority false. Reconnect cannot approve, dispatch, retry, or mutate work.

The local repository-fake pilot emits real activity when an Idea Lab result becomes a monitored project and when the
owner pauses, resumes, completes, archives, or reopens it. The accepted pilot test proves promotion plus pause/resume
events survive an actual runtime close and reopen.

## Security and architecture boundaries

- PostgreSQL remains the sole production write authority. PGlite exercises the same migrations only in local
  development and tests; no production database was provisioned or contacted.
- Tenant, workspace, and project scope come from the authenticated protected-project authority, never browser headers.
- Event rows are SQL append-only and HMAC authenticated; the head is HMAC authenticated and the event payload is bound
  to duplicated indexed columns. This presentation stream does not replace project, job, approval, or audit truth.
- Safe event fields pass the existing exact-value and secret-material boundary. Proxy inputs, cross-scope reads, forged
  cursors, malformed paths, mutation, and replay drift fail closed.
- A privileged full-database rollback is outside this presentation projection's claims. Authoritative project state and
  existing audit/high-water systems remain the recovery source.
- The reconnect/journal and activity-drawer concepts were informed by the reviewed Hermes WebUI/Desktop projects, but
  this is a repository-native implementation. No third-party source was copied. No Hermes Studio source was used.

## Verification

At candidate freeze:

- `npm run test:cr13a`: 12/12 passing;
- `npm run check`: passing;
- `npm run lint -- --quiet`: passing;
- `npm run db:verify`: migrations `0001` through `0033` applied; 112 PostgreSQL tables verified;
- registered pretests: 769/769 passing;
- core tests: 414/416 passing with the two intentional platform skips and zero failures;
- registered posttests: 233/233 passing;
- production build: passing, including the new dynamic event route;
- rendered-route checks: 3/3 passing;
- localhost Activity UI QA: desktop and 390-pixel layouts render the protected/fixture distinction, connection state,
  and negative-authority boundary with no console error or horizontal page overflow;
- macOS stage zero: `ready_for_runtime_check`; and
- whitespace validation: passing.

## Open gate

A different reviewer must inspect event-chain integrity, exact replay, concurrent append ordering, cursor reset and page
drain behavior, authentication ordering, safe errors, tenant/workspace/project isolation, browser reconnect behavior,
negative authority, migration reversibility constraints, and regression coverage against the exact implementation commit.
Review acceptance does not authorize a production database, deployment, live Hermes/provider use, or browser mutation.
