# CR13A-LIVE-240 unreachable native issuer composition implementation

**Status:** exact product `71e4c737b6e681fe24d730decc3497d196cf441c` independently accepted for ordinary integration
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Accepted LIVE-230 product:** `3974f165f106cb0fe616b2f0e91a18e45b1b4c2d`
**Accepted LIVE-230 review SHA-256:**
`eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a`

## Decision

LIVE-240 implements the accepted LIVE-230 order as an unreachable, repository-owned composition state machine. Its
private construction path receives only exact module-created inert ports. Those ports record simulated durable markers
and operate on one opaque fake resource. No caller may provide a port, resource, locator, callback, clock, signer,
persistence object, factory, adapter, or authority value.

The implementation is executable only through fixed scenario constructors that install sealed repository fakes. It
does not import LIVE-220, LIVE-190, `node:net`, persistence, timers, process state, or another effect module. Its safe
barrel export exposes the implementation identity, parsers, fixed scenarios, a fake-only constructor, and sanitized
status. No native object, locator, port, capability, or effect-bearing dependency can cross that surface.

## Fixed scenarios

The implementation must cover exactly:

1. `transferred_then_closed` — every marker is ordered, one opaque resource is retained, the exact same object is
   accepted once, ownership transfers atomically, the adapter closes it once, and independent absence is recorded.
2. `rejected_before_effect_marker` — durable claim rejects before uncertainty; no factory or resource action occurs.
3. `ambiguous_after_effect_marker` — factory settlement becomes ambiguous; issuer custody remains unresolved and no
   second factory retrieval, create, listen, locator, adapter, or close operation occurs.
4. `adapter_rejected_issuer_closes` — the adapter rejects before acceptance, issuer custody remains continuous, and the
   issuer closes the exact resource once before absence proof.
5. `adapter_acceptance_uncertain` — adapter acceptance is uncertain, owner is not guessed, and cleanup stays blocked.
6. `cleanup_failed_then_observed_absent` — the current owner makes one close attempt, records cleanup failure, then an
   independent no-reopen observation records absence and terminal cleanup truth.

## Required ordering and custody

One serialized `run()` promise performs the accepted order once. Exact contract bindings and expiry are checked before
the durable attempt claim. Locator authority, custody authority, and effect uncertainty are durably marked in that
order before the inert factory is retrieved. The factory may be retrieved once and creates one opaque resource. The
private locator observation may occur once only after inert listener settlement.

Issuer custody begins at resource creation and remains continuous through listener settlement, locator observation,
and the adapter offer. Only exact-object adapter acceptance may atomically transfer custody. Rejection preserves issuer
custody. Uncertain acceptance records owner `unresolved` and forbids close. Cleanup is performed once by the known
current owner. Terminal success requires durable cleanup outcome, independent zero-resource observation, tombstone,
and external high-water checkpoint.

Every state transition and simulated durable marker is append-only in private memory. Repeated or concurrent `run()`
calls return the same promise and cannot repeat a port operation. Failure, ambiguity, cancellation, timeout, restart,
cleanup failure, or recovery cannot create a second attempt, resource, listener, locator observation, adapter call,
transfer, close, or reopen.

## Public evidence

Status may expose only fixed scenario and state codes; bounded call and transition counts; simulated marker, custody,
transfer, cleanup, absence, tombstone, and checkpoint booleans; fixed safe error codes; product/review digests; and exact
zero real-effect/false-authority truth. It must not expose or derive any host, address, port, interface, server, socket,
listener, resource, descriptor, handle, locator, capability, native error, callback, protected value, identity material,
credential, filesystem path, prompt, command, or provider content.

## Forbidden scope

LIVE-240 must not import, retrieve, invoke, or modify LIVE-220; import `node:net` or any native/effect module; import or
call LIVE-190; use a real server, listener, socket, locator, port, persistence client, timer, signer, adapter, driver,
provider, credential store, SSH connection, or protected value; expose its private ports or fake resource; accept caller
dependencies; wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear a live blocker; make a
physical attempt; contact an external system; deploy; or grant approval or production authority.

## Acceptance

Acceptance requires exact LIVE-230 product/review binding; all six scenarios; exact durable order and one-use ceilings;
serialized promise identity; opaque same-object custody; correct rejection, ambiguity, uncertain-owner, cleanup-failure,
and absence behavior; exact repository provenance; frozen surfaces; hostile input, receiver, accessor, Proxy, callback,
and ambient-replacement non-execution; no native/effect/LIVE-220/LIVE-190 import or runtime consumer; safe public
privacy; exact zero real-effect and false-authority totals; the full producer gate; and a different independent
report-only zero-repair review with no High, Medium, or Low finding.

Acceptance permits ordinary integration of this exact unreachable fake-tested composition only. Connecting the real
factory, adapter, persistence, locator, runtime, qualification path, or production environment requires another
separately frozen and reviewed block and fresh exact authority for any physical attempt.

Accepted product `71e4c737b6e681fe24d730decc3497d196cf441c` passed the complete producer gate. A seventh
different report-only reviewer closed M-001 through M-006 and the companion constructor surface with 0 High, 0 Medium,
and 0 Low findings. Preserve `docs/reviews/CR13A_LIVE_240_INDEPENDENT_SIXTH_REREVIEW.md`; SHA-256
`1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8`.
