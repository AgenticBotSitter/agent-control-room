# CR-8Q independent approval, completion, Telegram, and secret-boundary review packet

**Status:** Ready for a separately authorized independent reviewer
**Mode:** `independent-review`
**Block:** CR-8Q
**Required model:** `gpt-5.6-sol`
**Required effort:** `max`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-8 working-tree snapshot described by the architect report.
**Platform eligibility:** Any platform with Node.js `>=22.13.0` and the already prepared frozen dependencies; no native provider, credential, bot, service, or network access is needed.
**Reviewer eligibility:** The reviewer must be independent of CR-8 implementation and architect remediation. It cannot accept a finding it authored or repaired.

## Objective

Attempt to break the repaired combined CR-8 repository boundary. Reproduce or disprove every `CR8Q-F01` through `CR8Q-F12` repair, search for new cross-module defects, and decide whether approval separation, completion independence, Telegram proposal-only behavior, secret containment, expiry, replay, and authenticated durability all fail closed.

Return exactly one disposition:

- `accepted_with_explicit_live_and_deployment_blockers`
- `remediation_required`
- `blocked_incomplete_review`

Passing producer tests are evidence to attack, not a verdict.

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
- migrations `0022_cr8b_completion_gate.sql` and `0023_cr8d_telegram_delivery.sql`
- CR-8 source and corresponding tests under `src/completion-gate/v1`, `src/telegram/v1`, `src/secret-broker/v1`, `app/components`, and `tests`

## Required attacks

### Approval and Completion Gate

1. Attempt quality-review, preference, verification, or Telegram-proposal substitution for consequential approval or execution authority.
2. Attempt self-review, correlated-review multiplication, missing provenance, deterministic-risk downgrade, superseded-target evidence, revision bypass, and finding deletion.
3. Attempt backdated request/decision creation, expiry-boundary creation, stale/revoked/short owner grants, policy/effect substitution, and strong-factor digest forgery.
4. Attempt row mutation, deletion, insertion, cross-tenant collision, state-head substitution, replay drift, and incomplete-history reads.
5. Verify that the UI renders no protected artifact content or consequential action authority.

### Telegram

1. Attempt webhook-secret bypass, caller-selected time/key, stale/future observation, callback MAC drift, non-canonical token, replay aliasing, and update/callback reuse.
2. Attempt callback registration under an unrelated plan, changed scope/lineage, undeclared response kind, unbound choice, high/critical risk, or widened expiry.
3. Attempt recipient-policy narrowing races, delivery double claim, retry after ambiguous outcome, replay settlement drift, and post-claim expiry.
4. Attempt mutation or deletion in every Telegram table, state-head tampering, wrong integrity/callback keys, and cross-tenant access.
5. Verify that every callback produces only a negative-authority proposal and no bot, chat, webhook, or transport qualification is implied.

### Secret broker and providers

1. Attempt caller-computed grant use, catalog replacement/revocation races, invocation-ID aliasing, concurrent consumption, expiry and clock rollback, restart after claim, and terminal replay reacquisition.
2. Attempt plaintext or locator exposure through rows, errors, receipts, fixtures, output, command arguments, environment, and cleanup paths.
3. Attempt prototype, descriptor, accessor, symbol, hidden-field, shared-buffer, binary, size, safe-code, and consumer-result widening without permitting getter execution or residual bytes.
4. Mutate provider, runner, resolver, and consumer objects after construction and attempt to replace the captured trusted functions.
5. Attempt SQLite key/identity/row/metadata/high-water/schema/path tampering and deletion; verify unknown outcomes remain terminal ambiguity.
6. Verify that no native runner, vault authentication, provider call, generic secret-read API, credential material, or deployment authority exists.

### Cross-boundary composition

1. Trace attention to Telegram proposal to central policy decision to node attestation/effect claim, explicitly identifying every separate gate.
2. Try to reuse shared IDs, digests, timestamps, risk labels, or replay keys to convert evidence or a proposal into authority.
3. Search public outputs, durable rows, UI fixtures, errors, and reports for secrets, raw chat IDs, callback tokens, provider locators, private host identity, or credential material.

## Required verification

Run from the repository root with existing dependencies and no install/update:

```text
pnpm run check
pnpm run lint
pnpm run test:cr8q
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check
```

Record the reviewer's own exit status, counts, skips, and relevant warnings. Do not copy producer evidence.

Producer evidence at packet freeze is 86/86 for `test:cr8q`, 131/131 for the repository pretest, 416 total with 414 passed and two intentional platform skips for the main suite, two rendered routes, and 82 verified PostgreSQL tables. These are claims to challenge, not reviewer evidence.

## Allowed write and stop conditions

The independent reviewer may write only `docs/reviews/CR8Q_INDEPENDENT_REVIEW.md`. Source, migration, test, dependency, lockfile, configuration, commit, push, PR, issue, or merge changes are forbidden. If a defect is found, report it without repairing it.

Stop before any install, download, network fallback, GitHub write, provider or credential access, native process, Keychain/vault action, bot/webhook/chat operation, service/listener/deployment, permission or network-policy change, or external effect.

## Required report content

For each finding provide stable ID, severity, exact file/line, reproducible attack, violated invariant, affected boundary, missing regression, and smallest safe remediation. Separately state:

- whether any path grants, spends, or widens authority;
- whether review independence or deterministic risk can be bypassed;
- whether replay/history can be deleted, changed, rewound, or retried ambiguously;
- whether Telegram can create more than a bounded proposal;
- whether secret material or provider-private identity crosses a public/central boundary;
- the disposition of each surface and all retained live/native/deployment blockers; and
- whether another different independent review is required after remediation.

Incomplete analysis, copied producer evidence, or tests alone require `blocked_incomplete_review`.
