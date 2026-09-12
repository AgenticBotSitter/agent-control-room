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
For unassigned work, obtain a maintainer reservation before editing. A claim comment
alone is not an atomic lock. Do not wait for a nonexistent V2 controller on public work.

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

## Submit and move on

One PR per coherent outcome, targeting the named branch. Include:

```text
Outcome / issue:
Base SHA / submitted SHA:
Relevant checks and results:
Not tested / remaining limitation:
Upstream additions and licenses, if any:
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
