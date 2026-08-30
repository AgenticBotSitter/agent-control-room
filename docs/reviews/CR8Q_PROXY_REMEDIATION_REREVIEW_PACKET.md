# CR-8Q Proxy-remediation independent re-review packet

**Block:** CR-8Q-005
**Mode:** Independent review
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `max`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-8/CR-8Q working-tree snapshot and the `CR8Q-SR-F01` remediation.
**Prior report anchor:** `CR8Q_SECOND_REREVIEW.md` SHA-256 `e2354607180d6c7058aa1643dcd3f9b3dbdc70b45a10d93213ed28c05aedb588`.
**Effect boundary:** Repository reads, static analysis, installed deterministic checks, temporary private test files, and synthetic in-process objects only. No network, GitHub, account, credential, provider, process runner, Keychain/vault, bot, webhook, chat, service, deployment, or external effect.

## Independence and write boundary

The reviewer must be different from every CR-8 implementation or remediation author and from all three prior CR-8Q independent reviewers. It must not repair implementation, tests, contracts, or fixtures and must not accept its own changes. It may write only:

```text
docs/reviews/CR8Q_PROXY_REMEDIATION_REREVIEW.md
```

Temporary private test artifacts are permitted only when they are removed before handoff. The three existing independent reports are immutable negative evidence and must not be edited.

## Objective

Independently verify or break the repair for `CR8Q-SR-F01`, confirm that `CR8Q-RR-F01`, `CR8Q-IR-F01` through `CR8Q-IR-F07`, and `CR8Q-F01` through `CR8Q-F12` remain closed, repeat the complete effect-free CR-8Q boundary, and return one evidence-backed disposition:

```text
accepted_effect_free_repository_snapshot
remediation_required
blocked_incomplete_evidence
```

Repository acceptance grants no live, native, credential, Telegram, deployment, approval, or execution authority.

## Remediation under review

Inspect at minimum:

- `src/security/host-value.ts`
- `src/security/rollback-checkpoint.ts`
- `src/secret-broker/v1/exact-data.ts`
- `src/secret-broker/v1/types.ts`
- `src/secret-broker/v1/broker.ts`
- `src/secret-broker/v1/provider-adapters.ts`
- `src/secret-broker/v1/synthetic-provider.ts`
- `src/secret-broker/v1/fixed-consumer.ts`
- `src/telegram/v1/durable-store.ts`
- `tests/proxy-test-helper.ts`
- `tests/secret-broker-contract.test.ts`
- `tests/secret-provider-adapters.test.ts`
- `tests/telegram-durable-store.test.ts`
- `tests/completion-gate-contract.test.ts`
- `docs/CR8E_SECRET_BROKER_CONTRACT.md`
- all three prior CR-8Q independent reports and the architect review

The intended boundary is:

1. Captured `node:util` host detection rejects a Proxy before reflection, property access, iteration, cloning, or result-object Promise assimilation.
2. Consumer, provider, injected-runner, and destination-native results are submitted exactly once through a broker-owned synchronous collector; their asynchronous operation returns `Promise<void>` rather than an arbitrary result object.
3. Exact ordinary snapshots still reject prototype, accessor, inherited, symbol, hidden, non-enumerable, extra, sparse-array, custom-array, shared-buffer, invalid-binary, invalid-code, and size widening.
4. Telegram settlement operates only on its accepted snapshot. A rejected input cannot change a delivery.
5. Rollback-checkpoint parsing rejects Proxy values before reflection.
6. Any accepted credential acquisition still wipes material and invokes cleanup exactly once. Uncertain or malformed results settle terminal ambiguity and exact replay never reacquires.

## Mandatory independent attacks

At every affected real seam, use transparent, key-hiding, descriptor-fabricating, and throwing Proxies. Count all relevant traps, including `get`, `getPrototypeOf`, `ownKeys`, `getOwnPropertyDescriptor`, and `has`. Each rejected Proxy must execute zero traps.

At minimum attack:

1. Direct broker consumer results for success, definite failure, and ambiguity, including a hidden symbol canary.
2. Direct broker provider acquisition results and provider wiring objects/arrays.
3. Fixed-consumer result composition, consumer wiring, route objects, and route arrays.
4. Bitwarden and 1Password top-level configuration, bindings arrays, binding entries, runner objects, runner result envelopes, nested stdout values, and callable method Proxies.
5. Destination-native resolver objects, result envelopes, material values, and release functions.
6. Result-collector absence, duplicate submission, late submission, producer throw before submission, producer throw after submission, and attempted recovery from a rejected Proxy with a later ordinary submission.
7. Telegram delivered, definite-failure, and ambiguous settlement shapes, including optional fields and a nested Proxy value. Verify zero delivery mutation after rejection and ordinary settlement afterward.
8. Rollback checkpoint transparent, hiding, descriptor-fabricating, throwing, revoked, nested-value, and prototype attacks.
9. Ordinary exact success/denial/ambiguity, cleanup failure, expiry during consumption, broker-clock rollback, terminal replay, and durable restart to prove the remediation did not weaken prior behavior.

Do not rely only on the supplied regressions. Add temporary defensive probes if useful, but do not retain them or change implementation.

## Complete prior boundary

Reperform the prior attacks for:

- Completion trusted time, strong-factor grant lifetime/revocation, reviewer independence, risk floors, tenant separation, append-only integrity, complete erasure, older valid restoration, and external checkpoints;
- Telegram current project/class/risk/time policy, callback-plan containment, key capture, callback grammar, replay, authenticated complete state, future policy, delivery settlement, complete erasure, and older valid restoration;
- secret catalog isolation, exact local admission, exact grant scope, provider/config/result exactness, trusted function capture, material cleanup, terminal replay, private SQLite schema/path/key/identity integrity, rollback checkpoints, file replacement, restart ambiguity, and clock high-water; and
- negative authority across Completion facts, Telegram proposals, credential receipts, and every UI projection.

## Required deterministic commands

Use only the existing installed dependency tree:

```text
pnpm run check
pnpm run lint
pnpm run test:cr8q
pnpm run pretest
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check
```

If the managed sandbox alone blocks the local `tsx` IPC socket, report the first failure exactly and rerun only the same migration verifier with permission limited to its temporary local IPC socket. No install or network fallback is allowed.

Producer claims at packet freeze are 113/113 for `test:cr8q`, 158/158 for `pretest`, 416 total with 414 passed and two intentional platform skips for the main suite, two rendered routes, and 82 PostgreSQL tables through migration `0024`. These are claims to challenge, not reviewer evidence.

## Required report

`CR8Q_PROXY_REMEDIATION_REREVIEW.md` must include:

1. exact reviewed snapshot and independence statement;
2. write/effect boundary and cleanup statement;
3. determination for `CR8Q-SR-F01` and every earlier finding family;
4. trap-count and real-seam attack evidence, including collector misuse cases;
5. authority, durability/replay, secret/cleanup, and Telegram proposal-only determinations;
6. exact command exit statuses and observed counts;
7. retained live/native/deployment blockers; and
8. one permitted final disposition.

Any new defect requires `remediation_required`. Missing evidence requires `blocked_incomplete_evidence`. A passing repository report must still state that production rollback-checkpoint custody, live provider authentication/runner/IPC/OS isolation/egress, Telegram bot/webhook/chat/transport, protected Completion deployment, CR-7B native proof, MCP deployment, CR-6E owner acceptance, Claude discovery, and macOS CR-5C.9H remain unqualified.
