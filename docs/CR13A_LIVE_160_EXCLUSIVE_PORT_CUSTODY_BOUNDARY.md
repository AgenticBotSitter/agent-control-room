# CR13A-LIVE-160 exclusive port custody boundary

**Status:** architecture contract frozen for effect-free implementation
**Stacked base:** CR13A-LIVE-150 branch head `5ff568ba49a831816102f8baec9bac78b7510f5b`
**Accepted LIVE-150 product:** `f089f896073fcc5aab24616a17fac592eba5146b`
**Accepted LIVE-150 review SHA-256:** `e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Effect boundary:** repository contract, deterministic tests, static inspection, and repository fake only; no address,
interface, DNS, port, socket, listener, timer, reservation, handle, capability, native-driver, provider, credential,
network, production, or deployment effect

## Purpose

LIVE-150 defines an opaque future locator capability but deliberately leaves `exclusive_port_custody_missing` true.
LIVE-160 defines what exclusive custody must prove and records an important compatibility fact: the accepted LIVE-120
physical driver currently receives a private numeric port and creates its own server later. A broker that briefly binds,
closes, and hands over only that number creates a time-of-check/time-of-use race and is not exclusive custody.

This block does not reserve a port or repair the driver. It prevents future work from mislabeling “port was available”
or “a prior probe bound successfully” as continuous exclusive ownership.

## Non-collapsible stages

1. frozen custody policy and `repository_fake` result;
2. accepted target-runtime attestation and private locator broker;
3. one operating-system-selected loopback listener/reservation resource;
4. continuous custody of that exact live native resource;
5. durable pre-effect marker and independent high-water checkpoint;
6. exact candidate/attempt-bound opaque handoff capability;
7. atomic one-use transfer of the same retained resource into a compatible driver;
8. independent resource observation during ownership transfer;
9. terminal close, zero-resource observation, and tombstone; and
10. later qualification-candidate assembly.

LIVE-160 implements only stage 1. A numeric port, bind-success boolean, timestamp, digest, closed prior socket, or
repository fake cannot manufacture stages 2 through 10.

## Frozen custody policy

- resource class: `retained_ipv4_loopback_tcp_listener`;
- exclusivity basis: the exact operating-system native resource remains open and solely held;
- selection mode: operating-system selection within the private range, never caller selection;
- ownership scope: one target attestation, locator broker, candidate, attempt, broker epoch, reservation, and handoff;
- maximum future pre-handoff custody lifetime: 30 seconds;
- maximum handoffs: one;
- retry/rebind/reopen: forbidden;
- transfer rule: the exact retained native resource, not an address/port copy, crosses the private handoff; and
- terminal rule: any failure or uncertainty after reservation creation requires close, zero-resource observation,
  durable tombstone, and no retry.

No public record contains a literal port, address, resource handle, socket/server identity, file descriptor, or stable
transform of any of them.

## Required future private proofs

A real custody result must privately bind:

- accepted target-runtime attestation and private-locator-broker references;
- exact custody provider implementation and broker boot/process/session epoch;
- candidate and attempt identities;
- literal private IPv4 loopback address and operating-system-selected private port;
- exact retained native listener/reservation handle and resource identity;
- exclusive bind observation and absence of shared/reuse configuration;
- durable pre-effect reservation marker and independent high-water checkpoint;
- trusted observed/expiry time and one-use nonce;
- exact one-use handoff capability and compatible driver identity;
- independent native-resource observations before, during, and after handoff; and
- terminal close evidence plus spend/tombstone identity.

All raw values remain inside the provider/ledger/observer/driver boundary.

## Accepted driver compatibility gap

The accepted LIVE-120 physical driver internally validates a capability containing `port: number`, then calls
`createServer()` and `listen({ host, port, exclusive: true })`. It has no accepted port that consumes an already-bound
server/listener handle. Therefore:

- the driver is not yet compatible with continuous broker-to-driver reservation transfer;
- `acceptedPhysicalDriverSupportsReservationHandoff` is false;
- `driverReservationHandoffGapPresent` is true; and
- no future reservation evidence may clear `exclusive_port_custody_missing` for this driver until a separately
  designed, implemented, and reviewed handoff boundary closes the gap.

This is not a defect in the previously accepted unwired driver, whose boundary explicitly left broker composition for
later. It is a prerequisite discovered before live work.

## Repository fake

The implementation exports one frozen policy singleton and one exact `repository_fake` result. The fake records the
policy, required proof names, accepted predecessor identities, and compatibility gap. It fixes provider availability,
address/port observation, selection, bind, reservation, retained resource, capability, handoff, ledger/checkpoint,
resource observation, close evidence, blocker clearance, and activation false. Every native/listener/IPC/socket/timer/
port/network/protected/effect count is zero and every authority grant is false.

It retains `exclusive_port_custody_missing`. It cannot be copied, caller-built, re-digested, relabeled, or accepted as
real custody or a handoff capability.

## Provenance, sanitation, and runtime boundary

Records use module-private exact provenance and private digest custody. Parsers reject copies, alternate prototypes,
accessors, symbols, Proxies, thenables, decorated callables, borrowed receivers, subclasses, malicious new targets,
and ambient intrinsic replacement without executing hostile behavior.

The module accepts no caller input or behavioral dependency; imports no `node:net`, OS/process/filesystem/DNS/timer,
native driver, provider, ledger, credential, database, HTTP, SSH, or deployment code; and performs no host, resource,
clock, random, locator, or network read. It may be exported only by the safe connection-registry barrel and has no
runtime consumer.

Errors are only `invalid_contract`, `invalid_result`, and `integrity_failed` with no stack or raw text. Public records
contain no literal locator/port, interface, socket/server/handle/file descriptor, process/path/user/host value,
credential, key, owner identity, native error, provider output, or guessable transform.

## Acceptance

Completion requires exact policy/fake/parsers, deterministic hostile and non-wiring tests, complete producer gates,
build/render/migrations/whitespace, an immutable review packet, and a different zero-repair reviewer with 0
High/Medium/Low and every forbidden-effect count zero.

Acceptance permits ordinary owner-controlled integration only. It does not close the blocker, repair the driver,
reserve a port, create/transfer a listener, issue a capability, assemble a candidate, or authorize a physical attempt.

## Reevaluate

Reevaluate before changing the physical driver, implementing a native custody provider, selecting/reserving a port,
creating/transferring a listener, issuing/spending a handoff capability, writing a ledger/checkpoint, observing native
resources, assembling a candidate, performing a physical attempt, or contacting credentials/providers/production.
