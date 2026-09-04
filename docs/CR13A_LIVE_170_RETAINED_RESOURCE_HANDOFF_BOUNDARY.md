# CR13A-LIVE-170 retained-resource handoff boundary

**Status:** effect-free architecture frozen; implementation verification pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked LIVE-160 base:** `ca36780704a9fe85c0e4c2fbca95cfc9e57e480e`
**Accepted LIVE-160 product:** `97d46c74e413d21c1f81c9704b9eb0b66447be5c`
**Accepted LIVE-160 review SHA-256:**
`0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6`

## Decision

The future custody provider must transfer the same retained operating-system listener resource directly into the
physical driver through a module-private, non-serializable, single-use handoff seam. Ownership changes atomically only
after the driver accepts that exact resource. The provider may not close before acceptance, and the driver may not bind
a replacement resource.

The handoff is scoped to one target, private locator, qualification candidate, attempt, custody-provider epoch,
reservation, handoff, and driver implementation. It permits at most one spend. Failure or uncertainty terminally closes
the retained resource, requires an independent zero-resource observation, and records a durable spend/close/tombstone
chain. Retry, rebind, reopen, duplication, locator exposure, and serialization are forbidden.

## Repository scope

LIVE-170 may add:

- one immutable public policy description with no locator or native-resource material;
- one provenance-protected repository fake that keeps the real handoff absent;
- strict exact-object parsers and safe fixed-code errors;
- hostile substitution, ambient-intrinsic, privacy, non-wiring, and zero-effect tests;
- documentation and an independent review packet.

LIVE-170 must not create, accept, inspect, bind, listen on, close, duplicate, or transfer a native resource. It must not
select or expose an address/port, import or construct a native backend, issue a handoff capability, call the physical
driver, wire a runtime consumer, clear a blocker, assemble a qualification candidate, or grant physical-attempt or
activation authority.

## Required private evidence for a future real implementation

1. Accepted exclusive-port custody contract reference.
2. Same retained-resource private identity before and after transfer.
3. Module-private handoff brand and issuer epoch.
4. Exact candidate, attempt, reservation, and handoff scope.
5. Unspent one-use handoff state.
6. Continuous-custody observation immediately before handoff.
7. Atomic driver acceptance and ownership transition.
8. Exact driver listener-configuration identity.
9. Post-handoff observation of the same resource.
10. Terminal close on failure or uncertainty.
11. Independent zero-resource observation after terminal close.
12. Durable spend, close, and tombstone chain.

The accepted LIVE-120 driver still owns resource creation and bind internally, so it cannot satisfy this boundary yet.
The repository result must retain `driverReservationHandoffGapPresent` and `exclusivePortCustodyMissing` until a later
separately reviewed native implementation supplies the real private seam.

## Acceptance

Acceptance requires the immutable implementation, stage zero, TypeScript, lint, focused and aggregate CR13A tests, the
complete registered lifecycle, production build/render checks, migration verification, whitespace validation, and a
different independent report-only review with no open High, Medium, or Low defect. Acceptance grants ordinary
owner-controlled integration only; it grants no live/native/runtime authority.
