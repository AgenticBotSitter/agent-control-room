# CR13A-LIVE-000 acceptance record

**Status:** accepted implementation candidate; integration restack verified; parent integration merge required
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

## Historical review gate (closed)

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

## Third independent review

A third, different reviewer accepted exact implementation
`fcc2f10881aaf7a094db76e01a898b0e04fba083` after reproducing the full four-finding history. The review confirmed:

- offset source timestamps reject and trusted offset clocks normalize to canonical UTC;
- the real protected Idea Lab Activity section mounts the authenticated live widget;
- complete authenticated source reconciliation repairs crash gaps and concurrent projection without loss or duplication;
- first-time historical backfill and restart replay work without a lower age cutoff, while future events still reject;
- tenant/workspace/project isolation, source-ledger and event/head authentication, exact replay, append-only storage,
  authorization-before-read, bounded cursor behavior, safe presentation fields, and negative authority remain intact.

The independent matrix passed 16/16 focused tests, the complete test lifecycle, typecheck, lint, production build, 3/3
rendered routes, migrations through 0033/112 tables, macOS stage zero, exact-range whitespace validation, and an
additional ephemeral 2024-to-2026 first-backfill probe. The only Low note is that the committed historical regression
directly covers old replay rather than separately naming first-time old ingestion; the reviewer reproduced that path and
classified it as test hardening, not a blocker.

**Disposition:** `accepted_candidate`. This acceptance is limited to the exact implementation commit above. It does not
authorize a production database, deployment, provider or native-runtime use, approval, dispatch, retry, command, or
execution effect. PR #218 was created on the connector base before that base completed remediation and independent
acceptance, so it is retained only as historical review evidence and must not be used for integration.

## Verified integration restack

The accepted CR13A product was replayed without semantic expansion onto connector-integration checkpoint
`38bf2c326fe262628d7df90b1876e34d73d034b6`. The restack preserves exact accepted product
`fcc2f10881aaf7a094db76e01a898b0e04fba083` and its three independent reviews while also inheriting the later accepted
Idea Lab time-hardening and the Node `22.13.0` lazy-global portability repair. Documentation conflicts were resolved by
retaining the complete connector evidence chain and ADR-147 Project Activity. No code defect or authority conflict was
found during the replay.

The combined stack was verified with the repository's exact minimum Node runtime, `22.13.0`:

- `npm run test:cr13a`: 16/16 passing;
- `npm run test:cr12b`: 172/172 passing;
- `npm run check` and `npm run lint -- --quiet`: passing;
- registered pretests: 769/769 passing;
- core tests: 418/420 passing with the two intentional Windows-only skips and zero failures;
- registered posttests: 251/251 passing;
- production build: passing, including `/api/v1/projects/:projectId/events`;
- rendered-route checks: 3/3 passing;
- migrations through `0033` applied and 112 PostgreSQL tables verified;
- macOS stage zero: `ready_for_runtime_check`; and
- whitespace validation: passing.

This restack performed no native or provider call, credential operation, production database access, network integration,
deployment, or other external effect. It remains stacked behind the main-target connector integration pull request and
cannot be retargeted to `main` or merged until that parent is owner-approved. Parent PR #228 passed GitHub Actions run
`33554072751`; dependent PR #229 targets the parent branch and intentionally has no main-target CI claim yet.
