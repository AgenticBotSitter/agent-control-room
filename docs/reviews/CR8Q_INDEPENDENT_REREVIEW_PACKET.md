# CR-8Q independent remediation re-review packet

**Status:** Ready after producer verification; explicit owner authorization still required
**Mode:** `independent-review`
**Block:** CR-8Q
**Required model:** `gpt-5.6-sol`
**Required effort:** `max`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-8 working-tree snapshot and CR-8Q remediation.
**Effects:** Local repository reads, already-installed deterministic tests, and effect-free temporary databases/files only.
**Reviewer eligibility:** The reviewer must be different from the CR-8 implementation/remediation author and from the first independent CR-8Q reviewer. It cannot repair or accept its own finding.

## Objective

Independently verify or break every repair for `CR8Q-IR-F01` through `CR8Q-IR-F07`, rerun the complete original CR-8Q packet, and determine whether the stable effect-free repository snapshot is acceptable with all live/native/deployment blockers retained.

Return exactly one disposition:

- `accepted_with_explicit_live_and_deployment_blockers`
- `remediation_required`
- `blocked_incomplete_review`

The first report remains negative historical evidence. Producer tests and remediation claims are evidence to attack, not a verdict.

## Normative inputs

- `docs/SECURITY_AND_AUTHORITY.md`
- `docs/CR5C_FINAL_SECURITY_CONTRACT.md`
- `docs/CR8B_COMPLETION_GATE_CONTRACT.md`
- `docs/CR8C_VIEW_MODEL_CONTRACT.md`
- `docs/CR8D_TELEGRAM_SECURITY_CONTRACT.md`
- `docs/CR8D_PRESENTATION_CONTRACT.md`
- `docs/CR8D_DURABLE_DELIVERY_CONTRACT.md`
- `docs/CR8E_SECRET_BROKER_CONTRACT.md`
- `docs/reviews/CR8Q_ARCHITECT_SECURITY_REVIEW.md`
- immutable first report `docs/reviews/CR8Q_INDEPENDENT_REVIEW.md`
- migrations `0022_cr8b_completion_gate.sql`, `0023_cr8d_telegram_delivery.sql`, and `0024_cr8q_rollback_checkpoints.sql`
- CR-8 source and corresponding tests under `src/completion-gate/v1`, `src/telegram/v1`, `src/secret-broker/v1`, `src/security`, `app/components`, and `tests`

## Mandatory remediation attacks

1. Delete every Completion Gate row and its PostgreSQL head while leaving the external checkpoint intact. Attempt normal access and repeated provisioning. Both must fail closed. Restore an older internally valid complete database snapshot and prove the current checkpoint rejects it.
2. Repeat complete erasure, repeated provisioning, and older valid-snapshot restoration across every Telegram row set and its head. Confirm no callback observation, proposal, delivery, or policy history is recreated or accepted.
3. Attempt to replace, mutate, throw from, return malformed data from, or replay the injected checkpoint port. Verify methods are captured, compare-and-swap conflicts fail closed, and the in-memory implementation is clearly test-only rather than deployment authority.
4. Mutate the original credential-catalog input and every object/array returned by registration, exact replay, replacement, resolution, and snapshot. Recompute public digests and attempt a broker grant outside the original scope. No mutation may change stored authority metadata.
5. Delete the complete SQLite ledger file; replace it with an empty file; attempt explicit recreation under the existing checkpoint; and restore an older internally valid file. Routine open or recreation must fail before authorization, claim, provider resolution, or consumer work.
6. Narrow current Telegram recipient project, message class, and maximum risk after callback registration. Introduce a future verification lower bound. Callback consumption must record no update/proposal. Registration must independently reject disallowed class and over-ceiling risk.
7. Exercise both sides of `verifiedAt <= trusted time < policyExpiresAt` at enqueue, claim, callback registration, and callback consumption. A future policy must never reach `sending`.
8. Round-trip every legal callback-ID character through record parse, token issue, webhook parse, lookup, MAC authentication, and proposal creation. Dot, colon, leading separators, non-canonical encodings, multiple separators, and over/under-length IDs must fail consistently.

## Complete-boundary attacks

Repeat every attack in `CR8Q_INDEPENDENT_REVIEW_PACKET.md`, including approval/completion separation and independence, deterministic risk floors, strong-factor binding, replay conflicts, Telegram negative authority, secret/output containment, provider envelope exactness, function capture, ambiguity, expiry, clock rollback, and cross-boundary substitution. Search for new defects introduced by the checkpoint port, explicit provisioning, schema revision, callback-record expansion, and create/open ledger modes.

Explicitly determine whether:

- any quality, Telegram, catalog, checkpoint, or replay fact grants or widens approval, dispatch, execution, credential, or effect authority;
- any complete deletion, valid rollback, missing checkpoint, stale checkpoint, or split commit can silently resume;
- external-checkpoint calls can be bypassed by caller mutation or malformed returns;
- a callback can survive current project/class/risk/time revocation;
- catalog scope can change without a monotonic replacement; and
- a replaced ledger can reacquire material or repeat a consumer effect.

## Required verification

Run from the repository root with existing dependencies and no install/update:

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

Record independent exit status, counts, skips, and relevant warnings. Do not copy producer counts.

Producer evidence at packet freeze is 99/99 for `test:cr8q`, 144/144 for `pretest`, 416 total with 414 passed and two intentional platform skips for the main suite, two rendered routes, and 82 PostgreSQL tables through migration `0024`. These are claims to challenge, not reviewer evidence.

## Allowed write and stop conditions

The reviewer may write only `docs/reviews/CR8Q_INDEPENDENT_REREVIEW.md`. Source, migrations, tests, contracts, status, dependencies, lockfile, configuration, Git state, commits, pushes, PRs, issues, and merges are forbidden. If a defect is found, report it without repairing it.

Stop before any install, download, network fallback, GitHub action, provider or credential access, native process, Keychain/vault action, bot/webhook/chat operation, service/listener/deployment, permission or network-policy change, or external effect.

## Required report content

For each first-review finding, record exact code/test evidence and one disposition: `verified_repaired`, `not_repaired`, or `blocked`. For every new finding provide a stable ID, severity, exact file/line, reproducible attack, violated invariant, affected boundary, missing regression, and smallest safe remediation. Separately state all authority, durability, replay, secret, Telegram proposal-only, native, and deployment determinations and the final repository disposition.

Incomplete analysis, producer-evidence copying, or tests alone requires `blocked_incomplete_review`.
