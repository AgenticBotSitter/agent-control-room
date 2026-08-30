# CR-8Q second independent remediation re-review

**Review date:** 2026-08-28
**Disposition:** `remediation_required`
**Reviewed snapshot:** owner-held local snapshot at base commit `14de468999b1ebf4584c13026114d40a0f66cea7` on `integration/cr5d-synthetic-executor-1`, including the supplied dirty CR-8/CR-8Q working tree
**Reviewer independence:** This reviewer did not author or previously review CR-8Q and did not author either remediation.
**Effects and write scope:** Repository reads, static analysis, already-installed deterministic verification, temporary private SQLite files, and synthetic in-process objects only. No network, GitHub, account, credential, provider, Keychain/vault, native runner, bot, webhook, chat, transport, listener, service, deployment, or external effect was used. Temporary files were removed. This report is the only repository file written.

## Overall determination

The repair for `CR8Q-RR-F01` works for the accessor, inherited, symbol, non-enumerable, hidden, and ordinary-extra object shapes it claims to repair. All seven first-review remediations and the other architect findings remain closed under the packet's existing deterministic attacks.

The complete ordinary-data boundary is nevertheless not acceptable. A new Proxy attack reaches the real consumer seam and the provider-runner seam. The reflective validators execute Proxy traps, and a Proxy can hide a symbol or other widening while presenting an apparently exact property set. The broker recorded a Proxy consumer result as terminal success, and the provider adapter accepted a Proxy runner result as resolved. This is `CR8Q-SR-F01`. The candidate therefore requires remediation and another independent review.

## `CR8Q-RR-F01` repair determination

**Status:** `verified_repaired` for the object shapes identified by the first re-review. The broader ordinary-data guarantee still fails under the new Proxy finding below.

**Code evidence:**

- `src/secret-broker/v1/broker.ts:11-13` selects the result variant from an own data descriptor, snapshots the exact allowed field set, and sends only the snapshot to Zod.
- `src/secret-broker/v1/exact-data.ts:5-13` rejects an ordinary object's wrong prototype, symbol keys, hidden or non-enumerable fields, accessors, and extras without reading accessor values.
- `src/secret-broker/v1/broker.ts:37-43` combines malformed-result, cleanup, expiry, and clock uncertainty into one terminal ambiguous settlement. `:38` wipes the material and invokes release in `finally`.
- `src/secret-broker/v1/fixed-consumer.ts:9-11` captures a prewired consumer and exposes no caller-selected consumer code.
- `tests/secret-broker-contract.test.ts:81-93` covers the 18 claimed malformed combinations and the three exact ordinary terminal outcomes. Function capture and expiry/rollback are covered at `:105-113`.

**Independent attacks:**

- At the real broker seam, 24 malformed cases covered all three outcomes across outcome accessor, value accessor, inherited required fields, symbol widening, non-enumerable required fields, non-enumerable extras, accessor extras, and enumerable extras. Every case returned `ambiguous` with `consumer_or_cleanup_outcome_unknown`; zero getters ran.
- Each malformed invocation acquired and released once. Exact terminal replay performed no second acquisition, cleanup, or consumer call. Receipts retained literal `grantsApproval: false` and `grantsExecutionAuthority: false`.
- Exact ordinary success, definite failure, and ambiguity produced `succeeded`, `failed`, and `ambiguous`, respectively.
- A malformed result through `FixedConsumerSecretBrokerV1` remained terminal ambiguity.
- Credential-shaped canary material in hidden/accessor/symbol/extra positions did not appear in the receipt, safe ledger, or any file in the temporary durable-ledger directory. The matrix observed 28 acquisitions, 28 cleanups, zero getter calls, and zero replay reacquisitions.
- Existing deterministic cleanup-failure, expiry-during-consumption, and clock-rollback paths converge at `src/secret-broker/v1/broker.ts:37-40`; none creates a retry path.
- Call ordering is correct for ordinary objects: the raw result reaches only `ownDataValueV1` and `exactDataSnapshotV1` before the accepted snapshot is parsed, redacted, serialized, or persisted. Proxy reflection is the exception reported below.

## Prior-remediation determinations

| Finding | Determination | Independent code and test evidence |
|---|---|---|
| `CR8Q-IR-F01` | `verified_repaired` | Completion explicit provisioning, captured checkpoint functions, missing-head rejection, and compare-and-swap advancement are at `src/completion-gate/v1/store.ts:98-112,323-333`. Telegram applies the same boundary at `src/telegram/v1/durable-store.ts:47-57,210-243`. Migration `0024_cr8q_rollback_checkpoints.sql:4-10` adds monotonic revisions. Complete erasure, older valid snapshots, and method mutation pass at `tests/completion-gate-contract.test.ts:324-350` and `tests/telegram-durable-store.test.ts:188-209`. Split database/checkpoint states remain fail-closed and owner-recovery-only. |
| `CR8Q-IR-F02` | `verified_repaired` | `src/secret-broker/v1/catalog.ts:5-14` clones and freezes entries and all scope arrays on every storage/return seam. Grant creation and invocation recheck the exact current catalog ceiling at `src/secret-broker/v1/grant.ts:13-23` and `src/secret-broker/v1/broker.ts:26-31`. The mutation regression passes at `tests/secret-broker-contract.test.ts:34-40`. |
| `CR8Q-IR-F03` | `verified_repaired` | `src/secret-broker/v1/sqlite-ledger.ts:20-42` separates create/open and validates private path, schema, identity, and external checkpoint. `:57-64` authenticates state/high-water and advances the external checkpoint. Missing, empty, recreated, older-file, and checkpoint-function attacks pass at `tests/secret-broker-contract.test.ts:140-158`. |
| `CR8Q-IR-F04` | `verified_repaired` | Callback consumption locks and rechecks current project, class, risk, verification lower bound, expiry, and chat before durable mutation at `src/telegram/v1/durable-store.ts:99-123`. The narrowing races pass with zero proposal/update creation at `tests/telegram-durable-store.test.ts:169-176`. |
| `CR8Q-IR-F05` | `verified_repaired` | Callback registration binds the exact plan, lineage, class, risk, response choice, chronology, and recipient ceiling at `src/telegram/v1/durable-store.ts:83-96`. Disallowed-class and over-risk regressions pass at `tests/telegram-durable-store.test.ts:163-167`. |
| `CR8Q-IR-F06` | `verified_repaired` | Enqueue and claim enforce `verifiedAt <= now < policyExpiresAt`, and claim dead-letters a newly disallowed candidate before transport at `src/telegram/v1/durable-store.ts:126-153`. The future-policy regression passes at `tests/telegram-durable-store.test.ts:178-185`. |
| `CR8Q-IR-F07` | `verified_repaired` | One callback ID/token grammar is defined at `src/telegram/v1/schemas.ts:11-14` and used by issue, parse, lookup, MAC verification, and proposal creation at `src/telegram/v1/security.ts:24-58,66-78`. The end-to-end legal/illegal grammar matrix passes at `tests/telegram-security-contract.test.ts:124-128`. |

## Complete architect-boundary determination

| Architect finding | Second re-review determination |
|---|---|
| `CR8Q-F01` trusted-time approval creation | Held. Request and decision creation use the captured clock and reject either expiry boundary at `src/completion-gate/v1/store.ts:190-208`. |
| `CR8Q-F02` Completion row deletion | Held with the authenticated tenant state and external checkpoint at `src/completion-gate/v1/store.ts:323-333`. Complete erasure and older-state tests passed. |
| `CR8Q-F03` approval grant lifetime/revocation | Held. Exact policy, strong-factor, human identity, grant lifetime, project, effect, risk, and decision-time binding remain at `src/completion-gate/v1/store.ts:280-309`. |
| `CR8Q-F04` Telegram caller time/stale observation | Held. Consumption rejects future and more-than-five-minute-old observations at `src/telegram/v1/durable-store.ts:99-103`; ingress owns the clock. |
| `CR8Q-F05` callback-to-plan containment | Held at `src/telegram/v1/durable-store.ts:83-96`. |
| `CR8Q-F06` caller-selected callback key | Held. The key and verifier are captured at construction, and consumption accepts no key parameter at `src/telegram/v1/durable-store.ts:47-50,99-108`. |
| `CR8Q-F07` Telegram protected-row deletion | Held across all six row sets plus the external checkpoint at `src/telegram/v1/durable-store.ts:215-243`. |
| `CR8Q-F08` provider/config/result exactness | The listed prototype, descriptor, accessor, symbol, hidden, non-enumerable, shared-buffer, binary, and size attacks pass. The broader ordinary-data claim is not fully closed because Proxy results pass the same helper; see `CR8Q-SR-F01`. |
| `CR8Q-F09` ledger clock rollback | Held. Authenticated high-water and checkpoint material are verified and advanced at `src/secret-broker/v1/sqlite-ledger.ts:56-64`. |
| `CR8Q-F10` mutable trusted functions | Held for provider, runner, resolver, fixed consumer, and all checkpoint methods. The functions are captured/bound at construction (`src/secret-broker/v1/broker.ts:23-25`, `provider-adapters.ts:32-40`, `fixed-consumer.ts:9-11`). |
| `CR8Q-F11` terminal replay order/mutability | Held. An isolated terminal receipt is checked before catalog/expiry/claim work at `src/secret-broker/v1/broker.ts:27-31`; replay did not reacquire or rerun the consumer. |
| `CR8Q-F12` Telegram settlement drift | Held for ordinary objects. Settlement requires the exact field set and exact outcome/provider/reason/retry semantics at `src/telegram/v1/durable-store.ts:156-172,200-204`. The same Proxy-hardening rule identified below should also be applied to `exactInput` at `:45`. |

Completion reviewer independence, producer/reviewer separation, deterministic risk floors, exact target/profile/revision/finding binding, named verification, supersession, bounded revision, and the strong-factor approval path held in source and the focused tests. The Completion Gate view accepts digest/metadata-only strict input and always emits negative authority at `src/completion-gate/v1/view-model.ts:17-33,74-99`; `app/components/completion-gate-panel.tsx:20-68` contains no action control or artifact reader.

## New finding

### `CR8Q-SR-F01` — Proxy envelopes execute validation behavior and pass ordinary-data guards

**Severity:** Medium
**Affected boundary:** Exact ordinary-data validation for node-local consumer outcomes and provider/runner results; the same unsafe reflective pattern exists in Telegram settlement input validation.

**Exact file/line evidence:**

- `src/secret-broker/v1/exact-data.ts:5-19` calls `Object.getPrototypeOf`, `Reflect.ownKeys`, `Object.getOwnPropertyDescriptors`, and `Object.getOwnPropertyDescriptor` without first rejecting a Proxy. Each operation can invoke Proxy traps. A Proxy can report `Object.prototype`, hide configurable symbol/extra keys, and fabricate or forward acceptable data descriptors.
- `src/secret-broker/v1/broker.ts:11-13,34,37` trusts this helper for consumer and provider results and records the resulting terminal state.
- `src/secret-broker/v1/provider-adapters.ts:16-17,23-28,40` uses the same helper for provider configuration, runner results, and destination-native results.
- `src/telegram/v1/durable-store.ts:45,156-172` independently implements the same reflective plain-object test for transport settlement and then reads the raw input.
- `tests/secret-broker-contract.test.ts:81-93` and `tests/secret-provider-adapters.test.ts:35-39` cover ordinary objects only. A repository search found no Proxy or host-level Proxy-detection regression in these boundaries.

**Reproducible defensive tests and observations:**

1. Wrap an otherwise valid `succeeded` consumer result in a Proxy. Give it `getPrototypeOf`, `ownKeys`, and `getOwnPropertyDescriptor` traps that count calls and forward the expected descriptors. At the real broker seam, the result executed six traps and was persisted as `{state:"succeeded", safeCode:"completed"}`. Acquisition and cleanup each ran once.
2. Add a configurable symbol property to that target and let the `ownKeys` trap hide it. The helper cannot distinguish the Proxy from exact ordinary data, so the widening is normalized away rather than rejected.
3. Return an analogous Proxy from the injected Bitwarden runner, hiding a symbol field. The adapter executed ten traps and accepted the envelope as `resolved` with a three-byte synthetic material buffer.

These tests used only synthetic in-process data. No credential, executable, account, provider, or external effect was involved.

**Violated invariant:** `docs/CR8E_SECRET_BROKER_CONTRACT.md:50,58` requires ordinary exact result envelopes, rejects widening, and requires validation not to execute object behavior. `src/secret-broker/v1/exact-data.ts:1-3` describes the helper as an untrusted plain-data snapshot. A Proxy is not plain data, can execute code during those checks, and can make the inspected key/descriptor surface differ from its target.

**Authority and containment impact:** The consumer case still requires a valid prior local admission, catalog scope, provider acquisition, and claimed invocation. Its receipt remains literal negative authority; cleanup ran and no plaintext was observed in safe output or durable bytes. The defect can falsify terminal outcome classification and defeats the promised no-behavior exact-envelope check. At the runner seam it also defeats the claimed provider-envelope exactness. It does not by itself mint approval, node attestation, dispatch, execution authority, or a credential grant.

**Missing regression:** No direct-broker, fixed-consumer, provider-runner, destination-native, exact-array/configuration, or Telegram-settlement matrix supplies transparent, key-hiding, descriptor-fabricating, or throwing Proxies and asserts rejection before any trap executes.

**Smallest safe remediation:** Add a non-trapping host-level Proxy rejection before every reflective/object-property operation in `exactDataSnapshotV1`, `ownDataValueV1`, and `exactDataArrayV1` (for the supported Node baseline, `node:util` `types.isProxy` is the direct primitive). Apply the same rejection to Telegram `exactInput` and any other security claim of “ordinary exact data.” Add real-seam regressions for consumer outcomes, provider/runner results, destination-native results, fixed-consumer composition, arrays/configuration, and Telegram settlement. Tests should cover transparent and key-hiding Proxies, prove zero trap calls, preserve cleanup/byte wiping where material has already been acquired, and prove terminal replay never reacquires. If a provider boundary cannot safely recover a buffer from a rejected Proxy without invoking traps, its producer/transport must return a broker-owned plain envelope rather than an arbitrary object.

## Required boundary determinations

### Authority

- Completion reviews, verification, findings, preferences, UI facts, Telegram messages/proposals, catalog metadata, checkpoint facts, and replay receipts remain literal negative authority.
- Consequential approval still requires the exact current strong-factor policy decision and an active human owner/operator grant. It still cannot replace a separately signed node attestation or effect claim.
- `CR8Q-SR-F01` changes terminal truth after an already admitted invocation but does not manufacture the prerequisite admission, widen catalog scope, or grant approval/execution authority.

### Durability and replay

- Completion and Telegram complete deletion, older valid restoration, missing/stale checkpoints, and split database/checkpoint transitions fail closed in the current tests and source.
- Missing, empty, recreated, older, wrong-key, wrong-identity, foreign-schema, modified-row, deleted-row, and clock-rollback SQLite ledger cases fail before reacquisition. Claimed restart state becomes terminal ambiguity.
- Exact replay remains immutable and non-dispatching. Changed IDs, digests, callback uses, settlements, catalog revisions, and invocation data conflict rather than aliasing.
- A checkpoint advance followed by protected-store rollback remains an explicit owner-recovery condition; no automatic repair or silent initialization exists.

### Secret and cleanup boundary

- The ordinary-object remediation matrix kept hidden/accessor/symbol/extra canaries out of receipts, safe ledgers, errors, and durable SQLite bytes. Material was wiped and cleanup ran once; malformed replay did not reacquire.
- No plaintext credential, raw provider locator, raw chat ID, durable callback token, bearer secret, private host/process identity, provider payload, or material was observed crossing a public or central boundary.
- `CR8Q-SR-F01` means the repository cannot yet claim complete ordinary-data validation or zero validation behavior execution.

### Telegram proposal-only boundary

- Current project, class, risk, verification lower bound, expiry, chat, callback expiry, MAC, and both replay dimensions are checked before a proposal is stored.
- Every callback result remains a bounded sanitized proposal with `grantsApproval: false`, `grantsExecutionAuthority: false`, and `requiresIndependentPolicyEvaluation: true`. High and critical risk remain dashboard-only.
- No bot, webhook, recipient enrollment, live transport, or callback drill was qualified.

## Independent verification evidence

All commands used the existing local dependencies. Counts are this reviewer's observations.

| Command | Result |
|---|---|
| `pnpm run check` | Exit 0; TypeScript `tsc --noEmit` passed. |
| `pnpm run lint` | Exit 0; ESLint passed. |
| `pnpm run test:cr8q` | Exit 0; 101 tests, 101 passed, 0 failed, 0 skipped. |
| `pnpm run pretest` | Exit 0; 146 tests, 146 passed, 0 failed, 0 skipped. |
| `pnpm test` | Exit 0; lifecycle pretest passed; main suite 416 total, 414 passed, 0 failed, 2 skipped. |
| `pnpm run test:build` | Exit 0; production build passed; rendered routes 2/2 passed. |
| `pnpm run db:verify` | The first managed-sandbox attempt exited 1 because `tsx` could not create its temporary local IPC pipe (`listen EPERM`). The same verifier reran with permission only for that local IPC socket and exited 0; migrations `0001` through `0024` applied and 82 PostgreSQL tables were verified. No install or network fallback was used. |
| `git diff --check` | Exit 0 before and after this report was written. |

The two main-suite skips are the platform-specific Windows DPAPI tests on this macOS host. Node emitted its existing experimental SQLite warning. Vinext emitted its existing route-classification warning. Neither warning changed an exit status.

## Retained live, native, and deployment blockers

- Production Completion API/identity ingress, policy service, integrity-key custody, owner-controlled rollback checkpoint, provisioning/recovery, and separately signed node attestation.
- Telegram bot/webhook/chat enrollment, keys and rotation, public ingress, external checkpoint, production transport, monitoring, recovery runbook, and owner-attended live callback.
- Secret-broker service identity, production catalog, native runner, vault authentication/session transport, authenticated narrow IPC, executable/path ownership, OS isolation, broker-only egress, consumer egress denial, provider rotation/revocation, canaries, cleanup, and owner-controlled rollback checkpoint.
- The independent CR-7B/CR-6E/CR-5C.9H/MCP/Claude and production deployment gates remain unchanged. This review authorizes no installation, account access, credential use, native prompt, service, network-policy change, deployment, Telegram operation, provider call, or external effect.

## Required next review

Codex or another eligible implementation agent may repair `CR8Q-SR-F01`; this reviewer must not. After remediation, another different owner-authorized independent reviewer must rerun the complete CR-8Q packet, specifically attack Proxies at every affected real seam, and retain every live/native/deployment blocker unless separately proven and accepted.

## Final repository disposition

`remediation_required`
