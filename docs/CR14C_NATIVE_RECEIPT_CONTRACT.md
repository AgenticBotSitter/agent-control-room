# Authenticated native delivery receipt recording

The trusted node router supplies a raw frame to the existing server session after its single transport
send has returned. The session authenticates the current configured node/key, connection, signature,
sequence and replay state, requires the dedicated native receipt type, and matches every delivery
identifier and body/packet/binding digest against its retained exact dispatch. Generic transport
acknowledgements are not native receipts. Receipt time cannot predate dispatch or lie in the future.

The receipt collaborator rechecks the HMAC-verified saved envelope and transmission intent, requires the
same original node key/connection and receipt time at or after intent, and re-verifies the receipt
signature under locked current node/key records. It stores the signed receipt and chained audit together.
Current session, cancellation, receipt expiry and key-validity time fences run before commit and after
commit acknowledgement. The session remains closed after uncertainty; late continuations cannot reopen
it. These are locked snapshots, not continuous revocation polling after commit.

Historical readback requires the current owner's existing scoped task permissions and exposes metadata
only. It verifies the domain-separated HMAC. `stored_authenticated_node_receipt` reports the node's
`recorded` or `rejected` disposition, not verified node storage, admission, execution, completion or a
new permission. Rejection can be recorded after the task deadline while the receipt/session/key windows
remain valid. Recording evidence does not renew the task or require renewed owner approval.

One attempt has one immutable receipt. Replay consumption precedes receipt persistence: if persistence
rolls back or commit acknowledgement is lost, the connection closes and there is no automatic retry.
An existing history record reconciles lost acknowledgement. Missing history is not proof that the agent
did nothing. Cross-connection recovery and node durable-receipt outbox/acknowledgement remain later work.

The transport owner must serialize/buffer an early response until the current send operation settles.
This block adds no router mounting or buffering, receipt-acknowledgement send, node intake/admission
handler, long-lived renewal or multiple-task reuse. A receipted session is terminal for dispatch.
No listener, credential, provider, real PostgreSQL service or deployment is configured.

Migration0052 requires138 tables, immutable receipt rows, a transmission-intent foreign key and
coordinator SELECT/INSERT only. Web SQL receives no access. Verified schema digest:
`93d4767ea03998da6049b2e75c2b3cdf3b2c6da150dc024278a10786aa0dc6c3`.
