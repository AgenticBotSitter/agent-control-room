# CR12B-IDEA-110E second remediation re-review — REV-001

**Disposition:** `accepted_provider_disabled_snapshot`

**Reviewed product commit:** `2bc80a20c7e4e1753b014395866972622c134fd3`

**Rejected first remediation:** `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`

**Rejected predecessor:** `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`

**Immutable REV-003 report:** `docs/reviews/CR12B_IDEA_110B_INDEPENDENT_REVIEW_REV_003.md`, SHA-256
`d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f`

**Immutable REV-001 report:** `docs/reviews/CR12B_IDEA_110D_REMEDIATION_REREVIEW_REV_001.md`, SHA-256
`7f9e3f73142a3af120218f3df51f9e47fbc71d5764bb586346da7c87ee75bd62`

**Frozen IDEA-110E packet SHA-256:**
`a5d406b36546524bba452cdae34f670261e243ae758287cb55c217848402f3a8`

**Review capsule:** `CR12B-IDEA-110E-REV-001`

**Reviewer profile:** fresh independent Codex reviewer for this capsule (`gpt-5.6-sol`, high effort)

## Independence and effect boundary

This reviewer is different from the REV-003 and REV-001 reviewers and from every profile that authored, advised, or
repaired IDEA-110D or IDEA-110E. It authored, advised, and repaired none of the reviewed source. The six bridge target
files are byte-identical between the frozen product commit and this review integration head.

The review used exact repository source, deterministic tests, and an independently authored out-of-tree probe. It
installed, downloaded, copied, linked, updated, and repaired nothing. It made zero Hermes, native, SSH, provider,
credential, protected-value, Keychain, vault, listener, service, external-database, production, deployment, DNS, hosting,
or other consequential-effect attempts.

## Result

All six prior findings are closed at the reviewed product commit:

1. every captured driver, store, bridge, connector, cleanup, and close method retains its concrete receiver;
2. cleanup aborts and joins execution, cannot complete early, and prevents later execution operations;
3. enrollment, permit digesting, and bridge dispatch share exactly seven fixed operations;
4. expiry, rollback, cancellation, and abort after durable claim settle terminal ambiguity with zero dispatch and no
   retry;
5. a post-claim clock exception attempts exactly one terminal settlement at the last valid claimed time, dispatches
   nothing, invokes no later clock sample, and remains non-retriable; and
6. the gateway constructor rejects every hostile top-level wrapper shape before caller behavior or collaborators run.

The failed-settlement clock case remains honestly uncertain: the gateway attempts one `terminal_ambiguity` settlement,
but does not claim it became durable when the store rejects. It still dispatches nothing and cannot retry.

No new finding was reproduced. Passing producer tests were treated only as inputs; the disposition also rests on an
independent line-by-line source review and a separate 63-assertion hostile probe repeated successfully across fresh
processes.

## Prior-finding dispositions

### CR12B-REV003-001 — High — closed — concrete receivers are preserved

**Exact source:** The filtered driver captures data methods and invokes them with the original port at
[`hermes-021-filtered-driver.ts:197`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L197) through
[`hermes-021-filtered-driver.ts:205`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L205). The gateway applies the
same rule to the spend store and native bridge at
[`hermes-021-enrolled-gateway-port.ts:302`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L302) through
[`hermes-021-enrolled-gateway-port.ts:330`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L330). The fixed
bridge binds connector methods at
[`hermes-021-fixed-rpc-bridge.ts:210`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L210) through
[`hermes-021-fixed-rpc-bridge.ts:220`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L220), and the durable store
uses its checkpoint receiver at
[`hermes-021-qualification-spend-store.ts:109`](../../src/idea-lab/v1/hermes-021-qualification-spend-store.ts#L109)
through [`hermes-021-qualification-spend-store.ts:127`](../../src/idea-lab/v1/hermes-021-qualification-spend-store.ts#L127).

**Reproducible attack:** Supply ECMAScript-private-field implementations at the driver, gateway, connector, bridge, and
store seams, then execute and clean up one repository-fake turn.

**Observed result:** Every private-brand access used the original concrete receiver. The independent probe exercised
private-field spend, native-bridge, and connector classes; the focused suites exercised the driver and durable store.

**Violated invariant / affected boundary:** Concrete class composition must work without weakening classes to
receiver-independent fakes. The invariant now holds.

**Missing regression:** None. Receiver regressions exist at the driver and gateway seams, and the fixed bridge and spend
store suites exercise the remaining captures.

**Smallest safe remediation:** None for CR12B-REV003-001.

### CR12B-REV003-002 — High — closed — cleanup is serialized behind execution

**Exact source:** The fixed bridge creates its settlement barrier before route open at
[`hermes-021-fixed-rpc-bridge.ts:230`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L230) through
[`hermes-021-fixed-rpc-bridge.ts:238`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L238), aborts and joins it
before cleanup at [`hermes-021-fixed-rpc-bridge.ts:333`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L333)
through [`hermes-021-fixed-rpc-bridge.ts:368`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L368), and checks
cancellation around connector awaits at
[`hermes-021-fixed-rpc-bridge.ts:371`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L371) through
[`hermes-021-fixed-rpc-bridge.ts:429`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L429). Gateway settlement is
ordered at [`hermes-021-enrolled-gateway-port.ts:396`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L396)
through [`hermes-021-enrolled-gateway-port.ts:424`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L424).

**Reproducible attack:** Pause route open and `session.create` independently, start cleanup, verify it remains pending,
then release the connector call while ignoring abort.

**Observed result:** Cleanup never resolved before execution settlement. The open case dispatched no operation; the
operation case dispatched only the already-entered create. Neither dispatched a later execution operation, both ended
with route close, and gateway durability ordered execution ambiguity before cleanup outcome.

**Violated invariant / affected boundary:** Completed cleanup must exclude later execution activity. The invariant holds.

**Missing regression:** None. Paused-open, paused-operation, and gateway settlement-order regressions are present.

**Smallest safe remediation:** None for CR12B-REV003-002.

### CR12B-REV003-003 — High — closed — signed scope is the exact seven-operation set

**Exact source:** The shared tuple and digest are fixed at
[`hermes-021-fixed-operation-set.ts:10`](../../src/idea-lab/v1/hermes-021-fixed-operation-set.ts#L10) through
[`hermes-021-fixed-operation-set.ts:36`](../../src/idea-lab/v1/hermes-021-fixed-operation-set.ts#L36). Enrollment requires
that tuple at [`hermes-021-enrolled-connection.ts:91`](../../src/idea-lab/v1/hermes-021-enrolled-connection.ts#L91)
through [`hermes-021-enrolled-connection.ts:122`](../../src/idea-lab/v1/hermes-021-enrolled-connection.ts#L122), and the
permit requires its digest at
[`hermes-021-enrolled-gateway-port.ts:33`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L33) through
[`hermes-021-enrolled-gateway-port.ts:68`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L68).

**Reproducible attack:** Recompute the digest, re-sign widened, reordered, omitted, and inserted enrollment operation
sets, and compare the tuple with every execute and cleanup dispatch literal.

**Observed result:** The recomputed digest matched. Every drifted signed enrollment rejected. The only operations are
create, prompt, replay, status, usage, interrupt, and close; steer and resume are absent.

**Violated invariant / affected boundary:** Signed authority must equal the complete least-authority method surface. The
invariant holds.

**Missing regression:** None. Exact-set and drifted-set regressions are present; the independent probe repeated four
distinct signed method-set drifts.

**Smallest safe remediation:** None for CR12B-REV003-003.

### CR12B-REV003-004 — High — closed — authority is rechecked after durable claim

**Exact source:** The gateway validates pre-claim time and creates a one-use barrier at
[`hermes-021-enrolled-gateway-port.ts:334`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L334) through
[`hermes-021-enrolled-gateway-port.ts:353`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L353), then checks
post-claim time, rollback, cleanup, and abort before dispatch at
[`hermes-021-enrolled-gateway-port.ts:354`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L354) through
[`hermes-021-enrolled-gateway-port.ts:367`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L367).

**Reproducible attack:** Cross exact expiry and later expiry during claim, roll trusted time backward, cancel during
claim, and retry each consumed instance.

**Observed result:** Every case made one claim, one terminal-ambiguity settlement attempt, zero bridge calls, and no
second execution. Rollback used the last valid claimed time; valid later denial times were retained exactly.

**Violated invariant / affected boundary:** Owner authority must be current at bridge dispatch and a consumed
non-dispatch must be terminal. The invariant holds.

**Missing regression:** None. Exact-expiry crossing is checked in-tree; the independent probe added later expiry,
rollback, cancellation, and retry.

**Smallest safe remediation:** None for CR12B-REV003-004.

### CR12B-RR001-001 — Medium — closed — post-claim clock exception is terminally consumed

**Exact source:** The post-claim sample is isolated at
[`hermes-021-enrolled-gateway-port.ts:354`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L354) through
[`hermes-021-enrolled-gateway-port.ts:360`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L360), where a throw
settles `terminal_ambiguity` with `claimedAt`. Settlement uses the exact permit, attempt, marker, outcome, and time at
[`hermes-021-enrolled-gateway-port.ts:427`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L427) through
[`hermes-021-enrolled-gateway-port.ts:431`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L431).

**Reproducible attack:** Return one valid pre-claim time, let claim succeed, throw on the second clock call, retry, and
repeat with the settlement store rejecting.

**Observed result:** The successful store saw exactly one claim and one terminal settlement at the last valid time,
zero bridge calls, two clock calls total, and no retry. With settlement failure, one claim and one settlement attempt
occurred; the call rejected, dispatch stayed zero, retry stayed denied, and durable success was not claimed.

**Violated invariant / affected boundary:** A known post-claim pre-dispatch failure must be terminally recorded when the
store accepts it; store failure must remain honest uncertainty. The invariant holds.

**Missing regression:** None for the accepted-store path. The independent probe covers the required failed-store path.

**Smallest safe remediation:** None for CR12B-RR001-001.

### CR12B-RR001-002 — Medium — closed — top-level wrapper is captured without behavior

**Exact source:** The constructor snapshots the exact five required and one optional fields before property access at
[`hermes-021-enrolled-gateway-port.ts:294`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L294) through
[`hermes-021-enrolled-gateway-port.ts:305`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L305). The host
snapshot rejects Proxies and non-ordinary prototypes before reflection and accepts only exact enumerable data descriptors
at [`host-value.ts:73`](../../src/security/host-value.ts#L73) through
[`host-value.ts:127`](../../src/security/host-value.ts#L127). The optional clock separately rejects a callable Proxy at
[`hermes-021-enrolled-gateway-port.ts:306`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L306) through
[`hermes-021-enrolled-gateway-port.ts:315`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L315).

**Reproducible attack:** Put an enumerable getter and then a setter on every required and optional field. Repeat with a
non-enumerable field, symbol, unknown field, inherited field, null prototype, Proxy wrapper, and proxied optional clock;
then compose valid private-field collaborators.

**Observed result:** All hostile wrappers rejected with zero getter, setter, Proxy, clock, spend-store, and bridge calls.
The valid ordinary wrapper preserved private-field receivers through execution and cleanup.

**Violated invariant / affected boundary:** Signed evidence and effect-capable collaborators must cross an inert exact
ordinary-data boundary. The invariant holds.

**Missing regression:** The in-tree regression covers every field getter, unknown/inherited state, and Proxy wrapper. The
independent probe covers setters, non-enumerable, symbol, null-prototype, proxied-clock, and valid-private-class cases.

**Smallest safe remediation:** None for CR12B-RR001-002.

## Whole-boundary attack results

| Boundary / attack | Independently observed result |
|---|---|
| Locator and protected-value leakage | Enrollment, route, operation, and cleanup schemas retain only IDs, digests, exact flags, and bounded safe values. Added locator/value fields reject. Source contains no process, SSH, filesystem, network, credential, protected-value, or provider client. Real connector custody remains unobserved. |
| Replay gaps and truncation | Replay requires `truncated: false`, a dense ordinary event array, exact contiguous sequence, one terminal, and final-sequence equality. Gap, truncation, post-terminal, and final-sequence drift reject without retry. |
| Gateway epoch and binding drift | Every operation binds the safe session and epoch; open, create, prompt, replay, status, usage, and cleanup identities are exact. Epoch, route, profile, conversation, participant, runtime, marker, attempt, and permit drift reject. |
| Terminal output and usage | Only strict bounded terminal JSON and exact usage arithmetic reach filtered frames. Malformed JSON, extra fields, oversized content, Proxy/accessor values, usage drift, and hostile deltas reject or are discarded without behavior. |
| Duplicate execution and cleanup | Bridge and gateway one-use flags reject second execution/cleanup. Durable unique attempt/marker claims, append-only chronology, authenticated rows, and rollback checkpoints prevent alternate replay. |
| Uncertain open and connector error | Attempt-bound route close follows uncertain open. Connector and execution exceptions never become successful contributions; gateway ambiguity is recorded before cleanup outcome when the store accepts it. No retry occurs. |
| Hostile nested values | Collector handoff rejects Proxies before traps; exact snapshots and strict parsing reject accessors, arrays with drift, and extra nested state. The top-level wrapper matrix likewise executes no behavior. |
| Cleanup and settlement ordering | Paused open/create cannot emit early completion or later operations. Execution ambiguity precedes cleanup completion/uncertainty. A failed settlement is never reported as durable success. |
| Method-set drift | One recomputed digest covers exactly seven ordered operations. Widening, insertion, omission, reorder, steer, and resume reject and require fresh evidence. |
| Post-await authority drift | Exact/later expiry, time rollback, cancellation, abort, and clock exception after claim dispatch nothing, consume the instance, and attempt terminal settlement at an honest time. |
| Upgrade boundary | Runtime revision, source manifest, connection source, operation set, product commit, both negative reports, and the frozen packet are digest-bound. Any connector, source, method, protocol, or runtime change requires fresh review, enrollment, packet, and owner authority. |
| Default composition | Driver, gateway, fixed bridge, enrollment readiness, owner qualification, live panel, production database, hosting, and deployment defaults remain disabled and non-authorizing. |

## Evidence classification and retained blockers

**Observed:** exact repository source at the frozen product commit; byte identity of all six reviewed target files at the
integration head; exact report and packet hashes; all six closed attacks; the complete whole-boundary matrix; strict
schemas; one-use and settlement barriers; disabled defaults; the independent 63-assertion probe; focused 42/42 hostile
tests; complete deterministic command outcomes; and zero native or external effects.

**Documented only:** Hermes Desktop owns local/SSH routing, connection pooling, reconnect, native identities, profile and
protected-value custody; the source pins describe an installed revision; producer claims about real connector and Hermes
semantics.

**Inferred:** A conforming real connector would fail closed on every exact receipt field because the inspected parsers do.
That inference does not prove connector provenance, real route behavior, Hermes custody, or absence of hidden behavior.

**Blocked/unobserved:** exact installed Hermes source bytes; accepted platform connector; enrolled trusted node signer;
real signed enrollment; effect-free connector preflight; refreshed post-review packet and fresh owner authorization;
owner-attended native qualification; provider call; native receipt review; architect acceptance; live-panel owner window;
production database/checkpoint/key custody; monitoring; hosting; deployment; DNS; and public infrastructure.

**Unsupported:** Any claim that this report approved or merged the block, enrolled a machine, accepted a connector,
qualified Hermes, proved a real local/SSH route, observed a provider call, accepted a native receipt, authorized a live
panel, or approved production or deployment.

## Deterministic verification

All commands used the existing prepared dependencies. No install, update, repair, native action, or external product
effect occurred.

| Command | Exit | Result |
|---|---:|---|
| independent out-of-tree hostile probe | 0 | 63 assertions passed per run; final repeated run 20/20; zero native/provider/external effects |
| focused bridge/driver/enrollment/spend suite | 0 | 42/42 passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; Node and pnpm policy resolved |
| `npm run check` | 0 | TypeScript passed |
| `npm run lint` | 0 | ESLint passed |
| `npm run test:cr12b` | 0 | 140/140 passed; 0 failed, 0 skipped |
| `npm test` | 0 | pretest 769/769; core 414/416 with two intentional platform skips; posttest 219/219; 0 failures |
| `CI=true npm run test:build` | 0 | production build passed; 3/3 rendered routes passed; dynamic-classification warning only |
| `npm run db:verify` | 0 after scoped local IPC permission | 32 migrations applied; 110 PostgreSQL tables verified |
| `git diff --check integration/cr12b-idea-110e-second-review...HEAD` | pending report commit | Run after this report-only implementation commit |

The first sandboxed `npm run db:verify` invocation exited 1 before migration execution because `tsx` could not create its
local temporary IPC socket (`EPERM`). The identical command passed with permission only for that local IPC socket. No
repository, dependency, database contract, or product repair occurred.

## Final decision

`accepted_provider_disabled_snapshot`. All six prior findings are closed and the whole fixed-bridge boundary passed the
required repository-only attacks at exact product commit `2bc80a20c7e4e1753b014395866972622c134fd3`.

This acceptance is limited to the abstract provider-disabled snapshot. It does not approve or merge this report, accept
a platform connector, enroll a signer or connection, refresh an owner packet, reuse prior authorization, qualify Hermes,
contact a provider, accept a native receipt, authorize a live panel, configure production storage, host, deploy, or grant
any external effect. Every retained blocker above remains mandatory.
