# CR13A-LIVE-230 private native issuer composition contract

**Status:** exact repository-only product independently accepted; ordinary integration ready
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked LIVE-220 base:** `26d43bdf098e67163cc8d0b419ebc3ea8c2b7227`
**Accepted LIVE-220 product:** `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9`
**Accepted LIVE-220 review SHA-256:**
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`

## Decision

LIVE-230 freezes an inert, exact composition contract for the future module-private path from accepted durable
preconditions to the accepted LIVE-220 quarantined native factory and then to the accepted LIVE-190 same-server adapter.
It may express required bindings, order, ceilings, failure classes, custody transitions, cleanup obligations, and safe
evidence as immutable repository data. It may not import, retrieve, expose, or invoke the native factory.

The future composition must be closed over exact repository-owned values. A caller cannot supply a factory, server,
adapter, native function, address, port, locator, callback, event, error, persistence writer, clock, signer, authority
record, or structural lookalike. All private resources and capabilities remain non-serializable and module-private.

## Required exact bindings

Before a future invocation, one private composition must bind the exact:

1. tenant, workspace, project, node, connection, and route identity;
2. qualification candidate, attempt, epoch, owner window, and expiry;
3. accepted target-runtime, tunnel-peer, host-key-custody, and connection-enrollment evidence;
4. accepted LIVE-200 issuer contract, LIVE-210 state machine, LIVE-220 factory, and LIVE-190 adapter identities;
5. private locator policy and exclusive-custody policy;
6. durable attempt claim, locator spend, custody spend, uncertainty marker, settlement marker, adapter-acceptance marker,
   ownership-transfer marker, cleanup marker, tombstone, and external high-water checkpoint; and
7. one repository-owned monotonic clock, signer boundary, persistence boundary, and independent zero-resource observer.

## Required order and ceilings

The future path must verify every binding and expiry, durably claim the exact attempt, spend locator and custody
authority, and durably mark effect uncertainty before retrieving or invoking the factory. It may retrieve one factory,
construct one server, make one listen attempt, observe one private locator, make one adapter acceptance, transfer the
same server once, and close once. No second operation is permitted after success, definite failure, ambiguity, cleanup
failure, restart, cancellation, timeout, or ownership transfer.

The issuer retains custody from server construction until the exact adapter atomically accepts that same object. Adapter
rejection or uncertainty leaves custody with the issuer. The adapter owns cleanup only after an exact accepted transfer.
All earlier failure paths remain issuer-owned. A terminal success requires a durable close outcome plus independent
zero-resource evidence; cleanup failure remains blocked until one no-reopen observation proves absence.

## Failure truth

- Rejection before durable effect marking is definite and consumes no native attempt.
- Any throw, rejection, native event, disconnect, cancellation, timeout, or restart after the effect marker is
  ambiguous until cleanup and independent absence evidence complete.
- Adapter rejection before exact acceptance preserves issuer custody and requires issuer cleanup.
- Uncertain adapter acceptance forbids a guessed owner; cleanup remains serialized behind durable reconciliation.
- Cleanup failure is terminally blocked. Recovery may only observe and close the same retained object; it cannot create,
  listen, bind, select, reserve, reconnect, retry, substitute, or reopen.

## Safe evidence

Public evidence may contain only fixed schema identifiers, digests, sequence numbers, bounded counts, fixed outcome
codes, booleans, and review references. It must never contain a host, address, port, interface, socket, server, listener,
resource, descriptor, handle, callback, locator, capability, protected value, identity material, credential, native
error, path, command, prompt, or provider content.

Repository status must state that factory retrieval/invocation, native construction, listener/close attempts, locator
observation, resource retention, capability issue/spend, adapter/driver calls, persistence writes, protected reads,
runtime wiring, blocker clearance, candidate/activation eligibility, external effects, and authority grants are zero or
false.

## Forbidden scope

LIVE-230 must not import `node:net` or any runtime native/effect module; import or consume LIVE-220; retrieve its private
factory; create, listen on, inspect, transfer, or close a server; observe, select, reserve, consume, or expose a locator;
issue or spend live authority; write live persistence; call LIVE-190 or the physical driver; install handlers or timers;
wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear a blocker; assemble a candidate;
contact a provider; deploy; or make a physical attempt.

## Acceptance

Acceptance requires exact LIVE-220 product/review binding; complete fixed binding, marker, order, failure, custody,
cleanup, and evidence sets; one-use ceilings; exact repository provenance; hostile input/callback/accessor/Proxy and
ambient replacement non-execution; frozen safe public truth; no native/effect import or runtime consumer; exact zero
effect and false-authority totals; the full producer gate; and a different independent report-only zero-repair review
with no High, Medium, or Low finding.

Acceptance permits an inert composition contract only. Retrieving or invoking the factory, creating a native resource,
observing a locator, issuing/spending live authority, wiring the runtime, or attempting physical qualification requires a
later separately frozen and reviewed block plus fresh exact owner-attended authorization.
