# CR14C — separately authorized native run recovery

Date: 2026-09-05. Repository-only composition, based on PR #302.

## Permission, not renewed execution

`createNativeRecoveryAuthority` implements only exact recorded-run status and stop checks. Its separate
Ed25519 permission has a domain-separated schema, complete native binding digest, issuer key identifier,
signed issue/expiry times, nonce and fixed `[status, stop]` operations. Start, capabilities, events and
marker creation are denied. No method signs or self-issues this permission.

The signed issue time must precede the work deadline and be no later than the durable execution/claim
creation times. These are trusted signed/durable timestamps, not independent proof of physical signing
time. Permission cannot last beyond enrollment expiry or five minutes after the exact work deadline.
This is a bounded recovery window, not execution grace: no lease is renewed, execution resurrected,
marker created, effect settled, capacity released or canonical job changed.

Every check verifies the signature against a freshly resolved trusted owner approval key, current
credential availability and explicit recovery policy/revocation, then verifies the exact accepted
profile/isolation evidence. Work pause/expired lease does not itself authorize or prohibit cleanup;
the separately typed current recovery policy decides whether cleanup remains allowed. Removing that
permission or its key fails closed. There is no fallback to expired work permission.

The current evidence callbacks are trusted node composition seams, never browser/job supplied. The
profile callback must resolve accepted qualification, OS isolation and enrolled destination evidence;
reported capability flags are insufficient. This block supplies no production resolver, signing custody,
approval UI, native credential or network adapter activation.

## Durable identity and one-attempt stop

Recovery requires the existing journal's exact binding and recorded native run ID, a full marker-bearing
executing/ambiguous effect claim, and matching admitted-then-started execution identity, authority and
absolute deadline. Missing IDs, missing markers, compacted/settled claims and mismatched records are
denied; unknown IDs cannot be attached through recovery. Expired/cancellation-requested execution may be
observed or stopped under recovery permission, never restarted. A terminal local permission record is
not physical cessation proof; the native adapter still treats native terminal states as recorded evidence.

The existing adapter owns the durable `stopAttempted` intent before HTTP and rechecks this authority just
before authenticated bytes. Lost responses, denied attempts and replacement adapters do not replay stop.
The recovery controller does not create another stop ledger or promise generic exactly-once transport.
Native `stopping` is acknowledgement, not stopped; native terminal state is not proof of all descendants
exiting. Existing ambiguity and capacity remain for explicit reconciliation.

`composeNativeRunAuthority` routes all status/stop checks to recovery and all start/capability/event checks
to start authority, capturing the supplied methods. It does not catch failures or attempt an alternate
permission path. The adapter's existing enrollment/deadline restrictions remain in force; event streams
are not extended beyond the work deadline. No route/runtime imports this composition yet.

## Bounds and ownership

Inputs are parsed/copied and enrollment frozen. Checks use a monotonic-per-controller nonnegative clock,
at most five seconds and at most eight unresolved operations, with no queue. Timed-out work retains its
slot until actual settlement; abort is advisory and late work cannot authorize. Close aborts pending
checks and disables that controller, not a remote run or caller-owned stores. Reconstructing a controller
does not establish a trustworthy wall clock; deployment must supply accepted clock and evidence sources.

All evidence reads are bounded/current snapshots, not an atomic lock over external trust services. The
shared SQLite journals are node-local enforcement only. PostgreSQL remains sole global write authority.
No schema/migration change or database provisioning is involved.

## Test and delivery boundary

Tests use real disposable canonical assignment, real local start policy/markers/journals and generated
synthetic signing keys with the actual Hermes adapter and fake transport. They cover stop after durable
expiry, signature/binding/preauthorization failures, final-byte revocation, lost acknowledgements,
replacement adapter deduplication, fixed expiry, unresolved-check bounds and close fencing.

No live qualification, provider, host credential, listener or deployment is exercised. Remaining C-WORK:
real trusted resolver composition, owner signing/intake, signed coordinator dispatch, result/revision
integration and scoped live validation. Continue Astra Medium.
