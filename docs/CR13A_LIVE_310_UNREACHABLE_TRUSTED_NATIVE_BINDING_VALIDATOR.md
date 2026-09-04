# CR13A-LIVE-310 unreachable trusted native-binding validator

**Status:** architecture frozen; source implementation may begin only after accepted LIVE-300 integration
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Authority:** repository-only unreachable source and ordinary integration

## Purpose

LIVE-300 rejects ambient and caller-controlled runtime evidence. LIVE-310 may add the minimum real private source
needed to enforce that rule: one no-input validator closed over one static `node:process` module namespace. It remains
outside the safe barrel, has no lookup or invocation path, and reads no process property while the module loads or in
tests.

## Fixed source boundary

The implementation may statically import the `node:process` namespace under a module-owned lexical binding. It may
capture trusted validation intrinsics and define one frozen no-input validator whose body, if separately authorized in
a future block, would inspect only the exact own descriptors for `version`, `execPath`, `pid`, and `ppid`.

The future validator must reject a missing property; an accessor; a callable or object value; a wrong primitive type;
an unexpected property shape; and any source other than the captured static namespace. It must return only a private
binding-validation result to a later same-module composition. It must not accept a process object, callback, proxy,
descriptor, property name, readiness flag, or other caller input.

LIVE-310 may create the validator and store it exactly once in a private WeakMap with no `get`, lookup, bridge, getter,
callback, token, capability, export, or consumer path. Public module evidence may state only fixed source presence and
zero validation/read/effect facts.

## Prohibited in LIVE-310

This block must not invoke the validator; inspect a descriptor; read `version`, `execPath`, `pid`, `ppid`, environment,
arguments, directory, user, host, network, credential, clock, or provider data; import or modify LIVE-290; combine with
the observer; return a binding or process value; create a raw observation or attestation; issue a nonce or replay
checkpoint; sign, hash, log, serialize, or persist process material; assemble a candidate; retrieve the native shell;
open a listener; wire application/startup use; clear a blocker; perform a physical attempt; contact Hermes/provider;
deploy; or touch production PostgreSQL/VPS state.

## Required evidence

Acceptance requires exact LIVE-300 product/review binding; exactly one static `node:process` namespace import; one
private frozen no-input validator stored once with zero lookup/invocation; property access and descriptor inspection
only inside its unreachable body; no ambient `globalThis.process`; no native value capture at initialization; no
production consumer; strict sanitized zero-use records; hostile ambient replacements executing zero behavior; all
validation/read/effect totals zero; all grants false; full producer verification; and a different independent
report-only zero-repair review.

Any validator retrieval or invocation, descriptor inspection, process read, observer composition, attestation, native
action, or external effect requires a later separately frozen block and fresh authority where repository policy
requires it.
