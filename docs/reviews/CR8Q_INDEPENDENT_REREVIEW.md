# CR-8Q independent remediation re-review

**Review date:** 2026-08-28
**Disposition:** `remediation_required`
**Reviewed snapshot:** owner-held local snapshot at base commit `14de468999b1ebf4584c13026114d40a0f66cea7` on `integration/cr5d-synthetic-executor-1`, including the supplied dirty CR-8/CR-8Q working tree
**Reviewer independence:** This reviewer is different from the CR-8 implementation/remediation author and from the first CR-8Q independent reviewer. This reviewer made no implementation or test repair.
**Effects and write scope:** Repository reads, static analysis, already-installed deterministic verification, in-memory PostgreSQL-compatible reproductions, and temporary private SQLite files outside the repository only. No network, GitHub, credential, provider, Keychain/vault, native runner, bot, webhook, chat, transport, listener, service, deployment, or external effect was used. Temporary files were removed. This report is the only repository file written by this reviewer.

## Overall determination

All seven findings from the immutable first report are `verified_repaired`. Complete Completion Gate and Telegram erasure, valid rollback, checkpoint mutation, checkpoint failure ordering, catalog mutation, SQLite file replacement, Telegram current-policy races, future policy, and callback grammar were attacked independently rather than inferred from producer counts.

One new ordinary validation-boundary defect remains. The secret broker accepts accessor, inherited, symbol-bearing, and non-enumerable consumer-result objects through the Zod result schema. An accessor result executes its getter and can be recorded as terminal `succeeded` instead of terminal ambiguity. The defect does not itself create a local admission, widen catalog scope, reacquire material, expose plaintext, grant approval, or grant execution authority, but it contradicts the frozen exact-result and malformed-consumer fail-closed contract. The repository snapshot therefore is not acceptable for CR-8Q completion.

## First-review repair determinations

### `CR8Q-IR-F01` — complete tenant-module erasure

**Status:** `verified_repaired`
**Original severity:** High

**Exact code and migration evidence:**

- `db/migrations/0024_cr8q_rollback_checkpoints.sql:4-10` adds a mandatory monotonic revision to both PostgreSQL module heads.
- Completion Gate captures the checkpoint functions at construction (`src/completion-gate/v1/store.ts:98-102`), provides an explicit one-time operation that rejects an existing head, any module rows, or any checkpoint (`:105-112`), rejects a missing normal-operation head (`:329-330`), and compares and advances the external checkpoint at each state transition (`:323-333`).
- Telegram applies the same captured-port and explicit-provisioning rules at `src/telegram/v1/durable-store.ts:47-57`. Its authenticated state covers recipients, policy events, callbacks, updates, proposal receipts, and deliveries (`:215-235`); normal access rejects a missing or mismatched head/checkpoint and each transition advances the checkpoint (`:237-243`).
- Focused regressions cover Completion total erasure, older valid state, and function capture at `tests/completion-gate-contract.test.ts:324-350`, and Telegram erasure, older valid state, and capture at `tests/telegram-durable-store.test.ts:188-209`.

**Independent attacks:**

- A Completion tenant was populated, every module row and its PostgreSQL head were removed while the external checkpoint remained, and both ordinary access and repeated provisioning returned `integrity_failed`. Restoring a complete older authenticated row/head pair also returned `integrity_failed`.
- A Telegram tenant was populated across all six protected row sets. Before deletion, recipient, policy-event, callback, update, proposal-receipt, delivery, and head counts were each one. After privileged removal, all were zero while the external checkpoint remained. Ordinary history access, repeated provisioning, recipient registration, and callback consumption each returned `integrity_failed`; no callback observation, proposal, delivery, or policy history was recreated.
- Checkpoint failure ordering was exercised independently. For Completion, the observed result was:

```json
{"throwBefore":"integrity_failed","rowsAfterBefore":0,"rowsAfterGood":1,"throwAfter":"integrity_failed","rowsAfterAfter":1,"postAmbiguousAccess":"integrity_failed","malformedRead":"integrity_failed"}
```

  A checkpoint failure before the external transition rolled the database transaction back and an unambiguous retry succeeded. An external transition followed by a thrown error left the external checkpoint ahead of the rolled-back database; later access remained failed closed.
- The same split ordering was independently repeated against Telegram:

```json
{"throwBefore":"integrity_failed","rowsAfterBefore":0,"rowsAfterGood":1,"throwAfter":"integrity_failed","rowsAfterAfter":1,"postAmbiguousAccess":"integrity_failed"}
```

No complete deletion, older valid rollback, missing or stale checkpoint, malformed checkpoint value, or split transition silently resumed. The ahead-checkpoint condition intentionally requires owner recovery and remains a deployment blocker.

### `CR8Q-IR-F02` — mutable credential-catalog authority metadata

**Status:** `verified_repaired`
**Original severity:** High

**Exact code/test evidence:** `src/secret-broker/v1/catalog.ts:5-14` structured-clones entries, freezes every nested authority array and the entry object, isolates stored values, and returns fresh isolated values from registration, exact replay, replacement, resolution, and snapshot. Grant construction still requires an accepted exact local decision and intersects every catalog scope at `src/secret-broker/v1/grant.ts:13-23`; the broker rechecks the current catalog digest, active state, and exact scope before claim at `src/secret-broker/v1/broker.ts:22-27`. The focused regression is `tests/secret-broker-contract.test.ts:34-40`.

**Independent attack:** The original registration input, registration return, exact-replay return, resolution return, snapshot entry, replacement input, and replacement return were each mutated after the call. Public entry digests were recomputed, and an otherwise accepted local admission for a project outside the stored scope was submitted to the real broker authorization seam. The observation was:

```json
{"mutationAttempts":{"registered":true,"replay":true,"resolved":true,"snapshot":true},"returnedBlocked":true,"registeredDigestStillExact":true,"replayDigestStillExact":true,"resolvedDigestStillExact":true,"snapshotDigestStillExact":true,"currentProjects":["project:content","project:second"],"outsideGrant":"credential scope denied"}
```

The caller could not alter stored revision-1 or revision-2 metadata. Scope changed only through the valid one-step replacement.

### `CR8Q-IR-F03` — SQLite ledger deletion/replacement

**Status:** `verified_repaired`
**Original severity:** High

**Exact code/test evidence:** `src/secret-broker/v1/sqlite-ledger.ts:20-22` makes `create` and `open` distinct and rejects a missing file during routine open. Lines `29-42` require the exact mode/version/schema/identity and initialize through the external checkpoint. Lines `60-64` authenticate complete state plus trusted-time high-water, require exact checkpoint equality, monotonically advance the head, and roll the SQLite transaction back on checkpoint conflict. Missing, empty, recreated, older-file, and capture regressions are at `tests/secret-broker-contract.test.ts:126-143`.

**Independent attack:** Temporary owner-only directories outside the repository were used and removed. No provider acquisition or consumer call was available before the tested opens. The observation was:

```json
{"splitThrowBefore":"credential ledger checkpoint conflict","afterBeforeRecovery":0,"splitThrowAfter":"credential ledger checkpoint conflict","postSplitOpen":"credential ledger rollback detected","olderOpen":"credential ledger rollback detected","missingOpen":"credential ledger missing","emptyOpen":"credential ledger schema invalid","recreate":"credential ledger checkpoint conflict"}
```

A failure before checkpoint advance rolled back the SQLite transition; an advance followed by a thrown error left the checkpoint ahead and made later open fail. Missing, empty, explicit recreation under the existing checkpoint, and an internally valid older file all failed before authorization, claim, provider resolution, or consumer work.

### `CR8Q-IR-F04` — callback consumption and current project revocation

**Status:** `verified_repaired`
**Original severity:** Medium

**Exact code/test evidence:** `src/telegram/v1/durable-store.ts:99-108` locks the current recipient and callback, checks current enablement, verification lower bound, expiry and chat, then checks current project, message class, and risk ceiling before MAC verification or durable observation. The regression at `tests/telegram-durable-store.test.ts:169-175` asserts each current-policy race and zero stored updates.

**Independent attack:** Four separately registered callbacks were followed by independent current-policy replacements narrowing project, class, risk, or moving `verifiedAt` into the future. Each consumption returned `recipient_not_allowed`; the shared tenant still had zero update rows:

```json
{"raceResults":{"project":"recipient_not_allowed","class":"recipient_not_allowed","risk":"recipient_not_allowed","time":"recipient_not_allowed"},"updateRows":0}
```

No observation or proposal was recorded.

### `CR8Q-IR-F05` — callback registration and current class/risk ceilings

**Status:** `verified_repaired`
**Original severity:** Medium

**Exact code/test evidence:** Callback records now bind message class and risk at `src/telegram/v1/schemas.ts:58-64`. Registration binds those fields to the exact named plan at `src/telegram/v1/durable-store.ts:83-89`, then checks the current recipient project, class, ordered risk ceiling, verification lower bound, and expiry at `:90-96`. Focused regressions are at `tests/telegram-durable-store.test.ts:163-167`.

**Independent attack:** Disallowed-class, over-ceiling-risk, and future-verification registrations were isolated under different recipients. Each returned `recipient_not_allowed`:

```json
{"registrationResults":{"class":"recipient_not_allowed","risk":"recipient_not_allowed","time":"recipient_not_allowed"}}
```

### `CR8Q-IR-F06` — future recipient policy reaching `sending`

**Status:** `verified_repaired`
**Original severity:** Medium

**Exact code/test evidence:** Enqueue enforces `verifiedAt <= now < policyExpiresAt` at `src/telegram/v1/durable-store.ts:126-138`. Claim locks and rechecks the same bounds and dead-letters a no-longer-current candidate before `sending` at `:141-153`. Registration and consumption enforce their corresponding lower/upper containment at `:83-108`. The enqueue/claim regression is `tests/telegram-durable-store.test.ts:178-185`.

**Independent attack:** A future-dated policy returned `recipient_not_allowed` at enqueue. A delivery enqueued under a current policy was followed by a future-dated replacement; claim returned no work and the delivery was `dead_letter` with `recipient_policy_not_current`:

```json
{"futureEnqueue":"recipient_not_allowed","futureClaimReturned":"none","futureClaimState":"dead_letter","futureClaimReason":"recipient_policy_not_current"}
```

The exact lower bound is inclusive and the expiry bound exclusive at each trusted-time seam; a future policy did not reach transport eligibility.

### `CR8Q-IR-F07` — incompatible callback-ID/token grammar

**Status:** `verified_repaired`
**Original severity:** Low

**Exact code/test evidence:** `src/telegram/v1/schemas.ts:11-14` defines one 3–30-character callback-ID grammar and one token grammar with dot reserved as the only separator. The record and proposal use that ID schema at `:58-64` and `:100-105`. Issue, canonical parse, lookup, MAC verification, and proposal construction share it at `src/telegram/v1/security.ts:24-58` and `:66-78`. The focused regression is `tests/telegram-security-contract.test.ts:124-128`.

**Independent attack:** Every legal alphabet member was placed in a valid callback ID and passed record parse, token issue, webhook parse, lookup, canonical base64url/MAC authentication, and proposal creation. Dot, colon, leading hyphen, leading underscore, under-length, over-length, multiple separator, base64url padding, and `+` were rejected. The observation was:

```json
{"legalCharactersRoundTripped":64,"illegalCases":9,"rejected":9}
```

## New finding

### `CR8Q-RR-F01` — malformed consumer-result object shapes can be recorded as success

**Severity:** Medium
**Affected boundary:** The node-local consumer-result validation boundary and durable terminal receipt truth after one valid, locally admitted credential invocation.

**Exact file/line evidence:**

- `src/secret-broker/v1/broker.ts:33` passes the consumer's returned value directly to `secretConsumerResultSchemaV1.parse(...)`. No ordinary-data snapshot is taken before Zod reads the discriminator and fields.
- `src/secret-broker/v1/schemas.ts:25-29` uses strict Zod objects. This rejects ordinary enumerable string-key extras, but it reads accessors and accepts required inherited values, symbol properties, and non-enumerable hidden properties while producing a narrowed parsed object.
- The repository already has a descriptor-safe helper at `src/secret-broker/v1/exact-data.ts:5-9`, but it is used for provider envelopes at `src/secret-broker/v1/broker.ts:30` and not for consumer results.
- `tests/secret-broker-contract.test.ts:79` tests only an ordinary enumerable `material` extra. It does not test an accessor, inherited required values, symbol property, or non-enumerable hidden property on the consumer result.
- This contradicts `docs/CR8E_SECRET_BROKER_CONTRACT.md:44` (malformed consumer output is terminal ambiguity), `:50` (strict consumer output; extra fields fail closed), and `:58` (result envelopes are ordinary exact data and accessors/hidden widening fail closed without getter execution). It also misses the explicit consumer-result widening attack in `docs/reviews/CR8Q_INDEPENDENT_REVIEW_PACKET.md:60`.

**Reproducible attack and observed result:** With the existing synthetic provider and a valid broker-issued local invocation grant, the consumer returned an object whose enumerable `outcome` was a getter and whose `outputDigest` was an ordinary data property. The broker invoked the getter twice, accepted the result, released and zeroed the provider buffer, and stored terminal success:

```json
{"getterCalls":2,"receipt":{"contractVersion":"control-room-secret-broker/v1","invocationId":"credential-invocation:accessor-result","credentialRef":"credential:publishing","state":"succeeded","safeCode":"completed","outputDigest":"sha256:b9de6892b7415633610035916dfd9d309f855260c03575495e36b41fc94c95cc","recordedAt":"2026-08-28T19:00:00.000Z","grantsApproval":false,"grantsExecutionAuthority":false},"providerMetrics":{"acquires":1,"releases":1}}
```

A schema-level shape matrix independently confirmed all four malformed shapes were accepted:

```json
{"getterCalls":2,"results":[{"name":"accessor","accepted":true},{"name":"inherited","accepted":true},{"name":"symbol","accepted":true},{"name":"non_enumerable","accepted":true}]}
```

**Violated invariant:** A consumer result must be one ordinary exact data object. A malformed object shape must become terminal ambiguity, and validation must not execute a getter. The current code instead converts these shapes into a clean parsed object and may persist `succeeded`, `definite_failure`, or caller-selected ambiguity as if the original result envelope were exact.

**Authority and containment impact:** The invocation still requires the exact prior local admission and catalog scope; one provider acquisition had already occurred. The receipt remains literal negative authority, the material buffer was zeroed, release ran once, and exact replay does not reacquire. The defect is false terminal outcome classification, not plaintext exposure or a new grant path.

**Missing regression:** There is no broker-level test that returns accessor, prototype/inherited, symbol, non-enumerable, or hidden-field consumer-result shapes; asserts zero getter calls; verifies terminal `ambiguous`; verifies zeroed material and one release; and verifies exact replay cannot invoke provider or consumer again.

**Smallest safe remediation:** Before any property read or Zod parse, snapshot the raw consumer value with `exactDataSnapshotV1` against exactly `outcome/outputDigest` or exactly `outcome/safeCode`. Reject if neither exact key set produces an ordinary data snapshot, then parse only the snapshot. Add the broker-level shape matrix above for all three outcomes and preserve the existing zeroing, release, terminal ambiguity, and non-reacquisition assertions. A different independent reviewer must verify that remediation.

## Complete original CR-8Q boundary

The twelve architect-remediated issues were re-traced in source and attacked through the focused and complete suites. The following determinations are independent of the producer's finding counts:

| Architect finding | Independent determination |
|---|---|
| `CR8Q-F01` trusted-time approval creation | Held. `src/completion-gate/v1/store.ts:190-208` uses the captured trusted clock and rejects request/decision creation at either expiry boundary while allowing only exact historical replay. |
| `CR8Q-F02` Completion row deletion | Held with the repaired external checkpoint. Complete deletion and older authenticated restoration failed as recorded under `CR8Q-IR-F01`. |
| `CR8Q-F03` approval grant lifetime/revocation | Held. Exact policy identity/action/resource/project/risk/effect/request/time/strong-factor binding and an active owner/operator grant through decision expiry are required at `src/completion-gate/v1/store.ts:288-309`. |
| `CR8Q-F04` Telegram caller time/stale observation | Held. Durable consumption rejects future observations and observations older than five minutes at `src/telegram/v1/durable-store.ts:99-103`; ingress retains the server-owned clock. |
| `CR8Q-F05` callback-to-plan containment | Held. Exact plan digest, scope, lineage, class, risk, response choice, chronology, and expiry are bound at `src/telegram/v1/durable-store.ts:83-96`. |
| `CR8Q-F06` caller-selected callback key | Held. The minimum-length key and verification function are captured at construction (`src/telegram/v1/durable-store.ts:47-50`) and consumption accepts no key parameter. |
| `CR8Q-F07` Telegram protected-row deletion | Held with the repaired external checkpoint across all six row sets at `src/telegram/v1/durable-store.ts:215-243`. |
| `CR8Q-F08` provider/config/result envelope widening | Provider, runner, resolver, configuration, binary, buffer, safe-code, and size checks held through descriptor-safe snapshots and byte wiping. The separate consumer-result boundary is not repaired and is reported as `CR8Q-RR-F01`. |
| `CR8Q-F09` durable ledger clock rollback | Held. The authenticated high-water is included in state and checkpoint material and monotonic observation at `src/secret-broker/v1/sqlite-ledger.ts:56-64`; restart rollback failed closed. |
| `CR8Q-F10` mutable trusted functions | Held. Provider and fixed-consumer functions and all three checkpoint methods are captured and bound; later public method replacement did not change behavior. |
| `CR8Q-F11` terminal replay order/mutability | Held. The broker checks and returns the ledger's isolated terminal receipt before current catalog/expiry resolution (`src/secret-broker/v1/broker.ts:23-27`); replay did not reacquire. |
| `CR8Q-F12` Telegram settlement drift | Held. Settlement first requires an exact ordinary input shape and then exact claim/outcome/provider/reason/retry semantics at `src/telegram/v1/durable-store.ts:156-172` and `:200-204`. |

Completion reviewer independence, producer separation, deterministic risk floors, exact target/profile/revision/finding binding, named verification, supersession, and revision limits also held at `src/completion-gate/v1/store.ts:127-181`, `:211-226`, and `:311-321`. The Completion view model and panel remain digest/metadata-only and expose no protected artifact reader or consequential action control.

## Required boundary determinations

### Authority

- Completion review, verification, findings, preferences, UI facts, Telegram messages/proposals, catalog metadata, checkpoint facts, and replay receipts remain literal negative authority. None substitutes for consequential approval, node attestation, dispatch, execution, credential admission, or an effect claim.
- Consequential approval still recomputes and locks the exact live job/effect and authority state, requires the exact current strong-factor policy decision and an active human owner/operator grant through decision expiry, and still grants no node execution authority.
- `CR8Q-RR-F01` can misclassify the outcome of an already valid local credential invocation, but it cannot manufacture the prerequisite local admission or catalog scope and its receipt still has `grantsApproval: false` and `grantsExecutionAuthority: false`.

### Durability, replay, deletion, and split transitions

- Complete Completion and Telegram erasure, older authenticated snapshots, missing heads/checkpoints, stale or malformed checkpoints, and SQLite missing/empty/recreated/older files failed closed.
- Exact state and receipt replay remained stable; changed IDs, digests, update bodies, callback uses, claim settlement, catalog revision, and invocation data conflicted rather than aliasing.
- A checkpoint failure before transition rolled the protected transaction back. A checkpoint transition followed by a thrown error left the checkpoint ahead and caused persistent fail-closed behavior. It did not silently provision, reopen, dispatch, reacquire material, or recreate proposal/delivery history. Owner recovery for this split state remains deliberately unimplemented.
- The injected checkpoint functions are captured against later method replacement. `parseRollbackCheckpointV1` rejects missing/wrong ordinary values, and digest comparison rejects stale/replayed state. The included `InMemoryRollbackCheckpointStoreV1` requires `{testOnly: true}` and is explicitly non-durable at `src/security/rollback-checkpoint.ts:41-55`; it is not production authority.

### Telegram proposal-only boundary

- Current project, class, risk, verification lower bound, expiry, chat, callback expiry, MAC, and both replay dimensions are checked before a proposal is recorded. The independent race run stored zero updates.
- Every callback result remains a bounded sanitized response proposal with `grantsApproval: false`, `grantsExecutionAuthority: false`, and `requiresIndependentPolicyEvaluation: true`. High and critical risk remain dashboard-only. No bot, webhook, chat, or transport qualification is implied.

### Secret and provider boundary

- No plaintext credential, raw provider locator, raw chat ID, callback token in durable observation, bearer secret, private host/process identity, provider payload, or material crossed a reviewed public row, receipt, fixture, error, UI model, or command plan.
- Catalog and grant scope, claim-before-resolution, single-use replay, concurrent claim exclusion, expiry, catalog replacement/revocation, ledger restart ambiguity, provider envelope exactness, runner/resolver/provider/fixed-consumer function capture, material zeroing, and cleanup held.
- `CR8Q-RR-F01` is the sole observed secret-broker contract failure: malformed consumer-result object shapes are normalized instead of being classified ambiguous. The reproduction still zeroed material and released exactly once.
- Provider adapters remain effect-free command/native-resolution plans. No native provider runner, authentication session, vault access, generic secret-read API, live consumer, network route, or IPC listener exists or was invoked.

## Cross-boundary composition

1. Attention and Completion evidence may establish quality status only.
2. Telegram may render a notification and produce a negative-authority proposal only.
3. Independent central policy evaluation and the exact strong-factor consequential approval path remain separate.
4. A separately signed node attestation remains required before execution/effect authority; CR-8 does not mint it.
5. Node-local policy admission and the current catalog scope must intersect before a credential grant.
6. The durable ledger claims once before material use and prevents replay reacquisition.
7. Shared IDs, digests, risk labels, timestamps, checkpoint revisions, or receipts satisfy none of the other gates.

## Surface dispositions and retained live/native/deployment blockers

| Surface | Repository determination | Retained live/native/deployment blockers |
|---|---|---|
| Completion Gate core | The seven-finding remediation holds; no new Completion defect found | Protected production API, authenticated identity ingress, policy service, integrity-key custody, production rollback-checkpoint custody/provisioning, split-transition recovery, and separate signed node attestation remain undeployed |
| Completion UI | Read-only digest/metadata negative-authority boundary holds | No protected live surface or strong-factor deployment is qualified |
| Telegram policy, callback, and delivery | Current-policy/time/grammar and rollback repairs hold; proposal remains negative authority | Bot/webhook/chat enrollment, bot/webhook/callback/integrity/checkpoint key custody and rotation, production transport, monitoring, recovery runbook, and owner-attended live callback remain disabled/unproved |
| Secret catalog and grant | Catalog isolation and exact admission/scope intersection hold | Production catalog persistence, key custody, service identity, and policy integration remain unproved |
| Secret broker consumer-result boundary | **Remediation required** for `CR8Q-RR-F01` | No live credential eligibility follows from repository remediation |
| Private SQLite ledger | Create/open, whole-file rollback detection, high-water, and single-use replay repairs hold | Owner-controlled rollback checkpoint, private provisioning, backup/restore and split-transition recovery, OS/service identity, and owner cleanup remain unproved |
| Provider adapters | Effect-free plans, private locators, exact provider envelopes, capture, and byte cleanup hold | Native runner/authentication/vault transport, authenticated narrow IPC, executable/path ownership, actual process identity, broker-only egress, consumer egress denial, rotation/revocation, redaction canaries, and provider-native cleanup remain unimplemented/unaccepted |

The separate CR-7B native OS-isolation proof, MCP deployment, CR-6E owner acceptance, CR-5C.9H macOS owner-attended evidence, Claude discovery/acceptance, and all production rollback-checkpoint implementations remain independent blockers. This report authorizes none of them. It also authorizes no installation, download, account access, credential use, permission/network-policy change, service operation, deployment, Telegram operation, provider call, or production effect.

## Independent verification evidence

All commands used the already-prepared local Node.js `v22.22.3`, pnpm `11.19.0`, and frozen dependencies. The global pnpm fallback described by the packet was unnecessary. Counts below were observed in this review; producer counts were not used as the verdict.

| Command | Independent result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; Node, pnpm, and frozen-lockfile preparation were ready. No runtime/native qualification was attempted. |
| `pnpm run check` | Exit 0; TypeScript `tsc --noEmit` passed |
| `pnpm run lint` | Exit 0; ESLint passed |
| `pnpm run test:cr8q` | Exit 0; 99 tests, 99 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo |
| `pnpm run pretest` | Exit 0; 144 tests, 144 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo |
| `pnpm test` | Exit 0; lifecycle pretest passed; main suite 416 total, 414 passed, 0 failed, 0 cancelled, 2 skipped, 0 todo |
| `pnpm run test:build` | Exit 0; production build passed; rendered HTML 2/2 passed |
| `pnpm run db:verify` | Initial managed-sandbox attempt exited 1 solely because installed `tsx` could not create its temporary local IPC socket (`listen EPERM`). The exact same command was rerun with permission only for that local IPC operation and exited 0; migrations `0001` through `0024` applied and 82 PostgreSQL tables were verified. No network fallback or install was used. |
| `git diff --check` | Exit 0 before and after this report was written |

The two main-suite skips are the Windows-only DPAPI cases at `tests/node-platform-key-stores.test.ts:205` and `tests/node-platform-qualification-harness.test.ts:176` on this macOS host. Node emitted its experimental SQLite warning in SQLite-loading test processes. Vinext emitted its existing route-classification warning during the build. Neither warning changed an exit status. The passing suites do not contain the malformed consumer-result shape matrix reported above.

## Cleanup and required next review

All reviewer-created SQLite files and directories were outside the repository and were removed; no reviewer-prefixed temporary directory remained under the host temporary root. In-memory PGlite databases were closed. The existing dirty owner snapshot was preserved. No source, migration, test, contract, status, dependency, lockfile, configuration, or Git state was edited.

After `CR8Q-RR-F01` is remediated, another different, separately authorized independent reviewer is required. The remediation author and this reviewer cannot accept that repair. The next review must repeat the full packet, add and attack the missing consumer-result object-shape regressions, rerun every deterministic command, and retain all live/native/deployment blockers unless separately proven and accepted.

## Final repository disposition

`remediation_required`
