# CR13A-LIVE-220 unwired native issuer implementation boundary

**Status:** isolated native-code architecture frozen; implementation pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked LIVE-210 base:** `02d4316947226d6a8988bd8e508410ba08dccda4`
**Accepted LIVE-210 product:** `c4cac41561214117161c9764604f5dc06ecd63b6`
**Accepted LIVE-210 review SHA-256:**
`c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7`

## Decision

LIVE-220 may add the first isolated native issuer implementation, but it remains unreachable and unexercised. One new
module may import the already allowlisted `node:net` runtime and capture only the exact primitives needed to create one
server, start one IPv4-loopback listen attempt, observe settlement, and close once. No application, API, worker, Idea
Lab, Hermes, startup, qualification, or production module may import it.

The public repository surface remains an inert implementation description and disabled status. The real issuer factory,
server identity, native methods, locator, and effect callbacks stay module-private. The exported creation path must fail
closed with `native_issuer_unavailable` before server creation unless a later separately reviewed private composition
provides every accepted LIVE-200 binding, LIVE-210 state-machine control, durable spends, and fresh owner authority.

## Native isolation rules

- Capture `createServer`, `Server.prototype.listen`, `Server.prototype.close`, `Server.prototype.once`, and required
  listener-removal methods at module initialization; never resolve them from caller objects or mutable ambient state.
- Permit only fixed IPv4 loopback host policy. Never accept a caller address, port, host, path, descriptor, socket,
  callback, server, options object, or structural capability.
- Create at most one server and make at most one listen attempt after durable private claim and effect marker.
- Treat any throw/rejection/event/timeout after the effect marker as ambiguous until close plus independent zero-resource
  evidence. Never retry, rebind, reopen, or substitute.
- Retain the exact server privately until the accepted LIVE-190 adapter has accepted that same object and ownership is
  atomically transferred through the LIVE-210 state machine.
- Serialize listen settlement, adapter transfer, close, and recovery; cleanup cannot overtake a pending native result.
- Discard and sanitize all native errors/events. Public status contains fixed codes and counts only.
- Do not install persistent process handlers, timers, socket handlers, or background services in this block.

## Repository verification

Tests must not call the native implementation. They may verify the disabled public path, frozen descriptions, exact
imports and consumers, captured primitive inventory, absence of caller-controlled native inputs, no runtime wiring, and
zero effect totals. Lifecycle behavior remains covered by the accepted LIVE-210 repository fake; LIVE-220 cannot invent
passing native evidence by injecting a lookalike server into the real boundary.

## Forbidden scope

LIVE-220 must not execute `createServer`, `listen`, `close`, or any native event registration; allocate, select, reserve,
inspect, or reveal a real address/port; instantiate or receive a real server; call the LIVE-190 adapter or physical
driver; write a live spend/checkpoint; install a listener/socket/timer/process handler; read protected values; wire a
runtime consumer; assemble a live candidate; make a physical attempt; contact a provider; deploy; or clear a blocker.

No test may monkey-patch the native module and call the implementation. No native smoke test, loopback probe, temporary
listener, or cleanup experiment is permitted under this block.

## Acceptance

Acceptance requires exact LIVE-210 product/review binding, one isolated allowlisted native importer, a disabled public
path, private captured primitive inventory, no caller native input, no consumer, no native invocation in tests, exact
zero actual effect and false-authority truth, safe errors, hostile non-execution, the full producer gate, and a different
independent report-only zero-repair review with no High, Medium, or Low finding.

Acceptance permits ordinary integration of unreachable code only. A later one-attempt physical qualification requires
a new exact packet, accepted signer/enrollment/preflight evidence, fresh owner-attended authorization, bounded cleanup,
and no retry.
