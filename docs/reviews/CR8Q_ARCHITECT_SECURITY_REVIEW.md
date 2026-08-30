# CR-8Q architect approval, completion, Telegram, and secret-boundary security review

**Date:** 2026-08-29
**Mode:** Codex architect adversarial review and remediation
**Status:** Accepted for the reviewed effect-free repository snapshot after a sixth different independent re-review
**Scope:** Effect-free CR-8B through CR-8E repository implementation
**Effects:** None. No credential, provider, process, bot, webhook, chat, network, deployment, GitHub write, or external effect was used.

## Disposition

The architect pass found twelve evidence-backed security defects and repaired them locally. Five successive independent reviews then found seven first-review defects and four later remediation defects: exact consumer-result shapes, Proxy/collector boundaries, shared-backing typed-array validation, and partial ordinary backing-store views. Codex repaired each defect; every negative report remains immutable. The separately authorized sixth reviewer, different from every implementation/remediation author and all five prior CR-8Q reviewers, independently verified all twelve hostile binary families at Bitwarden, 1Password, destination-native, and direct-broker seams, repeated every prior finding family and the complete deterministic gate, and returned `accepted_effect_free_repository_snapshot`. Architect review accepts that disposition for this exact local snapshot. It grants no live, native, credential, Telegram, deployment, approval, execution, or production authority.

| Surface | Current repository disposition | Live or deployed disposition |
|---|---|---|
| Completion and consequential approval | Accepted for the reviewed effect-free snapshot; no remaining repository defect found by the sixth review | Protected API, identity ingress, policy service, integrity/checkpoint custody, and node attestation remain undeployed |
| Completion Gate UI | Included in the combined regression gate; negative-authority read surface only | Protected artifact readers and consequential controls remain outside this surface |
| Telegram | Accepted for the reviewed effect-free snapshot; every first-review repair independently retained | Bot, webhook, recipient enrollment, external checkpoint, transport, monitoring, and callback drill remain disabled |
| Secret broker | Accepted for the reviewed effect-free snapshot; catalog, ledger, result, Proxy, shared-backing, partial-view, and whole-store-cleanup repairs independently verified | Native runner, rollback-resistant checkpoint, vault authentication, credential access, IPC, OS isolation, egress controls, and canaries remain disabled |
| Combined CR-8Q | `accepted_effect_free_repository_snapshot` | No live or consequential authority granted |

## Finding matrix

| ID | Severity | Finding | Remediation and regression proof |
|---|---:|---|---|
| CR8Q-F01 | High | Approval request and decision creation trusted caller timestamps, permitting backdated recording after real expiry | Completion store now uses a captured trusted clock and rejects new records at either expiry boundary; historical exact replay remains safe |
| CR8Q-F02 | High | Valid completion rows could be deleted by a privileged database writer without invalidating the remaining row HMACs, potentially hiding findings or evidence | Migration 0022 and the store now serialize and authenticate the complete per-tenant row set; reads and writes fail on deletion |
| CR8Q-F03 | High | A consequential decision could outlive the owner/operator role grant that justified it, or be recorded after that grant was revoked | The exact grant must remain active through the complete decision lifetime and unrevoked at trusted recording time |
| CR8Q-F04 | Medium | Telegram callback consumption accepted caller time and did not bound stale observation time | Ingress owns the clock; observations cannot be future-dated or more than five minutes stale; callback expiry is rechecked with trusted time |
| CR8Q-F05 | Medium | A durable callback record was not proven to be a bounded response from the exact message plan named by its digest | Registration now requires the strict plan and binds scope, attention lineage, response kind/choice, chronology, expiry, and low/medium risk |
| CR8Q-F06 | High | The low-level Telegram callback consumer accepted its HMAC verification key per request, allowing an internal caller to select a forged verification key | The durable store captures a minimum-256-bit callback key at construction and exposes no per-call key parameter |
| CR8Q-F07 | High | Deletion of Telegram callbacks, updates, receipts, policy history, or deliveries could erase replay or delivery truth without breaking a surviving row tag | Migration 0023 and the store add one authenticated per-tenant state head over all six protected row sets; reads and mutations verify it first |
| CR8Q-F08 | High | Secret-provider result and configuration checks could be widened through prototype, symbol, hidden, non-enumerable, accessor, shared-buffer, or partial-view members | Exact envelope validation is paired with captured native typed-array and ArrayBuffer intrinsics; shared or detached stores, partial views, own binary metadata, subclasses, prototype drift, and widened shapes are rejected without property access, and the full actual backing store is intrinsically wiped when reachable |
| CR8Q-F09 | High | The durable secret ledger had no authenticated trusted-time high-water across restart, permitting clock rollback for an authorized waiting invocation | Authenticated metadata now binds a monotonic high-water mark; restart preserves it and claim/settlement reject rollback |
| CR8Q-F10 | High | Provider, runner, native resolver, and fixed-consumer method references remained mutable through caller-held objects after construction | Every trusted function is captured and bound during construction; later caller mutation cannot replace credential-handling behavior |
| CR8Q-F11 | Medium | Terminal secret replay was checked after current catalog and grant expiry and returned caller-mutable receipt references | Locally authorized exact terminal replay is checked first, remains non-dispatching after expiry/revocation, and returns immutable copies |
| CR8Q-F12 | Medium | Telegram terminal delivery settlement accepted changed safe-reason and retry fields as replay and returned the prior receipt | Settlement now requires an exact ordinary-data shape and exact semantic outcome/provider/reason/retry binding; only the trusted observation time may advance on replay |

## First independent review and remediation

The first independent report is preserved unchanged at `CR8Q_INDEPENDENT_REVIEW.md` with disposition `remediation_required`. Codex, not that reviewer, implemented the following repairs:

| ID | Severity | Independent finding | Architect remediation and regression proof |
|---|---:|---|---|
| CR8Q-IR-F01 | High | Completion and Telegram treated total module-row plus state-head erasure as first use | Migration `0024` adds monotonic head revisions; both stores require explicit one-time tenant provisioning and compare every state transition against an injected owner-controlled checkpoint outside PostgreSQL. Normal operations never recreate a missing head. Complete erasure and older valid-snapshot regressions fail closed in both modules. |
| CR8Q-IR-F02 | High | `SafeCredentialCatalogV1` exposed mutable internal authority metadata | Inputs are cloned before storage; entries and all scope arrays are frozen; register, replay, replace, resolve, and snapshots return isolated frozen copies. Regressions attempt nested and scalar mutation across every return seam. |
| CR8Q-IR-F03 | High | Missing/replaced SQLite ledger files silently initialized as new ledgers | The ledger now requires explicit `create` or `open`, rejects absent/empty/uninitialized routine opens, advances an authenticated revision through an external compare-and-swap checkpoint, and refuses recreation or older valid files under an existing checkpoint. Missing, empty, recreated, and older-file regressions fail closed. |
| CR8Q-IR-F04 | Medium | Callback consumption ignored current project revocation | Callback consumption now rechecks the locked recipient's current project, class, risk, verification lower bound, expiry, and chat policy before durable observation/proposal mutation. Narrowing-race regressions retain zero updates. |
| CR8Q-IR-F05 | Medium | Callback registration omitted current message-class and risk ceilings | Callback records now bind message class and risk to the exact plan, and registration applies both current recipient ceilings. Separate disallowed-class and over-risk regressions fail closed. |
| CR8Q-IR-F06 | Medium | Future-dated recipient policy could enqueue and reach `sending` | Enqueue, claim, registration, and consumption enforce `verifiedAt <= trusted time < policyExpiresAt`. Future-policy enqueue fails and a queued delivery is dead-lettered before dispatch after a future-dated replacement. |
| CR8Q-IR-F07 | Low | Callback record, token parser, and webhook accepted incompatible ID grammars | One exported callback-ID/token grammar now governs record validation, issue, webhook parse, lookup, and authentication. Legal characters round-trip; dot, colon, leading separator, short, and ambiguous forms fail. |

## First remediation re-review and repair

The different first remediation reviewer preserved its negative report at `CR8Q_INDEPENDENT_REREVIEW.md`. It independently verified `CR8Q-IR-F01` through `CR8Q-IR-F07` as repaired, then found one new defect. Codex, not either reviewer, implemented this repair:

| ID | Severity | Independent finding | Architect remediation and regression proof |
|---|---:|---|---|
| CR8Q-RR-F01 | Medium | Consumer-result Zod parsing accepted accessor, inherited, symbol-bearing, and non-enumerable objects, executed a getter, and could record a malformed result as terminal success | The broker now reads only an own data descriptor for the outcome, selects the one exact allowed key set, snapshots an ordinary data object without invoking accessors, and parses only that snapshot. An 18-case broker matrix covers all three outcomes across outcome/value accessors, inherited fields, symbols, non-enumerable fields, and enumerable extras; every malformed result becomes terminal ambiguity with zero getter calls, one acquisition, one cleanup, wiped material, no safe-output leakage, and non-reacquiring exact replay. A separate regression preserves all three valid exact terminal outcomes. |

## Second remediation re-review and repair

The third independent reviewer preserved its negative report at `CR8Q_SECOND_REREVIEW.md`. It verified every earlier repair, then found one new defect. Codex, not any reviewer, implemented this repair:

| ID | Severity | Independent finding | Architect remediation and regression proof |
|---|---:|---|---|
| CR8Q-SR-F01 | Medium | Consumer, provider, runner, destination-native, and Telegram exact-data boundaries could execute Proxy traps; transparent or key-hiding Proxies could be normalized into accepted terminal truth | A shared host boundary uses captured `node:util` Proxy detection before reflection, property access, iteration, or cloning. Provider, runner, resolver, and consumer results now cross broker-owned synchronous collectors and return `Promise<void>`, preventing Promise thenable assimilation from touching an untrusted result. Telegram settlement uses a validated snapshot rather than the raw input, and rollback checkpoints use the same exact host snapshot. Transparent, key-hiding, descriptor-fabricating, and throwing Proxy matrices cover every affected real seam and assert zero trap executions, terminal ambiguity or rejection, one cleanup after accepted acquisition, wiped material, non-mutating Telegram rejection, and non-reacquiring replay. Missing, duplicate, late, throw-before, throw-after, and Proxy-then-ordinary collector misuse is also terminal; a first accepted provider value is recoverable only by the broker's abort path for wiping and cleanup. |

## Proxy-remediation re-review and binary repair

The fourth independent reviewer preserved its negative report at `CR8Q_PROXY_REMEDIATION_REREVIEW.md`. It verified the Proxy and collector repair and every earlier finding family, then found one new high-severity defect that reopened `CR8Q-F08`. Codex, not any reviewer, implemented this repair:

| ID | Severity | Independent finding | Architect remediation and regression proof |
|---|---:|---|---|
| CR8Q-PRR-F01 | High | A `SharedArrayBuffer`-backed `Uint8Array` could define an own `buffer` getter that returned an ordinary `ArrayBuffer`; runner validation executed the getter and accepted prohibited shared material | `exactHostUint8ArrayV1` observes the candidate only through captured `%TypedArray%` buffer, byte-length, byte-offset, and length getters plus captured `ArrayBuffer` intrinsics. It requires exact view/backing prototypes, dense indexed view keys, and zero backing-buffer own keys, rejecting Proxies, shared/detached/widened stores, subclasses, prototype drift, metadata/method shadows, and every extra own key without invoking a caller property. Runner, destination-native, direct-broker, and synthetic-provider inputs copy accepted bytes into boundary-owned ordinary buffers and wipe source/copy buffers through captured native `fill`. Three real-seam matrices cover ten hostile shapes, including shared stores, own `buffer` and `byteLength` getters/data properties, subclassing, prototype drift, detached stores, a backing-buffer constructor getter, and binary method getters; every hostile case executes zero getters, reaches no consumer, is wiped/released as applicable, and replays terminally without reacquisition. |

## Binary-remediation re-review and subview repair

The fifth independent reviewer preserved its negative report at `CR8Q_BINARY_REMEDIATION_REREVIEW.md`. It verified the previous binary, Proxy/collector, and complete-boundary repairs, then found one new high-severity defect that again reopened `CR8Q-F08`. Codex, not any reviewer, implemented this repair:

| ID | Severity | Independent finding | Architect remediation and regression proof |
|---|---:|---|---|
| CR8Q-BRR-F01 | High | An exact-prototype `Uint8Array` subview over a larger ordinary `ArrayBuffer` passed validation; cleanup zeroed only the visible view and left hidden prefix or suffix bytes intact | `exactHostUint8ArrayV1` now requires `byteOffset === 0` and view byte length equal to the complete backing-store byte length. Rejection cleanup obtains the actual backing store through the captured `%TypedArray%` buffer getter, constructs a full-buffer view with the captured native `Uint8Array` constructor, and fills the complete store through the captured native `fill`. The hostile matrices now cover twelve shapes, adding a nonzero-offset subview and an offset-zero short prefix with nonzero hidden bytes. Bitwarden, 1Password, destination-native, and direct-broker paths reject both forms, execute zero caller getters, wipe every backing byte, expose no material to a consumer, release once where applicable, and retain terminal non-reacquiring replay. |

## Sixth independent re-review and acceptance

The sixth reviewer preserved its report at `CR8Q_SUBVIEW_REMEDIATION_REREVIEW.md`, SHA-256 `5f014603d25e259009500a3a1ab457752e5c9af9bfb9ac0e55cf723b68808113`, with disposition `accepted_effect_free_repository_snapshot`. Its private four-test probe independently constructed all twelve hostile binary families rather than importing the producer helper, exercised 48 seam/case combinations, proved complete backing-store wiping for both subview forms, repeated exact whole-buffer success/copy/isolation/cleanup, and removed its sole temporary file. It independently repeated 50/50 CR-8E, 116/116 CR-8Q, 161/161 pretest, 414 passes plus two intentional platform skips in the 416-test main suite, the two-route build, and 82-table migration verification through `0024`. The report was its sole repository write; all five negative reports and the frozen packet remained unchanged.

## Cross-boundary determinations

1. No CR-8 path returns, logs, persists, or centrally transports plaintext credential material or raw provider locators.
2. Completion review, deterministic verification, preference, Telegram response proposals, and central approval remain distinct facts. None grants execution authority.
3. Reviewer or AI risk may raise a deterministic floor but cannot lower it. Required review independence cannot be replaced by self-review or correlated identities.
4. Telegram high/critical items remain authenticated-dashboard-only. Low/medium callbacks create negative-authority proposals requiring independent policy evaluation.
5. A central consequential approval still requires an exact current human strong-factor policy decision and cannot replace the separate signed node attestation and effect claim.
6. Secret grants require exact node-local admission, single-use claim-before-resolve behavior, bounded catalog scope, and terminal ambiguity for uncertain outcomes.
7. Passing synthetic and repository tests does not qualify any live Telegram, password-manager, credential, native process, OS-isolation, or deployment boundary.

## Producer verification

The dedicated `pnpm run test:cr8q` gate covers completion persistence, Completion Gate view/UI, Telegram security/presentation/durability, rollback checkpoints, and secret broker/provider adapters. It passes 116/116. The focused CR-8E gate passes 50/50. The sixth reviewer independently repeated those counts and the complete repository gate; full evidence is in `CR8Q_SUBVIEW_REMEDIATION_REREVIEW.md` and `BUILD_STATUS.md`.

## Acceptance boundary and reopening rule

CR-8Q is accepted only for the exact effect-free repository snapshot reviewed in `CR8Q_SUBVIEW_REMEDIATION_REREVIEW.md`. Any later source, migration, security contract, security test, key boundary, or deployment-assumption change that affects CR-8B through CR-8E reopens proportional CR-8Q review. Production rollback-checkpoint custody, live provider authentication/runner/IPC/OS isolation/egress, Telegram bot/webhook/chat/transport, protected Completion deployment, CR-7B native proof, MCP deployment, CR-6E owner acceptance, Claude discovery, and macOS CR-5C.9H remain unqualified owner-controlled gates.
