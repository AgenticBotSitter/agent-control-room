# CR-8Q Proxy-remediation fourth independent re-review

**Block:** CR-8Q-005
**Date:** 2026-08-28
**Mode:** Independent, effect-free repository review
**Disposition:** `remediation_required`
**Required model / effort:** `gpt-5.6-sol` / `max`

## Reviewed snapshot and independence

This reviewer was appointed after explicit owner authorization and is different from every CR-8 implementation or remediation author and from the three prior CR-8Q reviewers. The reviewer did not author or repair implementation, tests, contracts, fixtures, migrations, status, or prior reports.

The reviewed owner-held snapshot was:

- branch `integration/cr5d-synthetic-executor-1`;
- Git base `14de468999b1ebf4584c13026114d40a0f66cea7` plus the dirty CR-8/CR-8Q working tree frozen at dispatch;
- packet SHA-256 `cb23cb925d28b8c5affe4d22eed1329843079e90e4cf714bee45e35d4e9b95c8`;
- prior-report anchor `CR8Q_SECOND_REREVIEW.md` SHA-256 `e2354607180d6c7058aa1643dcd3f9b3dbdc70b45a10d93213ed28c05aedb588`;
- tracked binary-diff SHA-256, excluding this report, `4a3fe4a261497a8990302f2ded24fb72435aa9aa9c38929ce8d2542a495a46e4`;
- ordered untracked-file manifest SHA-256, excluding this report, `3e97d0e8644be7379cd8198382f7b32481cc4c896188ab9ab5dd9e6a4f3d35d7`; and
- short-status SHA-256, excluding this report, `c43c8fa38e2f2ad047574857b0edf6010a655a92fd9b1fa5366c6b35e0e8d270`.

The packet and prior-report hashes matched their dispatch anchors before review. The three earlier negative independent reports were not edited.

## Write, effect, and cleanup boundary

The only repository file created by this reviewer is this report. No product source, test, fixture, contract, dependency, Git state, or prior report was changed. The review used installed dependencies, repository reads, existing deterministic tests, and one synthetic in-process JavaScript correctness probe. It used no network, GitHub, account, credential, provider process, Keychain or vault, bot, webhook, chat, service, listener, deployment, or external effect.

The probe used only three synthetic numeric bytes. It created no repository or temporary test file. Its shared source view was zeroed by the current adapter after the accepted copy, and the copied acquisition was released and zeroed. The test suites removed their own disposable stores. No private test artifact remained at handoff.

## Overall determination

The `CR8Q-SR-F01` repair works for the top-level Proxy cases and result-collector misuse represented by the focused suite. Transparent, key-hiding, descriptor-fabricating, and throwing Proxies are rejected with zero observed traps at the consumer, provider, provider wiring, fixed-consumer, runner, destination-native, Telegram settlement, and rollback-checkpoint seams. Missing, duplicate, late, throw-before, throw-after, and Proxy-then-ordinary collector misuse remains terminal, and safely accepted material is wiped and released once.

The complete CR-8Q boundary is nevertheless not acceptable. A separately constructed real-seam probe showed that a shared-memory typed-array result can shadow its inherited `buffer` property with an own getter. The Bitwarden adapter executes that getter, trusts the getter's ordinary `ArrayBuffer` return instead of the typed array's actual internal backing store, and accepts the `SharedArrayBuffer`-backed output as resolved credential material. This is `CR8Q-PRR-F01`; it reopens `CR8Q-F08` and contradicts the packet's required shared-buffer and behavior-free result exactness.

The packet requires a reviewer to document and stop on a new defect. No repair was attempted. The existing complete deterministic suite was still run to establish the exact baseline.

## New finding

### `CR8Q-PRR-F01` — a typed-array own-property shadow executes behavior and bypasses shared-buffer rejection

**Severity:** High
**Affected boundary:** Bitwarden and 1Password injected-runner result validation; the same direct binary-property pattern also appears in provider material validation.
**Earlier family reopened:** `CR8Q-F08` provider/config/result exactness.

`src/secret-broker/v1/provider-adapters.ts:25-30` first snapshots the outer result envelope, but treats its nested `stdout` value as safe when it is a non-Proxy `Uint8Array`. The shared-buffer test at line 29 reads `stdout.buffer` as an ordinary JavaScript property. A typed array may define an own `buffer` accessor or data property that shadows the intrinsic typed-array getter. `src/secret-broker/v1/provider-adapters.ts:22-24` likewise reads `stdout.byteLength` directly after validation.

The independent synthetic real-seam probe did the following:

1. Created a three-byte `Uint8Array` whose actual backing store was a `SharedArrayBuffer`.
2. Defined an own `buffer` getter on that view. The getter incremented a counter and returned a new ordinary `ArrayBuffer`.
3. Submitted the view inside an otherwise exact `completed` runner envelope through the real `BitwardenSecretProviderV1` runner collector.
4. Observed this sanitized result:

```json
{"status":"resolved","getterCalls":1,"material":[65,66,67],"sharedAfter":[0,0,0]}
```

The adapter therefore executed user-defined validation behavior once and accepted bytes originating from a backing store the contract requires it to reject. The later wipe does not restore the rejected invariant: another holder of the shared buffer can race the validation/copy boundary, and the provider has already classified a prohibited result as resolved.

The failure is possible because `instanceof Uint8Array` authenticates neither the typed array's exact prototype/property shape nor the value returned by a normal `stdout.buffer` property read. Host Proxy detection does not cover this non-Proxy accessor case.

**Smallest safe remediation direction:** obtain buffer identity and length only through captured typed-array intrinsics applied to the candidate, reject incompatible/detached/shared backing stores from those intrinsic observations, and copy once into broker-owned bytes before later processing. Reject own-property or prototype widening that can shadow binary metadata. Add runner and destination-native regressions for own `buffer` and `byteLength` accessors/data properties, subclasses/prototype drift, detached buffers, and shared backing stores, proving zero getter calls, no accepted acquisition, bounded wiping, and terminal replay without reacquisition. A different independent reviewer must verify the repair.

## Proxy trap and real-seam evidence

The focused suite independently executed the repository's current matrices and observed the following passing assertions:

| Seam | Shapes exercised | Observed boundary result |
|---|---|---|
| Direct consumer results | transparent, key-hiding, descriptor-fabricating, throwing | zero traps; terminal ambiguity; one acquisition, wipe, and release; replay did not reacquire |
| Direct provider results and provider object/array wiring | same four result modes; throwing wiring Proxies | zero traps; terminal provider ambiguity or construction rejection; consumer did not run |
| Fixed-consumer result, consumer object, and route array | key-hiding/throwing | zero traps; ambiguity or construction rejection |
| Provider configuration, bindings array, binding, runner, resolver | throwing | zero traps; construction rejection |
| Runner result and nested stdout | four top-level modes plus throwing nested Proxy | zero traps; result rejected |
| Destination-native result | four modes | zero traps; result rejected |
| Telegram settlement | four modes | zero traps; no delivery mutation; an ordinary settlement afterward succeeded |
| Rollback checkpoint | four modes | zero traps; checkpoint rejected |

These results verify the narrow Proxy repair. `CR8Q-PRR-F01` proves that the broader behavior-free exact-data claim still fails for a non-Proxy typed-array wrapper at an affected real seam.

## Result-collector misuse and cleanup evidence

Static inspection of `createHostResultCollectorV1` and the passing focused tests established:

- absence and throw-before-submit cannot produce a result;
- a second submission invalidates the collector;
- a post-return submission conflicts and cannot change terminal truth;
- throw-after-submit and duplicate submission preserve the first accepted value only for abort cleanup;
- a rejected Proxy makes the collector invalid, so a later ordinary submission cannot recover it;
- broker consumer/provider misuse becomes terminal ambiguity and exact replay does not reacquire;
- runner duplicate/throw-after cases wipe the first accepted stdout buffer; and
- destination-native duplicate/throw-after cases wipe and release the first accepted material exactly once.

Ordinary exact success, definite failure, and ambiguity remained accepted. Cleanup failure, expiry during consumption, broker-clock rollback, terminal replay, durable restart ambiguity, and durable non-reacquisition remained passing. This collector determination does not cure `CR8Q-PRR-F01`, which occurs after one ordinary outer envelope has been accepted and while its nested binary value is being validated.

## Earlier finding determinations

| Finding | Determination on this snapshot |
|---|---|
| `CR8Q-SR-F01` | `verified_repaired_for_Proxy_inputs`; the host check and collectors stop the tested Proxy envelopes with zero traps. Overall ordinary-data acceptance remains blocked by `CR8Q-PRR-F01`. |
| `CR8Q-RR-F01` | `verified_repaired`; accessor, inherited, symbol, hidden, non-enumerable, and extra consumer-result shapes still become terminal ambiguity without getter execution. |
| `CR8Q-IR-F01` | `verified_repaired`; Completion and Telegram explicit provisioning, external checkpoints, total-erasure rejection, and older-valid restoration rejection pass. |
| `CR8Q-IR-F02` | `verified_repaired`; catalog inputs and returned scope metadata remain isolated/frozen and cannot widen an invocation. |
| `CR8Q-IR-F03` | `verified_repaired`; missing, empty, recreated, and older SQLite ledgers remain rejected against the external checkpoint. |
| `CR8Q-IR-F04` | `verified_repaired`; callback consumption rechecks current project, class, risk, verification time, expiry, and chat policy. |
| `CR8Q-IR-F05` | `verified_repaired`; callback registration binds and enforces current class/risk ceilings. |
| `CR8Q-IR-F06` | `verified_repaired`; future recipient policy cannot enqueue or reach sending. |
| `CR8Q-IR-F07` | `verified_repaired`; one callback ID/token grammar remains enforced end to end. |
| `CR8Q-F01` | `held`; Completion request and decision creation still use captured trusted time. |
| `CR8Q-F02` | `held`; Completion deletion/rewind is covered by authenticated complete state and the external checkpoint. |
| `CR8Q-F03` | `held`; approval lifetime, revocation, strong-factor, identity, policy, project, effect, and risk bindings remain enforced. |
| `CR8Q-F04` | `held`; Telegram rejects future and stale callback observations under ingress-owned time. |
| `CR8Q-F05` | `held`; callbacks remain contained to their exact message plan and response choice. |
| `CR8Q-F06` | `held`; callback verification key/function remain captured and no request-selected key is accepted. |
| `CR8Q-F07` | `held`; all protected Telegram row sets remain included in authenticated complete state and the external checkpoint. |
| `CR8Q-F08` | `reopened`; see `CR8Q-PRR-F01`. A nested typed-array accessor executes and hides shared backing memory from the runner result guard. |
| `CR8Q-F09` | `held`; the durable credential ledger still authenticates and advances its trusted-time high-water. |
| `CR8Q-F10` | `held` for the previously named provider, runner, resolver, consumer, and checkpoint method-capture attacks. |
| `CR8Q-F11` | `held`; terminal receipt replay remains isolated, precedes catalog/expiry/claim work, and does not reacquire. |
| `CR8Q-F12` | `held`; ordinary Telegram settlement replay requires exact semantic fields, and rejected Proxy settlement makes no mutation. |

## Authority, durability, secret, and Telegram determinations

### Authority

Completion review, verification, preference, and consequential approval remain separate types and persistence records. Deterministic risk floors, strong-factor grant binding, grant lifetime/revocation, reviewer independence, tenant separation, and bounded revision lineage passed. No Completion fact, UI projection, Telegram response, credential receipt, or provider result grants approval or execution authority.

`CR8Q-PRR-F01` does not manufacture a local admission, widen catalog scope, or mint approval. It does break the provider-result trust boundary after an admitted invocation by allowing prohibited shared runner output to become credential material.

### Durability and replay

Completion and Telegram authenticated complete-state checkpoints, secret-ledger exact schema/path/key/identity checks, total erasure, older valid restoration, file replacement, restart ambiguity, terminal replay, and clock high-water tests passed. Split database/checkpoint commits remain fail-closed and owner-recovery-only rather than accepted production proof.

### Secret and cleanup

Catalog isolation, exact grant scope, provider/config envelope checks other than the new nested binary defect, trusted function capture, material wiping, one-time cleanup, safe receipts, terminal replay, durable non-reacquisition, and canary absence passed. The independent probe used synthetic bytes only and observed both the source shared view and released copy zeroed. The finding is still security-significant because the shared backing store was accepted and user-defined validation behavior executed before that cleanup.

### Telegram proposal-only boundary

Telegram remains presentation and bounded response-proposal only. Current project/class/risk/time policy, callback-plan containment, captured callback key, callback grammar, replay, authenticated complete state, future-policy rejection, delivery settlement, erasure, and older-valid restoration tests passed. Proxy settlements executed zero traps, changed no delivery, and ordinary follow-up settlement succeeded. No Telegram response satisfies strong-factor approval, emits a node attestation, issues a credential, or executes work.

## Deterministic command evidence

Environment: Node `v22.22.3`, pnpm `11.19.0`, existing frozen dependency tree.

| Command | Exit | Observed evidence |
|---|---:|---|
| `pnpm run check` | 0 | TypeScript completed with no diagnostic. |
| `pnpm run lint` | 0 | ESLint completed with no diagnostic. |
| `pnpm run test:cr8q` | 0 | 113 tests, 113 passed, 0 failed, 0 skipped. |
| `pnpm run pretest` | 0 | 158 tests, 158 passed, 0 failed, 0 skipped. |
| `pnpm test` | 0 | The package lifecycle first repeated pretest successfully; the main suite reported 416 total, 414 passed, 0 failed, and 2 intentional platform skips. |
| `pnpm run test:build` | 0 | Production build completed; 2 rendered-route tests passed. |
| `pnpm run db:verify` in the managed sandbox | 1 | `Error: listen EPERM: operation not permitted <local-temp>/tsx-501/50730.pipe`; `code=EPERM`, `errno=-1`, `syscall=listen`. The verifier had not begun migration work. |
| Same `pnpm run db:verify` with permission limited to its temporary local IPC socket | 0 | Applied migrations `0001` through `0024`; verified 82 PostgreSQL tables. |
| `git diff --check` | 0 | No tracked whitespace error. |

The first inline probe attempt exited 1 before execution because top-level `await` was not supported by the evaluator's CommonJS transform. A wrapped retry exited 1 before execution because the managed sandbox denied the evaluator's local IPC socket. The final `node --import tsx -e` probe used no IPC listener, exited 0, and produced the sanitized failing observation recorded above. These setup failures did not touch repository or external state.

Passing deterministic gates do not override the independently reproduced boundary defect.

## Retained live, native, and deployment blockers

This report grants no live, native, credential, Telegram, deployment, approval, or execution authority. The following remain unqualified:

- production rollback-checkpoint custody, provisioning, split-commit recovery, and owner recovery;
- live provider authentication, native runner, authenticated IPC, key custody, actual binary/path/ownership proof, OS-identity isolation, broker-only egress, consumer egress denial, rotation/revocation, and provider-native cleanup;
- Telegram bot identity, credential, webhook, callback key custody, chat-ownership enrollment, transport, monitoring, and live behavior;
- protected Completion deployment, identity ingress, policy service, integrity-key custody, and separately signed node approval attestation;
- CR-7B native executor, process identity, provider-output authority, cancellation, descendant cleanup, and OS-isolation proof;
- northbound MCP transport, issuer/OAuth/TLS operation, protected deployment, and revocation/rotation operations;
- CR-6E owner acceptance;
- authenticated Claude discovery and acceptance;
- macOS CR-5C.9H native qualification; and
- every production service, credential, consequential effect, and owner-attended live canary.

## Required next step

Codex or another eligible implementation agent may repair `CR8Q-PRR-F01`; this reviewer must not. The repair should add intrinsic, behavior-free binary observation and real-seam regressions for typed-array property/prototype/shared/detached cases. After remediation, another different owner-authorized independent reviewer must repeat the complete CR-8Q boundary. The three earlier negative reports and this report remain immutable evidence.

## Final repository disposition

`remediation_required`
