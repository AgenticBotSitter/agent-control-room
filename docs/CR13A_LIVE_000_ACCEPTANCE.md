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

The local repository-fake pilot reconciles the authoritative Idea Lab lifecycle ledger into activity when an Idea Lab
result becomes a monitored project and when the owner pauses, resumes, completes, archives, or reopens it. Reconciliation
runs after source changes and again at startup, uses every exact source version rather than a racy latest-row lookup, and
makes exact replay inert. Tests prove promotion plus pause/resume events survive an actual runtime close and reopen and
that a simulated crash between source commit and projection is repaired without loss or duplication.

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

- `npm run test:cr13a`: 16/16 passing;
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

## First independent review and remediation

A fresh reviewer rejected implementation `4ddeb6c397a4c7b311852e26db5d2bda50d0c87e` with three blocking findings:

1. offset-form ISO timestamps could append successfully and then fail after PostgreSQL normalized them to UTC;
2. the live widget was mounted on fixture workspaces but not the protected promoted-project Activity page; and
3. source transitions committed before a separate latest-row projection, leaving crash gaps and an interleaving race.

The remediation requires canonical UTC millisecond timestamps at the public event boundary, canonicalizes the captured
trusted clock before hashing/storage, mounts the widget in the protected project section, exposes a directly rendered UI
test, verifies the complete authenticated source lifecycle sequence, and reconciles deterministic source-version events
after mutation and on startup. A crash-gap plus concurrent-reconciliation test proves recovery. A second different
reviewer must re-review the exact remediation commit; producer verification cannot accept it.

## First remediation re-review and historical backfill fix

A second, different reviewer confirmed all three original blockers closed at
`9f463396f7e8f69241115794898458601e9bd80d`, but rejected acceptance on one new Medium finding: startup reconciliation
replays the full authenticated source history, while the event store rejected any source event older than 365 days before
checking exact replay. An old project could therefore fail restart or first-time projection even though its lifecycle
ledger remained valid.

The second remediation keeps the 30-second future-time guard but removes the arbitrary lower wall-clock bound. This is an
explicit historical-projection rule: `occurredAt` preserves when the authenticated source event happened and `recordedAt`
preserves when Control Room ingested it. Exact old replay remains inert, changed replay remains a conflict, and a new
regression covers first append, a restart more than one year later, changed replay, and future-time rejection. A third,
different reviewer must re-review the exact second-remediation commit; producer verification cannot accept it.
