# CR12B-IDEA-110B independent review — REV-003

**Disposition:** `remediation_required`

**Reviewed implementation:** `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`

**Review capsule:** `CR12B-IDEA-110B-REV-003`

**Reviewer profile:** fresh isolated Codex reviewer for REV-003 (`gpt-5.6-sol`, high effort)

## Independence and effect boundary

This reviewer profile is different from the profiles assigned to the preparation-blocked REV-001 and REV-002 jobs. It
authored, repaired, and advised none of the product changes in the reviewed implementation. It did not read or rely on any
prior review conclusion.

The review was limited to repository source, contracts, tests, and ordinary deterministic commands. It made zero Hermes,
native, SSH, provider, credential, protected-value, service, deployment, production-database, hosting, or other external
effect attempts. It installed, downloaded, copied, linked, updated, and repaired nothing.

## Result

The provider-disabled default remains honest, the connector-facing value schemas are strict, the fixed bridge contains no
process, filesystem, network, SSH, credential, or provider client, and the focused and complete deterministic suites pass.
Those facts do not accept the implementation. Four source-confirmed mismatches prevent the repository classes from safely
realizing the claimed fixed bridge:

1. the real driver, gateway, fixed bridge, and durable spend-store classes cannot compose because callable methods are
   captured without their private-branded receivers;
2. cleanup can complete while execution/open is still in flight, after which execution can continue into the fixed turn;
3. the signed operation-set digest authorizes two lifecycle methods that the fixed bridge never uses; and
4. owner-window expiry is checked before an awaited durable claim but not again immediately before native bridge entry.

No locator, protected value, native identity, raw provider content, or secret was observed crossing the repository bridge
in the inspected tests. No repository evidence proves the behavior of a real platform connector, real route, real Hermes
reconnect/pool, or installed Hermes sources. Those boundaries remain unobserved, not passed.

## Findings

### CR12B-REV003-001 — High — unbound private-branded collaborators make the real class composition unusable

**Exact source:** The filtered driver captures `port.execute` and `port.cleanup` at
[`hermes-021-filtered-driver.ts:197`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L197), stores the bare functions at
[`hermes-021-filtered-driver.ts:202`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L202), and invokes them as fields
of the driver at [`hermes-021-filtered-driver.ts:227`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L227) and
[`hermes-021-filtered-driver.ts:268`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L268). The enrolled gateway repeats
that pattern for spend-store and native-bridge methods at
[`hermes-021-enrolled-gateway-port.ts:313`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L313), then calls the
bare functions at [`hermes-021-enrolled-gateway-port.ts:347`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L347),
[`hermes-021-enrolled-gateway-port.ts:351`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L351),
[`hermes-021-enrolled-gateway-port.ts:385`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L385), and
[`hermes-021-enrolled-gateway-port.ts:402`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L402). The concrete
fixed bridge and spend store immediately depend on ECMAScript-private receiver state at
[`hermes-021-fixed-rpc-bridge.ts:230`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L230) and
[`hermes-021-qualification-spend-store.ts:221`](../../src/idea-lab/v1/hermes-021-qualification-spend-store.ts#L221).

**Safe local reproduction:** Construct the concrete fixed bridge and concrete spend store, pass them to the concrete
gateway, pass that gateway to the concrete filtered driver, and invoke one repository-fake turn. JavaScript evaluates a
call such as `this.#executeFixedSession(...)` with the gateway as the receiver, not the fixed-bridge instance from which
the function was obtained. The first `this.#...` access therefore fails the private-brand check. The same failure exists
one layer above and on the durable store path.

**Observed result:** Type checking and all tests pass, but the tests substitute receiver-independent object-literal fakes:
[`idea-lab-hermes-021-enrolled-gateway-port.test.ts:103`](../../tests/idea-lab-hermes-021-enrolled-gateway-port.test.ts#L103)
and [`idea-lab-hermes-021-driver.test.ts:89`](../../tests/idea-lab-hermes-021-driver.test.ts#L89). They never compose the
actual classes. The real path cannot reach a durable claim or the fixed connector call.

**Violated invariant / affected boundary:** The accepted repository bridge must compose the exact filtered driver,
enrolled gateway, durable spend store, and fixed RPC bridge. Passing collaborator-fake tests cannot stand in for that
code-correctness boundary.

**Missing regression:** One end-to-end, repository-fake composition test using every concrete class and a disposable
database/checkpoint implementation.

**Smallest safe remediation:** Capture receiver-bound closures with `Reflect.apply` (or bind each method to the validated
instance) at both composition layers. Add the concrete composition regression and prove both execute and cleanup use the
original validated receiver.

### CR12B-REV003-002 — High — cleanup may report completion before execution or route open settles

**Exact source:** Execute marks itself started and records a binding before awaiting route open at
[`hermes-021-fixed-rpc-bridge.ts:235`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L235). Cleanup requires only
`#executeStarted`, not execution settlement, at
[`hermes-021-fixed-rpc-bridge.ts:324`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L324). With no lease/session yet,
it skips session cleanup, accepts a route-close receipt, and emits `outcome: "completed"` at
[`hermes-021-fixed-rpc-bridge.ts:333`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L333) through
[`hermes-021-fixed-rpc-bridge.ts:355`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L355). After the delayed open
resolves, execute has no cleanup/abort state check before continuing into create and prompt at
[`hermes-021-fixed-rpc-bridge.ts:246`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L246) and
[`hermes-021-fixed-rpc-bridge.ts:262`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L262).

**Safe local reproduction:** Use a repository fake whose `openFixedRoute` holds a promise. Start execute without awaiting
it, call cleanup while open is pending, return the exact route-close receipt, then release the open promise with the exact
valid receipt. Cleanup can emit a completed receipt first; execution then resumes into fixed operations.

**Observed result:** The implementation admits a successful cleanup claim while an execution coroutine remains capable of
later native activity. The existing uncertain-open test waits for execute to reject before cleanup and therefore misses
the overlap: [`idea-lab-hermes-021-fixed-rpc-bridge.test.ts:179`](../../tests/idea-lab-hermes-021-fixed-rpc-bridge.test.ts#L179).

**Violated invariant / affected boundary:** Cleanup completion must prove native-session closure, lease release,
temporary-state removal, zero retained references, and no later activity. Uncertain open must remain terminal and
non-retriable; it cannot be "cleaned" while the original operation can still advance.

**Missing regression:** Delayed open, delayed operation, timeout/abort, and cleanup-overlap cases that assert zero fixed
operations after cleanup starts and forbid completed cleanup until execution settlement is known.

**Smallest safe remediation:** Use an explicit execution/cleanup state machine. Abort and join the in-flight execution (or
record cleanup uncertainty) before emitting completion, recheck cancellation/cleanup state after every connector await,
and require a final absence proof after the execution promise is settled.

### CR12B-REV003-003 — High — the signed permit authorizes methods outside the fixed bridge sequence

**Exact source:** The signed operation-set digest includes `session.steer` and `session.resume` at
[`hermes-021-enrolled-gateway-port.ts:29`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L29), and the enrollment
schema requires the same wider set at
[`hermes-021-enrolled-connection.ts:103`](../../src/idea-lab/v1/hermes-021-enrolled-connection.ts#L103). The fixed bridge
type contains only create, prompt, replay, status, usage, interrupt, and close at
[`hermes-021-fixed-rpc-bridge.ts:37`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L37), matching its actual call
sequence at [`hermes-021-fixed-rpc-bridge.ts:248`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L248) through
[`hermes-021-fixed-rpc-bridge.ts:301`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L301).

**Safe local reproduction:** Decode the repository constant used to compute
`IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1` and compare its members with `IdeaLabHermes021FixedOperationV1` and
the fixed call sequence. The signed set has nine members; the implementation needs seven.

**Observed result:** A valid owner permit signs authority for two operations that the qualification bridge cannot use.
Tests reproduce the wider list rather than asserting least privilege:
[`idea-lab-hermes-021-enrolled-gateway-port.test.ts:43`](../../tests/idea-lab-hermes-021-enrolled-gateway-port.test.ts#L43).

**Violated invariant / affected boundary:** The owner window must authorize only the exact fixed turn and must not widen
signed authority. Connector or future code drift must not inherit unused steer/resume authority.

**Missing regression:** An equality test between the signed operation set, enrollment set, fixed bridge union, and exact
ordered execute/cleanup call set.

**Smallest safe remediation:** Define one shared immutable seven-operation qualification set, remove steer and resume from
enrollment and permit scope, recompute every dependent digest, and invalidate every earlier enrollment, packet, and owner
window.

### CR12B-REV003-004 — High — permit expiry is not rechecked immediately before bridge entry

**Exact source:** The gateway samples time and validates expiry before awaiting the durable claim at
[`hermes-021-enrolled-gateway-port.ts:343`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L343). After the await
returns `claimed`, it immediately enters `#executeFixedSession` at
[`hermes-021-enrolled-gateway-port.ts:347`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L347) through
[`hermes-021-enrolled-gateway-port.ts:351`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L351), with no fresh
time check. The durable claim interface receives the earlier `claimedAt` but not the permit expiry.

**Safe local reproduction:** Start with a permit that is current at the first clock sample, use a deterministic spend-store
fake that resolves `claim` only after the permit expiry, and observe that the next control-flow step is bridge entry.

**Observed result:** Claim latency can carry execution past the signed owner-window deadline without a dispatch-time denial.
The existing expiry test rejects a permit already expired at verification time; it does not delay claim across expiry:
[`idea-lab-hermes-021-enrolled-gateway-port.test.ts:184`](../../tests/idea-lab-hermes-021-enrolled-gateway-port.test.ts#L184).

**Violated invariant / affected boundary:** Expiry must hold when the native bridge is entered, not merely before a
potentially delayed state transition.

**Missing regression:** A deterministic claim-delay case that crosses expiry and asserts zero native-bridge calls plus a
durable non-execution outcome.

**Smallest safe remediation:** Re-read trusted time after the claim and immediately before bridge dispatch. Bind expiry to
the claim/dispatch transaction or record an explicit claimed-but-expired terminal outcome without entering the bridge.

## Required boundary review

| Boundary | Independently observed result |
|---|---|
| Locator and protected-value ingress | Strict connector inputs expose only IDs/digests, transport enum, fixed parameters, and `AbortSignal`; strict result schemas reject extra fields. No locator/value was observed in repository tests. A real connector is absent and remains unobserved. |
| Connector mutation/custody | Proxy connectors and accessor methods are rejected; the fixed bridge binds captured top-level methods. Real connector provenance, internal mutable state, route custody, SSH launch absence, reconnect, and pool identity are unobserved. An abstract connector receipt is not real enrollment or route proof. |
| Route/session/binding substitution | Open, operation, and cleanup receipts check attempt, permit, route, lease, session, epoch, profile, conversation, participant, runtime, and marker bindings in source. Finding CR12B-REV003-001 prevents the real composition from exercising them. |
| Fixed turn and replay | The bridge has one execute flag, a closed operation union, strict within-batch sequence/terminal checks, one prompt result, exact status/usage schemas, and no retry. Post-replay latest-sequence drift in a real Hermes session is unobserved because the connector/source is absent. |
| Malformed output and sanitation | Exact ordinary-data snapshots, strict schemas, bounded terminal JSON, and exact arithmetic reject malformed/extra/Proxy results. Streaming deltas are not retained in the filtered output. Real provider content never entered this review. |
| Signature and authority | Enrollment and owner permit verify canonical Ed25519 bodies and exact identities. CR12B-REV003-003 widens the signed method scope; CR12B-REV003-004 permits expiry during claim-to-dispatch. |
| Durable spend and replay | The store source and its disposable tests preserve one claim, chronology, authenticated append-only rows, checkpoint rollback detection, ambiguity, and no retry. CR12B-REV003-001 prevents the concrete gateway from calling that concrete store correctly. |
| Cleanup | Exact receipt schemas bind attempt/permit/route and require closure, lease release, removal, and zero references. CR12B-REV003-002 breaks the chronology and absence meaning of that receipt. |
| Authority separation | Enrollment, owner permit, spend, bridge output, filtered contribution, later receipt review, architect acceptance, and live-panel owner window remain distinct in source and contracts. No later authority was exercised. |
| Upgrade boundary | Runtime revision and source-manifest digest are bound into the fixed route open. The exact Hermes sources and connector implementation were unavailable under the no-download boundary, so reconnect behavior and source-role correctness remain unobserved. Every changed source/method/protocol digest requires new review and fresh enrollment/packet/authorization. |

## Six-source pin status

The repository constant independently observed six role-labelled pins for installed revision
`a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b` at
[`hermes-021-fixed-rpc-bridge.ts:22`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L22): Desktop JSON-RPC gateway,
gateway store, SSH connection, connection registry, session methods, and ISO certification. The exact pinned Hermes source
files were not present in the prepared repository and downloads were forbidden. Their bytes, role semantics, reconnect
behavior, and hashes are therefore **unobserved**, not passed. The two pins shared with the earlier repository assessment
match its recorded constants; that is only internal consistency, not independent source verification.

## Evidence classification and retained blockers

**Observed:** exact repository source and tests at the reviewed commit; strict schemas; fixed call sites; disabled defaults;
four findings above; deterministic command outcomes below; zero live/native effects.

**Documented only:** Hermes Desktop owns local/SSH routing, connection pooling, reconnect, native identifiers, profile and
protected-value custody; the six pins describe the installed revision; producer claims about real Hermes semantics.

**Inferred:** valid connector receipts would fail closed on the source-visible exact fields when the call reaches the
parsers. This inference is not proof of the absent connector or Hermes runtime.

**Blocked/unobserved:** exact Hermes source bytes; real signed enrollment; real route/credential custody; owner-attended
native qualification; provider call; native receipt review; architect acceptance; live-panel owner window; production
database/checkpoint/key custody; monitoring; hosting; deployment; DNS; and public infrastructure.

**Unsupported:** any claim that this review qualified Hermes, approved the block, proved a real SSH/local route, proved a
provider call count, accepted a native receipt, or authorized a live panel.

## Deterministic verification

All commands ran with the existing prepared dependencies and no install or update.

| Command | Exit | Result |
|---|---:|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; Node requirement and pnpm 11.19.0 policy resolved |
| `npm run check` | 0 | TypeScript passed |
| `npm run lint` | 0 | ESLint passed |
| `npm run test:cr12b` | 0 | 127/127 passed; 0 failed, 0 skipped |
| `npm test` | 0 | pretest 769/769; core 414/416 with 2 intentional platform skips; posttest 206/206; 0 failures |
| `CI=true npm run test:build` | 0 | build passed; 3/3 rendered routes passed; Vinext warned that some dynamic routes could not yet be statically classified |
| `npm run db:verify` | 0 | 32 migrations applied; 110 PostgreSQL tables verified |
| `git diff --check integration/cr12b-idea-110b-review...HEAD` | 0 | no whitespace errors |

The first sandboxed `npm run db:verify` invocation could not create the local `tsx` IPC socket and exited 1 with `EPERM`.
The identical command was rerun with approval only for its local temporary IPC socket and passed as recorded above. No
repository, dependency, database contract, or product repair occurred.

## Final decision

`remediation_required`. The exact snapshot remains provider-disabled and non-authorizing, but it cannot be accepted as the
fixed bridge. Repair all four findings, refresh every affected digest and packet, and require a different independent
reviewer to repeat the concrete composition, cleanup-overlap, least-authority, expiry-at-dispatch, replay/epoch, usage,
durability, sanitation, and upgrade-boundary checks. This report does not approve, merge, enroll, qualify, or contact
Hermes.
