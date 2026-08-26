---
name: agent-build-worker
description: Claim, execute, return, block, or submit a Control Room V2 jobber from the GitHub ready queue. Use for agent jobber issues; do not use for architecture, integration, or unclaimed work.
---

# Agent build worker

A jobber is one small task capsule. The committed capsule is authoritative; the GitHub issue is its queue view. Never start from an issue unless the queue controller replies `CLAIM ACCEPTED` to your exact claim.

## Pick a jobber

List issues with `gh issue list --state open --label jobber-ready`. Titles have this form:

```text
[READY][ANY|MACOS|WINDOWS|LINUX][T0|T1|T2|T3][CR-BLOCK][CAPSULE-ID] summary
```

Before claiming, open the capsule named in the issue and confirm:

- the platform is `any` or matches the machine you will actually use;
- your route is listed in `eligibleRoutes` and your GitHub login is listed for that route;
- every dependency is complete and every required tool is already available;
- you can use the exact integration target, allowed paths, acceptance commands, repair limit, and effect boundary;
- no install, download, credential, owner action, native attempt, or external effect is needed unless the capsule explicitly authorizes it.

If any item is false or uncertain, do not claim. Leave the ready jobber untouched and choose another.

## Claim

Comment on the issue with exactly (for example, `gh issue comment <issue-number> --body "/claim <route-id>"`):

```text
/claim <route-id>
```

Wait for `CLAIM ACCEPTED`. Rejection means no claim and no authority to branch or work. The controller serializes claims, enforces the route's concurrency limit, assigns the issue, and returns the exact producer branch and integration target.

Use a clean isolated checkout or worktree for this capsule. Fetch the named integration target and create exactly:

```text
agent/<route-id>/<lowercase-capsule-id>
```

Do not work in `main`, the integration checkout, another capsule's checkout, or another agent's branch.

## Perform

Read only the accepted contracts needed by the capsule and change only `allowedPaths`. Use the declared mode:

- `standard-work`: ordinary code, tests, fixtures, UI, or docs; use the capsule's repair iterations.
- `independent-review`: inspect the producer evidence without repairing it and satisfy the declared independence boundary.
- `platform-validation`: follow `../control-room-work-packets/references/platform-validation.md`; readiness is separate from the native attempt.
- `controlled-effect`: follow `../control-room-work-packets/references/execution-contract.md`; every attempt and cleanup stays inside the exact effect ledger.

An ordinary failed test may receive another focused repair only while `maxRepairIterations` remains. A native attempt, controlled effect, install, prompt, restart, or external mutation is not an ordinary repair and receives no retry unless the capsule explicitly counts and authorizes it.

Keep working on other already-ready independent jobbers while earlier submitted jobbers wait for review, up to `maxConcurrentClaimsPerRoute`. Do not start a dependent capsule early.

## Finish and continue

1. Run every acceptance command and inspect the final scope.
2. Commit only the product changes. Record this immutable implementation commit.
3. Fill `coordination/agent-build/results/<CAPSULE-ID>.json` from the V2 result template with exact paths, line counts, exit codes, repairs, failures, assumptions, and effects.
4. Commit only that result manifest in a second metadata commit.
5. Push the exact producer branch and open a PR targeting the exact `integration/<block>` branch. Never target `main`.
6. Comment on the jobber with `gh issue comment <issue-number> --body "/submitted <route-id> <pull-request-url>"`:

```text
/submitted <route-id> <pull-request-url>
```

Wait for the controller to accept the submission. Your route capacity is then released immediately. You may claim the next ready independent jobber without waiting for review.

Do not approve or merge the PR. Automated intake establishes only `eligible` or `quarantined`; a verifier and Codex decide acceptance.

## Return or block

If you claimed but created no producer branch, made no repository change, and performed no attempt or effect, return it with `gh issue comment <issue-number> --body "/release <route-id> --no-work-started <short reason>"`:

```text
/release <route-id> --no-work-started <short reason>
```

The controller verifies that no producer branch exists and returns the jobber to `READY` for another eligible route.

If a branch exists, work began, the repair budget ended, a prerequisite changed, scope became ambiguous, an acceptance check remains failed, or any attempt/effect occurred, preserve the branch and comment with `gh issue comment <issue-number> --body "/blocked <route-id> <short reason and branch or evidence reference>"`:

```text
/blocked <route-id> <short reason and branch or evidence reference>
```

This moves the jobber to `BLOCKED` and releases route capacity. Do not delete evidence, retry, transfer the same capsule, or tell another agent to continue it. Codex will close it, amend it before any attempt, or issue a replacement capsule with a new identity and base.

Never put secrets, raw host identity, private infrastructure, personal paths, or raw native diagnostics in the capsule, issue, result, branch, or PR.
