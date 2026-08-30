# CR-8Q subview-remediation independent re-review packet

**Block:** CR-8Q-007
**Mode:** Independent review
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `max`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-8/CR-8Q working-tree snapshot and the `CR8Q-BRR-F01` remediation.
**Prior report anchor:** `CR8Q_BINARY_REMEDIATION_REREVIEW.md` SHA-256 `5029c5e693616b92d92379a9f55ddb1c3d662636a17e32343be371c3dd1201bf`.
**Prior packet anchor:** `CR8Q_BINARY_REMEDIATION_REREVIEW_PACKET.md` SHA-256 `5c411da9d8650a4e54b2dcde43154d2d3d927cd4347896fa09b51582ae6c563f`.
**Effect boundary:** Repository reads, static analysis, installed deterministic checks, temporary private test files, and synthetic in-process bytes/objects only. No network, GitHub, account, credential, provider, process runner, Keychain/vault, bot, webhook, chat, service, deployment, or external effect.

## Independence and write boundary

The reviewer must be different from every CR-8 implementation or remediation author and from all five prior CR-8Q independent reviewers. It must not repair implementation, tests, contracts, or fixtures and must not accept its own changes. It may write only:

```text
docs/reviews/CR8Q_SUBVIEW_REMEDIATION_REREVIEW.md
```

Temporary private test artifacts are permitted only when removed before handoff. The five existing independent reports are immutable negative evidence and must not be edited:

- `CR8Q_INDEPENDENT_REVIEW.md`
- `CR8Q_INDEPENDENT_REREVIEW.md`
- `CR8Q_SECOND_REREVIEW.md`
- `CR8Q_PROXY_REMEDIATION_REREVIEW.md`
- `CR8Q_BINARY_REMEDIATION_REREVIEW.md`

## Objective

Independently verify or break the repair for `CR8Q-BRR-F01`, confirm that `CR8Q-PRR-F01`, `CR8Q-SR-F01`, `CR8Q-RR-F01`, `CR8Q-IR-F01` through `CR8Q-IR-F07`, and `CR8Q-F01` through `CR8Q-F12` remain closed, repeat the complete effect-free CR-8Q boundary, and return one evidence-backed disposition:

```text
accepted_effect_free_repository_snapshot
remediation_required
blocked_incomplete_evidence
```

Repository acceptance grants no live, native, credential, Telegram, deployment, approval, or execution authority.

## Remediation under review

Inspect at minimum:

- `src/security/host-value.ts`
- `src/secret-broker/v1/exact-data.ts`
- `src/secret-broker/v1/types.ts`
- `src/secret-broker/v1/broker.ts`
- `src/secret-broker/v1/provider-adapters.ts`
- `src/secret-broker/v1/synthetic-provider.ts`
- `src/secret-broker/v1/fixed-consumer.ts`
- `src/security/rollback-checkpoint.ts`
- `src/telegram/v1/durable-store.ts`
- `tests/proxy-test-helper.ts`
- `tests/secret-broker-contract.test.ts`
- `tests/secret-provider-adapters.test.ts`
- `tests/telegram-durable-store.test.ts`
- `tests/completion-gate-contract.test.ts`
- `docs/CR8E_SECRET_BROKER_CONTRACT.md`
- all five prior CR-8Q independent reports and the architect review

The intended binary boundary is:

1. Provider-controlled binary values are observed only through captured native `%TypedArray%` and `ArrayBuffer` intrinsics, never through caller properties, iteration, `instanceof`, or replaceable methods.
2. Only an exact `Uint8Array` with `Uint8Array.prototype`, dense indexed own byte keys, byte offset zero, view byte length equal to the complete backing-store byte length, and an exact zero-own-key `ArrayBuffer.prototype` backing store is accepted.
3. Proxies, `SharedArrayBuffer` views, detached stores, partial or widened ordinary-buffer views, own metadata/method accessors or data properties, symbols/extras, subclasses, and prototype drift are rejected without getter or Proxy-trap execution.
4. Runner, destination-native, and direct-broker boundaries copy accepted material into boundary-owned ordinary bytes before later trust layers receive it. Source and consumer copies are wiped through captured native `fill`; provider release remains once-only.
5. Rejected actual typed arrays are wiped when possible by obtaining their actual backing store through the captured `%TypedArray%` buffer getter, constructing a full-store view with the captured native `Uint8Array` constructor, and filling every backing byte through the captured native `fill`.
6. Provider uncertainty becomes terminal ambiguity and exact replay never reacquires.
7. The earlier synchronous collector, host Proxy rejection, exact ordinary snapshot, Telegram settlement, and rollback-checkpoint repairs remain intact.

## Mandatory independent binary attacks

Do not rely only on supplied regressions. At the real Bitwarden and 1Password runner seams, destination-native resolver seam, and direct broker provider seam, independently attack at least:

1. an exact-prototype ordinary `Uint8Array` with a nonzero byte offset over a larger backing store containing nonzero hidden prefix and suffix bytes;
2. an exact-prototype ordinary `Uint8Array` with byte offset zero but a length shorter than its larger backing store, with nonzero hidden suffix bytes;
3. an actual `SharedArrayBuffer`-backed `Uint8Array`;
4. a shared view with an own `buffer` getter returning an ordinary `ArrayBuffer`;
5. a shared view with an own `buffer` data property;
6. an ordinary view with an own `byteLength` getter;
7. an ordinary view with an own `byteLength` data property;
8. a `Uint8Array` subclass;
9. an ordinary view whose prototype was replaced;
10. a view over a detached `ArrayBuffer`;
11. an ordinary view whose backing `ArrayBuffer` has an own `constructor` getter; and
12. an ordinary view with own `at`, `fill`, `set`, `slice`, or iterator getters.

For the first two cases, capture and inspect a full-buffer observer before handoff. Wiping only the candidate view is a failure: every hidden prefix and suffix byte must be zero after rejection. Count getter calls and all relevant Proxy traps. Every hostile case must be rejected with zero getter/trap execution, no consumer exposure, full-backing-store intrinsic wiping when the store is reachable, once-only release when a release function was accepted, terminal ambiguity where applicable, and no reacquisition on exact replay.

Also prove an ordinary exact whole-buffer view still succeeds, is copied rather than shared with the next trust layer, and is wiped at every owned layer. Independently inspect zero-length whole stores, maximum-length enforcement, detached-store cleanup behavior, constructor/prototype capture, and whether resizable or growable backing stores create a validation-to-copy race or an accepted partial-store shape.

Review cleanup paths independently: invalid outer envelope, invalid nested material, copy failure, provider release failure, consumer failure, collector absence/duplicate/late/throw-before/throw-after, and attempted recovery from a rejected Proxy. Check that an attacker cannot use an own `fill`, `slice`, `set`, `at`, iterator, `buffer`, `byteLength`, `byteOffset`, `length`, or backing `constructor` member to execute code during validation, copy, or wiping.

## Complete prior boundary

Repeat the prior Proxy matrices at consumer, provider, provider-wiring, fixed-consumer, runner, destination-native, Telegram settlement, and rollback-checkpoint seams. Reperform the earlier attacks for:

- Completion trusted time, strong-factor grant lifetime/revocation, reviewer independence, risk floors, tenant separation, append-only integrity, complete erasure, older valid restoration, and external checkpoints;
- Telegram current project/class/risk/time policy, callback-plan containment, key capture, callback grammar, replay, authenticated complete state, future policy, delivery settlement, complete erasure, and older valid restoration;
- secret catalog isolation, exact local admission, exact grant scope, trusted function capture, material cleanup, terminal replay, private SQLite schema/path/key/identity integrity, rollback checkpoints, file replacement, restart ambiguity, and clock high-water; and
- negative authority across Completion facts, Telegram proposals, credential receipts, and every UI projection.

## Required deterministic commands

Use only the existing installed dependency tree:

```text
pnpm run check
pnpm run lint
pnpm run test:cr8e
pnpm run test:cr8q
pnpm run pretest
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check
```

If the managed sandbox alone blocks the local `tsx` IPC socket, report the first failure exactly and rerun only the same migration verifier through Node's installed `tsx` loader or with permission limited to the temporary local IPC socket. No install or network fallback is allowed.

Producer claims at packet freeze are 50/50 for `test:cr8e`, 116/116 for `test:cr8q`, 161/161 for `pretest`, 416 total with 414 passed and two intentional platform skips for the main suite, two rendered routes, and 82 PostgreSQL tables through migration `0024`. These are claims to challenge, not reviewer evidence.

## Required report

`CR8Q_SUBVIEW_REMEDIATION_REREVIEW.md` must include:

1. exact reviewed snapshot, packet and all prior-report anchors, and independence statement;
2. write/effect boundary and cleanup statement;
3. determination for `CR8Q-BRR-F01`, `CR8Q-PRR-F01`, and every earlier finding family;
4. separate nonzero-offset and zero-offset-short subview evidence, including the complete backing store before and after cleanup at all four real seams;
5. binary intrinsic, getter/trap-count, copy/isolation, and cleanup evidence for all twelve hostile shape families at every real seam;
6. prior Proxy/collector and complete authority/durability/Telegram boundary evidence;
7. exact command exit statuses and observed counts;
8. retained live/native/deployment blockers; and
9. one permitted final disposition.

Any new defect requires `remediation_required`. Missing evidence requires `blocked_incomplete_evidence`. A passing repository report must still state that production rollback-checkpoint custody, live provider authentication/runner/IPC/OS isolation/egress, Telegram bot/webhook/chat/transport, protected Completion deployment, CR-7B native proof, MCP deployment, CR-6E owner acceptance, Claude discovery, and macOS CR-5C.9H remain unqualified.
