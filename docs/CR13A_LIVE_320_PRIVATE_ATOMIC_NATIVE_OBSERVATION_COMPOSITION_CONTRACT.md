# CR13A-LIVE-320 private atomic native-observation composition contract

**Status:** architecture frozen for effect-free repository contract implementation
**Stacked base:** accepted LIVE-310 corrected integration product `d95738bf79f9f12f6986f28b8f7548b661f0587a`
**Accepted LIVE-310 review SHA-256:**
`db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** inert contract, deterministic tests, and safe zero-use evidence only; no import, modification,
retrieval, invocation, descriptor inspection, process/host/path read, observer composition, attestation, persistence,
candidate, native listener, provider, network, runtime, deployment, DNS, hosting, or production effect

## Purpose

LIVE-290 proved that minimum native observation source can remain private and unreachable. LIVE-310 proved that a
statically selected process namespace can be validated without accepting ambient or caller-controlled bindings, but it
also remains private and unreachable in a separate module. Exporting either private callable so another module can join
them would destroy the boundary both blocks established.

LIVE-320 freezes the future same-module composition before any source is moved, retrieved, or run. Its key rule is
simple: validate and consume the native process descriptors synchronously inside one private no-input routine, then
build one private raw observation without an intervening callback, `await`, timer, caller input, second binding read, or
public capability.

## Fixed future composition

A later implementation must consolidate the accepted LIVE-290 observation operations and LIVE-310 binding-validation
rules into one dedicated private native module. It must not connect the current modules by exporting, importing,
looking up, or passing either quarantined callable.

That future module must:

1. statically select one `node:process` module namespace and the accepted minimum `node:os` operations at module load;
2. capture every validation and invocation intrinsic before any caller can replace ambient methods;
3. create one frozen, no-input, non-exported routine and store it once under module-private custody;
4. on a separately authorized future invocation, read exactly the four own descriptors for `version`, `execPath`,
   `pid`, and `ppid` from that captured namespace;
5. reject a missing descriptor, accessor, wrong writable/enumerable/configurable shape, wrong primitive type, non-finite
   or non-integer PID, empty runtime version, or empty executable path before observation can succeed;
6. consume the already validated descriptor values directly rather than reading the namespace properties a second
   time;
7. call only the statically selected `platform`, `arch`, `release`, and `uptime` operations, validate their returned
   types and bounds, and combine them with those descriptor values in the same synchronous call;
8. return at most one private frozen raw-observation record to later same-module custody; and
9. treat any thrown call, changed descriptor shape, invalid value, uncertainty, or partial observation as terminal for
   that one future entry, with no retry, replacement binding, fallback, or partial result.

There may be no caller-selected namespace, process object, OS object, property name, callback, readiness boolean,
descriptor, expected value, validator, observer, clock, nonce, signer, persistence port, or output collector. Module
source and a passing contract do not count as trusted binding capture, descriptor validation, observation, attestation,
qualification, or authority.

## Non-collapsible stages

The path remains split in this order:

1. accepted LIVE-290 observer source and review;
2. accepted LIVE-310 validator source and review;
3. LIVE-320 inert atomic-composition contract;
4. later same-module unreachable source consolidation;
5. separately authorized one-use retrieval and invocation boundary;
6. private raw observation;
7. trusted clock, nonce, candidate, and attempt binding;
8. platform signature;
9. durable replay checkpoint;
10. private physical candidate assembly;
11. fresh one-use owner authorization;
12. one owner-attended physical attempt;
13. sanitized result and independent absence evidence;
14. different independent review; and
15. separate runtime activation approval.

No stage implies, performs, or authorizes the next.

## LIVE-320 repository record

The implementation may export only one exact frozen contract, one exact frozen status, their strict parsers, fixed
safe error codes, and fixed arrays describing composition rules, stages, and blockers. Exact private provenance must
reject copies, re-digested substitutes, accessors, Proxies, alternate prototypes, inherited fields, Symbols, hostile
extras, and ambient method replacement without executing caller behavior.

Public status must report only accepted repository identities and fixed negative truth, including:

- `compositionContractImplemented: true` and `atomicCompositionImplemented: false`;
- both accepted sources remain isolated, stored, unreachable, and uninvoked;
- trusted binding, descriptor validation, raw observation, attestation, replay checkpoint, candidate, physical attempt,
  and runtime activation remain absent;
- every lookup, invocation, descriptor, process, OS, host, path, observation, signer, clock, nonce, persistence, native,
  listener, network, provider, protected-value, command, and external-effect count is zero; and
- approval, qualification, candidate, activation, network, command, lease, and execution grants are false.

Public material contains no runtime version, executable path, PID, OS release, uptime, host/user identity, locator,
interface, endpoint, credential, key, command, environment value, provider content, native diagnostic, stack, or
reversible transform of protected material.

## Prohibited in LIVE-320

LIVE-320 must not import or modify either native implementation; import `node:process`, `node:os`, or another native or
effect module; add a private-map lookup; implement or invoke the consolidated routine; inspect a descriptor; read a
process, OS, host, path, environment, clock, nonce, credential, locator, or provider value; create or expose a raw
observation; implement a signer, attestation, ledger, checkpoint, assembler, or owner window; retrieve the native shell;
open a listener; wire application, API, worker, scheduler, Idea Lab, Hermes, startup, or production use; clear a
blocker; perform a physical attempt; contact a provider; deploy; or touch production PostgreSQL/VPS state.

## Acceptance

Completion requires exact LIVE-290 and LIVE-310 product/review binding; complete atomic rules, stage order, blockers,
privacy and failure semantics; strict safe singleton provenance; hostile and ambient zero-execution tests; no native
import or runtime consumer; every actual total zero; every grant false; full producer verification; and a different
independent report-only zero-repair review.

Acceptance permits ordinary integration of the inert contract only. It grants no source consolidation, lookup,
invocation, descriptor/process/host read, raw observation, attestation, signer, nonce, replay checkpoint, candidate,
owner authorization, listener, physical qualification, runtime, provider, deployment, blocker clearance, or production
authority.

## Reevaluate

Reevaluate before modifying LIVE-290 or LIVE-310; creating a consolidated native module; importing either private
source; adding lookup or invocation; inspecting a descriptor or reading a native value; creating an observation,
attestation, replay checkpoint, candidate, or owner window; retrieving the native shell; making a physical attempt;
wiring runtime use; contacting a provider; or deploying.
