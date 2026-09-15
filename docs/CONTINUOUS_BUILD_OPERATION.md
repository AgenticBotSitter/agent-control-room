# Continuous build operation

The goal is that contributors and maintainers coordinate through GitHub without the
project owner relaying messages. Measurements help diagnose waiting; they do not by
themselves create, review, or complete work.

## The operating loop

1. An owner-approved worker scheduler starts an agent session every 30 minutes, or
   keeps an existing session available. The read-only notification watcher alone
   cannot start an agent. Each installation needs evidence that its scheduled agent
   session actually ran; an installed timer is insufficient.
2. The worker reads its current assignments, corrections and Ready candidates using
   the same inbox command. It handles corrections first, otherwise requests a fitting
   substantial package within capacity and waits for the controller's accepted claim.
3. It builds, checks, obtains proportional independent review and submits on GitHub.
   Its next scheduled session reads new corrections and continues the same work.
4. The lead's 30-minute monitor inspects every open pull request, its current commit,
   comments and checks, including submissions still labeled Working. Labels alone
   cannot hide completed work. The lead reviews the current submitted result, gives
   one consolidated material correction list or accepts and merges eligible work.
5. After merges, the lead refreshes dependencies and makes substantial independent
   packages available. Existing ownership and valid path locks remain in force.
6. Each cycle records resolved bottlenecks and checks whether useful delivery improved.

An API error, contradictory record, missing claim packet, duplicate issue binding,
or unmatched worker ID is a distinct repair task for the lead. It must never become
a silent "nothing to do". Do not repair an authority conflict by blindly relabeling it.
Use the existing serialized claim/handoff controller and verify the resulting record.

## Response responsibilities

| Observation | Who acts and what happens next |
| --- | --- |
| Ready package not picked up after two scheduled checks | Lead checks the packet and active path conflicts, then reads capability/no-fit reports. Repair the offer or prepare independent work that fits available capacity. |
| Worker cannot take an offer | Worker names candidate issues and concrete platform, skill, capacity or permission reasons on GitHub. Lead resolves the mismatch. |
| Submission has no review state, or changed commit after a correction | Lead reads the PR anyway, verifies the submitted commit and reconciles the handoff through the controller. |
| Review requests changes | Controller routes the full consolidated findings to the accepted worker; the next worker session acknowledges and corrects them. |
| Worker reports no assignment but an old worker ID owns it | Lead reconciles the identity deliberately, preserving the branch and ownership. No owner courier required. |
| Worker stopped reporting | Lead checks for submitted work and latest progress before arranging a handoff. Inactivity alone is not permission to discard work or hand out overlapping paths. |
| Dependency merged | Lead rechecks remaining prerequisites and packet validity before making the dependent work Ready. |
| Host asleep, authentication missing, provider exhausted, or production approval absent | Record the exact interruption and continue independent work. Ask the owner only for the part that actually requires their action. |

## Verified repairs and remaining proof

The September 15 investigation found three concrete failures: watchers inspected only
existing assignments; the inbox ignored newer claim lifecycle records; and queue health
did not recognize the standard `Control-Room-Issue` field. Regression checks now cover
Ready discovery by the installed watcher, packet defects, current submission and release
records, and canonical PR bindings. Existing controller decisions retain their authority.

This is not yet evidence of an unattended night. Before claiming that the loop works,
observe a staffed 24-hour window with:

- scheduled agent sessions actually running on the intended hosts;
- a full real claim, build, submit, review, correction if needed, and merge cycle;
- no unresolved false-empty inbox or stale correction routing after two monitor cycles;
- every avoidable delay assigned to a specific responsible area with an action taken;
- accepted product outcomes and honest work-time coverage reported together.

The [measurement report](PUBLIC_BUILD_FLOW_MEASUREMENT.md) provides waiting and delivery
signals. Missing work-time reports remain unknown. Avoid repeatedly creating reporting
jobs; make each operational repair improve the next real contribution cycle.

The full process remains in the [contributor handbook](../CONTRIBUTOR_HANDBOOK.md).
This page explains operational responsibility, not a second claim or review protocol.
