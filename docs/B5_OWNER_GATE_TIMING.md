# B5 owner gates and work budget

This B5 timing amendment replaces the shared wall-clock interpretation of the
four-hour `maxDurationMs` cap for real foreground-controller journeys. Owner
phone testing is informal: each published gate can be answered when the owner
returns. Rehearsal retains its existing short absolute deadlines.

For a real run, the configured cap remains at most 14,400,000 ms. The controller
reserves `min(300000, floor(maxDurationMs / 2))` for cleanup. The rest is a
cumulative active-work allowance across the entire run. It is not renewed
between gates.

Let S be controller start, M the configured cap, R the cleanup reserve, and G
accumulated time awaiting published owner receipts. Active elapsed time is
`now - S - G`. The effective work deadline is `S + M - R + G`, and the cleanup
cap is `S + M + G`. S and the original deadline anchors never reset. While an
owner receipt is pending, G includes the current wait and the work abort timer
is suspended. On receipt or cancellation, the wait is recorded and the timer
resumes with the remaining active allowance. A gate cannot suspend an already
exhausted allowance. Cleanup freezes G immediately; it cannot extend itself.

The common receipt wait covers connect/prepare, bindings-ready, confirm and
Start, questions, plan approval, spec approval, final-look evidence, all-tabs-
closed attestations, and fresh sign-in before a gate's initial browser
challenge. The real owner install request also uses this accounting. Publishing,
automatic desktop capture, receipt acceptance, saved intake/link progress,
approval recovery, model work between gates and final verification use the
active allowance. All phases retain one cumulative active budget. Watchdog and
receipt polling continue during owner waits (about 1 Hz and 10 Hz respectively);
these background checks do not charge the suspended active-work allowance, so
total request volume grows with the wait.

Stop, external abort, SIGINT and SIGTERM remain available during owner waits.
They interrupt the wait and invoke the same complete cleanup. Cleanup bounds
remain 30 s for Stop, 60 s for host close, 120 s for mapping removal, and 60 s
for Postgres stop. No cleanup operation becomes an unlimited owner gate.

`controller-start.json` records the mode and configured budget.
`controller-timing.json` records gate-wait milliseconds and the effective work
and cleanup deadlines. Evidence timestamps retain their actual wall time.

## Security limits still blocking unlimited remote waiting

The controller budget has no separate owner-response deadline in real mode.
The existing transport authorization still expires. Its immutable packet is
checked on every remote request and pinned across host restarts, with no renewal
operation. Real device requests therefore retain the packet's `expiresAt` as a
security boundary, rather than using the active-work deadline. **PROVEN (R302):**
the product already accepts an explicit run-length approval of four days. There
is no transport duration cap to raise or add: `validateB5TransportV1` compares
the current time with the packet's `authorizedAt` and `expiresAt`, and real
controller phases use that exact expiry. The test `B5 transport accepts an
explicit four-day run approval and enforces its exact expiry without a duration
cap` in `tests/improve-control-room-first-website-device.test.ts` accepts four
days (and five days to guard against adding a cap), refuses before authorization,
and refuses at exact expiry. The owner must approve an expiry covering the
intended run; the product never renews or extends the packet itself. Open risk
**TRANSPORT_APPROVAL_EXHAUSTED:** a real wait reaching that explicit expiry still
refuses and cleans up. An unlimited run remains unsupported.

Remote browser sessions remain 300 seconds. Owners sign in fresh on return.
**PROVEN after fix:** `createB5ControllerSessionV1` revokes an expired loopback
session and issues a fresh one before its next exchange. Previously the composed
server refused revocation of its own expired cookie, aborting renewal with
`B5_CONTROLLER_SESSION_CLEANUP`. `LocalOwnerSessionServiceV1.revoke` now durably
revokes the exact locally issued expired session before removing it from memory;
an expired cookie remains unauthorized for protected reads, and storage failures
remain visible. `B5 composed controller renews across four days with durable
expired-session and cleanup revocation` in
`tests/improve-control-room-first-website-session.test.ts` uses the production
B5 session-profile/store factory, actual Mac-local HTTP application, PostgreSQL
session-store adapter and migrated disposable PGlite database. At a fake 96-hour
idle gap it checks expired GET 401, DELETE 204, fresh POST 201, successful protected
GET 200, one issuance for eight concurrent return polls, and durable revocation
of both sessions at cleanup. A second test covers failed durable revocation and
unissued cookies. This is composed product coverage without a listener; it does
not claim independent PostgreSQL connections or real phone qualification.
Sign-in before a
phase's first evidence challenge works. After correlation, the mailbox requires
the same session and an immutable observation for that phase. Mid-phase fresh
sign-in after expiry needs a reviewed renewed-challenge protocol; mixed-session
evidence is still rejected. Unlimited document-reading/reauthentication within
one phase is therefore also blocked. No authentication or evidence policy is
weakened here.

Republishing only a fresh challenge is insufficient if an owner action already
succeeded in the old attempt. A `confirm-start` receipt requires both Confirm
and Start service successes under its observation; dropping an old-session
Confirm and recording only a fresh-session Start must still refuse with
`B5_DEVICE_SERVICE_MISSING`. Answers and approvals likewise consume their
current gates. A new UI action key cannot repeat those consumed decisions.
The service supports exact idempotent replay with the original body and key,
but the device request packet carries neither a replay reference nor a recovery
instruction, and the current UI loses its in-memory replay action on fresh
navigation or protected-authority clearing. A complete restart needs a reviewed
owner replay/recollection flow for already accepted actions. Counting old-session
actions or substituting saved status would change the proof rules; neither is
implemented. A restart limited to pre-action expiry would not cover this case.

The owner-action replay extension is stopped at its owner UI boundary. An
optional versioned packet list of opaque command references would locate
accepted actions without retaining bodies or session material in evidence,
but the current owner page cannot consume those references. Its decision
component clears the original body/key on a gate change or authentication
failure and only renders current gates; the run panel disables Start after
acceptance. Neither a packet field nor a browser-client change can add the
missing explicit owner replay control. The existing approval-document HTTP
route returns conflict after approval consumption, and current status no
longer contains an answered question. Exact replay with the original key also
refuses a changed body; a fresh key cannot replace a consumed gate.

Completing recovery requires an owner recovery surface in `private-app/**`
which, under a fresh sign-in and challenge, resolves the pending attempt's
opaque references, displays the exact saved request/document and original
answer where applicable, and explicitly submits the original body/key through
the existing authorized command route. Service support must make the original
sealed document available after consumption under current lineage authority.
Fresh HTTP replay successes and captures must be collected in the new attempt;
abandoned observations/events remain immutable audit only. This requires UI
work beyond the permitted replay-build files; no restart, packet extension or
proof-policy change is implemented here.

Controller-owned hosts disable their standalone work timer when `signalOwner`
is supplied (`first-website-host.ts`); standalone CLI bounds remain unchanged.
**PROVEN (product recovery path):** `B5 long gate reclaims an exited one-hour
driver through durable scan without duplicate Start` in
`tests/improve-control-room-first-website-long-gates.test.ts` composes the real
5-second interval cycle, recovery worker, service SQL scan/reconciliation and
adapter subprocess ownership. A synthetic external engine's actual
`wait --chain --hours 1` child exits with code 4 at a fake hour; the next scheduled
scan acquires a new generation for the same durable run. Later scans retain the
live replacement. A fresh owner session answers a question through the service
and adapter; the saved engine revision advances and Start remains a single
journal claim and invocation. Cleanup reaps the replacement and cancels the
cycle. The external engine and its exclusive driver capability are explicit
fixtures. Open risk **ENGINE_RECOVERY_UNAVAILABLE:** the real installation must
still attest an ended driver and runnable unchanged input; a live, uncertain,
changed-input or unavailable capability cannot be reclaimed on a time threshold.

**PROVEN (product availability admission):** `B5 long gate refresh reaches real
adapter admission and fails closed on stale collection` in the same long-gates
test file composes the production interval cycle and recovery `onTick` callback
with the real adapter, collector subprocess, monitor schedule and owned files.
A fake clock advances a four-hour gate through four 50-minute refreshes, with
no foreground browser activity. Admission via the adapter's real `available`
check stays true on return. A failed collection and its five-minute retry retain
the previous bytes; exactly one hour remains fresh, one millisecond beyond it
refuses Start, Stop remains available, and a later successful collection
restores admission. The external `logins --json` CLI supplies synthetic health
only; no native provider is contacted. Open risk **COLLECTOR_OUTAGE:** failed
collection can exhaust the ten-minute freshness margin and intentionally block
new work until a fresh successful sample exists. Availability of actual routes
remains the external engine's admission decision. No active-budget change
renews an availability qualification.

Saved intake/link progress keeps its fixed 120-second machine bound after
prepare. The observer polls an unlinked saved intake during prepare without
starting that bound behind the owner gate. Approval progression uses remaining
active work after each approval receipt; restarts drain and restart the observer.
`B5 real journey continues through every long owner gate and both restarts` in
`tests/improve-control-room-first-website.test.ts` exercises the exported journey
with 17 two-hour gates, both restarts, post-gate intake and approval checks,
session renewal and mapping cleanup. Its host, browser, binding and final verifier
ports are fixtures; it establishes controller liveness, not native execution or
phone evidence qualification.

The controller does not change a separately operated native attendant's attendance
or transport policy. These limits must be resolved before claiming an unlimited
real run.

No prior B5 specification document is tracked in this checkout. This document
records the revised cap semantics and their explicit unresolved security limits;
it does not modify unrelated four-hour limits elsewhere in the product.
