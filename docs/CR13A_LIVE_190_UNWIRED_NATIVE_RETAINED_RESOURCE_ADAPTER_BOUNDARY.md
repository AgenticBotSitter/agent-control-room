# CR13A-LIVE-190 unwired native retained-resource adapter boundary

**Status:** effect-free architecture frozen; implementation pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked base:** LIVE-180 branch at `5225f0a57ee661d4a865a5ea91148afc6ede4273`
**Accepted LIVE-180 product:** `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0`
**Accepted LIVE-180 review SHA-256:**
`05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76`

## Decision

LIVE-190 defines the physical driver's future same-server adapter without creating or receiving a real server. The
adapter is module-private, non-serializable, exact-identity-bound, single-use, and owns one state transition from
custody-provider retention to driver acceptance. It does not accept a numeric port and cannot bind a replacement.

The implementation has two deliberately separate layers:

1. An effect-free public description and safe status projection freeze the native adapter requirements and retain all
   blockers.
2. A repository-only fake proves the adapter's private acceptance, settlement, cleanup, and recovery ordering. The fake
   resource never crosses the module boundary and never becomes a production-shaped capability.

The future native issuer belongs in this same isolated module so private provenance cannot be reconstructed by a
caller. It must privately hold an already-listening server, exact LIVE-180 acceptance, candidate/attempt/epoch bindings,
fresh owner authorization, custody evidence, locator capability spend, target-runtime attestation, tunnel-peer and host-
key proof, deadlines, and durable pre-effect/spend/checkpoint state. That issuer does not exist in LIVE-190.

## Required adapter rules

- Accept the exact retained server object once; never accept an address, port number, file descriptor, digest, copied
  wrapper, or caller-built handle as a substitute.
- Require private identity membership and exact object equality before the acceptance boundary.
- Atomically spend the handoff and change ownership only when the driver has accepted the same object.
- Serialize concurrent prepare, accept, close, and recover calls behind one operation each.
- Distinguish definite rejection before acceptance from ambiguity after the acceptance marker.
- On failure or uncertainty, close the accepted resource exactly once and require independent zero-resource evidence
  before claiming terminal cleanup.
- Never retry, rebind, reopen, duplicate, detach, serialize, log, return, or publish the resource.
- Expose only fixed safe state, counts, implementation identity, accepted predecessor bindings, blockers, and false
  authority/effect truth.

## Allowed repository scope

- One immutable adapter implementation description bound to accepted LIVE-180 evidence.
- One exact repository-fake factory using module-private fake-resource provenance.
- A frozen fake adapter surface with prepare, accept, status, close, and recover operations.
- Exact implementation/status parsers and same-adapter status assertion.
- Fixed success, pre-accept rejection, post-accept ambiguity, and cleanup-failure scenarios.
- Hostile tests for private identity, copies, accessors, symbols, Proxies, receivers, construction, callable mutation,
  ambient replacement, promise serialization, one spend, cleanup, privacy, non-wiring, and zero effects.
- A type-only reference to the existing allowlisted `node:net` server type inside the isolated adapter module. It must
  produce no runtime import or initialization.
- Acceptance and different independent zero-repair review records.

## Forbidden scope

LIVE-190 must not export or create a native-resource issuer, accept a real server, create/bind/listen/inspect/close a
real resource, select or expose an address/port, use the existing numeric-port bind capability, install a listener or
socket handler, create a timer, issue or spend a real capability, write a live ledger/checkpoint, import or call the
physical driver's effectful backend, wire any application/API/UI/worker/Idea Lab/Hermes/startup/runtime consumer,
assemble a qualification candidate, perform a physical attempt, contact a provider, or deploy.

Repository-fake success does not set `realNativeRetainedResourceAdapterImplemented`,
`nativeRetainedResourceIssuerPresent`, `driverAcceptedRealRetainedResource`, `exclusivePortCustodyProvided`,
`driverReservationHandoffGapCleared`, `activationEligible`, or any authority grant. All actual host, port, resource,
handoff, driver, native, listener, socket, timer, network, protected-read, and external-effect counts remain zero.

## Acceptance

Acceptance requires immutable product identity, exact predecessor/review binding, stage zero, TypeScript, lint,
dedicated and aggregate CR13A tests, the complete lifecycle, production build/render, migration verification,
whitespace validation, and a different independent report-only review with no High, Medium, or Low finding. Acceptance
permits ordinary integration only. A later separately authorized block must implement the private real-resource issuer,
compose it with the physical driver, and still obtain fresh owner-attended authority before one physical attempt.

