# Durable native delivery preparation

Prepare the exact native dispatch body from locked canonical state, current paired owner-signature
revalidation and the HMAC-verified existing queue intent. Queue scope, lease, input, packet, operation,
enrollment, binding and deadline must match. Persist an immutable HMAC-protected body plus one audit
event within the same checked transaction. No caller-supplied body or earlier snapshot is accepted by
the coordinator operation. Trust changes, cancellation, expiry and audit failure invalidate commit.

Migration0049 adds one preparation table with queue and job/project foreign keys and append-only
triggers. Only the coordinator gains SELECT/INSERT; web SQL access remains unchanged. Schema gates
use the generated fingerprint and disposable preparation requires135 tables, migrations0001–0049.

Duplicate preparation retains the original exact body and receipt. The canonical request's observation
time can advance during revalidation; comparison excludes only occurredAt while preserving all other
fields. The original occurrence cannot be before queue insertion or after current time. It is not an
execution timestamp or renewed authority. Preparation/audit timestamps remain original on replay.

Current-owner historical readback returns only digest/identifier/time evidence, never prompt, packet,
enrollment or signed body. It can reconcile a lost commit acknowledgement after expiry without retry.
The evidence label explicitly says stored unsigned delivery body. It is not a signed server frame,
negotiated connection, delivered message, agent receipt or execution permission.

The next sender must establish current connection/feature/key state, revalidate authority, issue a
bounded server signature and durably track delivery and acknowledgement. Neither this record nor a
historical receipt authorizes a later network effect. No sender/handler or HTTP/lifecycle operation is
mounted here. Tests use disposable SQL and synthetic signatures, with no real credentials, native calls,
listener, database service, deployment or merge.
