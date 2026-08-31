# CR-8Q subview-remediation sixth independent re-review

**Block:** CR-8Q-007
**Review date:** 2026-08-29
**Review mode:** sixth independent defensive security/correctness review; effect-free repository boundary only
**Required model / effort:** `gpt-5.6-sol` / `max`

## Executive result

`CR8Q-BRR-F01` is repaired. Exact-prototype ordinary `Uint8Array` subviews are now rejected when either the byte offset is nonzero or the view is shorter than its ordinary backing store. At the real Bitwarden adapter class, 1Password adapter class, destination-native adapter class, and direct broker class, both partial-view forms were rejected without consumer exposure, every byte in each reachable backing store was zero afterward, any accepted release ran exactly once, and exact replay did not reacquire.

I independently repeated all twelve packet-required hostile binary families through all four seams (48 seam/case executions). Every hostile value was rejected, no attacker getter or Proxy trap ran, all reachable backing stores were intrinsically wiped in full, and uncertainty was terminal. Exact ordinary whole-buffer values still succeeded through all four seams, were copied into distinct boundary-owned storage, and were wiped at every owned layer. The earlier Proxy, synchronous collector, exact-object, Completion, Telegram, secret durability, and negative-authority repairs also remain closed under direct inspection and the complete deterministic gates.

This accepts only the reviewed effect-free repository snapshot. It grants no live, native, credential, Telegram, deployment, approval, execution, or production authority.

## Reviewed snapshot and independence

The review began with the required report absent. I recorded the owner-held dirty snapshot before any private probe and obtained the same status fingerprint after removing the probe:

| Anchor | Reviewed value |
| --- | --- |
| Branch | `integration/cr5d-synthetic-executor-1` |
| Git base `HEAD` | `14de468999b1ebf4584c13026114d40a0f66cea7` |
| Frozen subview packet SHA-256 | `2a16b59c5469e50559977db55678e4ba6205261f7fb63a5dccc0c035937d58cc` |
| Fifth packet SHA-256 | `5c411da9d8650a4e54b2dcde43154d2d3d927cd4347896fa09b51582ae6c563f` |
| Tracked `git diff --binary` SHA-256 | `f47ae74ab5211f6d7222db06adf800320e3fd26c3910f16f74b8718545ca6064` |
| Ordered untracked-file manifest SHA-256 | `cca5de8bc39adc69c40a5209a06d0ebe2513c9bbc846a79132004dc591697569` |
| Ordered untracked content-manifest SHA-256 | `aefe7d1da9942ed216c580606e5c8f4f79ed4c2c160d32eb90b466697745a9fa` |
| Sorted full porcelain-status SHA-256 | `308f17107f95c0a0137f024b43f3f727ddf6c306b7848795386d4987852433d9` |
| Full porcelain-status entry count | 158 |
| Required report at dispatch | Absent |

All five immutable negative reports and the architect review were read and verified without alteration:

| Immutable report | SHA-256 |
| --- | --- |
| `CR8Q_INDEPENDENT_REVIEW.md` | `8796d52a95d3045729d8d87ab31b4dd01c92ff52dc5464f508ff910be9a90021` |
| `CR8Q_INDEPENDENT_REREVIEW.md` | `ebd918709ebad912706f4d2cd7864275ffcd9f9fcfa255b2c9e763bde19370a4` |
| `CR8Q_SECOND_REREVIEW.md` | `e2354607180d6c7058aa1643dcd3f9b3dbdc70b45a10d93213ed28c05aedb588` |
| `CR8Q_PROXY_REMEDIATION_REREVIEW.md` | `36cc52df04b2ec91000f0edc9d136ea248be90d6966f8c54b7ab44aaf2e88c39` |
| `CR8Q_BINARY_REMEDIATION_REREVIEW.md` | `5029c5e693616b92d92379a9f55ddb1c3d662636a17e32343be371c3dd1201bf` |
| `CR8Q_ARCHITECT_SECURITY_REVIEW.md` | `b29764c688c35e0f0fa0a830b581f1a0c17b12b8acbb5246a401fdbfcf1ebd41` |

I am different from every CR-8 implementation/remediation author and from all five prior CR-8Q reviewers. I did not delegate review work, communicate with a prior reviewer, implement or repair anything, or accept my own change. I treated prior reports and producer claims as evidence to challenge, not acceptance authority.

I read `AGENTS.md`, `docs/BUILD_STATUS.md`, the complete `control-room-delegation-review` skill, the complete frozen packet, all packet-minimum source/tests/contracts, all five prior reports, and the architect review. The conclusions combine direct source inspection, independently constructed synthetic in-process attacks, and the installed deterministic gates.

## Write, effect, and cleanup boundary

The only repository write made by this reviewer is this report. I did not edit source, tests, contracts, fixtures, migrations, build status, packets, or prior reports. I did not commit, push, fetch, pull, switch branches, install/download, browse, use GitHub/network, access an account or credential, invoke a live provider/process runner, use Keychain/vault, contact a bot/webhook/chat/service, deploy, or cause an external/native/consequential effect.

Independent attacks used only synthetic in-memory objects, bytes, fake runners/resolvers/providers, and the installed dependency tree. The one temporary private test file, `tests/.tmp-cr8q-subview-sixth-independent.test.ts`, was created solely for these attacks and removed immediately after its successful run. Its absence was verified. The full pre-probe status fingerprint returned exactly after removal. No reviewer temporary artifact remains.

## `CR8Q-BRR-F01` remediation determination

**Determination:** `verified_repaired`

Direct inspection of `src/security/host-value.ts` found the repaired exact-view invariant in `exactHostUint8ArrayV1`: the captured `%TypedArray%` getters obtain the actual buffer, byte length, byte offset, and element length; the captured `ArrayBuffer.prototype.byteLength` getter obtains the complete store length; acceptance requires exact native prototypes, a zero-own-key ordinary `ArrayBuffer`, dense exact index keys, `byteOffset === 0`, and `byteLength === bufferByteLength`. It uses no caller property, iteration, `instanceof`, or replaceable byte method. The copy path uses the captured constructor and `set`; accepted cleanup constructs a complete-store view and invokes captured native `fill`.

The rejection cleanup path independently obtains an actual typed array's backing through the captured `%TypedArray%.buffer` getter, constructs a full-store `Uint8Array` with the captured constructor, and fills that complete store through the captured native `fill`. Consequently, rejecting a partial ordinary view does not limit wiping to the visible view.

### Separate partial-view attacks at all four real seams

I constructed both partial views independently and retained a full-buffer observer before handoff. `NZ` used a nonzero offset into a seven-byte store. `ZS` used offset zero but a length shorter than its seven-byte store. The complete store observations were:

| Case | Complete store before | Candidate | Complete store after rejection |
| --- | --- | --- | --- |
| `NZ` nonzero offset | `[91,65,66,67,93,94,95]` | `new Uint8Array(store, 1, 3)` | `[0,0,0,0,0,0,0]` |
| `ZS` zero-offset short | `[65,66,67,93,94,95,96]` | `new Uint8Array(store, 0, 3)` | `[0,0,0,0,0,0,0]` |

The results at the four real class seams were:

| Seam | `NZ` result | `NZ` full store after | `ZS` result | `ZS` full store after | Getter/trap calls | Consumer calls | Release | Exact replay |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| Bitwarden adapter class with fake runner | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | 0 | 0 | none accepted/applicable | 0 further runner calls |
| 1Password adapter class with fake runner | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | 0 | 0 | none accepted/applicable | 0 further runner calls |
| Destination-native adapter class with fake resolver | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | `ambiguous/provider_outcome_unknown` | `[0,0,0,0,0,0,0]` | 0 | 0 | exactly 1 per case | 0 further resolver calls |
| Direct broker class with fake provider | `ambiguous/provider_result_invalid` | `[0,0,0,0,0,0,0]` | `ambiguous/provider_result_invalid` | `[0,0,0,0,0,0,0]` | 0 | 0 | exactly 1 per case | 0 further acquisitions |

Each first call invoked only its fake runner/resolver/provider once. The two command-adapter runner envelopes do not accept a provider release function, so a zero release count is the required result there. Destination-native and direct-provider results did accept releases, and each release ran exactly once. Every first receipt was terminal; exact replay returned that terminal truth without new acquisition.

## Independent twelve-family binary matrix

I constructed the twelve mandatory hostile families independently rather than importing the supplied shape helper. Each was driven through an actual Bitwarden provider-adapter instance, actual 1Password provider-adapter instance, actual destination-native provider-adapter instance, and an actual broker instance with a direct fake provider: 48 seam/case executions.

Notation below is `rejected / attacker calls / consumer calls / full reachable store wiped`. `0` attacker calls means the sum of every installed getter and relevant Proxy trap was zero.

| Hostile family | Bitwarden runner | 1Password runner | Destination-native | Direct broker |
| --- | --- | --- | --- | --- |
| Nonzero-offset ordinary subview with hidden prefix/suffix | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Zero-offset short ordinary subview with hidden suffix | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| `SharedArrayBuffer`-backed view | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Shared view with own `buffer` getter returning ordinary store | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Shared view with own `buffer` data property | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Ordinary view with own `byteLength` getter | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Ordinary view with own `byteLength` data property | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| `Uint8Array` subclass | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Ordinary view with replaced prototype | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| View over detached ordinary store | `yes / 0 / 0 / detached` | `yes / 0 / 0 / detached` | `yes / 0 / 0 / detached` | `yes / 0 / 0 / detached` |
| Backing `ArrayBuffer` with own `constructor` getter | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |
| Own `at`, `fill`, `set`, `slice`, and iterator getters | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` | `yes / 0 / 0 / yes` |

Aggregate observations:

- Bitwarden: 12 runner calls, 12 terminal ambiguous receipts, zero consumer calls, zero getter/trap executions, every reachable store completely zeroed, and zero new runner calls on exact replay.
- 1Password: the same 12/12/0/0/full-wipe/non-reacquisition result.
- Destination-native: 12 resolver calls, 12 terminal ambiguous receipts, zero consumer calls, zero getter/trap executions, exactly 12 accepted releases, every reachable store completely zeroed, and zero new resolver calls on exact replay.
- Direct broker: 12 acquisitions, 12 terminal `ambiguous/provider_result_invalid` receipts, zero consumer calls, zero getter/trap executions, exactly 12 accepted releases, every reachable store completely zeroed, and zero new acquisitions on exact replay.
- A detached store was already unobservable and could not expose remaining bytes; rejection and cleanup executed no caller behavior. Shared and growable-shared stores remained reachable in their probes and were zero in full after rejection.

The shared-view own-`buffer` getter is the original `CR8Q-PRR-F01` exploit. Its getter count was zero at every seam. The combined method-shadow candidate installed separate counters for `at`, `fill`, `set`, `slice`, and `Symbol.iterator`; all five counters remained zero at every seam. Direct source inspection and the focused tests also cover own `buffer`, `byteLength`, `byteOffset`, `length`, method, iterator, and backing `constructor` members individually. None is read or called during validation, copy, or wiping.

## Exact ordinary success, isolation, cleanup, and edge cases

An exact whole-buffer `Uint8Array([65,66,67])` succeeded at every real seam. In each case the next trust layer observed `[65,66,67]` in a different backing store, never the provider/runner store. After settlement, both the original source observer and the consumer-held observer read `[0,0,0]`. The first call ran once; exact replay made no further runner, resolver, provider, or consumer call. Destination-native and direct-provider releases each ran exactly once; no release callback exists in the command-runner result contract.

Additional independent edge probes established:

- A zero-length exact whole ordinary store satisfies the host exact-view predicate, but all four acquisition seams reject empty credential material terminally, expose no consumer, perform any accepted release once, and do not reacquire on replay.
- Exactly 65,536 bytes are accepted by the host binary maximum and copied/wiped correctly. A larger value is rejected.
- Detached stores fail closed; there is no remaining observable store to clean, and no user getter/trap runs while cleanup is attempted.
- The module captures `Object.getPrototypeOf`, `Reflect.apply`, `Reflect.ownKeys`, the `Uint8Array` constructor, and native `at`/`fill`/`set` before use. Replacing the corresponding globals/prototype methods after module initialization produced zero replacement-function calls; exact copy and full-store wipe still worked. All replacements were restored.
- A resizable ordinary full store at its current length is synchronously accepted, copied, and completely wiped. After resizing the same store so a fixed-length view becomes partial, that view is rejected and the complete current store is wiped. No `await` or attacker callback occurs between intrinsic validation and copy, so the inspected code presents no validation-to-copy resize race.
- A growable `SharedArrayBuffer` view is rejected and its complete reachable shared store is wiped.

## Cleanup, collector, and earlier Proxy repairs

I traced every packet-listed cleanup transition through `broker.ts`, `provider-adapters.ts`, `fixed-consumer.ts`, `exact-data.ts`, and the host collector, and challenged the same paths with the focused gates. The security-relevant result is:

| Path | Determination |
| --- | --- |
| Invalid outer provider envelope | Terminal `provider_result_invalid`; any discoverable actual typed-array material is intrinsically wiped when reachable; any accepted release is once-only; no consumer; replay does not reacquire |
| Invalid nested material | Same terminal result; full actual backing store wiped when reachable; no getter/trap or consumer exposure |
| Copy failure | Source cleanup remains in `finally`; accepted release is attempted once; no partial copy is handed to a consumer; terminal ambiguity replays without reacquisition |
| Provider release failure | Source and owned copies are wiped; release is attempted once; result becomes `consumer_or_cleanup_outcome_unknown`; replay does not reacquire |
| Consumer failure | Source and consumer copy are wiped; release runs/attempts once; result is terminal `consumer_or_cleanup_outcome_unknown` |
| Collector absence / duplicate / late / throw-before / throw-after | A non-single synchronous submission cannot become success. Any first accepted value is recovered through `abort()` for intrinsic cleanup/release; late writes cannot alter terminal truth |
| Rejected Proxy followed by ordinary recovery | Proxy is rejected before traps; collector is invalidated, so the later ordinary submission cannot recover the attempt; terminal replay does not reacquire |

The installed 116-case CR-8Q gate repeats transparent, key-hiding, descriptor-fabricating, and throwing Proxy modes at consumer-result, provider-result, provider-array/wiring, fixed-consumer result/wiring, runner-result/nested-output, destination-native result, Telegram settlement, and rollback-checkpoint seams. I also independently constructed 13 Proxy/wiring cases across rollback checkpoints, provider objects and provider arrays, and fixed-consumer wiring, using all four modes where applicable. Total observed traps were zero.

Specific retained outcomes are:

- Consumer-result Proxies cannot establish success; terminal ambiguity, cleanup, once-only release, and replay isolation hold.
- Provider-result and runner-result Proxies execute zero traps and never reach a consumer. Collector invalidation prevents a later ordinary recovery.
- Provider arrays, provider objects, runner/resolver functions, fixed-consumer results, and fixed-consumer wiring are rejected before a Proxy trap or captured method can run.
- Destination-native collector misuse cleans and releases the first accepted material once.
- Telegram settlement Proxies return `invalid_record`, execute zero traps, leave the delivery in `sending`, and do not block a later valid ordinary settlement.
- Rollback-checkpoint Proxies execute zero traps and cannot validate or mutate state.

These observations keep `CR8Q-SR-F01` and `CR8Q-RR-F01` closed.

## Complete Completion, Telegram, secret durability, and negative-authority boundary

### Completion

- Completion creation and decision use captured trusted time; newly submitted backdating and clock rollback fail closed.
- Named verification, deterministic risk floors, reviewer independence, correlated-reviewer serialization, immutable semantic replay, exact revision/finding resolution, and tenant separation remain enforced.
- Consequential approval still requires exact policy, owner identity, active strong factor, unexpired/unrevoked grant, project, effect, risk, and decision-time binding. Quality acceptance cannot substitute for approval.
- Append-only rows reject mutation and recomputed ordinary digests without the external integrity key.
- Authenticated complete tenant state plus captured external checkpoints reject privileged deletion, complete erasure, and restoration of an older internally valid snapshot. Checkpoint Proxies execute zero traps.
- Completion facts and UI projections remain evidence-only, expose no raw artifact material, and provide no approval or execution action.

### Telegram

- Callback registration and consumption recheck current tenant/project, message class, deterministic/effective risk, recipient ceiling, verification lower bound, expiry, chat binding, and exact callback-to-plan containment before mutation.
- Callback key/verifier functions are captured. A single callback-ID/token grammar applies end-to-end. Exact replay is stable; drift, callback reuse, wrong chat, wrong MAC, future issue, and expiry fail closed.
- Future-dated recipient policy cannot enqueue or reach `sending`; current-policy replacement is rechecked before dispatch.
- Callback observations, callbacks, recipient-policy history/current state, delivery state, and integrity state form authenticated complete tenant state. Tampering, deletion, complete erasure, and older-valid restoration fail against the external checkpoint.
- Delivery settlement remains exact/idempotent. Only definite failures retry; ambiguous or expired claims do not auto-retry. Settlement Proxies execute zero traps and do not mutate state.
- Telegram callbacks remain response proposals only (`grantsApproval: false`, `grantsExecutionAuthority: false`) and require independent policy evaluation. High/critical presentations are protected-dashboard-only; UI projections contain no consequential control.
- Every test was repository-local and synthetic. No bot, webhook, chat, or transport was contacted.

### Secret broker and durable ledger

- The catalog stores metadata/reference locators only, deep-copies/freezes nested scope, uses monotonic replacement, and preserves tenant/project isolation.
- Grants derive only from accepted exact local admission and exact current catalog scope; a caller-computed grant is not local authority. Fixed-consumer composition excludes caller-injected credential handlers.
- Provider, runner, resolver, consumer, broker-time, and checkpoint functions are captured against later mutation.
- Material is copied before crossing the next trust boundary and wiped at every owned layer. Provider/consumer/cleanup uncertainty, expiry during use, and clock rollback during use become terminal ambiguity.
- Terminal receipts replay before new catalog/expiry/provider work, remain isolated, survive restart, and never reacquire. An invocation claimed across restart becomes terminal ambiguity.
- Private SQLite path, permissions, key, identity, exact schema, authenticated rows, file replacement, missing/empty/recreated/older files, added schema, restart ambiguity, clock high-water, complete erasure, and rollback checkpoint attacks remain fail-closed.
- Credential receipts persist no secret material and retain `grantsApproval: false` and `grantsExecutionAuthority: false`. Effect-free core construction still provides no live provider eligibility.

## Finding-family determinations

| Finding | Determination |
| --- | --- |
| `CR8Q-BRR-F01` | `verified_repaired`: nonzero-offset and zero-offset-short ordinary subviews are rejected at all four real seams; every reachable hidden backing byte is zero, getters/traps and consumer calls are zero, accepted release is once-only, and replay does not reacquire. |
| `CR8Q-PRR-F01` | `verified_repaired`: shared backing with an own `buffer` getter is rejected with zero getter execution at all four real seams and fully wiped when reachable. |
| `CR8Q-SR-F01` | `verified_repaired`: host Proxy rejection and synchronous collectors preserve zero-trap rejection, cleanup, terminal ambiguity, and non-reacquiring replay. |
| `CR8Q-RR-F01` | `verified_repaired`: accessor, inherited, symbol, non-enumerable, hidden, extra, and Proxy consumer-result shapes cannot establish success or run behavior. |
| `CR8Q-IR-F01` | `verified_repaired`: explicit provisioning, captured external checkpoints, complete-erasure rejection, and older-valid-snapshot rejection hold for Completion and Telegram. |
| `CR8Q-IR-F02` | `verified_repaired`: catalog inputs and returned nested scope metadata remain isolated and frozen. |
| `CR8Q-IR-F03` | `verified_repaired`: missing, empty, recreated, replaced, and older private SQLite ledgers fail against external state. |
| `CR8Q-IR-F04` | `verified_repaired`: callback consumption rechecks current project, class, risk, verification time, expiry, and chat. |
| `CR8Q-IR-F05` | `verified_repaired`: callback registration binds the exact plan and current class/risk ceilings. |
| `CR8Q-IR-F06` | `verified_repaired`: future-dated recipient policy cannot enqueue or reach sending. |
| `CR8Q-IR-F07` | `verified_repaired`: one callback ID/token grammar is enforced end-to-end. |
| `CR8Q-F01` | `held_closed`: Completion request/decision creation uses captured trusted time. |
| `CR8Q-F02` | `held_closed`: authenticated complete Completion state and the external checkpoint reject deletion and rewind. |
| `CR8Q-F03` | `held_closed`: consequential approval lifetime, revocation, strong-factor, identity, policy, project, effect, and risk bindings remain enforced. |
| `CR8Q-F04` | `held_closed`: Telegram rejects future/stale observations under ingress-owned time. |
| `CR8Q-F05` | `held_closed`: callbacks remain contained to their exact message plan and response choice. |
| `CR8Q-F06` | `held_closed`: callback key/verifier remain captured and no request-selected key is accepted. |
| `CR8Q-F07` | `held_closed`: protected Telegram row sets remain authenticated complete state with external rollback protection. |
| `CR8Q-F08` | `held_closed`: provider/config/result exactness now also rejects ordinary partial backing-store views and wipes the complete reachable store. |
| `CR8Q-F09` | `held_closed`: the durable ledger authenticates and advances its monotonic clock high-water. |
| `CR8Q-F10` | `held_closed`: provider, runner, resolver, consumer, broker-time, and checkpoint trusted functions remain captured. |
| `CR8Q-F11` | `held_closed`: terminal replay is isolated, precedes redispatch work, and does not reacquire. |
| `CR8Q-F12` | `held_closed`: Telegram settlement requires exact semantics; a rejected Proxy settlement does not mutate. |

## Deterministic command evidence

The installed runtime was Node.js `v22.22.3`; the required package manager was `pnpm 11.19.0` at `/Users/alastairfraser/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm`. The repository stage-zero check ran before the gates and returned exit 0 with `status: "ready_for_runtime_check"`; it resolved the installed `tsx` and `zod` dependencies and performed no native check.

| Command | Exit | Observed result |
| --- | ---: | --- |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; no native attempt |
| `pnpm run check` | 0 | `tsc --noEmit`; no diagnostics |
| `pnpm run lint` | 0 | ESLint; no diagnostics |
| `pnpm run test:cr8e` | 0 | 50 tests; 50 passed; 0 failed/cancelled/skipped/todo |
| `pnpm run test:cr8q` | 0 | 116 tests; 116 passed; 0 failed/cancelled/skipped/todo |
| `pnpm run pretest` | 0 | 161 tests; 161 passed; 0 failed/cancelled/skipped/todo |
| `pnpm test` | 0 | Lifecycle pretest: 161/161; main: 416 total, 414 passed, 0 failed, 2 intentional platform skips, 2 suites |
| `pnpm run test:build` | 0 | Five build phases completed; 2 rendered-route tests passed; 0 failed/skipped |
| `pnpm run db:verify` | 1 | Known managed-sandbox `tsx` IPC denial reproduced exactly below before migration work |
| `node --import tsx scripts/verify-migrations.ts` | 0 | Sole packet-permitted same-verifier fallback; migrations `0001` through `0024`; 82 PostgreSQL tables |
| `git diff --check` | 0 | No output |
| `node --import tsx --test tests/.tmp-cr8q-subview-sixth-independent.test.ts` | 0 | Independent private probe: 4 tests; 4 passed; 0 failed/cancelled/skipped/todo; file then removed |

The first migration-verifier failure, captured before any migration output, was:

```text
$ tsx scripts/verify-migrations.ts
node:net:1918
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T/tsx-501/20838.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1918:21)
    at listenInCluster (node:net:1997:12)
    at Server.listen (node:net:2119:5)
    at file:///Users/alastairfraser/Documents/Codex/Agent%20Control%20Room/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs:53:31472
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/alastairfraser/Documents/Codex/Agent%20Control%20Room/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs:53:31450)
    at async file:///Users/alastairfraser/Documents/Codex/Agent%20Control%20Room/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs:55:500 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T/tsx-501/20838.pipe',
  port: -1
}

Node.js v22.22.3
[ELIFECYCLE] Command failed with exit code 1.
```

This is the packet's documented managed-sandbox-only IPC restriction. I did not request permission escalation. I used only the explicitly permitted installed Node-loader invocation of the same verifier.

## Retained unqualified boundaries

The following remain unqualified regardless of this repository disposition:

- production rollback-checkpoint custody;
- live provider authentication, runner, IPC, OS isolation, and egress;
- Telegram bot, webhook, chat, and transport;
- protected Completion deployment;
- CR-7B native proof;
- MCP deployment;
- CR-6E owner acceptance;
- Claude discovery; and
- macOS CR-5C.9H.

Owner recovery, split-host transitions, production key custody, live credential lifecycle, and any owner-attended/native qualification also remain outside this review. No repository result converts any proposal, fact, receipt, or view into approval or execution authority.

## Post-report snapshot and cleanup verification

After creating this report I rechecked the packet and every prior-report anchor, confirmed the temporary private test file was absent, reran `git diff --check`, and recomputed the dirty-tree fingerprints while excluding only this report. The tracked diff, ordered untracked manifest/content manifest, sorted full-status hash, and 158-entry count matched dispatch exactly. This report is the sole reviewer-created repository file; no pre-existing repository file changed.

## Final disposition

`accepted_effect_free_repository_snapshot`
