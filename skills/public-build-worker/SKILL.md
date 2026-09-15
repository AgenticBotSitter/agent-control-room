---
name: public-build-worker
description: Complete substantial assigned public Agent Control Room work with proportionate independent review. Not for legacy V2 capsules or unapproved live operations.
---

# Public build worker

Read [the contributor handbook](../../CONTRIBUTOR_HANDBOOK.md) before starting.
It owns claim, submission, acknowledgment, correction and handoff rules, including
the configured controller versus legacy manual fallback. This skill adds worker
guidance without copying that lifecycle. Existing V2 capsules retain their named rules.

Check the worker inbox first. Continue received corrections on the existing branch;
do not make a replacement issue or claim. Attention means the records need reconciling,
not that there is no work. Stop requests preserve ownership until stopping is acknowledged.
A worker ID organizes shared-account work; it is not an authenticated identity.
If your stable worker ID changed, do not silently resume work claimed under the old ID;
the maintainer must use the controller's legacy-correction adoption transfer so the
current ID receives the correction visibly.

Read the issue's outcome, platform, pinned base, owned paths, dependencies and checks.
Use an isolated checkout. Reuse selected upstream components and preserve notices.
Build the complete outcome and repair ordinary failures without an arbitrary retry
limit. If repeated attempts produce no new evidence, report the useful reproduction
and saved branch, then continue independent authorized work.

Do not change shared contracts, authentication, migrations or selected dependencies
merely to pass checks. Ask for the exact missing decision. Provider calls, credentials,
services and other external effects retain the issue's scoped authority; an uncertain
effect is not permission to retry.

Before an automated worker's first push, obtain the handbook's proportionate independent
check of the committed changes. Record the checker identity, commit, verdict, actual
checks and material limitations. Material changes afterward need a focused delta check.
Do not request unrelated full-suite reruns or cosmetic evidence. Human contributors
may submit for maintainer review normally.

Submit one coherent package with honest checks, untested behavior and upstream notices.
Never publish credentials, private records or raw host diagnostics. Do not self-merge.
Use the handbook's current submission format and keep issue/PR links. Continue another
eligible independent package within its capacity rules while review is pending.

The repository-wide serialized controller checks the issue again, pins the current public
`main` revision, changes it from Ready to Working, and edits its one machine marker to
`CLAIM ACCEPTED`. Begin only when the issue is Working and that accepted comment was
posted by `github-actions[bot]`; public users can copy text but cannot grant a claim.
`CLAIM PENDING`, your request, a label change by itself, or an Actions failure is not permission.
If that comment later says `CLAIM REVOKED — STOP`, stop; the accepted permission no longer exists.
Malformed, duplicate, non-ready and needs-decision requests are refused, as are
requests whose work packet is missing or invalid, whose dependencies are not
closed issues with the done disposition, whose effects are not `none`, whose
path scopes overlap another Working or In-review reservation, whose other
locks are packet-less legacy or drifted from their accepted markers, or whose
pair already holds a Working claim. Do not wait
for the legacy V2 controller on public work.

Every Ready issue carries one strict machine-readable packet
(`<!-- acr-public-work:v1 {...} -->`) with target, literal path scopes,
dependencies, checks, risk, effects and a finite lease in hours. Only literal
paths and terminal `/**` prefixes are valid scopes; any other globbing or path
escape is refused.

Keep a reservation with `CLAIM RENEW` (same login and worker, unchanged packet,
unexpired lease; the renewal preserves the immutable accepted base). Record
submission readiness with a four-line `CLAIM SUBMIT` naming the open pull
request number and its exact head SHA. The pull request reports exactly one
`Worker-Model:` line and one `Worker-Effort:` line, plus any known optional
`Worker-Active-Minutes:` / `Worker-Input-Tokens:` / `Worker-Output-Tokens:` /
`Worker-Provider-Calls:` / `Worker-Interruptions:` lines (unknown stays `unknown`,
never guessed). The controller verifies the PR is open
against `main` in the same repository, authored by your login, references the
issue exactly with one `Control-Room-Issue:` line, the packet is unchanged
and the lease is unexpired, the issue is still working and the pull request
carries no workflow labels — then records the SUBMITTED marker and moves no
labels, so the `HANDOFF submit` command can move the issue and the pull
request to In review together. The path lock stays in force through review;
you may then claim another independent packet, up to two outstanding
submissions per pair. Return safe, effect-free, unsubmitted work with
`CLAIM RELEASE`. Expired leases stop automatically: quiet work returns to
Ready, one open PR by the accepted worker stays In review, and ambiguous,
multi-PR or effectful work becomes Needs decision.

The accepted marker binds the reservation to both the requester's GitHub login and
unique worker ID. Each exact login-and-worker pair may hold one active implementation;
separate bots sharing one GitHub account remain distinct through their worker IDs. A
claim grants no repository authority, and maintainers may release abusive or abandoned
reservations.

Use your own branch/checkout and the published setup instructions. If blocked by a
missing prerequisite, report it once and take another assigned independent item.
Never edit another worker's checkout or start dependent work on an unmerged branch.

## Build the outcome

Reuse the named existing components. Implement, test, diagnose and repair ordinary
code failures without a fixed retry count. Keep useful local commits; no special
metadata commit or JSON result manifest is needed. Add tests that exercise the actual
changed path, not merely a synthetic replacement for it.

Stay within the outcome and owned paths. Ask the lead to settle changes to shared
contracts, authentication, credentials, migrations or dependency choices. Do not
change those boundaries merely to pass a test. New installs, provider calls, services
and other external effects need the assignment's explicit authority. Uncertain
external execution is not permission to retry. Preserve any narrower attempt limits.

If two attempts produce no new diagnostic evidence, stop repeating the approach:
send a concise blocker with the reproduction, hypothesis and useful saved branch.
That is a handoff, not a failure penalty. Continue an independent assigned task.

## Independent check before an automated worker submits

An automated worker must commit locally, then ask a separate read-only subagent that
authored none of the changed files to review that exact local commit before its first
remote push. If the worker changes material code after that review, repeat the check
for the changed portion. Human contributors may submit normally and receive the
repository's maintainer review.

Match the check to the risk:

- For ordinary UI, documentation or isolated refactoring, inspect the actual diff,
  affected user behavior and relevant tests. Do not require a production-code revert
  or a repository-wide test run unless a concrete uncertainty justifies it.
- For shared execution, authorization, persistence, recovery, release integrity or
  provider boundaries, verify the relevant refusal/failure paths and run focused
  evidence that could expose duplicate work, data loss or excess authority. Use a
  mutation or revert check when a safety claim depends on a new test and its ability
  to catch the broken behavior is genuinely uncertain.

The reviewer returns `accept`, `changes required` or `blocked`, with only material
findings and checks actually performed. It cannot edit the branch, approve a merge or
replace the lead's final review. Record the concise verdict in the PR handoff. A style
preference or wording suggestion does not block submission.

## Submit and move on

One PR per coherent outcome, targeting the named branch. Include:

```text
Outcome / issue:
Base SHA / submitted SHA:
Relevant checks and results:
Not tested / remaining limitation:
Upstream additions and licenses, if any:
Independent subagent verdict and focused checks:
```

Use synthetic UI evidence when relevant. Never publish credentials, private records
or raw host diagnostics. Do not self-approve or merge. Correct ordinary review findings
on the same PR; do not create a replacement job for each repair.

While review is pending, take the next explicitly reserved independent assignment.
Default: one active implementation per exact GitHub-login and worker-ID pair, and up
to two submitted PRs per worker. A third
submitted PR triggers a lead review-capacity check, not silent loss of ownership.
Maintain one short status when a milestone, handoff or blocker changes; no timer spam.

## Handoff or release

If work has not started, tell the lead the reservation is available. If work started,
retain the branch and summarize what works, what remains and relevant checks. Only
the maintainer transfers ownership, after the previous worker acknowledges stopping
or its runner is verified stopped. A stale timestamp alone does not prove it stopped.
