# E23 — reuse upstream primitives for never-sent recovery

2026-09-06. Pinned pg-boss 12.30.0, existing E01 acquisition, offline evaluation.

## Decision from source and execution

Do not invent a queue reset query or use pg-boss internal methods. Its public retry()
and update() APIs can recover the same operational identity while keeping automatic
retries disabled, if executed together in one checked transaction:

1. retry(name, id, {db}) changes a failed row to retry and increments retry_limit.
2. update(name, undefined, {id, retryLimit: 0, db}) disables automatic retries before
   that transaction commits. Omitted payload and timing fields remain unchanged.

The next fetch has retryCount 1 and retryLimit 0. A subsequent explicit failure becomes
failed, and another fetch returns no job. This is an operational mechanism, NOT proof
that any particular task is safe to retry. Retry alone would leave extra automatic
retry allowance, so it is not the selected composition.

The initial experiment attempted restore() because it exists in internal manager source.
It failed: restore is not exposed by the public package. The regression now records this
public API absence; no internal manager access or direct reset SQL is selected.

## Verified

- Actual package retry/update commit under the existing restricted worker role.
- Retry count increases; zero automatic retry allowance survives pickup and failure.
- Job ID, payload and keepUntil are preserved; failure completedOn is cleared.
- Throwing before commit rolls back both operations to the exact previous job snapshot.
- All 48 actual-package submission/worker checks pass together; targeted lint and
  whitespace checks pass. No new dependencies or downloads.

These tests warm package metadata through ordinary initial submission. The future
adapter must also bind cold-cache SQL to the exact transaction, as the submission
adapter already does. PGlite is not independent-pool or real-PG concurrency evidence.

## Integration contract still to implement

The existing worker intentionally rejects retryCount > 0. Do not relax that check in
isolation. Connect recovery and pickup together, with the following acceptance cases:

- Revalidate the HMAC queue intent, owner/grants, signed approval, active project/node,
  unchanged assigned attempt/lease and original deadline under canonical locks.
- Require absence of a staged delivery envelope, transmission intent, delivery receipt
  and native run evidence for that exact attempt. Missing receipt alone is NOT unsent
  proof. A staged-but-unsent envelope remains held for reconciliation in this first path.
- Lock the exact operational row and verify its reference, failed state and zero retry
  limit. Never restore active/completed/cancelled jobs, recreate pruned rows, backfill old
  intents or select another node. Bound recovery attempts and retain canonical audit.
- Apply canonical proof, operational changes and audit atomically. Existing coordinator
  grants do not permit job UPDATE; choose and test the narrow role/port composition
  before any change to effective permissions. The queue worker must not gain canonical
  write authority merely to make recovery convenient.
- An authenticated reconnect may request bounded recovery of eligible never-staged work;
  queue records alone cannot authorize it. Revocation, expiry, cancellation, staged send,
  ambiguous commit and duplicate reconnect must not generate another external start.
- Test offline -> reconnect -> one dispatch -> pending review through the actual worker,
  plus denial/replay/rollback cases. Do not count the mechanism tests as that journey.

No automatic recovery, new grants, runtime mounting or live agent effects were enabled.
This closes the upstream mechanism question; canonical authority and reconnect integration
are next, not another broad queue-platform search.
