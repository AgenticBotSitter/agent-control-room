# CR-8Q second independent remediation re-review packet

**Status:** Ready after producer verification; explicit owner authorization still required
**Mode:** `independent-review`
**Block:** CR-8Q
**Required model:** `gpt-5.6-sol`
**Required effort:** `max`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-8 working-tree snapshot and both CR-8Q remediations.
**Effects:** Local repository reads, already-installed deterministic tests, and effect-free temporary databases/files only.
**Reviewer eligibility:** The reviewer must be different from the CR-8 implementation/remediation author, the author of `CR8Q_INDEPENDENT_REVIEW.md`, and the author of `CR8Q_INDEPENDENT_REREVIEW.md`. It cannot repair or accept its own finding.

## Objective

Independently verify or break the repair for `CR8Q-RR-F01`, confirm that the seven previously repaired findings remain closed, repeat the complete CR-8Q boundary, and determine whether the stable effect-free repository snapshot is acceptable with every live/native/deployment blocker retained.

Return exactly one disposition:

- `accepted_with_explicit_live_and_deployment_blockers`
- `remediation_required`
- `blocked_incomplete_review`

Both earlier independent reports remain immutable negative historical evidence. Producer tests and remediation claims are evidence to challenge, not a verdict.

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
- `docs/reviews/CR8Q_INDEPENDENT_REVIEW_PACKET.md`
- `docs/reviews/CR8Q_INDEPENDENT_REREVIEW_PACKET.md`
- immutable reports `docs/reviews/CR8Q_INDEPENDENT_REVIEW.md` and `docs/reviews/CR8Q_INDEPENDENT_REREVIEW.md`
- migrations `0022_cr8b_completion_gate.sql`, `0023_cr8d_telegram_delivery.sql`, and `0024_cr8q_rollback_checkpoints.sql`
- CR-8 source and corresponding tests under `src/completion-gate/v1`, `src/telegram/v1`, `src/secret-broker/v1`, `src/security`, `app/components`, and `tests`

## Mandatory `CR8Q-RR-F01` attacks

1. At the real broker consumer seam, return each of `succeeded`, `definite_failure`, and `ambiguous` using an accessor for `outcome`, then separately for `outputDigest` or `safeCode`. No getter may execute and every result must become terminal ambiguity.
2. Repeat all three variants with required fields inherited from a custom prototype, a symbol property, a non-enumerable required field, a non-enumerable extra field, and an ordinary enumerable extra field. None may be normalized into a valid result.
3. Put credential-shaped canary text in hidden, symbol, accessor-returned, and extra values. Confirm it never appears in the receipt, safe ledger, error, output, or durable SQLite bytes.
4. Confirm malformed-result settlement wipes the material buffer, invokes provider cleanup exactly once, returns `consumer_or_cleanup_outcome_unknown`, and records literal negative authority.
5. Replay each malformed-result invocation with a consumer that would fail if called. Confirm the terminal ambiguity is returned without provider acquisition, consumer invocation, getter execution, or cleanup repetition.
6. Confirm exact ordinary enumerable data objects for success, definite failure, and ambiguity preserve their intended terminal state and safe output.
7. Combine malformed consumer results with cleanup failure, broker-clock rollback, and expiry during the consumer call. The result must remain terminal ambiguity with no automatic retry or reacquisition.
8. Exercise both the direct broker seam and the fixed-consumer composition. Later mutation of captured fixed-consumer/provider functions must remain ineffective.
9. Review `exactDataSnapshotV1` and `ownDataValueV1` call ordering. The raw consumer object must not be sent to Zod, redaction, JSON serialization, digesting, logging, or ordinary property access before exact snapshot acceptance.

## Prior-remediation and complete-boundary attacks

Repeat every mandatory attack in `CR8Q_INDEPENDENT_REREVIEW_PACKET.md` and every complete-boundary attack in `CR8Q_INDEPENDENT_REVIEW_PACKET.md`. At minimum, independently recheck complete Completion/Telegram erasure and valid rollback, checkpoint mutation and split-transition failure, credential-catalog mutation through the real authorization seam, missing/empty/recreated/older SQLite files, current Telegram project/class/risk/time races, callback grammar, approval/completion separation, deterministic risk floors, strong-factor binding, replay conflicts, Telegram negative authority, provider envelope exactness, function capture, ambiguity, expiry, clock rollback, and cross-boundary substitution.

Explicitly determine whether:

- malformed consumer output can be recorded as success or definite failure;
- validation executes any getter or accepts inherited, symbol, hidden, non-enumerable, or extra fields;
- any malformed result can leak material, skip cleanup, reacquire on replay, or change approval/dispatch/execution/effect authority;
- any complete deletion, valid rollback, missing checkpoint, stale checkpoint, or split commit can silently resume;
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

Producer evidence at packet freeze is 101/101 for `test:cr8q`, 146/146 for `pretest`, 416 total with 414 passed and two intentional platform skips for the main suite, two rendered routes, and 82 PostgreSQL tables through migration `0024`. These are claims to challenge, not reviewer evidence.

## Allowed write and stop conditions

The reviewer may write only `docs/reviews/CR8Q_SECOND_REREVIEW.md`. Source, migrations, tests, contracts, status, dependencies, lockfile, configuration, Git state, commits, pushes, PRs, issues, and merges are forbidden. If a defect is found, report it without repairing it.

Stop before any install, download, network fallback, GitHub action, provider or credential access, native process, Keychain/vault action, bot/webhook/chat operation, service/listener/deployment, permission or network-policy change, or external effect.

## Required report content

Record exact code/test evidence and an independent disposition for `CR8Q-RR-F01`. Reconfirm `CR8Q-IR-F01` through `CR8Q-IR-F07` and the complete architect boundary. For every new finding provide a stable ID, severity, exact file/line, reproducible defensive test, violated invariant, affected boundary, missing regression, and smallest safe remediation. Separately state all authority, durability, replay, secret, cleanup, Telegram proposal-only, native, and deployment determinations and the final repository disposition.

Incomplete analysis, producer-evidence copying, or tests alone requires `blocked_incomplete_review`.
