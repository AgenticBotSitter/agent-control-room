# CR-8Q binary-remediation fifth independent re-review

**Block:** CR-8Q-006
**Review date:** 2026-08-29
**Review mode:** fifth independent defensive security review; effect-free repository boundary only
**Required model / effort:** `gpt-5.6-sol` / `max`

## Executive result

The narrow exploit reported as `CR8Q-PRR-F01` is repaired: a `SharedArrayBuffer`-backed `Uint8Array` with an own `buffer` getter is rejected through captured intrinsics without executing the getter. The same is true for all ten packet-listed hostile shapes at the real Bitwarden runner, real 1Password runner, destination-native resolver, and direct-broker provider seams. The prior Proxy and synchronous-collector repairs also remain effective.

The complete binary boundary is nevertheless not acceptable. An exact-prototype `Uint8Array` subview over a larger ordinary `ArrayBuffer` is accepted at all four required seams. Only the visible subview is wiped; bytes in the same backing store outside the view survive. This new high-severity defect is `CR8Q-BRR-F01`. It reopens `CR8Q-F08` and directly contradicts the frozen packet's requirement to reject widened backing stores.

No live, native, credential, Telegram, deployment, approval, or execution authority follows from this review.

## Reviewed snapshot and independence

The review began with the required report path absent and these anchors intact:

| Anchor | Reviewed value |
| --- | --- |
| Branch | `integration/cr5d-synthetic-executor-1` |
| Git base `HEAD` | `14de468999b1ebf4584c13026114d40a0f66cea7` |
| Frozen packet SHA-256 | `5c411da9d8650a4e54b2dcde43154d2d3d927cd4347896fa09b51582ae6c563f` |
| Fourth-review report SHA-256 | `36cc52df04b2ec91000f0edc9d136ea248be90d6966f8c54b7ab44aaf2e88c39` |
| Tracked `git diff --binary` SHA-256 | `b5abf3c591208647a750abba9ceb267781f526beea16356ad5686aac3525f011` |
| Ordered untracked-file manifest SHA-256 | `ca033694e07b1f538ca96495f222f8fff4d926df3d5c52311f41687c86657165` |
| `git status --short` SHA-256 | `c43c8fa38e2f2ad047574857b0edf6010a655a92fd9b1fa5366c6b35e0e8d270` |
| Required report at dispatch | Absent |

I am distinct from the CR-8 implementation and remediation authors and from the four prior independent reviewers, including Darwin, Kant, Cicero, and Hegel. I did not delegate any review work, communicate with a prior reviewer, implement or repair anything, or accept my own change. I read the four immutable negative reports and architect review only because the frozen packet requires them as review evidence.

I read `AGENTS.md`, `docs/BUILD_STATUS.md`, the complete delegation-review skill, the complete frozen packet, the relevant CR-8 architecture/security/durability contracts, every packet-minimum source and test target, all four prior independent reports, and the architect review. Conclusions below combine direct source inspection, installed deterministic commands, and separately constructed synthetic in-process probes; they do not treat producer claims or prior-review conclusions as acceptance authority.

## Write, effect, and cleanup boundary

The only repository write made by this reviewer is this report. I did not edit source, tests, contracts, fixtures, migrations, status, or any prior report. I did not commit, push, switch branches, change Git state, install anything, or use a network, GitHub, an account, credentials, a native provider, password manager, Keychain/vault, bot, webhook, chat, service, deployment, listener, plugin, MCP, or consequential effect.

All independent attacks used synthetic in-process objects and byte arrays with the installed dependency tree. No temporary private file was created, so no temporary-file deletion was required. The one custom matrix false start was in-process and exited before the 1Password case because the synthetic label `onepassword` triggered the repository's secret redaction guard with `credential invocation grant contains secret material at $.invocationId`. It created no file or effect. The matrix was rerun with the safe label `op` and completed. All temporarily replaced JavaScript globals were restored in `finally` blocks, all probe-owned buffers were zeroed, and the post-review filesystem check found no reviewer temporary artifact.

## New finding

### `CR8Q-BRR-F01` — an ordinary typed-array subview bypasses widened-backing rejection

**Severity:** High
**Earlier family reopened:** `CR8Q-F08` provider/config/result exactness
**Affected seams:** Bitwarden runner output, 1Password runner output, destination-native resolver material, and direct-broker provider material

`exactHostUint8ArrayV1` correctly uses captured `%TypedArray%` and `ArrayBuffer` getters, exact prototypes, backing-store own-key checks, dense indexed view keys, and captured byte methods. Its bounds condition is incomplete, however. At `src/security/host-value.ts:120-153`, and specifically line 135, it rejects only when:

```ts
byteOffset + byteLength > bufferByteLength
```

That verifies containment, not an exact full-store view. It accepts a nonzero offset and accepts a backing store longer than the visible view. The supplied helper at `tests/proxy-test-helper.ts:26-60` has ten attack modes but no actual widened ordinary subview, despite two supplied test titles claiming widened-view coverage.

The independent probe constructed:

```ts
const backing = new ArrayBuffer(7);
const whole = new Uint8Array(backing);
whole.set([91, 65, 66, 67, 93, 94, 95]);
const candidate = new Uint8Array(backing, 1, 3);
```

The candidate has exactly `Uint8Array.prototype`, dense own keys `0`, `1`, and `2`, no extra own keys, and an exact zero-own-key `ArrayBuffer.prototype` backing store. The host guard returned an observer instead of rejecting it. The backing bytes changed from `[91,65,66,67,93,94,95]` to `[91,0,0,0,93,94,95]` after boundary cleanup: the visible credential bytes were wiped, but all four bytes outside the view survived.

The same candidate produced this real-seam evidence:

| Seam | Acceptance and handoff | Cleanup and replay |
| --- | --- | --- |
| Bitwarden runner | Accepted as completed output; next layer received isolated `[65,66,67]` | Visible source became `[0,0,0]`; backing remained `[91,0,0,0,93,94,95]`; owned copy was later zeroed; exact replay made zero additional runner calls |
| 1Password runner | Accepted as completed output; next layer received isolated `[65,66,67]` | Same surviving backing bytes and owned-copy wipe; exact replay made zero additional runner calls |
| Destination-native resolver | Accepted as resolved material; next layer received an isolated copy | Original release ran exactly once; visible source and owned copy were zeroed; out-of-view backing bytes survived; replay made zero additional resolver calls |
| Direct broker provider | Accepted; consumer ran once and produced a terminal success receipt | Provider release ran exactly once; visible source and consumer copy were zeroed; out-of-view backing bytes survived; exact replay made zero additional acquisitions |

Copy isolation, once-only release, terminal replay, and cleanup of each owned visible view therefore work after acceptance. They do not cure the antecedent boundary failure: the packet requires the widened store to be rejected, and cleanup does not cover the accepted source's complete backing store.

The smallest repair direction is to require, through the already captured intrinsics, both `byteOffset === 0` and `bufferByteLength === byteLength` before accepting a view. Regressions must construct genuine exact-prototype subviews over larger ordinary backing stores, including both nonzero-offset and zero-offset/short-length forms, at all four real seams. This reviewer did not apply that repair. A different eligible independent reviewer must repeat the full frozen boundary after remediation.

## Independent binary-boundary evidence

### Mandatory ten-shape matrix

I constructed all ten hostile shapes independently and drove each through a broker using the actual Bitwarden provider adapter, actual 1Password provider adapter, actual destination-native provider adapter, and a direct synthetic provider implementation. This produced 40 seam/case executions.

| Hostile shape | Bitwarden runner | 1Password runner | Destination-native | Direct broker |
| --- | --- | --- | --- | --- |
| `SharedArrayBuffer`-backed `Uint8Array` | rejected / 0 getters or traps | rejected / 0 | rejected / 0 | rejected / 0 |
| Shared view with own `buffer` getter returning ordinary buffer | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Shared view with own `buffer` data property | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Ordinary view with own `byteLength` getter | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Ordinary view with own `byteLength` data property | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| `Uint8Array` subclass | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Ordinary view with replaced prototype | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Detached ordinary backing store | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Ordinary backing buffer with own `constructor` getter | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |
| Own `at`, `fill`, `set`, `slice`, and iterator getters | rejected / 0 | rejected / 0 | rejected / 0 | rejected / 0 |

Aggregate observations were:

- Bitwarden: 10 runner calls, 10 terminal ambiguous receipts, zero consumer calls, zero getter/trap executions, bounded source cleanup, and zero runner calls on exact replay.
- 1Password: 10 runner calls, 10 terminal ambiguous receipts, zero consumer calls, zero getter/trap executions, bounded source cleanup, and zero runner calls on exact replay.
- Destination-native: 10 resolver calls, 10 terminal ambiguous receipts, zero consumer calls, zero getter/trap executions, exactly 10 original releases, bounded source cleanup, and zero resolver calls on exact replay.
- Direct broker: 10 acquisitions, 10 `ambiguous/provider_result_invalid` receipts, zero consumer calls, zero getter/trap executions, exactly 10 releases, bounded source cleanup, and zero acquisitions on exact replay.
- Intrinsic wiping zeroed every still-attached actual typed-array view. The detached case was already unobservable. No hostile value reached a consumer.

The shared-view own-`buffer` getter case is the exact narrow `CR8Q-PRR-F01` exploit. Its getter count remained zero at every seam, confirming that the captured intrinsic buffer getter defeats that exploit.

### Expanded member and Proxy attacks

Separate one-property attacks installed an own getter for each of `buffer`, `byteLength`, `byteOffset`, `length`, `at`, `fill`, `set`, `slice`, and `Symbol.iterator`. Every candidate was rejected, every getter count remained zero, and each attached actual typed-array target was intrinsically wiped. A Proxy-wrapped `Uint8Array` was rejected with zero observed Proxy traps. The intrinsic wipe intentionally refused to touch that Proxy; the probe retained the target reference and zeroed it itself.

These results confirm that validation, copy, and wiping do not call attacker-selected members. They do not affect `CR8Q-BRR-F01`, whose candidate has no attacker-defined member and is accepted solely because the intrinsic offset/backing-length relation is underconstrained.

### Ordinary exact success and copy isolation

An exact whole-buffer `Uint8Array([65,66,67])` succeeded at every seam. The receiving trust layer's bytes did not share the source buffer. Bitwarden and 1Password wiped runner output and later wiped adapter/broker-owned copies. Destination-native copied before handoff, wiped the source, invoked original release exactly once, and later wiped the downstream copy. The direct broker copied before the consumer, wiped the consumer copy, invoked provider release exactly once, and exact replay did not reacquire.

### Cleanup and uncertainty paths

I exercised the following paths independently through the direct broker:

| Path | Observed terminal result | Cleanup / replay evidence |
| --- | --- | --- |
| Invalid outer provider envelope | `ambiguous/provider_result_invalid` | Discoverable source wiped; accepted release called once; consumer not called; replay acquired zero times |
| Invalid nested material | `ambiguous/provider_result_invalid` | Hostile actual typed array wiped when possible; release once; consumer not called; replay acquired zero times |
| Forced copy failure | `ambiguous/provider_result_invalid` | Source wiped; release once; consumer not called; replay acquired zero times; temporarily replaced `globalThis.Uint8Array` restored in `finally` |
| Provider release throws | `ambiguous/consumer_or_cleanup_outcome_unknown` | Source and consumer copy wiped; release attempted once; replay acquired zero times |
| Consumer throws | `ambiguous/consumer_or_cleanup_outcome_unknown` | Source and consumer copy wiped; release once; replay acquired zero times |

Provider collector absence, duplicate, late submission, throw-before, throw-after, and Proxy-then-ordinary recovery attempts all became terminal `ambiguous/provider_outcome_unknown`. Each invoked the provider once and the consumer zero times. Duplicate and throw-after had one accepted first value and therefore exactly one release; absence, throw-before, late, and Proxy-then-ordinary had no accepted value and therefore no release. The rejected Proxy executed zero traps, the attempted ordinary recovery was also rejected after collector invalidation, late submission could not change terminal truth, and exact replay reacquired zero times.

The same six modes at the consumer collector all became terminal `ambiguous/consumer_or_cleanup_outcome_unknown`. Each acquired once, called the consumer once, released exactly once, wiped source and consumer copies, executed zero Proxy traps, rejected late or recovery submissions, and reacquired zero times on exact replay.

## Prior Proxy/collector repair determination

The installed `test:cr8q` matrix and direct source inspection repeated the prior four-mode transparent, key-hiding, descriptor-fabricating, and throwing Proxy attacks:

| Seam | Determination |
| --- | --- |
| Consumer result | Zero traps; no Proxy-derived terminal success; terminal ambiguity; material cleanup once; non-reacquiring replay |
| Provider result envelope | Zero traps; terminal ambiguity; accepted material cleanup bounded and once-only |
| Provider array/provider wiring | Zero traps; construction rejected before method capture or acquisition |
| Fixed-consumer result and wiring | Zero traps; rejected before terminal truth or credential use |
| Runner result and nested stdout | Zero traps; rejected before resolved material handoff |
| Destination-native result | Zero traps; rejected before handoff; accepted first acquisition cleaned and released once on collector misuse |
| Telegram settlement | Zero traps; rejected as `invalid_record`; delivery state stayed `sending`; a later ordinary settlement remained possible |
| Rollback checkpoint | Zero traps; rejected before validation or state mutation |

Together with the independent six-mode provider/consumer collector probes above, this verifies `CR8Q-SR-F01` and the synchronous collector repair. It does not cure the non-Proxy subview accepted by `CR8Q-BRR-F01`.

## Complete CR-8Q authority, durability, Telegram, and secret boundaries

Direct implementation inspection plus the focused 116-case CR-8Q suite repeated the earlier attacks:

### Completion and negative authority

- Completion creation and decision use captured trusted time; a newly submitted backdated request is rejected.
- Named verification, deterministic risk floors, review independence, correlated-reviewer serialization, and immutable semantic replay remain enforced.
- Consequential approval still requires exact policy, human identity, active strong factor, grant lifetime/revocation, project, effect, risk, and decision-time binding. Quality acceptance cannot substitute for approval.
- Identical record IDs remain tenant-scoped. Append-only rows reject mutation and recomputed ordinary digests without the external integrity key.
- Authenticated complete tenant state plus the external checkpoint reject privileged deletion, complete erasure, and restoration of an older internally valid snapshot. Checkpoint functions are captured, and checkpoint Proxies execute zero traps.
- Completion facts and every Completion UI projection remain negative authority: the view presents evidence and has no approval or execution control.

### Telegram

- Callback registration and consumption recheck current tenant/project, message class, deterministic/effective risk, recipient ceiling, verified-at lower bound, expiry, chat binding, and exact callback-to-plan containment before mutation.
- Future-dated recipient policy cannot enqueue or reach `sending`; a queued item under a future or revoked replacement is dead-lettered before transport.
- Callback key and verification functions are captured. One unambiguous callback-ID/token grammar applies from issue through lookup/authentication. Exact replay is stable; drift, reuse, wrong chat, wrong MAC, future issue, and expiry fail closed.
- Callback observations, callbacks, recipient policy history, recipient current state, delivery state, and integrity state are authenticated as complete tenant state. Deletion, tampering, total erasure, and older valid restoration fail against the external checkpoint.
- Delivery settlement remains exact and idempotent. Only definite failures retry; ambiguous or expired claims do not auto-retry. Settlement Proxies execute zero traps and make no mutation.
- Telegram callbacks remain response proposals only, with `grantsApproval: false`, `grantsExecutionAuthority: false`, and independent policy evaluation required. High/critical messages deep-link to the authenticated dashboard, and the UI supplies no consequential authority control.
- Webhook-secret and synthetic transport tests were repository-local only; no bot, webhook, chat, or transport was contacted.

### Secret broker and durable ledger

- The safe catalog keeps reference metadata only, deep-clones/freezes nested scope, uses monotonic replacement, and cannot be mutated to widen authority.
- Grants derive only from an accepted exact local admission and exact current catalog scope; caller-computed grants are not node-local authority. Fixed-consumer routing prevents caller-supplied credential handlers.
- Provider, runner, resolver, consumer, and checkpoint functions are captured against later mutation. Provider uncertainty, consumer uncertainty, cleanup uncertainty, clock rollback during use, and expiry during use settle terminally ambiguous.
- Terminal receipts replay before new claim/catalog/expiry work, remain isolated, survive restart, and do not reacquire. A claimed invocation after restart becomes terminal ambiguity.
- Private SQLite path, permissions, key, identity, exact schema, authenticated rows, file replacement, missing/empty/recreated/older files, added schema, restart ambiguity, and clock high-water attacks remain fail-closed against the external checkpoint.
- Credential receipts persist no material and retain `grantsApproval: false` and `grantsExecutionAuthority: false`.
- The sole secret-boundary failure observed is the widened ordinary backing store in `CR8Q-BRR-F01`; no live provider eligibility is established.

## Finding-family determinations

| Finding | Determination |
| --- | --- |
| `CR8Q-PRR-F01` | Narrow exploit `verified_repaired`: shared backing plus an own `buffer` getter is rejected with zero getter execution at all four real seams. The larger binary-remediation claim fails separately under `CR8Q-BRR-F01`. |
| `CR8Q-SR-F01` | `verified_repaired`: host Proxy detection and synchronous collectors reject the repeated Proxy/collector matrices with zero traps, terminal uncertainty, bounded cleanup, and non-reacquiring replay. |
| `CR8Q-RR-F01` | `verified_repaired`: accessor, inherited, symbol, non-enumerable, hidden, and extra consumer-result shapes become ambiguity without getter execution. |
| `CR8Q-IR-F01` | `verified_repaired`: explicit provisioning, captured external checkpoints, complete-erasure rejection, and older-valid-snapshot rejection hold for Completion and Telegram. |
| `CR8Q-IR-F02` | `verified_repaired`: catalog inputs and returned nested scope metadata remain isolated and frozen. |
| `CR8Q-IR-F03` | `verified_repaired`: missing, empty, recreated, replaced, and older private SQLite ledgers fail against external state. |
| `CR8Q-IR-F04` | `verified_repaired`: callback consumption rechecks current project, class, risk, verification time, expiry, and chat. |
| `CR8Q-IR-F05` | `verified_repaired`: callback registration binds the exact plan and current class/risk ceilings. |
| `CR8Q-IR-F06` | `verified_repaired`: future-dated recipient policy cannot enqueue or reach sending. |
| `CR8Q-IR-F07` | `verified_repaired`: one callback ID/token grammar is enforced end to end. |
| `CR8Q-F01` | `held`: Completion request/decision creation uses captured trusted time. |
| `CR8Q-F02` | `held`: authenticated complete Completion state and the external checkpoint reject deletion and rewind. |
| `CR8Q-F03` | `held`: consequential approval lifetime, revocation, strong-factor, identity, policy, project, effect, and risk bindings remain enforced. |
| `CR8Q-F04` | `held`: Telegram rejects future and stale observations under ingress-owned time. |
| `CR8Q-F05` | `held`: callbacks remain contained to their exact message plan and response choice. |
| `CR8Q-F06` | `held`: callback key/verifier remain captured and no request-selected key is accepted. |
| `CR8Q-F07` | `held`: protected Telegram row sets remain in authenticated complete state and external rollback protection. |
| `CR8Q-F08` | `reopened`: `CR8Q-BRR-F01` accepts an exact-prototype subview over a widened ordinary backing store at every required material seam. |
| `CR8Q-F09` | `held`: the durable ledger authenticates and advances its monotonic clock high-water. |
| `CR8Q-F10` | `held`: provider, runner, resolver, consumer, and checkpoint trusted functions remain captured. |
| `CR8Q-F11` | `held`: terminal replay remains isolated, precedes redispatch work, and does not reacquire. |
| `CR8Q-F12` | `held`: ordinary Telegram settlement replay requires exact semantics; rejected Proxy settlement does not mutate. |

## Deterministic command evidence

The installed package manager was `pnpm 11.19.0`. Every frozen command was run against the installed dependency tree.

| Command | Exit | Observed result |
| --- | ---: | --- |
| `pnpm run check` | 0 | `tsc --noEmit`; no diagnostics |
| `pnpm run lint` | 0 | `eslint . --ignore-pattern dist --ignore-pattern .next`; no diagnostics |
| `pnpm run test:cr8e` | 0 | 50 tests; 50 passed; 0 failed/skipped |
| `pnpm run test:cr8q` | 0 | 116 tests; 116 passed; 0 failed/skipped |
| `pnpm run pretest` | 0 | 161 tests; 161 passed; 0 failed/skipped |
| `pnpm test` | 0 | 416 tests total; 414 passed; 0 failed; 2 intentional platform skips; 2 suites |
| `pnpm run test:build` | 0 | Build completed; 2 rendered-route tests passed |
| `pnpm run db:verify` | 1 | Known managed-sandbox `tsx` IPC denial reproduced exactly below |
| `node --import tsx scripts/verify-migrations.ts` | 0 | Sole permitted same-verifier fallback; migrations `0001` through `0024`; 82 PostgreSQL tables |
| `git diff --check` | 0 | No output |

The first migration-verifier failure was:

```text
$ tsx scripts/verify-migrations.ts
node:net:1918
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T/tsx-501/8047.pipe
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
  address: '/var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T/tsx-501/8047.pipe',
  port: -1
}

Node.js v22.22.3
[ELIFECYCLE] Command failed with exit code 1.
```

This is the packet's known managed-sandbox-only IPC restriction. No permission or network fallback was used. The allowed Node loader executed the same `scripts/verify-migrations.ts` verifier successfully.

## Retained unqualified boundaries

The following remain unqualified regardless of repository remediation:

- production rollback-checkpoint custody;
- live provider authentication, runner, IPC, OS isolation, and egress;
- Telegram bot, webhook, chat, and transport;
- protected Completion deployment;
- CR-7B native proof;
- MCP deployment;
- CR-6E owner acceptance;
- Claude discovery; and
- macOS CR-5C.9H.

## Post-report snapshot and cleanup verification

After creating this report, the packet and fourth-review hashes remained unchanged. Recomputing the tracked diff, ordered untracked manifest, and short status while excluding only this new report reproduced all three dispatch hashes. The report is the sole reviewer-created repository file; no existing file changed, and no reviewer temporary file remained.

## Final disposition

`remediation_required`
