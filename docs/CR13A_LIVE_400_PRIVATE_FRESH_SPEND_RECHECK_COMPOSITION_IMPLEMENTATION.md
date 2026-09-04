# CR13A-LIVE-400 private fresh-spend/recheck composition implementation

**Status:** architecture frozen for repository implementation
**Stacked base:** independently accepted LIVE-390 product `34640c7c6a3c63b781aa848f687ae1c23e7c2dee`
**Accepted LIVE-390 review SHA-256:**
`c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** one repository-owned composition of accepted PostgreSQL-compatible spend and recheck operations,
plus local PGlite tests; no source import/lookup/invocation, protected native read, listener, provider, network,
deployment, production database contact, or runtime wiring

## Purpose

LIVE-390 fixes the only acceptable ordering between accepted LIVE-370 atomic authorization consumption and accepted
LIVE-380 post-transaction database-time recheck. LIVE-400 implements that ordering in one private lexical flow. It
prevents a caller from supplying or receiving either receipt and makes every failure after spend terminal before the
future source boundary.

## Construction boundary

One exported repository factory may receive only a database client and the three exact protected key inputs required
to construct the accepted invocation-authorization store. It must not accept a store instance, receipt, clock,
callable, source, lookup, native binding, retry instruction, fallback, output collector, readiness boolean, or runtime
configuration. The factory constructs and owns one exact store, captures its frozen spend and recheck methods, and
returns one frozen runner. The implementation module is not exported from the connection-registry barrel and has no
application, API, worker, scheduler, Idea Lab, Hermes, startup, or production consumer.

The runner accepts only the original sealed authorization. Each entry creates a new lexical flow. It does not mutate,
freeze, retain after settlement, or return the caller's value. Concurrent entries share only the durable accepted
store rules; each entry has its own receipt custody and cannot consume another entry's receipt.

## Exact private flow

The nested private flow must:

1. verify the exact LIVE-390 singleton before starting;
2. call accepted LIVE-370 `consumeForInvocation` exactly once with the sealed authorization;
3. retain the returned receipt only in a lexical local;
4. stop terminally if the spend is uncertain, already consumed, malformed, or not fresh;
5. call accepted LIVE-380 `recheckAfterConsumption` exactly once with the same sealed authorization value and the exact
   fresh receipt object returned by step 2;
6. retain the recheck receipt only in a lexical local and accept only its exact successful fixed state;
7. erase both local references on settlement; and
8. return one frozen sanitized outcome and stop before any source import, lookup, or invocation.

No branch may call spend or recheck twice. There is no automatic or manual retry entry, replacement authorization,
receipt input, refund, unconsume, fallback, source path, or continuation callback. Mutation or substitution of the
caller-owned sealed value while the asynchronous database work is pending can only force terminal rejection; it
cannot replace either private receipt or create source authority.

## Sanitized outcomes

The public result may report only one of five terminal outcomes:

- `rejected_before_spend` — the accepted store established no committed spend;
- `terminal_spend_uncertain` — commit state is unknown or spent and the flow stops;
- `terminal_already_consumed` — the authorization was previously spent and the flow stops;
- `terminal_recheck_failed` — a fresh spend committed but the second trusted-time decision failed; or
- `completed_and_stopped_before_lookup` — the fresh spend and exact immediate recheck succeeded and the flow stopped.

It may include fixed spend/recheck call counts, the coarse spend state `not_spent`, `spent`, or `unknown_or_spent`, and
fixed false effect/authority fields. It must not expose an authorization/body/nonce/receipt digest, consumption or
recheck time, database locator, key material, raw safe error, source locator, native value, host identity, endpoint,
credential, command, stack, or reversible transform of protected material. Every result is repository-branded,
frozen, digest-bound, strictly parsed, and grants no approval, qualification, candidate, activation, network,
command, lease, or execution authority.

## Failure and uncertainty

Only an accepted store error other than `terminal_ambiguity` from the spend call may become
`rejected_before_spend`. Unknown errors and `terminal_ambiguity` become `terminal_spend_uncertain`. A non-fresh spend
becomes `terminal_already_consumed`. Every failure after a fresh receipt exists becomes `terminal_recheck_failed`.
No error text or lower-level code escapes. All terminal outcomes stop before source lookup and cannot be retried by
this composition.

## Repository record

The module may export one frozen implementation singleton, one frozen non-execution status singleton, the frozen
factory, strict implementation/status/result parsers, fixed outcome sets, and a fixed safe implementation error. The
status reports the composition as implemented but unwired, all repository execution totals zero, every source/native/
runtime/external-effect total zero, and every authority grant false. Dynamic test results may report one spend call
and at most one recheck call, but must keep both receipts private.

## Prohibited in LIVE-400

LIVE-400 must not add or change a migration; issue, register, validate, renew, revoke, delete, list, or inspect an
authorization outside the accepted spend/recheck operations; export either receipt; accept caller time or behavior;
import, modify, retrieve, or invoke LIVE-330; look up a source; inspect a process descriptor; read or expose protected
native material; create an observation, attestation, signature, checkpoint, candidate, owner authorization, listener,
or physical attempt; wire any runtime; contact a provider or production PostgreSQL; open a network path; deploy; clear
a blocker; or treat success as a bearer capability.

## Acceptance

Completion requires exact accepted LIVE-390 product/review binding; factory-owned exact store construction; exact
one-spend/one-recheck ordering; same sealed value and exact private receipt custody; terminal ambiguity, replay,
expiry, mutation, concurrency, and database-failure tests; frozen sanitized outcomes; no receipt leakage; no barrel or
runtime consumer; source/native/runtime totals zero; full producer verification; and a different independent
report-only zero-repair review.

Acceptance permits ordinary integration of the unwired private spend/recheck composition only. It grants no source
lookup/invocation, protected native read, observation, attestation, candidate, owner authorization, physical
qualification, runtime activation, provider, production database, deployment, or production authority.

## Reevaluate

Reevaluate before adding any private source retrieval or lookup; passing successful private state to the source;
invoking it; reading protected native material; creating an observation, attestation, checkpoint, candidate, or owner
window; performing a physical attempt; wiring runtime use; contacting a provider or production database; or deploying.
