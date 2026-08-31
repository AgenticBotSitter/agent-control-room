# CR11B-AUTO-080 Acceptance Record

Status: first candidate rejected; first remediation implemented; different independent re-review required

Date: 2026-08-30

## Candidate claim

The candidate provides a versioned, authenticated, effect-free request for a later disposable hosted PostgreSQL
qualification. It carries the complete accepted AUTO-070 plan/report chain, fixed operations, strict ceilings, mandatory
cleanup, sanitized evidence rules, and ten explicit blockers.

It provides no live runner and no authorization path. Provider selection, protected access, network, processes, database
contact, cleanup, live qualification, production activation, dispatch, execution, and external effects remain false.

## Implemented boundary

- exact accepted AUTO-070 implementation and independent-review identities;
- complete authenticated successful no-fault AUTO-070 plan/report re-verification;
- two-database, three-process, seven-operation disposable request;
- 40-provider-call, 1,800-second, and 1,048,576-byte requested ceilings;
- ten explicit owner/resource/custody/cleanup/review blockers;
- mandatory separate cleanup authority and cleanup receipt;
- no production data, public endpoint, raw evidence retention, or protected material;
- digest/HMAC-bound request with strict chronology and replay checks;
- bounded sanitized projection with every action disabled; and
- no provider, PostgreSQL, process, network, credential, protected-reference, consumer, scheduler, dispatch, execution, or
  deployment client.

## Candidate verification

- focused AUTO-080 tests: 10/10 passing;
- combined CR11B tests: 147/147 passing;
- registered pretests: 729/729 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public post-tests: 52/52 passing;
- TypeScript check: passing;
- full lint: passing;
- production build and rendered-route checks: passing, 2/2 routes;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: passing.

## Required independent review

Producer tests cannot accept this boundary. A different independent reviewer must examine the exact committed candidate,
rerun the focused and combined gates, attack source substitution, re-signing, chronology, strict schema, projection,
accessor/Proxy, and mutable-runtime seams, confirm that no live-effect path exists, and preserve a sanitized immutable
report. Any finding keeps AUTO-080 open.

## First review disposition and remediation

The first independent review rejected exact candidate commit `85199ab146c8362a216dc9b2cdd3285efc3008b7`, tree
`99bc9a386b234c7bb937a53d5074f2315d0b2b15`. The unchanged report is
`docs/reviews/CR11B_AUTO_080_INDEPENDENT_REVIEW.md`, SHA-256
`343da8c163bda9d437d3b850186a4a6b3623b9c255b9b9ab3eec5deaaf532f8c`.

Finding `AUTO080-IR-001` proved that both request-key cleanup paths used ambient
`Uint8Array.prototype.fill`. A post-load replacement could execute caller behavior, retain the private copied HMAC key,
and prevent erasure. The first remediation captures the exact typed-array fill identity, rejects drift before source or
request work, and erases private copies through the repository host-value boundary's captured native intrinsic. Its
hostile regression replaces the ambient method after module load, requires builder and parser to fail closed with zero
hostile calls and no retained receiver, directly proves the captured erasure primitive zeros a complete backing store,
restores the descriptor, and re-verifies exact request replay, safe projection, and negative authority. A different
independent reviewer must accept the exact remediation commit.

## Negative authority

No provider was selected, no disposable or production resource was assigned, no owner signature or protected reference
was supplied, and no network, process, database, backup, restore, evidence-collection, cleanup, deployment, or external
effect occurred. The request is not a controlled-effect packet and cannot authorize its own completion.
