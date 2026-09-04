# CR13A-LIVE-420 — Private Same-Module Atomic Source-Lookup Bridge Implementation

**Status:** architecture frozen; implementation and independent review pending
**Accepted LIVE-410 product:** `e4d58ff35a44e66454cae8e778b31362902dab6b`
**Accepted LIVE-410 review SHA-256:**
`c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** one repository-owned, non-barrel private composition using accepted PostgreSQL-compatible spend
and recheck operations, one lookup of the exact module-owned atomic source, and local PGlite tests; no source
invocation, descriptor/process/OS/host/path read, raw observation, attestation, listener, provider, network,
production database, runtime wiring, deployment, DNS, hosting, or production effect

## Purpose

LIVE-410 established that public results and receipts cannot bridge LIVE-400 to LIVE-330. JavaScript module privacy
makes the consequence concrete: the final spend/recheck decision and the source's private `WeakMap` lookup must be
implemented in the source-owning module. LIVE-420 adds that first private lookup while stopping before source
invocation and every protected native read.

The accepted LIVE-400 public runner is not called, parsed, or treated as authority. Instead, the exact accepted
spend/recheck algorithm is re-expressed inside the source-owning module using the same accepted store primitives. This
intentional consolidation is necessary because returning a success state or continuation from LIVE-400 would create
the exported capability prohibited by LIVE-410.

## Fixed implementation shape

LIVE-420 modifies only the LIVE-330 source-owning module for executable behavior. That module may add one direct-module
factory for tests and later private composition, but it must remain absent from the connection-registry barrel and
have no application, API, worker, scheduler, Idea Lab, Hermes, startup, or production consumer.

The factory:

1. accepts only a database client and the exact protected keys needed to construct the accepted invocation-
   authorization store;
2. constructs that exact store internally and captures its frozen spend and recheck prototype methods;
3. accepts no store instance, receipt, success result, clock, callback, source, map, key, getter, native binding, retry,
   fallback, output collector, readiness boolean, or runtime configuration;
4. returns one frozen runner whose only input is the original sealed authorization; and
5. does not export itself through the connection-registry barrel.

The runner's private lexical flow:

1. verifies the exact accepted LIVE-410 contract singleton before starting;
2. calls accepted atomic spend at most once with the sealed authorization;
3. keeps the exact fresh spend receipt only in a lexical local and stops terminally on pre-spend rejection, commit
   uncertainty, malformed state, or already-spent evidence;
4. calls accepted post-transaction recheck at most once with the same sealed authorization and exact fresh receipt;
5. keeps the exact successful recheck receipt only in a lexical local and stops terminally on every failure;
6. performs exactly one captured `WeakMap.get` using the existing module-owned LIVE-330 implementation singleton as
   key;
7. accepts only the exact frozen source function minted and recorded by that module at initialization;
8. records no source value outside lexical custody and never returns, serializes, logs, hashes, stores, schedules, or
   passes it to a callback;
9. stops before calling the retrieved function and erases the local spend receipt, recheck receipt, and source
   references on settlement; and
10. returns one frozen sanitized terminal result.

The source-owning module must accurately supersede LIVE-330's old unreachable truth: the source remains private,
frozen, stored once, unexported, and uninvoked, but becomes retrievable only by the new guarded private flow. Its public
source/status evidence must say so without implying that an import, public result, or caller can retrieve it.

## Results and terminal behavior

The result may report only:

- `rejected_before_spend`;
- `terminal_spend_uncertain`;
- `terminal_already_consumed`;
- `terminal_recheck_failed`;
- `terminal_source_lookup_failed`; or
- `completed_lookup_and_stopped_before_invocation`.

Only the final two post-recheck outcomes report one lookup call; only the last reports that the exact private source
was successfully retrieved. Every result is terminal and non-authorizing. A result may report coarse spend state,
fixed spend/recheck/lookup counts, successful database-time recheck truth, and fixed false invocation, native-read,
observation, effect, and grant fields. It exposes no authorization, receipt, map, key, source, callable,
descriptor, process, path, host, database row, timestamp, locator, credential, raw code, diagnostic, or stack.

A known pre-spend rejection establishes no spend. Commit uncertainty remains unknown-or-spent. Already-spent evidence,
recheck failure, missing or substituted source, and every error after fresh spend are terminal spent outcomes. No
branch retries, replaces an authorization, refunds, unconsumes, falls back, performs a second lookup, or invokes the
source. The public success result cannot authorize the next block; future invocation must be inserted directly into
the same private lexical flow before that result is built.

## Evidence and tests

Tests may use only local PGlite and synthetic authorizations. They must prove:

- exact accepted LIVE-410 product/review binding and exact LIVE-330/LIVE-400 continuity;
- one internal store, one spend, one immediate recheck, one private lookup, and zero invocation on success;
- replay, concurrency, expiry, database failure, commit-return uncertainty, and mid-flight caller mutation stop
  without a second lookup or authority path;
- hostile inputs and dependencies execute no hostile behavior;
- the lookup returns only the exact module-minted frozen source and no source/map/key/callback/capability is exported;
- the source-owning module's revised public truth is exact and frozen;
- implementation/status/result parsers accept only their exact branded records and survive ambient replacement;
- static status has zero calls/effects and eight false grants;
- dynamic results expose at most one local lookup and always zero invocation/native reads; and
- no barrel/runtime consumer, migration, listener, provider, network, production database, or deployment path exists.

## Prohibited in LIVE-420

LIVE-420 must not call the LIVE-400 public runner or accept its result; export a private success value, source, map,
map key, lookup/getter, callback, continuation, token, capability, or receipt; invoke the retrieved source; inspect a
descriptor; read process, OS, host, path, environment, clock, credential, locator, or native values; create or expose a
raw observation; implement attestation, signer, replay checkpoint, candidate, owner authorization, listener, or
physical attempt; add a migration; wire runtime use; contact a provider or production PostgreSQL/VPS; open a network
path; deploy; clear a blocker beyond the private lookup bridge; or authorize production behavior.

## Acceptance

Completion requires a separately frozen design commit; exact accepted LIVE-410 product/review binding; truthful
supersession of LIVE-330 unreachable status; exact private store construction; accepted spend/recheck parity; one
module-keyed exact-source lookup; zero source invocations/native reads; terminal failure/no-retry behavior; strict
immutable records and sanitized results; hostile, concurrency, replay, expiry, mutation, database-failure, and ambient
tests; no barrel/runtime consumer; full producer verification; and a different independent report-only zero-repair
review.

Acceptance permits ordinary integration of the unwired private lookup composition only. It grants no source
invocation, descriptor/process/OS/host read, raw observation, attestation, persistence beyond local synthetic
authorization tests, candidate, owner approval, listener, physical qualification, runtime activation, provider,
production database, deployment, DNS, hosting, blocker clearance beyond lookup implementation, or production
authority.

## Reevaluate

Reevaluate before invoking the source; reading or returning protected native material; creating an observation,
attestation, nonce, replay record, candidate, or owner authorization; retrieving a listener; performing a physical
attempt; wiring runtime use; contacting a provider or production database; or deploying.
