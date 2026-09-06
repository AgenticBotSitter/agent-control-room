# E28 — automatic recovery after signed reconciliation

2026-09-06. Local opt-in implementation; native execution remains simulated.

## Result

The actual pg-boss test now completes offline pickup -> signed reconnect/reconciliation
-> automatic canonical recovery -> audit-verified pickup -> one signed dispatch -> exact
stored result bytes and pending review, with no explicit recovery call in test flow.
The first offline pickup sends nothing. Recovery retains the same job and approval and
does not permit automatic retries of a subsequent uncertain send.

## Implementation

When an explicitly recovery-enabled managed session finishes signed reconciliation and
has a ready native-delivery channel, one generation-bound readiness hook runs. Raw hello,
attachment, and later fresh ACKs do not trigger it. It runs after the session operation
releases its busy flag, so eligible queue work can use the connection.

The coordinator discovers at most 32 candidates (33rd row reports truncation), scoped
to the configured tenant/node and optional exact attempt, active unexpired leases and
absence of delivery envelopes. Discovery is not authority. Each candidate receives its
own original HMAC/owner/signed-approval/never-staged checks and transaction; the current
connection generation is checked again before commit. One ineligible candidate is held
without treating it as recovered or failing every other candidate.

Replacement and close abort that generation's readiness work. A five-second deadline
aborts late recovery and leaves status uncertain, without closing a healthy connection
needed for result intake. There is no automatic second hook attempt on the same session.
Trusted server composition can read not-attempted/running/complete/uncertain status and
completed scan counts, including held/truncated; these are not production health claims.

The hook and candidate policy are Control Room-specific approval/identity glue; pickup
and recovery mutations still use pg-boss, with no new poller or transfer protocol.

## Evidence and limits

- All 55 actual-package integration checks pass, including automatic offline-to-review.
- 55 related canonical/session/lifecycle checks pass together; the additional focused
  readiness-timeout test passes. TypeScript, targeted lint and whitespace checks pass.
- Tests cover no trigger on hello, no duplicate on a later signed ACK, recovery failure
  preserving usable connection, generation replacement, node/attempt scope, revoked
  owner held outcome, and generation-change transaction/audit rollback.
- Initial replacement-test expectation incorrectly allowed further messages on the
  retired session. It was corrected to expect rejection; implementation was not weakened.
- The handshake fixture can stop before a newly queued dispatch so the test does not
  accidentally consume task frames while draining handshake messages.

The connected fixture uses privileged canonical setup plus restricted queue and managed
roles on one PGlite engine. It is not full production startup, physical pool isolation,
real PostgreSQL concurrency, a real provider call or owner/browser acceptance. A capped
scan is not an unbounded fleet recovery sweep; held/truncated work remains visible in
the server result and needs the operator/inbox integration and sustained-fleet tests.

## Next

Verify the actual full-host composition under exact database roles and complete queue
schema expectations; connect the browser approval/enqueue workflow. Carry held/uncertain
recovery into the attention view. Consolidate separately authorized real-PG/live-owner
acceptance rather than reusing spent native authorization. Deployment remains disabled.

No downloads, credential access, native services/provider, deployment or GitHub writes.
