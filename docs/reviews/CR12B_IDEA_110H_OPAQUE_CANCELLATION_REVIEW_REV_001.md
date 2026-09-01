# CR12B-IDEA-110H opaque cancellation independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed implementation commit:** `d22c76444b80f8dd469380aab52ec457f5d76fad`

**Review integration head:** `1c5adb67e1af5ad225bca6f20f4b42395929b4cc`

**First connector candidate:** `70f5890b3be5162896a585dae458a9a9c02e8036`

**Rejected IDEA-110G implementation:** `3e72cce7b7b91fd8f36bd5ebfe559984b30a2f68`

**First connector review report SHA-256:**
`d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808`

**Frozen IDEA-110H packet SHA-256:**
`4800d632123fc1d97a98ed4a3e887e7502520461ba3ce4533c718b1625acb4eb`

**Review capsule:** `CR12B-IDEA-110H-REV-001`

## Independence and effect boundary

This is a fresh independent reviewer for this capsule. It differs from every IDEA-110F, IDEA-110G, and IDEA-110H
contributor; the first connector reviewer; all prior fixed-bridge reviewers; and the reviewer processes recorded on
jobbers #214 and #215. It authored, advised, and repaired none of the reviewed product source and did not inherit either
interrupted process as completed review evidence. Both prior IDEA-110G queue records remain
`blocked_incomplete_review`; neither produced a complete disposition or reusable acceptance evidence.

The supplied isolated checkout was clean and detached at current integration head
`1c5adb67e1af5ad225bca6f20f4b42395929b4cc` before claim. The remote integration target matched that head, no producer
branch existed, Node was `v22.22.3`, pnpm was `11.19.0`, and stage zero returned `ready_for_runtime_check`. The frozen
packet and first negative report matched the hashes above. The driver, gateway, bridge, connector, opaque-capability
implementation, and their focused tests were reviewed from exact implementation ancestry; later integration changes
only bind the pending review state and packet in enrollment readiness and documentation.

The review used exact repository source, deterministic repository tests, and an independently authored out-of-tree
hostile probe. It installed, downloaded, copied, linked, updated, and repaired nothing. It made zero Hermes, native,
SSH, provider, credential, protected-value, Keychain, listener, service, production-database, deployment, DNS, hosting,
or other consequential-effect attempts. The probe used only repository objects and in-memory test doubles. No private
port is configured by the shipped composition.

## Result

The structural IDEA-110H token itself is materially safer than the rejected native-signal observer. The reviewer
reproduced the rejected design exactly as `{"accepted":true,"added":false,"traps":1}`. Passing the same poisoned genuine
native signal to the IDEA-110H connector instead produced rejection with zero traps and zero private-port calls.

The whole packet nevertheless found three new defects: one High opaque-seam failure, one High final-native-cancellation
failure, and one Medium captured-global failure. A native signal can consume the gateway's one-use permit and can cross
gateway and bridge cleanup seams. A private port can poison the connector-owned native signal so route-close abort
executes a Proxy trap and returns an unsafe host exception before serialization completes. Finally, replacing the
global `AbortController` after module initialization executes caller behavior after a valid opaque capability has been
accepted and leaks the thrown object unchanged.

Producer tests passed and are recorded below as inputs. They do not override these independently reproduced defects.
The provider-disabled defaults remain truthful, but implementation `d22c76444b80f8dd469380aab52ec457f5d76fad` does not
satisfy ADR-146 or the frozen packet.

## Findings

### CR12B-110H-REV001-FINDING-001 — High — non-opaque signals cross gateway and bridge cleanup seams

**Exact source:** Gateway execution validates cancellation only after setting one-use execution state, obtaining trusted
time, and durably calling `claim` at
[`hermes-021-enrolled-gateway-port.ts:336`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L336) through
[`hermes-021-enrolled-gateway-port.ts:369`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L369). Gateway
cleanup performs no exact cancellation validation before setting `#cleanupStarted` and dispatching the supplied signal
to the native bridge at
[`hermes-021-enrolled-gateway-port.ts:405`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L405) through
[`hermes-021-enrolled-gateway-port.ts:420`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L420). Fixed-bridge
cleanup likewise does not validate its input signal before changing lifecycle state and forwards it unchanged through
all three cleanup operations and route close at
[`hermes-021-fixed-rpc-bridge.ts:345`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L345) through
[`hermes-021-fixed-rpc-bridge.ts:440`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L440).

**Reproducible input:** Construct an otherwise exact signed gateway and one-use permit, then call `execute` with a genuine
native `AbortSignal` cast into the opaque field. Separately complete one valid gateway execution and call gateway cleanup
with a genuine native signal. Finally complete one valid fixed-bridge execution and call fixed-bridge cleanup with the
same class of native signal while recording the connector-facing calls.

**Observed result:** The invalid execute rejected only after `claim` ran once and terminal settlement ran once; bridge
execution remained zero. Gateway cleanup then invoked its bridge once with the genuine native signal. Fixed-bridge
cleanup forwarded the genuine native signal to all three connector cleanup operations and connector route close: four
connector-facing calls. The sanitized probe result was
`{"gatewayExecute":{"rejected":true,"claims":1,"settlements":1,"bridgeCalls":0},"gatewayCleanup":{"cleanupCalls":1,"receivedNative":true},"bridgeCleanup":{"connectorCallsReceivingNative":4}}`.

**Violated invariant / affected boundary:** ADR-146 and the packet require driver-to-gateway, gateway-to-bridge, and
bridge-to-connector seams to carry only a repository-minted opaque capability. Every seam must reject a native signal
before getter behavior, lifecycle mutation, durable spending, or collaborator dispatch. This affects the one-use spend
boundary, gateway cleanup, fixed-bridge cleanup, and cancellation type containment. A one-use permit can be consumed by
an invalid cancellation input, and a native host object crosses two repository component seams.

**Missing regression:** Focused tests pass valid opaque capabilities through gateway and bridge and test poisoned native
rejection only at the final connector. No test gives gateway execute, gateway cleanup, or fixed-bridge cleanup a native,
poisoned, accessor-bearing, Proxy, forged, or pre-canceled non-opaque signal and requires zero state change and zero
collaborator call.

**Smallest safe remediation:** At the first executable line of gateway execute, gateway cleanup, and fixed-bridge cleanup,
validate `input` through an exact descriptor-based snapshot and require `exactHostCancellationSignalV1(input.signal)`
before changing lifecycle state or calling time, spend, bridge, connector, or collector collaborators. Preserve mandatory
cleanup by having the driver mint a separate valid cleanup capability; do not weaken exact validation for cleanup.
Add zero-behavior and zero-dispatch regressions for native, poisoned, accessor-bearing, Proxy, revoked-Proxy, forged,
pre-canceled, and post-capture-mutated cases at each repository seam.

### CR12B-110H-REV001-FINDING-002 — High — private mutation of the final native signal breaks route-close cancellation

**Exact source:** The connector creates a native controller and defines cancellation as a direct dynamic
`controller.abort()` call at
[`hermes-021-macos-connector.ts:343`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L343) through
[`hermes-021-macos-connector.ts:354`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L354). Route close invokes that
closure outside the connector's private-call error replacement and before awaiting active settlement at
[`hermes-021-macos-connector.ts:290`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L290) through
[`hermes-021-macos-connector.ts:300`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L300). The bounded replacement at
[`hermes-021-macos-connector.ts:323`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L323) through
[`hermes-021-macos-connector.ts:325`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L325) covers private-port awaits,
not native abort failure.

**Reproducible input:** Open a valid connector route. Pause `session.create` in the private-port test double after it has
received the final connector-owned native signal. Preserve the signal's outer shape but replace its built-in event-map
data value with a Proxy. Start route close while the create remains pending, then let the create return a valid late
receipt.

**Observed result:** Route close called native abort, executed one private-port-installed Proxy trap, and rejected with an
unmapped host exception rather than a new bounded `IdeaLabErrorV1`. Because the throw occurred immediately after
`#closing = true`, route close did not reach the active-settlement join or cleanup gate. The later create rejected, but
the connector remained in closing state. Sanitized output was
`{"traps":1,"closeRejected":true,"closeSafe":false,"requestRejected":true}`.

**Violated invariant / affected boundary:** The packet requires the private port to be able to mutate, retain, abort, or
observe the final native signal during every await without changing connector settlement. ADR-145 requires private
diagnostics to be replaced, and ADR-146 requires settlement to depend on connector-owned state rather than mutable native
signal internals. This affects final native conversion, route-close cancellation, active-settlement serialization,
bounded cleanup, and safe-error replacement. A private-port mutation can execute behavior, escape the safe error
boundary, and interrupt the cleanup state machine before its mandatory join.

**Missing regression:** The in-flight close test installs an ordinary abort listener but never mutates the connector-owned
native signal. The poisoned-signal regression tests only a native signal supplied *to* the connector and rejected before
dispatch. No test lets the private port poison the newly created native signal and then races caller cancellation, route
close, cleanup timeout, late return, and native abort failure.

**Smallest safe remediation:** Make final native cancellation a captured, non-throwing connector operation. Set the
connector-owned cancellation bit first, invoke the captured native abort method inside a bounded catch, never expose its
exception, and continue through the active-settlement/cleanup state machine using only connector-owned state. Ensure an
abort failure cannot leave `#closing` terminally wedged or bypass mandatory cleanup. Add private-port mutation probes at
open, every ordinary and cleanup await, collector submission, late return, route close, and timeout, including poisoned
event maps, abort-method drift, retained signals, and native completion after settlement.

### CR12B-110H-REV001-FINDING-003 — Medium — native conversion resolves a mutable global after opaque acceptance

**Exact source:** `#beginActive` resolves and constructs the ambient global `AbortController` each time at
[`hermes-021-macos-connector.ts:343`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L343) through
[`hermes-021-macos-connector.ts:347`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L347). Open invokes
`#beginActive` before entering its bounded private-call `try` at
[`hermes-021-macos-connector.ts:184`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L184) through
[`hermes-021-macos-connector.ts:202`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L202).

**Reproducible input:** Import the module normally, then replace `globalThis.AbortController` with a constructor that
increments a counter and throws a unique sentinel. Supply an exact valid open request carrying a genuine repository-minted
opaque capability and record both the private-port calls and rejected object identity.

**Observed result:** The hostile constructor executed once after the opaque capability was accepted. No private-port call
occurred, but open rejected with the exact sentinel object. Sanitized output was
`{"behavior":1,"privateCalls":0,"leakedErrorIdentity":true}`.

**Violated invariant / affected boundary:** The packet requires review of module-initialization and captured-intrinsic
assumptions and requires only a connector-owned native signal to reach the private port. An ambient constructor selected
after validation is caller-controlled behavior and cannot establish connector ownership. Its raw exception also bypasses
safe-error replacement. This affects native conversion, captured globals, exact host behavior, and error sanitation.

**Missing regression:** No focused test mutates `AbortController`, its prototype methods, its signal getter, or related
native globals after module initialization and before or during a valid opaque operation.

**Smallest safe remediation:** Capture and validate the native `AbortController` constructor, signal getter, and abort
method at module initialization, and use captured `Reflect.apply` operations thereafter. Map constructor/getter/abort
failure to a new bounded safe error without exposing identity, and combine this with the non-throwing settlement behavior
required by finding 002. Add post-import global and prototype drift regressions before open and during every await.

## Mandatory cancellation-boundary review

| Case | Independent result |
|---|---|
| Rejected IDEA-110G event-map Proxy | Reproduced exactly: outer shape accepted, listener addition failed, one Proxy trap executed. |
| Connector rejection of native and poisoned signals | Passed for connector inputs: native, poisoned, accessor-bearing, Proxy, lookalike, prototype-drifted, and pre-canceled non-opaque values reject before private-port dispatch; the poisoned map executes zero traps. |
| Driver-to-gateway capability | Driver mints one repository capability and passes no caller signal. Timeouts abort it once and cleanup receives a separate controller. |
| Gateway execute capability | Failed finding 001: exact rejection occurs only after durable claim and settlement. |
| Gateway cleanup capability | Failed finding 001: native signal is forwarded to the native bridge. |
| Bridge execute capability | A non-opaque signal fails subscription before connector dispatch; a valid opaque signal is composed into a new bridge-owned opaque execution capability. |
| Bridge cleanup capability | Failed finding 001: the supplied native signal is forwarded through three connector operations and route close. |
| Connector native conversion | Failed findings 002 and 003: conversion uses an ambient constructor and abort still depends on mutable native internals. |
| Pre-cancel behavior | Open, ordinary operation, and route close reject without private-port dispatch. A canceled ordinary create remains cleanup-requiring; a later fresh cleanup capability may still perform the fixed cleanup sequence. |
| Abort timing and settlement | Unmutated paths preserve one operation attempt and no retry before subscription, after subscription, before dispatch, during await, after collector submission, and after return. Private mutation during await breaks route-close settlement as finding 002. |
| Listener lifecycle | Opaque abort is idempotent; subscribed listeners run at most once; unsubscribe is idempotent; late subscription returns terminal `aborted`; one throwing listener cannot block peers; listener identity remains in module-private state. |
| Opaque minting and forgery | Only `createHostCancellationControllerV1` registers a token. The signal has the frozen private prototype, zero own keys, frozen surface, and module-private WeakMap state. Forged prototypes, copied descriptors, ordinary/null-prototype objects, wrappers, subclasses, Proxies, revoked Proxies, receiver loss, and cross-realm-like lookalikes fail registry membership without traps. |
| Captured opaque intrinsics | Capability validation/subscription use captured proxy, prototype, key, WeakMap, array push/splice, freeze, and apply intrinsics over private containers. The capability itself remained exact under post-capture mutation attempts. Connector-native conversion does not retain that property, per findings 002/003. |

## Original-finding closure and whole-boundary matrix

| Boundary / attack family | Independent result |
|---|---|
| CR12B-110F-REV001-001 possible-session cleanup | The connector marks create cleanup-requiring before private dispatch, joins active settlement before close eligibility, and refuses route close until at least one cleanup operation has started. Late success, late throw, incomplete/conflicting collector, malformed receipt, aliased identities, and pending create remain one-attempt/no-retry and cannot become a bridge cleanup completion without the fixed cleanup sequence. Finding 002 leaves the private-mutated abort race open. |
| CR12B-110F-REV001-003 private errors | Private-port Errors, primitives, Proxies, accessor-bearing errors, causes, subclasses, and locator-shaped diagnostics are discarded by `#callPrivate`; malformed and conflicting collector paths return new bounded errors. Host conversion/abort errors outside that wrapper remain open in findings 002/003. |
| CR12B-110F-REV001-004 authority domains | Connection, route, permit, profile, conversation, lease, session, and epoch digests are pairwise distinct. Omitted, malformed, overlong, swapped, cross-attempt, re-digested, aliased, and post-capture-mutated values fail closed; normal operation binding remains non-vacuous. |
| CR12B-110F-REV001-005 locator custody | The fixed bridge derives one domain-separated `connectionIdentityDigest`; connector/private-port requests have no connection ID, hostname, username, port, key path, gateway, profile path, native session ID, or arbitrary locator. Local and SSH modes share the digest-only connector seam. Locator-shaped values cannot pass the digest schemas or exact receipt capture. |
| Exact host and receiver boundary | Connector construction and request/receipt capture reject accessors, setters, unknown/inherited properties, symbols, custom/null prototypes, object/callable Proxies, receiver loss, and nested parameter drift without caller behavior. Gateway/bridge cancellation entry exactness remains open in finding 001. Concrete collaborator receivers are preserved. |
| Lifecycle and composition | Before-open, duplicate open, uncertain open, duplicate operation, wrong order, cleanup-only, duplicate close, after-close, route-close failure, conflicting receipt, and disabled-composition paths remain terminal and non-retrying. Active execution precedes close decisions. Findings 001/002 invalidate cancellation-specific lifecycle acceptance. |
| Receipt sanitation and mutation | Open, operation, cleanup, and close receipts reject extra, inherited, symbol, accessor, Proxy, locator-shaped, malformed, binding-drifted, aliased, and mutated values. Deep event/output parsing remains strict and bounded. No private error identity crosses normal private calls. |
| Timeout and race composition | Driver execution timeout requests cancellation, suppresses late unhandled rejection, and starts distinct bounded cleanup. Cleanup timeout cancels only its own capability and suppresses late rejection. Ordinary unmutated races settle once without retry. Native mutation during route-close cancellation fails finding 002. |
| Source and client absence | Production connector, bridge, gateway, driver, and readiness source contain no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value, environment, provider, deployment, hosting, or generic-shell client and do not modify Hermes. |
| Disabled shipped state | Connector, bridge, gateway, and driver records remain frozen with no configured port, signer, route, connection attempt, SSH connection, native attempt, provider call, live-panel eligibility, or execution authority. |
| Upgrade boundary | Runtime, source manifest, operation set, implementation, packet, readiness, signer, route, and provider-disabled composition remain pinned. Any connector, bridge, capability, native-conversion, identity, private-port protocol, source manifest, readiness-security-field, runtime, signer, or route change invalidates this report. |

## Evidence classification and retained blockers

**Observed:** exact repository source at implementation commit `d22c76444b80f8dd469380aab52ec457f5d76fad` and review
head `1c5adb67e1af5ad225bca6f20f4b42395929b4cc`; exact packet and first-report hashes; issue #214/#215 blocked
queue state; the rejected event-map result; all three findings; source-linked boundary traces; opaque token structure;
focused 154/154 tests; complete deterministic lifecycle; disabled composition; and zero native or external effects.

**Documented only:** Hermes Desktop owns local/SSH routing, pooling, reconnect, host/user/port/key selection, protected
values, gateway endpoint, profile path, and native session identifiers; the source manifest describes the pinned 0.21
revision. None of those private/native behaviors was contacted or independently observed.

**Inferred:** A future remediated and enrolled Mac-private port could preserve locator custody and implement the fixed
route. That inference does not prove private-port provenance, installed source bytes, signer custody, route behavior,
native cancellation behavior, cleanup behavior, or Hermes compatibility.

**Blocked/unobserved:** accepted connector remediation; trusted node signer enrollment; signed connection enrollment;
effect-free preflight; refreshed implementation/source/packet pins; fresh owner authorization; owner-attended native
qualification; live-panel authority; provider call; native receipt review; production PostgreSQL/checkpoint/key custody;
monitoring; hosting; deployment; DNS; and public infrastructure.

**Unsupported:** Any claim that this report approves or merges the connector, configures a port, enrolls a machine,
signer, or route, qualifies Hermes, proves a real local/SSH route, observes a provider call, accepts a native receipt,
authorizes a live panel, approves production storage, hosts, deploys, or grants an external effect.

Enrollment readiness remains `blocked_before_real_enrollment`, retains the first negative report, rejected IDEA-110G
state, two interrupted review attempts, exact IDEA-110H implementation and packet pins, pending fresh review, seven
blocker codes, zero effects, and non-reusable old authorization. This negative report does not remove
`connector_implementation_unaccepted`. Trusted signer, signed connection enrollment, effect-free preflight, packet
refresh, fresh owner authorization, and native qualification remain explicit; live panel, production database, hosting,
and deployment remain downstream blocked boundaries.

## Deterministic verification

All commands used the existing prepared dependencies. No install, update, repair, native action, or external product
effect occurred.

| Command | Exit | Result |
|---|---:|---|
| independent out-of-tree hostile probe | 0 | Rejected regression reproduced; three IDEA-110H findings reproduced; zero native/provider/external effects |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; Node and pnpm policy resolved |
| `npm run check` | 0 | TypeScript passed |
| `npm run lint` | 0 | ESLint passed |
| `npm run test:cr12b` | 0 | 154/154 passed; 0 failed, 0 skipped |
| `npm test` | 0 | pretest 769/769; core suite passed with two intentional platform skips; posttest 233/233; 0 failures |
| `CI=true npm run test:build` | 0 | production build passed; 3/3 rendered routes passed; classification warning only |
| `npm run db:verify` | 0 after scoped local IPC permission | 32 migrations applied; 110 PostgreSQL tables verified |
| `git diff --check integration/cr12b-idea-110h-opaque-cancellation-review...HEAD` | pending report commit | Final result is recorded in the isolated V2 result manifest |

The first sandboxed `npm run db:verify` invocation exited 1 before migration execution because `tsx` could not create
its local temporary IPC socket (`EPERM`). The identical command passed with permission limited to that local IPC socket.
No repository, dependency, database contract, or product repair occurred.

## Final decision

`remediation_required`. The repository-owned token closes the specific shared native event-map observer defect at the
final connector input, but the full component chain does not enforce the opaque capability before spending and cleanup
dispatch, and final native conversion/cancellation still executes mutable host behavior in ways that can escape safe
settlement. Exact implementation `d22c76444b80f8dd469380aab52ec457f5d76fad` therefore does not satisfy the frozen
packet.

This report does not approve, merge, configure, enroll, qualify, contact, host, deploy, or grant authority. Every
retained blocker remains mandatory. Any remediation requires a new exact implementation commit and a different fresh
independent report-only review.
