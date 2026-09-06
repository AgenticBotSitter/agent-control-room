# Recorded native reconnect

This block restores reporting for one already-recorded task after a new managed
connection completes its signed hello and reconciliation. It does not restart a
provider, dispatch a task, register a missing run, renew a lease or accept quality.

## Trusted operation

The supplied-transport handle exposes `recover({projectId, jobId, attemptId,
inputDigest}, signal)`. This is trusted runtime composition, not a browser route.
The receiver verifies its fixed workspace and authenticated saved delivery envelope,
transmission intent, recorded node receipt, and existing run plus event history.
The run must equal the receipt-derived original registration after removing only
the store's mutable observation fields. The canonical job/attempt/lease identity,
input digest, node and lease epoch must still match.

Missing evidence is a refusal, never an instruction to create or execute work.
The recorded node key and server signing key must match the configured current
pins. Key rotation recovery is not supported by this block. Enrollment and native
session identity remain the original binding; transport connection identity changes.
Recovery uses the identity authenticated at the handshake; it is not a second key
status query. Every subsequent progress frame independently rechecks the current
node/key status before evidence writes. Revocation after hello therefore prevents
reporting even if the read-only recovery step already returned.

## State and authority

Only a newly reconciled ready connection may recover. The original signed dispatch
remains historical, with its original connection ID and expiry. It is verified but
never transmitted or re-signed. A separate `recovered` observation state cannot
stage a dispatch, transmit an envelope or accept another delivery receipt.

Historical execution/lease expiry does not expire recorded evidence. Fresh reporting
still requires a valid current transport session and fresh authenticated frames on
its new connection. Existing snapshot/version/terminal-state, result-binding and
review rules apply unchanged. Recovery itself performs no database writes or sends;
subsequent reporting can persist evidence and return ordinary acknowledgements.

Cancellation, replacement, failed health, clock rollback, deadline or unresolved
operation invalidates the handle. Proof transactions recheck session currentness at
commit, and no awaited continuation may install recovered state after invalidation.
An uncertain acknowledgement does not erase durable evidence or authorize retrying
execution; a later fresh connection can recover and reconcile the evidence.

## Evidence required

- Fresh signed reconnect and useful progress/result submission without added native
  starts, delivery records, leases or canonical execution transitions.
- Fresh-envelope exact snapshot replay, old-connection refusal and no send authority.
- Missing/tampered/mismatched proof and cancellation/replacement rejection.
- Independent production review and existing managed-session regression tests.

All execution here is synthetic and disposable. No physical listener, credential,
provider, production PostgreSQL, host preparation or deployment is activated.
