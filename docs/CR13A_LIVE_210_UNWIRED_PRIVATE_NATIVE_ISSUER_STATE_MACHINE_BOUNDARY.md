# CR13A-LIVE-210 unwired private native issuer state-machine boundary

**Status:** effect-free architecture frozen; implementation pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Stacked LIVE-200 base:** `2fc3e631a0ff77906e2bc5b34c8830717030cf02`
**Accepted LIVE-200 product:** `9e3cb2afdcd3008dcdac94d113db991f34e49175`
**Accepted LIVE-200 review SHA-256:**
`82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185`

## Decision

LIVE-210 implements the repository-only state machine behind the accepted LIVE-200 issuer contract. It uses one
module-private inert fake-resource identity to prove ordering, continuous simulated custody, one simulated transfer into
one fake adapter, mandatory cleanup, and stable no-reopen recovery. It imports no network module and never creates,
receives, inspects, transfers, or closes a real native object.

Five fixed scenarios cover the entire outcome space:

1. `retained_transferred_then_closed` — one claim and effect marker lead to one retained fake, one exact fake-adapter
   acceptance, atomic simulated ownership transfer, and verified simulated closure.
2. `rejected_before_effect` — claim fails definitely before an effect marker; no fake resource or cleanup is claimed.
3. `ambiguous_after_effect_marker` — settlement is uncertain after the marker; cleanup becomes mandatory and terminal.
4. `adapter_rejected_after_retention` — the retained fake never changes owner; issuer custody continues through cleanup.
5. `cleanup_failed_then_recovered` — cleanup failure remains terminal until one independent simulated zero-resource
   verification, without reopening, retrying, or transferring.

## State and operation policy

The fixed public state set is `created`, `claimed`, `effect_marked`, `retained`, `transferred`, `failed_before_effect`,
`ambiguous_after_effect`, `cleanup_failed`, and `closed_verified`. The frozen fake surface exposes only `claim`,
`markEffect`, `settleRetention`, `transfer`, `close`, `recover`, and `status`.

- Each operation is legal in only its documented predecessor state.
- Concurrent or repeated calls to the same operation return the original operation promise.
- A later operation waits for its required predecessor settlement and cannot overtake it.
- The simulated attempt, locator spend, custody spend, fake-resource creation, adapter acceptance, ownership transfer,
  close, recovery, and transition counters never exceed one.
- Exact private WeakSet/WeakMap identity binds fake resource, issuer, adapter, and status provenance.
- No method accepts caller resource, port, locator, descriptor, handle, callback, capability, clock, or effect client.
- Copies, structural lookalikes, foreign status, borrowed receivers, accessors, symbols, and Proxies fail before behavior.
- Errors expose only frozen safe codes and no native or caller text.

## Safe public truth

Status may expose only fixed scenario/state/outcome labels, counts, accepted predecessor identities, repository-fake
truth, simulated booleans, retained blockers, and false authority/effect values. It must not expose the fake identity or
anything from which a real locator or native resource could later be reconstructed. Simulated success cannot set real
issuer implementation, real resource creation/retention, real adapter acceptance, exclusive custody, blocker clearance,
candidate eligibility, activation eligibility, runtime wiring, external effect, or authority.

## Forbidden scope

LIVE-210 must not import a runtime network, process, filesystem, child-process, or persistence client; create, receive,
bind, listen on, inspect, transfer, or close a real server; select or expose an address or port; call LIVE-190, the
physical driver, or a real adapter; issue or spend live capability; write a ledger/checkpoint; use a clock or timer; read
protected values; wire any application, API, worker, Idea Lab, Hermes, startup, or production consumer; assemble a live
candidate; make a physical attempt; contact a provider; or deploy.

## Acceptance

Acceptance requires exact LIVE-200 product/review binding, all five scenarios and nine states, serialized promise
identity and operation order, exact private provenance, one-use counters, failure/ambiguity separation, mandatory
cleanup, no-reopen recovery, safe public truth, hostile non-execution, no network/native/persistence import or runtime
consumer, exact zero real-effect and false-authority totals, the complete producer gate, and a different independent
report-only zero-repair review with no High, Medium, or Low finding.

Acceptance permits ordinary integration only. A later separately authorized block must implement the real issuer and
still obtain fresh owner-attended authority before one physical attempt.
