# CR13A-LIVE-200 private native retained-resource issuer contract boundary

**Status:** effect-free architecture frozen; implementation pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked LIVE-190 base:** `4c8f8c6d8d10f3a87444389daa341e5f3c3aec25`
**Accepted LIVE-190 product:** `d59c02792e49a79a291e3f9109fc43f2fd22fbd8`
**Accepted LIVE-190 rereview SHA-256:**
`29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a`

## Decision

LIVE-200 freezes the private native retained-resource issuer contract before any issuer exists. The contract describes
the exact private bindings, one-use state, custody rules, failure classification, cleanup evidence, and durable ordering
that a future native issuer must satisfy when creating and retaining one IPv4 loopback TCP listener for the accepted
LIVE-190 adapter. The repository implementation remains a static fake-only description. It cannot create or receive a
server and it cannot issue a capability.

The future issuer and accepted adapter must share one private module and one unforgeable identity domain. The issuer
must retain the same server continuously from successful listen completion until exact adapter acceptance. Public and
cross-module code may receive only a safe digest-bound status record; it may never receive the resource, address, port,
descriptor, handle, locator, callback, or reconstructable capability.

## Required private bindings

- exact qualification candidate, physical-attempt, connection, tenant, node, route, and server epoch;
- exact fresh owner authorization and maximum deadline;
- accepted LIVE-130 prerequisite, LIVE-140 target-runtime, LIVE-150 private-locator, LIVE-160 exclusive-custody,
  LIVE-170 handoff, LIVE-180 driver-port, and LIVE-190 adapter evidence;
- exact target runtime, tunnel peer, verified host-key digest, fixed IPv4 loopback host policy, and private locator spend;
- durable pre-effect intent, one-use spend, listen-settlement marker, custody marker, handoff marker, close outcome,
  zero-resource observation, tombstone, and external checkpoint chain;
- separate definite failure before resource creation, uncertainty after an effect marker, cleanup failure, and
  independently verified recovery states.

## Required ordering

1. Verify all private bindings and fresh owner authority without touching a native resource.
2. Durably claim the exact attempt and locator/custody spends before the first effect.
3. Create at most one server and attempt at most one loopback listen; never retry, rebind, reopen, or substitute.
4. Record effect uncertainty before observing completion, then record the exact successful resource identity privately.
5. Retain continuous custody until the LIVE-190 adapter accepts that same object and atomically records ownership change.
6. On rejection or uncertainty, close exactly once and require independent zero-resource evidence before a terminal claim.
7. Preserve cleanup failure and ambiguity durably; recovery may only verify closure and may never reopen or retry.

## Allowed repository scope

- One frozen contract and one frozen safe repository-fake result.
- Exact private-proof, state, failure, and durable-marker sets.
- Exact-provenance parsers with canonical digest and safe-error behavior.
- Hostile tests for copies, mutation, accessors, symbols, Proxies, ambient intrinsic replacement, false positive claims,
  serialization, privacy, source imports, runtime consumers, and zero effects.
- Acceptance and different independent zero-repair review records.

## Forbidden scope

LIVE-200 must not import a runtime network module; create, receive, bind, listen on, inspect, transfer, or close a real
server; select, reserve, reveal, or consume a real address or port; issue or spend a live locator, custody, handoff, or
driver capability; write a live ledger; call the physical driver or LIVE-190 adapter; read a protected value; install a
listener, socket, or timer; wire an application, API, worker, Idea Lab, Hermes, startup, or production consumer; assemble
a live qualification candidate; perform a physical attempt; contact a provider; or deploy.

Repository-fake truth cannot set a real issuer, server, adapter, custody, handoff, driver acceptance, blocker clearance,
candidate eligibility, activation eligibility, or authority grant. Every actual host, port, native-resource, handoff,
driver, listener, socket, timer, network, protected-read, persistence, and external-effect count remains zero.

## Acceptance

Acceptance requires exact LIVE-190 product/review binding, frozen surfaces, strict parser and provenance behavior,
complete required sets and ordering, safe public truth, hostile non-execution, no runtime network import or consumer,
zero actual effects and authority, the full producer gate, and a different independent report-only zero-repair review
with no High, Medium, or Low finding.

Acceptance permits ordinary integration only. A later separately authorized block must implement the private issuer and
still pass a fresh owner-attended readiness packet before any physical attempt.
