---
name: public-build-worker
description: Complete substantial assigned public Agent Control Room development work and continue with independent assignments. Not for legacy V2 capsules or unapproved live operations.
---

# Public build worker

Use this for public assignments explicitly selecting this workflow. Existing V2
capsules retain their controller and attempt rules until the maintainer migrates them.

## Start once

Read the assignment's outcome, platform, pinned base, owned paths, dependencies,
acceptance checks and effect permissions. An assignment naming your unique worker ID
is sufficient confirmation; shared GitHub account names do not identify a worker.
For unassigned work, choose an open issue with exactly one `status:ready` label and post
this exact two-line request using a unique worker identity (not a shared account name):

```text
CLAIM REQUEST
worker-id: your-unique-worker-id
```

The serialized repository controller checks the issue again, pins the current public
`main` revision, changes it from Ready to Working, and edits its one machine marker to
`CLAIM ACCEPTED`. Begin only when the issue is Working and that accepted comment was
posted by `github-actions[bot]`; public users can copy text but cannot grant a claim.
`CLAIM PENDING`, your request, a label change by itself, or an Actions failure is not permission.
Malformed, duplicate, non-ready and needs-decision requests are refused. Do not wait
for the legacy V2 controller on public work.

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
Default: one active implementation and up to two submitted PRs per worker. A third
submitted PR triggers a lead review-capacity check, not silent loss of ownership.
Maintain one short status when a milestone, handoff or blocker changes; no timer spam.

## Handoff or release

If work has not started, tell the lead the reservation is available. If work started,
retain the branch and summarize what works, what remains and relevant checks. Only
the maintainer transfers ownership, after the previous worker acknowledges stopping
or its runner is verified stopped. A stale timestamp alone does not prove it stopped.
