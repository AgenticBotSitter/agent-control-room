# E24 — canonical never-staged recovery and upstream adapter

2026-09-06. Local opt-in implementation under ADR-252.

## What changed

TaskAssignmentCoordinator.recoverNeverStagedQueueDelivery reuses ADR-251 queue authority
and the existing canonical tenant/project/job/attempt/lease/node locks and signed packet
revalidation. It refuses any staged envelope, transmission intent, delivery receipt or
native run evidence. It invokes only an explicitly supplied recovery port, in the same
transaction, and records successful recovery in canonical audit. No-op consumes no audit
budget. The shared limit is three recoveries per original queue identity.

preparePgBossNativeTaskSubmission exposes that port only with recovery:true. It binds all
upstream SQL, including cold metadata, to the checked caller transaction, locks the exact
queue/job, verifies immutable reference, zero retry limit, standard policy and matching
prior recovery count, then uses public retry/update. It verifies the resulting state
before returning. No operational row is created, payload changed or approval renewed.

Default adapter shape remains unchanged. Current lifecycle/startup does not expose a
recovery command, existing coordinator grants do not permit recovery UPDATE, and the
worker still rejects recovered metadata. This is an implemented authority/transaction
piece, not enabled automatic reconnect recovery.

## Evidence

- 52 combined actual-package/PGlite checks pass, including four new canonical recovery
  cases: commit/bounded replay, audit rollback, expiry rollback and mismatched reference.
- A fresh producer's cold cache stays within the canonical transaction. An escaped
  database query would fail the test rather than silently use another transaction.
- 42 related unit/canonical/session regression checks pass. New cases cover browser
  logout without fabricated identity, three-recovery cap, no-op, absent port, expiry,
  cancellation, thrown operation, owner revocation and real staged/transmitted refusal.
- TypeScript, targeted ESLint and whitespace checks pass.

The operational/canonical integration uses privileged canonical setup on one PGlite
engine. It does not prove final production grants or physical pool isolation. Recovery
tests explicitly fetch/fail synthetic work using the package; they do not claim the
current application worker accepts a recovered job or that a native provider ran.

## Next coherent integration

Add the exact permitted recovery SQL role/profile and lifecycle command, then bind
recovered pickup to its canonical audit ordinal before relaxing retryCount admission.
Trigger eligible recovery through authenticated assigned-node readiness, retaining
scope/deadline and deduplicating reconnect requests. Prove offline -> reconnect -> one
dispatch -> pending review, including revoked, expired, staged and uncertain cases.
Complete actual whole-host/full-schema and real PostgreSQL evidence before deployment.

No download, native provider, credential access, persistent service, new database grants,
deployment or GitHub publication. All fixtures close after tests.
