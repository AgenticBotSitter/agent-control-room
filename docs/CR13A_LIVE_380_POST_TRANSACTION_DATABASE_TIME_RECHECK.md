# CR13A-LIVE-380 post-transaction database-time recheck

**Status:** architecture frozen for repository implementation
**Stacked base:** independently accepted LIVE-370 product `6f908ccd1f65f48a5d874fa0da96afe301d8decf`
**Accepted LIVE-370 review SHA-256:**
`c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** authenticated PostgreSQL-compatible read after a committed local PGlite spend; no source lookup/
invocation, protected native read, listener, provider, network, deployment, or production database contact

## Purpose

LIVE-370 atomically spends an exact authorization after an in-transaction database-time check. A commit can still
complete close to expiry, so that check cannot prove the authorization remains current after the transaction returns.
LIVE-380 adds the separately reviewable second database-time decision required between a fresh spend and any future
source lookup. The result remains evidence, not a capability.

## Exact recheck input

One exact `recheckAfterConsumption` method accepts the original sealed authorization envelope and the exact immutable
fresh LIVE-370 receipt. The receipt must have the fixed contract version, digest-bound reference and identities, stored
consumption time, `consumed_pending_post_transaction_time_recheck` state, `freshConsumption: true`, every effect field
false, every authority grant false, and its exact consumption digest. An already-consumed receipt, changed field,
unknown field, Proxy, accessor, Symbol, noncanonical time, malformed digest, or mismatched envelope rejects before the
database transaction.

The receipt is not secret and object identity is not trusted. Exact replay of a valid fresh receipt may repeat this
read-only validation, but cannot create a second spend, restore freshness, authorize a retry, or independently permit
source lookup. A future private composition must obtain the fresh receipt from its own immediately preceding LIVE-370
call and keep the spend, recheck, and source boundary within one non-exported control flow.

## Post-transaction read

In a new transaction opened only after the spend transaction returned, the method requires the exact tenant and
reauthenticates the complete registration stream/head and every nonce reservation. It then reauthenticates the complete
consumption stream/head using the third protected key and requires exactly one stored consumption matching the receipt,
authorization-ID digest, nonce digest, body digest, and canonical consumed-at time.

Only after all state is authenticated does the transaction execute one fixed same-session `clock_timestamp()` read.
The result must be exactly one canonical finite instant, must not precede the stored consumption time, must be at or
after not-before, and must remain strictly before expiry. Missing, duplicate, malformed, noncanonical, failed, regressed,
or expired database time rejects. The method never accepts caller time, `Date.now`, a callback, header, timer, receipt
generation time, or any non-database clock as current-time authority.

## Result and failure semantics

Success returns one immutable sanitized `consumed_and_post_transaction_time_rechecked` receipt bound to the exact
authorization, consumption, stored consumption time, and new database recheck time. It states that consumption and the
second time decision were observed but explicitly grants no source lookup, invocation, native read, retry, approval,
qualification, candidate, activation, network, command, lease, execution, physical-attempt, runtime, provider,
deployment, or blocker-clearance authority.

All failures are sanitized. Read-only transaction uncertainty is an integrity failure and cannot change the terminal
spent fact. The method does not delete, update, renew, refund, unconsume, or supersede the LIVE-370 record. Expiry after
spend remains terminal: the authorization stays consumed and no alternate authorization, retry, fallback, or source
path may be inferred.

## Prohibited in LIVE-380

LIVE-380 must not add a migration; issue, renew, revoke, delete, list, or consume an authorization; add a new spend;
accept caller time/callables; import/modify/retrieve/invoke LIVE-330; look up a source; inspect a process descriptor;
read or expose protected native material; create an observation, attestation, signature, candidate, owner
authorization, listener, physical attempt, application/API/worker/scheduler/Idea Lab/Hermes/runtime wiring, provider
call, network path, production PostgreSQL connection, or deployment; or treat either receipt as a bearer capability.

## Acceptance

Completion requires exact accepted LIVE-370 product/review binding; exact hostile-safe fresh-receipt validation; full
registration/nonce/consumption-chain reauthentication in a new transaction; exact stored consumption match; one
same-session database clock read after state authentication; monotonic consumed-at and inclusive not-before/exclusive
expiry decisions; restart/replay/tamper/deletion/reordering/time/database-failure evidence; immutable sanitized
non-authorizing receipts; no migration or source/native/runtime consumer; full producer verification; and a different
independent report-only zero-repair review.

Acceptance permits ordinary integration of the exact read-only post-transaction recheck only. It grants no source
lookup/invocation, protected native read, observation, attestation, candidate, owner authorization, physical
qualification, runtime activation, provider, production database, deployment, or production authority.

## Reevaluate

Reevaluate before adding the private fresh-spend/recheck composition, source bridge or lookup, source invocation,
protected native read, raw observation handoff, attestation, candidate assembly, owner authorization, physical attempt,
runtime wiring, provider contact, production database configuration, or deployment.
