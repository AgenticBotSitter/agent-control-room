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
active allowance. All phases retain one cumulative active budget.

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
security boundary, rather than using the active-work deadline. This amendment
does not authorize ignoring or extending that expiry. Unlimited remote waits
remain blocked until a reviewed run-lifetime authorization or renewal policy
exists. A real wait reaching that expiry still refuses and cleans up.

Remote browser sessions remain 300 seconds. Owners sign in fresh on return;
controller loopback sessions already renew independently. Sign-in before a
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

Controller-owned hosts already disable their standalone work timer. Recovery
uses durable status and an existing 5-second scan: the bounded one-hour wait
driver can exit and be reclaimed on a later scan. Its command bounds remain
unchanged. Saved intake/link progress keeps its 120-second machine bound;
approval progression remains bounded by remaining active work. The controller
does not change a separately operated native attendant's attendance or transport
policy. These limits must be resolved before claiming an unlimited real run.

No prior B5 specification document is tracked in this checkout. This document
records the revised cap semantics and their explicit unresolved security limits;
it does not modify unrelated four-hour limits elsewhere in the product.
