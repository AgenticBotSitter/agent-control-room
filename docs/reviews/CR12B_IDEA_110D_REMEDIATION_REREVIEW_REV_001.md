# CR12B-IDEA-110D remediation re-review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`

**Rejected predecessor:** `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`

**Immutable REV-003 report integration commit:** `d0875a7f80d887c6bcf7528346b1fe5aafc88c61`

**Immutable REV-003 report SHA-256:**
`d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f`

**Frozen remediation packet SHA-256:**
`414899406296a0e7326ea467f6a5cca31a93f5e2ab14974e59dd9508c8a5e827`

**Review capsule:** `CR12B-IDEA-110D-REV-001`

**Reviewer profile:** fresh independent Codex reviewer for REV-001 (`gpt-5.6-sol`, high effort)

## Independence and effect boundary

This reviewer profile is different from the REV-003 reviewer and from every profile that authored, advised, or repaired
the IDEA-110D remediation. It authored, advised, and repaired none of the reviewed source. The exact six bridge target
files are byte-identical between the immutable product commit and the review integration head.

The review used repository source, deterministic tests, and an ephemeral out-of-tree probe. It installed, downloaded,
copied, linked, updated, and repaired nothing. It made zero Hermes, native, SSH, provider, credential, protected-value,
Keychain, vault, listener, service, external-database, deployment, DNS, hosting, or other consequential-effect attempts.

## Result

All four REV-003 High findings are closed at the reviewed product commit:

1. captured driver, spend-store, bridge, connector, cleanup, and close methods retain their concrete receivers;
2. cleanup aborts and joins execution, cannot emit completed evidence early, and prevents later execution operations;
3. enrollment, permit digesting, and the fixed bridge share exactly seven operations; and
4. exact expiry, expiry crossing, time rollback, cancellation, and an already-aborted signal after durable claim consume
   the claim into terminal ambiguity with zero bridge dispatch and no retry.

Those repairs do not accept the snapshot. Two new Medium findings were independently reproduced in the required broader
Proxy/accessor and post-claim ambiguity attacks. A gateway-constructor wrapper accessor executes before validation, and a
trusted-clock exception after a successful claim leaves claim-only durable state rather than the required terminal
non-execution outcome. Neither attack dispatched the bridge or made the permit retriable, but both violate explicit
security/evidence invariants and lack regressions.

## REV-003 finding dispositions

### CR12B-REV003-001 — closed — concrete receivers are preserved

**Exact source:** The filtered driver invokes captured methods with the original port receiver at
[`hermes-021-filtered-driver.ts:197`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L197) through
[`hermes-021-filtered-driver.ts:205`](../../src/idea-lab/v1/hermes-021-filtered-driver.ts#L205). The gateway does the same
for the concrete spend store and native bridge at
[`hermes-021-enrolled-gateway-port.ts:306`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L306) through
[`hermes-021-enrolled-gateway-port.ts:325`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L325). The fixed
bridge binds connector methods at
[`hermes-021-fixed-rpc-bridge.ts:210`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L210) through
[`hermes-021-fixed-rpc-bridge.ts:220`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L220). The durable store invokes
checkpoint methods on their original receiver at
[`hermes-021-qualification-spend-store.ts:109`](../../src/idea-lab/v1/hermes-021-qualification-spend-store.ts#L109)
through [`hermes-021-qualification-spend-store.ts:127`](../../src/idea-lab/v1/hermes-021-qualification-spend-store.ts#L127).

**Reproducible attack:** Supply ECMAScript-private-field classes for driver execute/cleanup and gateway
claim/settle/execute/cleanup, then exercise fixed execute, durable claim and settlement, route cleanup, and connector close.

**Observed result:** Every private-brand access used its concrete original receiver. The focused 40-test run exercised
the concrete receiver probes, the durable PGlite spend store, fixed bridge operations, cleanup, and close without a brand
failure.

**Invariant / boundary:** Concrete component composition, not receiver-independent fakes, must implement the bridge.

**Regression status:** Present in the driver and gateway suites; durable store and fixed bridge suites exercise the other
captured seams.

**Further remediation:** None for CR12B-REV003-001.

### CR12B-REV003-002 — closed — cleanup is serialized behind execution settlement

**Exact source:** The fixed bridge installs its execution barrier before route open at
[`hermes-021-fixed-rpc-bridge.ts:230`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L230) through
[`hermes-021-fixed-rpc-bridge.ts:238`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L238), checks cancellation
before and after connector awaits at
[`hermes-021-fixed-rpc-bridge.ts:371`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L371) through
[`hermes-021-fixed-rpc-bridge.ts:398`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L398), and cleanup aborts and
joins the barrier before cleanup operations at
[`hermes-021-fixed-rpc-bridge.ts:333`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L333) through
[`hermes-021-fixed-rpc-bridge.ts:357`](../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts#L357). The gateway separately
orders execution settlement before cleanup settlement at
[`hermes-021-enrolled-gateway-port.ts:343`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L343) through
[`hermes-021-enrolled-gateway-port.ts:410`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L410).

**Reproducible attack:** Pause route open and `session.create` independently, start cleanup, verify cleanup remains
pending, release the ignored-abort connector call, and inspect dispatched operations and durable settlement order.

**Observed result:** Cleanup did not resolve early. After release, execution failed at the post-await active check. No
execution operation followed cleanup start; the open case dispatched none and the operation case dispatched only the
already-entered create. Gateway events ordered `terminal_ambiguity` before `cleanup_completed`.

**Invariant / boundary:** Completed cleanup must follow execution settlement and must exclude later execution activity.

**Regression status:** Paused-open, paused-operation, and gateway settlement-order regressions are present and pass.

**Further remediation:** None for CR12B-REV003-002.

### CR12B-REV003-003 — closed — signed scope equals the fixed seven-operation set

**Exact source:** The shared immutable set and its digest are defined at
[`hermes-021-fixed-operation-set.ts:10`](../../src/idea-lab/v1/hermes-021-fixed-operation-set.ts#L10) through
[`hermes-021-fixed-operation-set.ts:36`](../../src/idea-lab/v1/hermes-021-fixed-operation-set.ts#L36). Enrollment requires
that exact tuple at
[`hermes-021-enrolled-connection.ts:91`](../../src/idea-lab/v1/hermes-021-enrolled-connection.ts#L91) through
[`hermes-021-enrolled-connection.ts:122`](../../src/idea-lab/v1/hermes-021-enrolled-connection.ts#L122), and the permit
requires its literal digest at
[`hermes-021-enrolled-gateway-port.ts:32`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L32) through
[`hermes-021-enrolled-gateway-port.ts:67`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L67).

**Reproducible attack:** Independently recompute the digest, then re-sign enrollment bodies containing `session.steer`,
`session.resume`, a reordered tuple, an omitted operation, and an extra operation. Compare the fixed bridge's hard-coded
execute and cleanup dispatch names with the shared set.

**Observed result:** The recomputed digest matched. All five re-signed drift bodies were rejected before bridge creation.
The only source dispatch names are create, prompt, replay, status, usage, interrupt, and close; steer and resume are absent.

**Invariant / boundary:** Signed authority must equal the bridge's complete least-authority method surface.

**Regression status:** Exact-set and widened-set regressions are present; the independent probe additionally covered
single-method insertion, reorder, omission, and extra-member cases.

**Further remediation:** None for CR12B-REV003-003.

### CR12B-REV003-004 — closed — time and cancellation are rechecked after claim

**Exact source:** The gateway samples pre-claim time at
[`hermes-021-enrolled-gateway-port.ts:340`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L340) through
[`hermes-021-enrolled-gateway-port.ts:347`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L347), then samples
again and rejects cleanup, abort, invalid time, rollback, exact expiry, and crossed expiry before dispatch at
[`hermes-021-enrolled-gateway-port.ts:349`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L349) through
[`hermes-021-enrolled-gateway-port.ts:355`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L355).

**Reproducible attack:** Hold a successful claim while advancing the trusted clock to exact expiry and beyond expiry;
move the clock backward; and abort during claim. Retry the same gateway instance after each denial.

**Observed result:** Every case produced one claim, one `terminal_ambiguity` settlement, zero native-bridge calls, and an
immediate second-execute denial. The durable spend store also rejects replay and illegal settlement chronology.

**Invariant / boundary:** Authority must be current at bridge dispatch; a consumed non-dispatch must be terminal and
non-retriable.

**Regression status:** Exact-expiry crossing is present. Independent review additionally exercised after-expiry,
rollback, cancellation, and same-instance retry.

**Further remediation:** None for CR12B-REV003-004. CR12B-RR001-001 below is a separate exceptional-clock path.

## New findings

### CR12B-RR001-001 — Medium — a post-claim clock exception leaves no terminal non-execution record

**Exact source:** After `claim` returns `claimed`, the gateway calls the injected clock at
[`hermes-021-enrolled-gateway-port.ts:346`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L346) through
[`hermes-021-enrolled-gateway-port.ts:349`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L349). The denial
branch records `terminal_ambiguity` only when the clock returns a value at
[`hermes-021-enrolled-gateway-port.ts:350`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L350) through
[`hermes-021-enrolled-gateway-port.ts:354`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L354). A thrown clock
exception bypasses the inner bridge catch and reaches only the outer `finally` at
[`hermes-021-enrolled-gateway-port.ts:384`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L384) through
[`hermes-021-enrolled-gateway-port.ts:387`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L387).

**Reproducible attack:** Use a valid enrollment and permit, a spend store whose claim succeeds, a clock that returns one
valid pre-claim time and throws on its post-claim sample, and a bridge that counts calls.

**Observed result:** Execute rejected and bridge dispatch count remained zero, but durable events contained only
`claimed`; neither `terminal_ambiguity` nor another execution outcome was submitted. The instance remained non-retriable.

**Violated invariant / affected boundary:** ADR-139 and the remediation packet require a consumed post-claim
non-execution to retain a terminal outcome. A claim-only ledger cannot distinguish this definite local pre-dispatch
failure from restart or interruption at another point in the claimed interval.

**Missing regression:** A post-claim throwing-clock case asserting zero dispatch, one terminal-ambiguity settlement, and
no retry.

**Smallest safe remediation:** Catch post-claim trusted-clock exceptions before bridge entry, settle
`terminal_ambiguity` with the last valid claimed time, and then reject. Add the missing deterministic regression.

### CR12B-RR001-002 — Medium — the gateway constructor executes wrapper accessors during validation

**Exact source:** The constructor rejects a Proxy wrapper but directly reads `input.spendStore`, `input.nativeBridge`,
and later `input.now` at
[`hermes-021-enrolled-gateway-port.ts:293`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L293) through
[`hermes-021-enrolled-gateway-port.ts:310`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L310). It continues
to read enrollment, permit, collaborator, and clock properties directly through
[`hermes-021-enrolled-gateway-port.ts:312`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L312) through
[`hermes-021-enrolled-gateway-port.ts:326`](../../src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts#L326).

**Reproducible attack:** Pass a non-Proxy ordinary wrapper with an enumerable getter for `spendStore` that increments a
counter and returns an invalid value.

**Observed result:** Construction rejected, but the getter counter was one. The hostile behavior ran before the gateway
could reject the boundary. Nested connector methods and result handoffs remain safely captured; this finding is specific
to the top-level constructor wrapper.

**Violated invariant / affected boundary:** The frozen packet requires hostile accessor values to be rejected without
executing behavior. The constructor wrapper is the composition boundary that carries signed evidence and the two
effect-capable collaborators.

**Missing regression:** A plain-object constructor wrapper with getters on each required and optional property, asserting
zero getter calls and no collaborator calls.

**Smallest safe remediation:** Capture the exact top-level constructor input with descriptor-based ordinary-data reads
before any property access, reject accessors and unknown properties, and use only the captured values for all later
validation and receiver binding.

## Whole-boundary review

| Boundary | Independently observed result |
|---|---|
| Locator and protected-value leakage | Enrollment and connector receipts retain only IDs/digests and fixed flags; strict schemas reject extra locator/value fields. Source contains no process, SSH, filesystem, network, credential, protected-value, or provider client. Real connector custody is unobserved. |
| Replay, truncation, and gateway epoch | Replay requires `truncated: false`, exact contiguous sequence, a terminal event, final-sequence equality, and unchanged session/epoch binding. Gap, truncation, post-terminal event, and epoch drift attacks reject without retry. |
| Output and usage sanitation | Only bounded exact terminal JSON and exact usage reach filtered frames. Malformed JSON, extra fields, usage arithmetic drift, Proxy results, retained accessors, and hostile deltas reject or are discarded without traps. |
| Duplicate execution and cleanup | Fixed bridge and gateway one-use flags deny second execution and cleanup. Durable spend rows and unique attempt/marker constraints preserve one claim and exact settlement chronology. |
| Uncertain open and connector error | Attempt-bound close runs after uncertain open. Connector exceptions cannot create a successful contribution and require cleanup. Completed cleanup still depends on exact close/absence receipts; the real connector remains unobserved. |
| Cleanup race | Paused open and paused operation cannot produce early cleanup completion or later execution operations. Gateway durability orders execution ambiguity before cleanup completion/uncertainty. |
| Signature and operation scope | Canonical Ed25519 enrollment and permit bodies bind exact identities. One shared digest covers exactly seven operations; widened, reordered, omitted, or extra enrollment sets reject. |
| Claim expiry, rollback, and cancellation | Returned invalid/expired/rolled-back times and cancellation settle terminal ambiguity with zero dispatch and no retry. A thrown post-claim clock lacks that settlement: CR12B-RR001-001. |
| Proxy/accessor values | Proxy collaborators, accessor methods, Proxy results, and nested result accessors reject without traps. The gateway's top-level constructor wrapper invokes an accessor: CR12B-RR001-002. |
| Default composition and later authority | Disabled constants and readiness truth keep connector, signer, enrollment, preflight, owner packet, fresh authorization, qualification, live panel, production database, hosting, and deployment absent. No earlier authorization is reusable. |
| Upgrade boundary | Runtime revision, source manifest, route, operation set, product commit, report, and packet are digest-bound. Any source/method/protocol change requires fresh review, enrollment, packet, and authorization. Exact Hermes source bytes and real reconnect behavior remain unobserved. |

## Evidence classification and retained blockers

**Observed:** exact repository source at the reviewed product commit; exact packet and report hashes; the four closed
REV-003 attacks; the two new findings; strict schemas; one-use flags; disabled defaults; focused 40/40 tests; ephemeral
4/4 attack probes; complete deterministic command outcomes; and zero live/native effects.

**Documented only:** Hermes Desktop owns local/SSH routing, connection pooling, reconnect, native identities, profile and
protected-value custody; the six source pins describe the installed revision; producer claims about real connector and
Hermes semantics.

**Inferred:** A conforming real connector would fail closed on every exact receipt field because the inspected parsers do.
That inference does not prove connector provenance, real routing, Hermes custody, or absence of hidden behavior.

**Blocked/unobserved:** exact installed Hermes source bytes; accepted platform connector; enrolled trusted node signer;
real signed enrollment; effect-free connector preflight; refreshed packet and owner authorization; owner-attended native
qualification; provider call; native receipt review; architect acceptance; live-panel owner window; production
database/checkpoint/key custody; monitoring; hosting; deployment; DNS; and public infrastructure.

**Unsupported:** Any claim that this report approved or merged the block, enrolled a machine, qualified Hermes, proved a
real local/SSH route, observed a provider call count, accepted a native receipt, authorized a live panel, or approved
production or deployment.

## Deterministic verification

All commands used existing prepared dependencies. No install, update, repair, native action, or external product effect
occurred.

| Command | Exit | Result |
|---|---:|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; Node and pnpm policy resolved |
| `npm run check` | 0 | TypeScript passed |
| `npm run lint` | 0 | ESLint passed |
| `npm run test:cr12b` | 0 | 138/138 passed; 0 failed, 0 skipped |
| `npm test` | 0 | pretest 769/769; core 414/416 with two intentional platform skips; posttest 217/217; 0 failures |
| `CI=true npm run test:build` | 0 | production build passed; 3/3 rendered routes passed; dynamic-classification warning only |
| `npm run db:verify` | 0 | 32 migrations applied; 110 PostgreSQL tables verified |
| `git diff --check integration/cr12b-idea-110d-remediation-review...HEAD` | pending implementation commit | Run after this report is committed |

The first sandboxed `npm run db:verify` invocation exited 1 before migration execution because `tsx` could not create its
local temporary IPC socket (`EPERM`). The identical command passed with permission only for that local IPC socket. No
repository, dependency, database contract, or product repair occurred.

## Final decision

`remediation_required`. The four original High findings are closed and the snapshot remains provider-disabled, but the
abstract bridge is not accepted while CR12B-RR001-001 and CR12B-RR001-002 remain. Preserve this report as negative
evidence, make one bounded remediation, refresh the affected immutable commit and packet, and require another different
independent reviewer to repeat all prior and new attacks. This report does not approve, merge, enroll, qualify, contact
Hermes, authorize a live panel, or grant any production effect.
