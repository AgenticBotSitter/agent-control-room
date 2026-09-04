# CR13A-LIVE-360 trusted database-time and lineage validation

**Status:** architecture frozen for repository implementation
**Stacked base:** accepted corrected LIVE-350 product `053c4d02003e0223438e26aecea851253d05a60b`
**Accepted LIVE-350 re-review SHA-256:**
`ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** authenticated PostgreSQL-compatible read-only validation and local PGlite tests only; no
authorization consumption, source lookup/invocation, protected native read, listener, provider, network, deployment,
or production database contact

## Purpose

LIVE-350 durably registers and replay-reserves one authenticated invocation authorization but intentionally does not
decide whether that authorization is currently valid. LIVE-360 adds the final pre-consumption check: it reconstructs
the exact authenticated authorization and nonce state, confirms the complete sealed lineage, then evaluates the
not-before/expiry window against time read from the authoritative database session. It remains a read-only preflight;
passing it does not spend an authorization and is not a capability to reach the native source.

## Trusted time source

The existing authorization store may gain one exact `validateForConsumption` method. Inside one database transaction,
after locking and authenticating the tenant stream, the method reads `clock_timestamp()` from that same database
session. Caller-supplied time, JavaScript `Date.now`, a generic callback, an HTTP header, authorization timestamps, and
receipt timestamps are never current-time authority. The database value must parse as one finite instant and be
canonicalized to UTC before comparison.

This makes the future private PostgreSQL primary the global time authority for this security decision while local tests
remain PGlite-only evidence. No production database is contacted or configured in this block. Database-clock trust,
availability, and rollback protection remain part of the accepted production database/operations boundary; an invalid,
missing, duplicated, non-finite, or noncanonical database time result fails closed.

## Exact validation transaction

The method accepts only the exact sealed envelope already required by LIVE-350. It reauthenticates the envelope,
requires the tenant to exist, locks and verifies the complete authorization stream/head and every digest-only nonce
reservation, then finds exactly one authorization and exactly one matching nonce reservation. The persisted body,
body digest, authorization tag, authorization-ID digest, nonce digest, accepted LIVE-330/LIVE-340 evidence, tenant,
project, connection, node, platform, runtime, candidate, attempt, operation, sealing-key identity, issued time,
not-before time, and expiry time must all match the supplied sealed envelope.

Only after those checks may the transaction read database time. Validation passes exactly when database time is at or
after `notBefore` and strictly before `expiresAt`. Time before the window returns a sanitized not-yet-valid rejection;
time at or after expiry returns a sanitized expired rejection. Missing/conflicting rows, replay drift, tamper, deletion,
foreign scope, invalid time, database failure, and transaction uncertainty fail closed.

## Result and custody

Success returns one immutable sanitized validation receipt bound to the authorization-ID digest, nonce digest, body
digest, canonical database validation time, and `validated_unconsumed` state. It reports that the authenticated lineage
and current window were validated, while authorization consumption, source lookup/invocation, native read, observation,
attestation, candidate authority, owner authorization, physical qualification, and runtime activation remain false.

The receipt is evidence only. It is not accepted as a token, key, bearer capability, replay checkpoint, or substitute
for atomic consumption. A later consumption transaction must repeat authenticated stream, nonce, lineage, and trusted
time checks before changing durable state. Repeated read-only validation may return equivalent evidence but never
changes the authorization or makes source access possible.

## Prohibited in LIVE-360

LIVE-360 must not add or modify a migration; issue, consume, revoke, update, delete, list, or externally look up an
authorization; accept caller time or a caller callable; export a key or authorization body; import/modify LIVE-330;
retrieve or invoke the private source; inspect process descriptors; read or expose protected native material; create a
raw observation, attestation, signature, candidate, owner authorization, listener, physical attempt, application/API/
worker/scheduler/Idea Lab/Hermes/runtime wiring, provider call, network path, production PostgreSQL connection, or
deployment; clear any blocker beyond final pre-consumption time/lineage validation; or treat a validation receipt as
spend or execution authority.

## Acceptance

Completion requires exact accepted LIVE-350 product/review binding; one exact read-only method; full authenticated
stream and nonce verification before the time read; exact sealed-lineage matching; database-session-only trusted time;
inclusive not-before and exclusive expiry semantics; missing/duplicate/conflict/tamper/deletion/time/database-failure
rejection; hostile-input and ambient-intrinsic safety; immutable sanitized evidence; repeatable non-consuming preflight;
no new migration, downstream consumer, native import, source lookup, or production contact; full producer verification;
and a different independent report-only zero-repair review.

Acceptance permits ordinary integration of the exact read-only validator only. It grants no production database use,
authorization issuance/consumption/revocation, source lookup/invocation, protected native read, observation,
attestation, candidate, owner authorization, physical qualification, runtime activation, provider, deployment, or
production authority.

## Reevaluate

Reevaluate before adding durable consumption state, a consumption method, post-transaction time recheck, source bridge,
lookup/invocation, native read, raw observation handoff, attestation, candidate assembly, owner authorization, physical
attempt, runtime wiring, provider contact, production database configuration, or deployment.
