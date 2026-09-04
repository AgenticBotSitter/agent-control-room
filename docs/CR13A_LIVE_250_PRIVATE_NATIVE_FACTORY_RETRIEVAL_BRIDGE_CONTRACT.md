# CR13A-LIVE-250 private native-factory retrieval bridge contract

**Status:** exact product `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f` independently accepted for ordinary integration
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Accepted LIVE-220 product:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9`
**Accepted LIVE-220 review SHA-256:**
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`
**Accepted LIVE-240 product:** `71e4c737b6e681fe24d730decc3497d196cf441c`
**Accepted LIVE-240 review SHA-256:**
`1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8`

## Decision

LIVE-250 freezes an inert contract for one future same-source-module bridge between the quarantined LIVE-220 native
factory and the accepted LIVE-240 composition. This block does not implement that bridge. It publishes only immutable,
safe repository truth describing its prerequisites, order, one-use ceilings, privacy, failure classes, and blockers.

The future bridge must be a non-exported callable in the module that owns the existing private factory WeakMap. It may
look up the exact factory only for an exact repository-owned implementation identity and hand it directly into the
private composition closure. It cannot return the factory, store it in public state, serialize it, log it, digest it,
or pass it through a caller-controlled value. A public getter, exported capability, caller-supplied implementation,
composition, permit, or factory is forbidden.

## Required prerequisites

Before the future bridge's private consumption section, the composition must establish the exact accepted LIVE-220 and
LIVE-240 product and review identities; the exact module-owned implementation and composition identities; the exact
attempt, epoch, owner window, and unexpired state; the durable attempt claim; both durable authority spends; and the
durable effect-uncertainty marker. Structural lookalikes and caller assertions do not satisfy these prerequisites.

## Required order and one-use behavior

The future path must:

1. verify the two accepted product/review pairs;
2. verify the same-module implementation and composition identities;
3. verify the attempt, epoch, owner window, and expiry;
4. verify the durable claim and locator/custody spends;
5. verify the durable effect-uncertainty marker;
6. enter one synchronous, module-private consumption section;
7. consume the bridge once before factory lookup;
8. look up the exact factory once from the existing private WeakMap; and
9. hand it directly to the private composition without returning or serializing it.

Each bridge consumption, factory lookup, and private handoff has a ceiling of one. Failed prerequisites occur before
consumption and are definite. Once consumption begins, missing identity or factory state is terminal. Any uncertainty
after lookup is ambiguous and cannot be retried. A restart may reconcile durable state and retained-resource truth, but
may not retrieve the factory again.

## Safe evidence

Public evidence may contain only fixed schema identifiers, exact product/review digests, fixed policy names, bounded
counts, fixed status codes, booleans, and repository review references. It must never contain a factory, callable,
server, socket, listener, resource, handle, descriptor, callback, host, address, port, interface, locator, capability,
protected value, identity material, credential, native diagnostic, path, command, prompt, or provider content.

Repository status must truthfully report that bridge consumption, private lookup, private handoff, factory return,
serialization, logging, native construction, resource creation, listen, locator observation, close, persistence, timer,
network, and protected reads are zero. Runtime wiring, external effects, blocker clearance, candidate or activation
eligibility, and every authority grant remain false.

## Forbidden scope

LIVE-250 must not modify or import the LIVE-220 implementation or LIVE-240 composition; expose, retrieve, return,
invoke, copy, serialize, log, digest, or test the real factory; add a public getter or capability; accept caller-owned
implementation, composition, permit, factory, adapter, persistence, clock, or native input; import `node:net` or another
new native/effect module; create, listen on, inspect, transfer, or close a real server; observe or expose a locator;
issue or spend live authority; write live persistence; install handlers or timers; call LIVE-190 or a physical driver;
wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear a blocker; assemble a candidate;
contact a provider; deploy; or make a physical attempt.

## Acceptance

Acceptance requires exact LIVE-220 and LIVE-240 product/review binding; complete immutable prerequisite, order, failure,
privacy, and blocker sets; one-use ceilings; exact parser identity; hostile input/accessor/Proxy and ambient replacement
non-execution; no retrieval callable export; no native/effect import or runtime consumer; exact zero-effect and
false-authority truth; the full producer gate; and a different independent report-only zero-repair review with no High,
Medium, or Low finding.

Acceptance permits ordinary integration of an inert repository contract only. Implementing the private bridge, making
the factory reachable inside composition, retrieving or invoking it, creating a native resource, observing a locator,
wiring runtime use, or making a physical qualification attempt requires a later separately frozen and reviewed block.

The different report-only reviewer accepted the exact product with 0 High, 0 Medium, and 0 Low findings after all
twelve fixed commands passed. Preserve `docs/reviews/CR13A_LIVE_250_INDEPENDENT_REVIEW.md`; SHA-256
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`.
