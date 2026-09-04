# CR13A-LIVE-370 atomic invocation-authorization consumption

**Status:** architecture frozen for repository implementation
**Stacked base:** accepted corrected LIVE-360 product `6028badb6db6b0455e9bed02c45751ea81517fa4`
**Accepted LIVE-360 re-review SHA-256:**
`2dbf2c395ba8a95c41898cba05309551ca4e7be8e2b04e706f1fed1b7828cd47`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** authenticated PostgreSQL-compatible one-use consumption and local PGlite tests only; no source
lookup/invocation, protected native read, listener, provider, network, deployment, or production database contact

## Purpose

LIVE-360 proves that one exact stored authorization is authenticated, replay-reserved, lineage-complete, and currently
within its database-time window, but intentionally does not spend it. LIVE-370 adds the durable one-use state change
required before any native-source lookup can exist. The spend occurs only after repeating the complete LIVE-360 checks
inside the same transaction and remains incapable of reaching the source.

## Durable consumption ledger

Migration 0038 may add one append-only consumption stream and one authenticated stream head. Each consumption binds the
tenant, sequence, authorization-ID digest, nonce digest, body digest, canonical database consumption time, previous
record digest, record digest, and record authentication tag. Unique tenant/authorization and tenant/nonce constraints
make both identities one-use under PostgreSQL concurrency. Update, delete, and truncate guards preserve consumption
history; only the authenticated head advances.

A separately supplied 32-byte consumption-state HMAC key authenticates consumption records and heads. It must be
defensively captured and byte-distinct from both the authorization-sealing and registration-state keys. The module
does not generate, persist, return, log, or expose any key. Local tests may use exact synthetic keys; production key
configuration remains prohibited.

## Atomic spend transaction

One exact `consumeForInvocation` method accepts only the original sealed envelope. In one transaction it requires the
tenant, verifies the complete registration stream/head and every nonce reservation, proves the exact identity and
lineage match, verifies the complete consumption stream/head, and reads same-session database time. It repeats the
inclusive not-before and exclusive-expiry decision immediately before inserting the consumption.

If no consumption exists, the transaction inserts exactly one authenticated append-only consumption record and
advances its authenticated head atomically. The returned immutable receipt is
`consumed_pending_post_transaction_time_recheck`: it proves the authorization is spent but deliberately grants no
source lookup or invocation authority. Exact concurrent submissions converge to one spend; the loser receives only
sanitized already-spent evidence and cannot retry toward the source.

Changed authorization-ID/nonce/body reuse, partial state, duplicate rows, tamper, deletion, reordering, invalid time,
expired/not-yet-valid authorization, insert/head failure, or database failure rejects. A failure known to occur before
commit may report no spend; any uncertainty at or after commit is terminal. The caller must not retry, replace, fall
back, infer rollback, look up the source, or invoke it. A later exact read may establish already-spent state but cannot
restore invocation authority.

## Non-collapsible boundary

LIVE-370 ends immediately after durable consumption evidence. A later separately reviewed block must read trusted
database time again after the transaction and bind that result to this exact spend before any same-module source lookup
can be considered. A consumption receipt alone is never a capability or permission to cross the native boundary.

## Prohibited in LIVE-370

LIVE-370 must not issue, renew, revoke, delete, or list authorizations; accept caller time/callables; expose keys, raw
authorization IDs, bodies, or tags; import/modify/retrieve/invoke LIVE-330; inspect a process descriptor; read or expose
protected native material; create an observation, attestation, signature, candidate, owner authorization, listener,
physical attempt, application/API/worker/scheduler/Idea Lab/Hermes/runtime wiring, provider call, network path,
production PostgreSQL connection, or deployment; perform the post-transaction time recheck; clear a blocker beyond
atomic one-use consumption; or treat consumed/already-spent/ambiguous evidence as source authority.

## Acceptance

Completion requires exact accepted LIVE-360 product/re-review binding; migration 0038 with authenticated append-only
consumption/head state; a third byte-distinct protected key; full registration and consumption-chain verification;
same-transaction database time and exact window/lineage revalidation immediately before insert; atomic one-use spend;
concurrent convergence; exact restart behavior; tamper/deletion/reordering/rollback/failure/ambiguity handling; hostile
row/input safety; immutable sanitized non-authorizing receipts; no source/native/runtime consumer or production contact;
full producer verification; and a different independent report-only zero-repair review.

Acceptance permits ordinary integration of the exact durable consumption store only. It grants no source lookup/
invocation, post-transaction validity, protected native read, observation, attestation, candidate, owner authorization,
physical qualification, runtime activation, provider, deployment, or production authority.

## Reevaluate

Reevaluate before adding the post-transaction trusted-time recheck, a source bridge or lookup, source invocation,
protected native read, raw observation handoff, attestation, candidate assembly, owner authorization, physical attempt,
runtime wiring, provider contact, production database configuration, or deployment.
