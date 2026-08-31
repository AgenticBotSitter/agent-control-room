# CR11B-AUTO-080 Acceptance Record

Status: complete for exact independently accepted effect-free commit `091ff116c8735aa980608c9c5c0b468436537cae`

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

- focused AUTO-080 tests: 12/12 passing;
- combined CR11B tests: 149/149 passing;
- registered pretests: 731/731 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public post-tests: 52/52 passing;
- TypeScript check: passing;
- full lint: passing;
- production build and rendered-route checks: passing, 2/2 routes;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: passing.

## Independent review boundary

Producer tests did not accept this boundary. Four different independent reviewers examined successive exact candidates,
reran the focused and combined gates, attacked source substitution, re-signing, chronology, strict schema, projection,
accessor/Proxy, raw-key, keyed-context, and mutable-runtime seams, and confirmed the absence of a live-effect path. Three
immutable rejections remain part of the acceptance chain; only the exact third-remediation implementation is accepted.

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
independent reviewer was required to assess the exact remediation commit.

## First remediation re-review and second remediation

A different independent reviewer rejected exact first-remediation commit
`10eb807c8edd859261aa8dae09bcd5e116f42420`, tree
`a7b764ea434ff9fd93db5e16cc4d162da7bf1092`. The unchanged report is
`docs/reviews/CR11B_AUTO_080_FIRST_REMEDIATION_REREVIEW.md`, SHA-256
`bbe1a02b1f442c74f4f7e1e07ba038dcf620a2e3d43595c399a20f0427ec4421`.

Finding `AUTO080-RR1-001` proved that the shared HMAC helper still applied mutable `instanceof Uint8Array` and inherited
`key.byteLength` behavior to the private copied request key before cleanup. A post-load global constructor or inherited
getter replacement could execute caller behavior and retain a second key copy that cleanup could not reach.

The second remediation validates HMAC key byte length through captured host operations with no key property lookup,
removes typed-array `fill` from the shared full-buffer erasure helper, and verifies the global constructor, exact
prototype link, constructor prototype, inherited fill identity, and inherited byte-length getter before any AUTO-080
key copy. Hostile regressions cover correct and tampered requests, construction and parsing, global constructor
replacement, inherited byte-length replacement, post-load fill replacement, and a helper imported after fill
replacement. They require zero hostile key-surface calls, no retained key or receiver, complete backing-buffer erasure,
restored exact replay, sanitized projection, and unchanged negative authority.

This remains an in-process clean-start boundary: it trusts the runtime intrinsics present when the security modules
initialize. It does not claim that an already compromised process can prove native provenance after the fact. Another
different independent reviewer was required to assess the exact second-remediation commit.

## Second remediation re-review and third remediation

A third different independent reviewer rejected exact second-remediation commit
`b8287d75dca597196723e7705ba864ae153e48ac`, tree
`b4abfd8f941f9b6f1f62e66a99529d26b362a387`. The unchanged report is
`docs/reviews/CR11B_AUTO_080_SECOND_REMEDIATION_REREVIEW.md`, SHA-256
`c105ed8ef640ca4cd4aeb0c5f548d57e4ec5f9f3a9b3144c800dfb3f0c92f239`.

The reviewer closed the exact raw-key mechanisms in `AUTO080-IR-001` and `AUTO080-RR1-001`, but finding
`AUTO080-RR2-001` proved that ambient `.update()` or `.digest()` lookup on a newly keyed Node HMAC object could execute
caller behavior, retain the unfinalized keyed native context, and leave a one-use signing capability after the byte-array
key was erased.

The third remediation fully canonicalizes material before a keyed object exists; captures the clean-start HMAC prototype,
`update`, `digest`, descriptor reader, prototype reader, and invocation primitive; verifies both method identities before
keyed-object creation; and applies both captured methods directly without ambient property lookup. AUTO-080 includes the
HMAC runtime check before any private request-key copy. Hostile regressions replace update with an accessor and method and
replace digest with an accessor and method. Across correct and tampered requests, construction, parsing, direct shared
HMAC use, success, and failure, the replacements receive zero calls and retain no raw key or keyed capability; exact
replay, projection privacy, and all false authority fields are restored afterward. A fourth different independent
reviewer was required to assess the exact third-remediation commit.

## Third remediation acceptance

A fourth different independent reviewer accepted exact implementation
`091ff116c8735aa980608c9c5c0b468436537cae`, tree
`0153f5d2b794eaa05d30c88add8398d2c5ec2898`. The unchanged report is
`docs/reviews/CR11B_AUTO_080_THIRD_REMEDIATION_REREVIEW.md`, SHA-256
`10d7e0e32d59dadb5d435c8fda01e767e7234327105120fff95fec3fb034b118`.

The review closed `AUTO080-IR-001`, `AUTO080-RR1-001`, and `AUTO080-RR2-001`; independently passed 12/12 focused,
149/149 combined CR11B, 731/731 registered pretests, 414/416 core with two intentional skips, 52/52 public post-tests,
typecheck, lint, production build, 2/2 rendered routes, 27 migrations/97 tables, and macOS stage zero; and found no live
provider, network, process, database, credential, cleanup, dispatch, execution, or deployment path. AUTO-080 is complete
only for this exact effect-free request boundary.

## Negative authority

No provider was selected, no disposable or production resource was assigned, no owner signature or protected reference
was supplied, and no network, process, database, backup, restore, evidence-collection, cleanup, deployment, or external
effect occurred. The request is not a controlled-effect packet and cannot authorize its own completion.
