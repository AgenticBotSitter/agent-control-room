# Durable native transmission intent

The trusted coordinator revalidates current canonical task/owner/lease/key authority against the exact
stored envelope before recording one immutable transmission intent and audit in a checked transaction.
The frame must match the session's privately retained reservation and the HMAC-verified envelope. Its
expiry may not exceed current canonical key/task validity. The original signed bytes are not rebuilt.

After confirmed commit, the server session rechecks its current state, frame expiry and the coordinator's
trust/cancel/deadline assertions. It consumes its local prepared state synchronously before entering the
supplied transport exactly once. The transport is explicitly injected and must not hide retries. No
listener, socket, provider connection or production bootstrap is installed by this block.

The pre-send fence also retains the time checks for the locked owner authorization snapshot: identity,
verification, stored session and required grant windows must remain valid after commit acknowledgement.
This is not a new post-commit database revocation poll. Revocation serialized before the original
authorization lock is observed; already-running transactions retain the existing ordering semantics.

`stored_transmission_intent` means a committed intention, not proof that send was entered, delivered,
accepted or executed. A lost commit acknowledgement can leave that record without a send. A transport
rejection or timeout can leave it with an uncertain send. Even a returned transport call is reported as
`returned_without_receipt`, with deliveryConfirmed false. Do not infer absence of effects from failure.

Timeout, disconnect or failed/uncertain completion closes the session. Late completion and concurrent
calls cannot send again. Current-owner scoped history remains readable after task expiry and verifies
its HMAC; it never returns payload, approval packet or an execution grant. No automatic retransmission,
re-signing, replacement-session recovery or native receipt processing is implemented here.

Migration0051 adds immutable intent history (137 total tables) with a foreign key to the saved envelope,
coordinator SELECT/INSERT only, and no web-role access. The verified schema fingerprint is
`f86730c7e0047bc44c346cde2c58f8bce19371f75951f7c9fc8067fc88be7732`.

Only trusted coordinator composition establishes canonical provenance for the supplied callback.
The sent session remains unavailable for further dispatch until separately implemented receipt/lifecycle
handling. The agent bridge's native intake/admission handler is not mounted by this change. Therefore
synthetic transport evidence is not a working live task-to-agent path or private-beta acceptance.
