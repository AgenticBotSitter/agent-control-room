# CR-8Q independent approval, completion, Telegram, and secret-boundary review

**Review date:** 2026-08-28
**Disposition:** `remediation_required`
**Reviewed snapshot:** owner-held local snapshot at base commit `14de468999b1ebf4584c13026114d40a0f66cea7` on `integration/cr5d-synthetic-executor-1`
**Reviewer independence:** This reviewer did not author the CR-8 implementation, the architect review, or the remediations under review.
**Effects:** Repository reads, static analysis, already-installed deterministic verification, and effect-free local database reproductions only. No source, migration, test, contract, status, dependency, lockfile, configuration, Git state, network, GitHub, credential, provider, bot, webhook, chat, native runner, service, deployment, or external effect was changed or used. This report is the only file written.

## Overall determination

The candidate is not acceptable yet. Seven ordinary correctness and durable-boundary defects remain. All four cases called out for independent determination are confirmed:

1. callback consumption does not revalidate the current recipient's project allowlist;
2. deleting all of one tenant's module rows and its in-database summary can be reinterpreted as a new empty module state in both Completion Gate and Telegram;
3. `SafeCredentialCatalogV1` exposes its internally stored mutable entries to callers; and
4. deleting/replacing the private SQLite ledger file can be reinterpreted as a new ledger.

The focused and full suites pass because none exercises these attacks. Three additional Telegram defects affect current-policy enforcement, time validity, and the accepted callback-ID grammar. No reviewed path directly grants consequential approval or execution authority, and no plaintext credential crossed a reviewed boundary, but passing those negative-authority properties does not cure the durable and policy failures below.

## Findings

### `CR8Q-IR-F01` — complete tenant-module erasure is accepted as first use

**Severity:** High
**Affected guarantee and boundary:** Append-only history, privileged-deletion detection, and rollback resistance in the tenant-scoped Completion Gate and Telegram PostgreSQL stores.

**Exact evidence:**

- `src/completion-gate/v1/store.ts:312-316` computes a summary only from `control_completion_gate_records`. At `:314`, absence of the integrity row is accepted and a new zero-count integrity row is created whenever the module row count is also zero.
- `src/telegram/v1/durable-store.ts:212-231` does the same across the Telegram tables. At `:224-227`, a missing integrity row plus zero module rows is bootstrapped as a new state.
- The summaries live in the same deletion domain as the protected rows: `db/migrations/0022_cr8b_completion_gate.sql:36-41` and `db/migrations/0023_cr8d_telegram_delivery.sql:47-54`.
- This contradicts the complete-state and privileged-deletion claim in `docs/CR8D_DURABLE_DELIVERY_CONTRACT.md:20-24`. The same construction also cannot distinguish a whole valid older module snapshot from current state.

**Reproducible attack:** In an isolated PGlite tenant, register one Completion Gate profile and one Telegram recipient. With the append-only guards disabled in the same way as the existing privileged-deletion tests, delete every row belonging to each module and delete that module's integrity row. Re-enable the guards and register the same profile/recipient again. Both calls succeed instead of returning `integrity_failed`; the independent reproduction observed:

```json
{"completionReplayedAfterFullReset":false,"telegramReplayedAfterFullReset":false}
```

The stores therefore treat erased history as never having existed.

**Missing regression:** `tests/completion-gate-contract.test.ts:314-320` deletes one record while retaining the integrity head. `tests/telegram-durable-store.test.ts:146-150` deletes one callback or delivery while retaining the head and other tenant state. Neither deletes the complete module row set together with its summary, nor restores an older valid complete state.

**Smallest safe remediation:** Separate one-time tenant/module initialization and the monotonic generation or high-water checkpoint from the replaceable module tables. On normal open, a missing summary for a previously initialized tenant must fail closed rather than auto-bootstrap. Authenticate the checkpoint outside the same rollback/deletion domain, and add complete-erasure and older-snapshot regressions for both stores.

### `CR8Q-IR-F02` — the safe credential catalog exposes mutable authority metadata

**Severity:** High
**Affected guarantee and boundary:** Node-local credential-catalog scope, monotonic replacement/revocation, and the catalog ceiling used when issuing an invocation grant.

**Exact evidence:**

- `src/secret-broker/v1/catalog.ts:5-11` stores parsed mutable entries in a `Map`. `register` returns the stored object, replay returns the same stored object, `replace` stores and returns its mutable object, and `resolve` returns the internal reference. Only `safeSnapshot` clones.
- `src/secret-broker/v1/broker.ts:22-25` trusts `catalog.resolve` for grant construction and subsequent current-scope validation.

**Reproducible attack:** Register a revision-1 entry limited to `project:one`; retain the object returned by `register`; append `project:two` to its `projectIds` and recompute its public `entryDigest`; then submit an otherwise valid accepted local admission for `project:two`. No `replace`, expected digest, or revision increment occurs. The independent reproduction observed:

```json
{"sameReference":true,"revision":1,"widenedProjects":["project:one","project:two"],"grantProject":"project:two"}
```

This does not bypass the separate accepted local admission, but it does let a caller widen the credential catalog ceiling and induce local grant issuance outside the registered revision's original scope.

**Missing regression:** `tests/secret-broker-contract.test.ts:25-32` checks exact replay and explicit monotonic replacement, but never mutates an object returned from `register`, `replace`, or `resolve`. The receipt-copy test at `:48-52` covers a different object boundary.

**Smallest safe remediation:** Deep-clone and deeply freeze catalog entries before storage, never return internal references, and return cloned/frozen values from every public method. Add mutations of every nested array and scalar after registration, replacement, replay, and resolution, followed by broker authorization attempts.

### `CR8Q-IR-F03` — private SQLite ledger deletion/replacement silently creates a new ledger

**Severity:** High
**Affected guarantee and boundary:** Durable single-use invocation state, terminal replay, ambiguous-retry handling, trusted-time high-water state, and node-private ledger identity.

**Exact evidence:**

- `src/secret-broker/v1/sqlite-ledger.ts:18-20` creates the ledger file when the configured path is absent.
- `src/secret-broker/v1/sqlite-ledger.ts:27-35` treats SQLite version 0 with no rows or metadata as initialization, inserts fresh metadata for the supplied identity, and sets version 1. The identity, authenticated row-set summary, and high-water value all live only inside the replaceable file.
- This is weaker than the deletion/rollback fail-closed deployment claim at `docs/CR8E_SECRET_BROKER_CONTRACT.md:52-56`.

**Reproducible attack:** Create a file-backed ledger, authorize and settle an invocation as `succeeded`, close it, unlink the ledger file, and construct the ledger again at the same path with the same identity and integrity key. The prior terminal receipt is absent. Re-authorizing the identical grant and claiming it returns dispatch:

```json
{"claimAfter":{"disposition":"dispatch"}}
```

In a live deployment this could reacquire material and repeat a consumer effect. A whole valid older-file replacement likewise cannot be detected solely by state stored in that file.

**Missing regression:** `tests/secret-broker-contract.test.ts:94-103` checks restart replay and claimed-state recovery. `:105-108` deletes rows while retaining authenticated metadata. No test removes/replaces the whole file or restores a valid older file.

**Smallest safe remediation:** Split explicit first-time creation from normal open and make normal open reject an absent, empty, or uninitialized ledger. Pin ledger generation/high-water state in a separate owner-controlled rollback-resistant checkpoint so older valid-file replacement also fails. Add whole-file deletion, empty replacement, and older-snapshot regressions.

### `CR8Q-IR-F04` — callback consumption ignores current project revocation

**Severity:** Medium
**Affected guarantee and boundary:** Current recipient-policy enforcement when an authenticated Telegram callback becomes a durable response proposal.

**Exact evidence:** `src/telegram/v1/durable-store.ts:89-97` loads the current recipient and rechecks enabled, expiry, chat, and record recipient/chat binding, but never checks `recipient.allowedProjectIds.includes(record.projectId)`. That directly misses the project recheck promised by `docs/CR8D_DURABLE_DELIVERY_CONTRACT.md:26-32`.

**Reproducible attack:** Register a callback for `project:one`; replace the recipient policy with a later policy allowing only `project:other`; then consume the still-time-valid, correctly MACed callback from the same chat. The independent reproduction observed:

```json
{"status":"recorded","projectId":"project:one","currentAllowedProjects":["project:other"]}
```

The output is still negative-authority, but revoked project scope reaches the durable proposal boundary.

**Missing regression:** `tests/telegram-durable-store.test.ts:47-61` covers restart, exact replay, wrong chat/MAC, update drift, and callback reuse. The policy-replacement dispatch test at `:105-113` covers delivery only. No test narrows projects between callback registration and consumption.

**Smallest safe remediation:** At consumption, after locking the current recipient and callback, recheck current tenant, project allowlist, enabled state, verification lower bound, expiry, chat, and any still-relevant class/risk ceiling before recording an observation or proposal. Add narrowing races for each current-policy dimension.

### `CR8Q-IR-F05` — callback registration omits current class and risk ceilings

**Severity:** Medium
**Affected guarantee and boundary:** Recipient policy and deterministic/current risk containment at durable callback registration.

**Exact evidence:** `src/telegram/v1/durable-store.ts:73-81` verifies message-plan binding, rejects high/critical plans, and checks recipient enabled/chat/project/time containment. It never checks whether `messagePlan.messageClass` is in `recipient.allowedMessageClasses` or whether `messagePlan.risk` is at or below `recipient.maximumRisk`. `docs/CR8D_TELEGRAM_SECURITY_CONTRACT.md:22-27` says disallowed-class and over-ceiling policies fail closed.

**Reproducible attack:** Register a current recipient that allows only `informational` messages with maximum risk `low`. Supply a strict, digest-bound `question` message plan at risk `medium` and its matching callback record. Registration succeeds:

```json
{"registered":true,"recipientAllowedClasses":["informational"],"recipientMaximumRisk":"low","planClass":"question","planRisk":"medium"}
```

This does not downgrade the plan's deterministic risk; it bypasses the recipient's current delivery/risk ceiling at the durable callback seam.

**Missing regression:** `tests/telegram-durable-store.test.ts:39-45` covers wrong chat, unbound plan digest, and high-risk rejection, but no valid low/medium plan that is disallowed by current class or maximum risk.

**Smallest safe remediation:** Apply the same current class and ordered risk-ceiling checks used by delivery enqueue/claim during callback registration, and add one regression per omitted dimension.

### `CR8Q-IR-F06` — a future-dated recipient policy can reach `sending`

**Severity:** Medium
**Affected guarantee and boundary:** Trusted-time validity for Telegram delivery eligibility and claim.

**Exact evidence:** `src/telegram/v1/durable-store.ts:115-142` checks the policy's upper expiry bound during enqueue and claim, but neither path rejects `input.now < recipient.verifiedAt`. The ordinary policy resolver does reject not-yet-valid policy, and `docs/CR8D_TELEGRAM_SECURITY_CONTRACT.md:22-27` explicitly requires future policies to fail closed.

**Reproducible attack:** Store a recipient policy with `verifiedAt` `2026-08-28T18:05:00.000Z`; enqueue a matching otherwise valid presentation at `18:01`; claim at `18:01`. Both operations succeed and the delivery becomes `sending`:

```json
{"policyVerifiedAt":"2026-08-28T18:05:00.000Z","claimAt":"2026-08-28T18:01:00.000Z","claimedState":"sending"}
```

**Missing regression:** `tests/telegram-durable-store.test.ts:105-113` rechecks a disabled later replacement but never exercises a policy whose verification lower bound is in the future at enqueue or claim.

**Smallest safe remediation:** Enforce `recipient.verifiedAt <= trusted now < recipient.policyExpiresAt` at every current-policy eligibility seam, including enqueue, claim, callback registration, and callback consumption. Add exact-boundary and just-before-boundary tests.

### `CR8Q-IR-F07` — valid callback IDs have incompatible token grammars

**Severity:** Low
**Affected guarantee and boundary:** Strict-input consistency and availability of otherwise valid Telegram callback records.

**Exact evidence:**

- The shared ID schema permits `.`, `_`, `:`, and `-` at `src/telegram/v1/schemas.ts:4`; callback records use it at `:54-59`.
- Token issue/authentication accepts the same callback-ID characters at `src/telegram/v1/security.ts:25-37`.
- The webhook observation schema at `src/telegram/v1/schemas.ts:96-97` permits only alphanumeric, underscore, and hyphen before the separator, so a token for `callback:one` cannot enter the durable ingress path.
- Independently, `src/telegram/v1/durable-store.ts:94` uses `split(".")[0]`, which misidentifies a valid callback ID containing a dot.

**Reproducible attack:** Parse a callback record with ID `callback:one`, issue its correctly authenticated token, then parse an otherwise valid webhook observation carrying that token. Record and token creation succeed, but observation parsing fails:

```json
{"recordAccepted":true,"token":"callback:one.UYEnXhi-EnrWzxtxeCCVYw","observationAccepted":false}
```

**Missing regression:** Existing callback fixtures use underscore-only IDs, including `tests/telegram-durable-store.test.ts:39-61`; no test iterates every callback-ID character accepted by the record schema through issue, webhook parse, lookup, and authentication.

**Smallest safe remediation:** Define one canonical callback-ID grammar and one canonical token parser shared by record validation, issue, webhook observation, lookup, and authentication. Do not recover the ID with `split`. Add exhaustive legal-character round trips and illegal/ambiguous separator cases.

## Required explicit boundary determinations

### Authority grant, spend, or widening

- Completion reviews, preferences, evidence, and Telegram proposals remain literal negative authority. I found no direct path from them to consequential approval, node attestation, dispatch, execution, or an effect claim.
- Completion Gate reviewer separation, exact target/profile/revision binding, named verification, finding resolution, deterministic risk floor, exact strong-factor approval binding, and post-expiry rejection held in code and the focused tests. I found no bypass of review independence or Completion Gate risk.
- `CR8Q-IR-F05` bypasses the Telegram recipient's current class/risk ceiling, and `CR8Q-IR-F04` bypasses current project revocation, but the resulting callback remains a response proposal with `grantsApproval: false`, `grantsExecutionAuthority: false`, and `requiresIndependentPolicyEvaluation: true`.
- `CR8Q-IR-F02` does widen node-local credential catalog scope without the required revision transition. With a separately accepted exact local admission, the broker can issue a grant for the widened scope. It does not itself manufacture that admission or directly execute a provider.
- `CR8Q-IR-F03` permits a previously terminal invocation to return to dispatch eligibility after ledger replacement. No provider or consumer effect exists in the reviewed deployment and none was invoked during review.

### Replay, history, deletion, rewind, and ambiguity

- Exact Completion, Telegram, and secret-ledger replay works while the authenticated summary/ledger remains present.
- `CR8Q-IR-F01` means complete module history deletion, and potentially whole valid module-state rewind, is not distinguishable from initialization because the only anchor is deleted or rewound with the data.
- `CR8Q-IR-F03` loses terminal/ambiguous history, the single-use decision, and trusted-time high-water state when the whole SQLite file is replaced. The same invocation can become dispatchable again rather than replaying its terminal receipt.
- Telegram update/callback two-dimensional idempotency, definite-only transport retry, terminal ambiguity, claim serialization, and delivery settlement drift checks otherwise held in the reviewed code and tests.

### Telegram proposal boundary

A Telegram callback still creates only a bounded, authenticated, sanitized response proposal. It cannot satisfy strong-factor approval, mint the separate signed node attestation, issue a credential, or execute work. Findings `F04-F07` concern whether a proposal or delivery may be accepted under revoked/not-yet-valid/incompatible policy and input states; they do not convert the proposal into authority.

### Secret and private identity boundary

I found no plaintext credential, raw provider locator, bearer token, raw chat ID, raw host identity, private process identity, provider payload, or credential material crossing the reviewed public rows, receipts, errors, fixtures, UI projections, or command plans. Catalog entries contain safe reference metadata only; `F02` is mutation of that metadata, not material exposure. Provider locator bindings remain node-private, provider/runner/resolver functions are captured, result envelopes are strict, consumer output is bounded, and material buffers are wiped on reviewed paths. No live runner, authentication transport, vault access, native provider call, or generic credential-read operation exists.

## Cross-boundary composition

1. Attention/evidence and Completion Gate review can establish quality completion only; they do not grant consequential authority.
2. Telegram rendering and callback handling can create a negative-authority response proposal only. Independent central policy evaluation is still required.
3. Consequential approval still requires the exact strong-factor approval path and cannot be substituted by quality review, preference, verification, or a Telegram response.
4. A separate signed node attestation remains required and is not implemented by CR-8.
5. Node-local credential admission and catalog scope must intersect before a credential grant; `F02` currently weakens the catalog side of that intersection.
6. A durable single-use ledger must claim before provider/consumer use; `F03` currently lets replacement erase that terminal history.
7. Shared IDs, digests, timestamps, or proposal records satisfy none of the omitted gates.

## Surface dispositions and retained blockers

| Surface | Repository disposition | Live/native/deployment disposition |
|---|---|---|
| Completion Gate core | **Remediation required** for complete-state erasure/rewind detection | Protected API identity ingress, policy service, external integrity-key/checkpoint custody, and separate signed node attestation remain undeployed |
| Completion Gate UI | **Accepted as read-only negative authority**; metadata/digest previews have no approval or execution control | No live protected surface or strong-factor deployment is accepted |
| Telegram policy/presentation | **Remediation required** for durable current-policy/time enforcement and callback grammar | Bot, webhook, chat-ownership enrollment, bot/webhook/callback/integrity key custody and rotation, transport, monitoring, and live callback drill remain disabled/unproved |
| Telegram delivery | Synthetic state machine remains negative authority, but **remediation required** for whole-state erasure and future-policy claim | No live send, bot identity, provider transport, or production delivery operation is accepted |
| Secret catalog/broker | **Remediation required** for mutable catalog scope | No vault authentication, native credential access, generic read API, or live credential eligibility is accepted |
| Private SQLite ledger | **Remediation required** for file replacement/deletion and rollback anchoring | External key custody, rollback-resistant owner checkpoint, broker service identity, private provisioning, backup/restore policy, and owner cleanup remain unproved |
| Provider adapters | Effect-free planning and strict result/runner seams remain bounded | Native runner, executable and OS-identity proof, authenticated narrow IPC, broker-only egress, consumer egress denial, rotation/revocation, canaries, and provider-native cleanup remain unimplemented/unaccepted |

The separate CR-7B native OS-isolation proof, CR-6E owner acceptance, CR-5C.9H macOS owner-attended evidence, MCP service deployment, and Claude discovery/acceptance gates recorded in `docs/BUILD_STATUS.md` remain independent blockers. This report does not authorize qualification, installation, download, owner-presence assertions, Keychain/vault operations, services, listeners, deployment, network policy, provider calls, Telegram operations, or any production effect. No live provider or external send path is eligible.

## Independent verification evidence

All commands used the already-prepared local dependencies. Counts below are this reviewer's observed results, not copied acceptance evidence.

| Command | Independent result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; Node and pnpm baseline and frozen-lockfile preparation were ready. No runtime/native qualification was attempted. |
| `pnpm run check` | Exit 0; TypeScript check passed |
| `pnpm run lint` | Exit 0 |
| `pnpm run test:cr8q` | Exit 0; 86 tests, 86 passed, 0 failed, 0 skipped |
| `pnpm run pretest` | Exit 0; 131 tests, 131 passed, 0 failed, 0 skipped |
| `pnpm test` | Exit 0; pretest passed; main suite 416 total, 414 passed, 0 failed, 2 skipped, 0 todo |
| `pnpm run test:build` | Exit 0; production build passed; rendered HTML 2/2 passed. Vinext emitted its route-classification warning and Node emitted the experimental SQLite warning. |
| `pnpm run db:verify` | The first managed-sandbox attempt exited 1 because `tsx` could not create its temporary local IPC pipe (`listen EPERM`). The exact verifier was rerun with permission for that local IPC socket and exited 0; migrations `0001` through `0023` applied and 82 PostgreSQL tables were verified. |
| `git diff --check` | Exit 0 both before and after this report was written |

The two main-suite skips are the Windows-only DPAPI tests at `tests/node-platform-key-stores.test.ts:205` and `tests/node-platform-qualification-harness.test.ts:176` on this macOS host. SQLite's experimental warning was present in the CR-8 and complete suites. Passing verification does not cover the seven reproductions above.

## Required next review

Another different independent reviewer is required after remediation. The repair author cannot accept their own fix, and this reviewer must not be used to convert the negative findings into acceptance without a separately authorized independent round. That round must rerun the full packet, include regressions for every finding, re-attempt whole-state/file rollback attacks, and retain every live/native/deployment blocker unless separately proven and accepted.
