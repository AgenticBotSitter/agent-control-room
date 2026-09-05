# Atomic approved native task queue

The trusted coordinator enqueues one immutable delivery intent per canonical attempt. Its existing
owner/session, active ordinary project, task/plan/reservation/node/key transaction rebuilds preparation,
revalidates the actual saved paired signatures, inserts the intent and appends the audit event. The same
transaction's commit checks enforce cancellation, trust freshness and authority deadlines. Queue/audit
insertion is rolled back together on failure. No snapshot returned by an earlier transaction is accepted.

The intent commits exact tenant/project/job/attempt/node, lease ID/epoch, input, saved packet, operation,
binding, enrollment and deadline. It contains references/digests rather than duplicate prompt, signatures,
private keys or credential material. Its HMAC uses a separate queue purpose with the explicitly supplied
approval store key. Foreign keys bind the canonical job/project and existing saved approval attempt.
Duplicate enqueue verifies the original intent and returns its original receipt; changed material fails.
UPDATE, DELETE and TRUNCATE are rejected. No delivery attempt is made within a SQL transaction.

The restricted coordinator gains SELECT/INSERT on this one table; web permissions are unchanged. Both
role gates use the recomputed migration0048 structural fingerprint, and disposable preparation requires
migrations0001–0048 with134 tables. No runtime role widening or real database setup is performed.

Authenticated historical readback requires current owner approval access and the canonical input scope,
but not a still-live reservation. It enables reconciliation after an uncertain commit without enqueue
retry. The receipt means recorded delivery intent only: not a currently eligible queue item, signed server
message, node receipt, running agent or permission to execute. No new web/lifecycle port is exposed yet.

Delivery processing remains the next integration. A sender must revalidate current canonical and trust
state before issuing a bounded signed message and record delivery progress/reconciliation durably; it
must not execute stale intents. Cancellation never requires deleting this history. Nodes independently
verify signed provenance, exact approved payload and current local admission before their durable
claim/marker and physical effect. No sender, native call, listener, service or deployment is activated.
