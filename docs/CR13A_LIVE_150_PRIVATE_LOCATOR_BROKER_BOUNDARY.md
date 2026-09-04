# CR13A-LIVE-150 private locator broker boundary

**Status:** architecture contract frozen for effect-free implementation
**Stacked base:** CR13A-LIVE-140 branch head `e8d498cb6ad3eb54720b400f662a43ce85d7a560`
**Accepted LIVE-140 product:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Accepted LIVE-140 review SHA-256:** `483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** repository contracts, deterministic tests, static inspection, and repository fakes only; no address
or interface observation, DNS resolution, port selection/reservation, capability issuance/spend, timer/clock, native
driver construction, listener/socket operation, SSH, credential access, Hermes/provider contact, production contact,
deployment, DNS change, or hosting effect

## Purpose

LIVE-130 lists `private_locator_broker_missing` and `exclusive_port_custody_missing` as separate physical-qualification
blockers. LIVE-150 defines the first boundary: how a future private broker may hold a loopback locator behind an opaque
one-use capability without publishing, serializing, or caller-selecting its address or port.

This block does not create a broker, choose an address, select or reserve a port, issue a capability, clear either
blocker, or make a locator available to the physical driver.

## Non-collapsible stages

The locator path remains split into:

1. frozen locator policy and explicitly non-production repository fake;
2. separately accepted target-runtime attestation;
3. private platform locator observation and selection;
4. exclusive operating-system port reservation and custody;
5. private one-use capability issuance bound to one candidate and attempt;
6. durable issuance and spend recording plus independent high-water custody;
7. one atomic capability spend into the separately accepted physical driver;
8. independent resource observation and terminal cleanup; and
9. later qualification-candidate assembly.

LIVE-150 implements only stage 1. No repository test, serialized object, digest, or caller assertion can manufacture
stages 2 through 9.

## Frozen intended policy

The repository contract describes policy without claiming observation:

- locator class: private IPv4 loopback;
- transport class: private TCP qualification listener;
- publication mode: never public, logged, persisted in public evidence, or returned to UI/API/worker callers;
- capability scope: one target attestation, candidate, attempt, broker epoch, reservation, and spend;
- maximum future capability lifetime: 30 seconds;
- spend ceiling: exactly one;
- automatic retry: forbidden; and
- cleanup: reservation/capability terminally consumed or tombstoned on success, failure, timeout, or uncertainty.

The policy does not contain a literal address or port. Even the conventional loopback literal is private operational
material in this boundary because coupling it to the unpublished port would reveal the live locator.

## Required future private bindings

A real broker capability must privately bind all of these before it can exist:

- accepted target-runtime attestation reference;
- broker boot/process/session epoch;
- exact broker implementation and policy identity;
- exact qualification-candidate and attempt identity;
- privately observed literal IPv4 loopback address;
- privately selected port and operating-system reservation handle;
- exclusive reservation proof and independent resource observation reference;
- fresh one-use nonce;
- trusted issue and expiry times;
- durable issuance marker and independent high-water checkpoint; and
- one-use capability identity and terminal spend/tombstone identity.

Raw bindings stay inside the future broker, ledger, observer, and driver handoff boundary. Public evidence may reveal
only fixed schema enums, booleans, zero counts, blocker codes, public repository digests, and a fresh non-correlatable
acceptance reference created later inside an accepted signer/verifier boundary.

## Repository fake

The implementation exports exactly one frozen policy singleton and one exact `repository_fake` result. The fake:

- records only the intended policy and required future private binding names;
- fixes broker, target-attestation input, locator observation, address selection, port selection, exclusive reservation,
  capability issuance/spend, ledger/checkpoint, driver handoff, cleanup evidence, and blocker clearance false;
- retains both `private_locator_broker_missing` and `exclusive_port_custody_missing`;
- fixes observation, selection, reservation, capability, native, listener, IPC-listener, socket, timer, network,
  protected-value, and external-effect counts to zero;
- grants no approval, qualification, candidate, activation, network, command, lease, or execution authority; and
- cannot be copied, rebuilt, re-digested, relabeled, or accepted as a real broker or capability.

## Provenance, input, and sanitation boundary

Policy and fake records use module-private exact provenance and private digest custody. Parsers accept only the exact
frozen singleton objects. Serialization, spread, public digest equality, alternate prototypes, accessors, symbols,
Proxies, thenables, decorated callables, subclasses, malicious new targets, ambient intrinsic replacement, or borrowed
receivers cannot substitute values or execute hostile behavior.

The module accepts no caller data, address, port, locator, capability, target/candidate/attempt reference, provider,
callback, clock, timer, random source, signer, ledger, reservation handle, socket, driver, command, or executable input.
Errors expose only `invalid_contract`, `invalid_result`, and `integrity_failed` with no raw message or stack.

Public records and errors must contain no literal address, port, interface, endpoint, URL, hostname, DNS name, socket,
reservation handle, capability identifier, hardware/user/process/path value, credential, key, owner identity, native
error, provider output, or reversible/guessable transform of private material.

## Runtime and import boundary

The LIVE-150 module:

- imports no `node:net`, `node:os`, process, filesystem, child process, DNS, HTTP, crypto signer, SSH, credential,
  Keychain, database, timer, provider, native-driver, resource-observer, or deployment module;
- performs no platform, address, interface, port, process, environment, path, clock, random, or resource read;
- is exported only from the safe connection-registry barrel for status projection; and
- has no application route, UI action, API, worker, scheduler, startup hook, service, Idea Lab, Hermes, physical-driver,
  or deployment consumer.

## Future real broker

A later real broker must receive only independently accepted opaque inputs, keep locator material private, use a
separately accepted operating-system reservation port and durable ledger, and issue one module-private capability whose
spend atomically transfers custody to the exact candidate/attempt driver. A public hash or UUID is not a capability.

Selection must fail closed on non-loopback/non-IPv4 input, unavailable or reused port, missing exclusive reservation,
target/candidate/attempt mismatch, stale epoch/time, nonce reuse, ledger/checkpoint disagreement, capability copy,
second spend, unknown field, cleanup ambiguity, or retained resource. Uncertainty terminally spends/tombstones the
attempt and never authorizes retry.

A future accepted private locator may clear only `private_locator_broker_missing`. Exclusive port custody remains a
separate acceptance even when the broker interface expects it. Neither fact grants listener, admission, SSH, owner,
qualification, activation, command, or general network authority.

## Acceptance

Completion requires the exact frozen policy/fake, strict parsers, deterministic hostile tests, relevant and full
producer verification, build/render/migrations/whitespace, one immutable review packet, and a different zero-repair
reviewer with 0 High/Medium/Low findings and every forbidden-effect count zero.

Acceptance permits ordinary owner-controlled integration only. It does not create a real broker, locator, port
reservation, capability, candidate, physical attempt, or runtime activation.

## Reevaluate

Reevaluate before adding a platform/address observer, interface enumeration, DNS resolution, port selection or
reservation, clock, nonce, signer, ledger/checkpoint, capability issuer or spender, resource observer, candidate,
owner window, native-driver import, listener/socket action, SSH/credential operation, provider/production contact, or
deployment.
