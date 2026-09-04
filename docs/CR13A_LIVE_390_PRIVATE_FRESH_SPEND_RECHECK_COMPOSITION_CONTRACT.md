# CR13A-LIVE-390 private fresh-spend/recheck composition contract

**Status:** architecture frozen for effect-free repository contract implementation
**Stacked base:** independently accepted LIVE-380 product `1b79bbc75dfe74ce0777bcc33cbcc801054113f0`
**Accepted LIVE-380 review SHA-256:**
`4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** inert contract, deterministic tests, and sanitized zero-use evidence only; no authorization call,
database transaction, source import/lookup/invocation, protected native read, persistence, listener, provider, network,
deployment, DNS, hosting, or production effect

## Purpose

LIVE-370 can atomically spend one exact invocation authorization. LIVE-380 can independently authenticate that spend
and recheck trusted database time after the consuming transaction. Both methods are deliberately public repository
primitives whose returned receipts grant no source authority. Allowing a caller to supply, replay, or combine either
receipt later would leave a gap before the first private source lookup.

LIVE-390 freezes the only acceptable composition of those accepted primitives. One future non-exported control flow
must obtain its own fresh LIVE-370 receipt, immediately pass the same sealed authorization and that exact receipt to
LIVE-380, accept only its own successful recheck, and stop. The source remains unreachable.

## Fixed private control flow

A later separately reviewed implementation must:

1. enter one private, non-exported composition with one exact sealed authorization already bound by LIVE-340;
2. call accepted LIVE-370 `consumeForInvocation` exactly once;
3. accept only `consumed_pending_post_transaction_time_recheck` evidence reporting a fresh consumption from that call;
4. retain the sealed authorization and fresh receipt only inside that private control flow;
5. call accepted LIVE-380 `recheckAfterConsumption` exactly once with the same sealed authorization and exact receipt;
6. accept only `consumed_and_post_transaction_time_rechecked` evidence returned from that immediately preceding call;
7. retain both receipts privately as non-authorizing evidence and return neither to the caller; and
8. stop immediately before the first same-module private source lookup.

The future composition must not accept a caller-supplied spend or recheck receipt, a callable, store, clock, database
session, source, lookup function, native binding, output collector, retry instruction, fallback, or readiness boolean.
It cannot reconstruct a receipt from public fields or trust object identity as proof that the same private flow created
it.

## Terminal failure and uncertainty

A known precommit rejection returns only a sanitized failure and creates no source authority. Any uncertainty at or
after spend initiation is terminal for this flow. A failed, expired, malformed, ambiguous, or uncertain recheck leaves
the durable authorization spent and is terminal before lookup. None of those outcomes permits replay, automatic or
manual retry with the same authorization, replacement authorization inside the flow, fallback, receipt reuse, or
inference that a source lookup is safe.

Even the successful `completed_and_stopped_before_lookup` outcome is evidence of ordering, not a capability. A later
same-module lookup implementation needs its own contract and independent review before it may consume the private
success state in the same synchronous custody boundary.

## Non-collapsible stages

The path remains split in this order:

1. accepted LIVE-370 atomic authorization consumption;
2. accepted LIVE-380 post-transaction database-time recheck;
3. LIVE-390 inert private composition contract;
4. later private same-control-flow implementation;
5. one fresh atomic spend;
6. one post-transaction database-time recheck;
7. mandatory stop before source lookup;
8. separately reviewed same-module private source lookup;
9. one synchronous private source invocation;
10. private raw-observation handoff;
11. trusted attestation, platform signature, and durable replay checkpoint;
12. private physical-candidate assembly;
13. fresh owner authorization and one owner-attended attempt;
14. different independent review; and
15. separate runtime-activation approval.

No stage implies, performs, or authorizes the next.

## LIVE-390 repository record

The implementation may export only one frozen contract singleton, one frozen non-execution status singleton, strict
parsers, fixed rules/stages/blockers/outcomes, and fixed safe errors. Exact private provenance rejects copies,
re-digested substitutes, accessors, Proxies, Symbols, inherited or extra fields, alternate prototypes, and ambient
intrinsic replacement without executing caller behavior.

The contract binds the exact accepted LIVE-370 and LIVE-380 product and review evidence. Public status reports the two
dependencies as accepted but not called, composition as contract-only, lookup absent, invocation not attempted, and
runtime not wired. Every composition, authorization, database, receipt, retry, source, native, observation, signer,
persistence, candidate, owner, listener, network, provider, protected-value, command, ambiguity, and external-effect
total is zero. Every approval, qualification, candidate, activation, network, command, lease, and execution grant is
false.

Public material contains no authorization identifier or body, nonce, receipt value, consumption time, recheck time,
database locator, runtime value, executable path, PID, OS/host/user identity, private source locator, endpoint,
credential, key, command, provider content, native diagnostic, stack, or reversible transform of protected material.

## Prohibited in LIVE-390

LIVE-390 must not import or instantiate the authorization store; add executable composition; call validation,
consumption, recheck, or database behavior; accept caller time or callables; add a migration; import, modify, retrieve,
or invoke LIVE-330; implement a source lookup; inspect a descriptor; read or expose protected native material; create an
observation, attestation, signature, checkpoint, candidate, owner authorization, listener, or physical attempt; wire
application, API, worker, scheduler, Idea Lab, Hermes, startup, or production use; contact a provider or production
PostgreSQL; open a network path; deploy; clear a blocker; or treat a spend or recheck receipt as bearer authority.

## Acceptance

Completion requires exact accepted LIVE-370 and LIVE-380 product/review bindings; complete same-control-flow, own-fresh-
receipt, exact-order, terminal-failure, no-retry, no-fallback, private-custody, and stop-before-lookup semantics; strict
singleton provenance; hostile and ambient zero-execution tests; no store/source/native/runtime consumer; every actual
total zero; every grant false; full producer verification; and a different independent report-only zero-repair review.

Acceptance permits ordinary integration of the inert contract only. It grants no executable composition,
authorization spend/recheck, source lookup/invocation, protected native read, observation, attestation, candidate, owner
authorization, physical qualification, runtime activation, provider, production database, deployment, or production
authority.

## Reevaluate

Reevaluate before importing or instantiating the authorization store; adding the private executable composition;
calling spend or recheck; importing, retrieving, or looking up the private source; invoking it; reading protected native
material; creating an observation, attestation, checkpoint, candidate, or owner window; performing a physical attempt;
wiring runtime use; contacting a provider or production database; or deploying.
